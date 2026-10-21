import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { maximalPublicationScopeCases } from "../../../tests/fixtures/publication-scope-capacity.mjs";
import {
  InboxStore,
  OutboxStore,
  runOutboxWorker,
  SnapshotStore,
  CollectionStore,
  EnrichmentStore,
  DeliveryPayloadExpiryStore,
  postgresDatabase,
  createWebhookHandler,
  createIngestionServer,
  runWorker,
  parseDispatchPublications,
} from "../dist/index.js";

const snapshotUp = await readFile(new URL("../sql/002_snapshots.up.sql", import.meta.url), "utf8");
const snapshotDown = await readFile(new URL("../sql/002_snapshots.down.sql", import.meta.url), "utf8");
const collectionUp = await readFile(new URL("../sql/003_collection.up.sql", import.meta.url), "utf8");
const collectionDown = await readFile(new URL("../sql/003_collection.down.sql", import.meta.url), "utf8");
const up =
  (await readFile(new URL("../sql/001_ingestion.up.sql", import.meta.url), "utf8")) +
  "\n" +
  snapshotUp +
  "\n" +
  collectionUp +
  "\n" +
  (await readFile(new URL("../sql/004_outbox_dispatch.up.sql", import.meta.url), "utf8")) +
  "\n" +
  (await readFile(new URL("../sql/006_delivery_payload_expiry.up.sql", import.meta.url), "utf8")) +
  "\n" +
  (await readFile(new URL("../sql/007_operator_replay_results.up.sql", import.meta.url), "utf8")) +
  "\n" +
  (await readFile(new URL("../sql/008_dispatch_publication_scope_capacity.up.sql", import.meta.url), "utf8"));
const down =
  (await readFile(new URL("../sql/008_dispatch_publication_scope_capacity.down.sql", import.meta.url), "utf8")) +
  "\n" +
  (await readFile(new URL("../sql/007_operator_replay_results.down.sql", import.meta.url), "utf8")) +
  "\n" +
  (await readFile(new URL("../sql/006_delivery_payload_expiry.down.sql", import.meta.url), "utf8")) +
  "\n" +
  (await readFile(new URL("../sql/004_outbox_dispatch.down.sql", import.meta.url), "utf8")) +
  "\n" +
  collectionDown +
  "\n" +
  snapshotDown +
  "\n" +
  (await readFile(new URL("../sql/001_ingestion.down.sql", import.meta.url), "utf8"));
const url = process.env.INGESTION_TEST_DATABASE_URL;
let engine, db, store, snapshots;
before(async () => {
  if (url) {
    if (!/^\/leaderboard_ingestion(?:_[a-z0-9]+)*_test$/.test(new URL(url).pathname))
      throw new Error("Tests require a disposable leaderboard_ingestion[_suffix]_test database");
    engine = new Pool({ connectionString: url });
    db = postgresDatabase(engine);
  } else {
    engine = new PGlite();
    db = {
      query: (sql, params) => engine.query(sql, params),
      transaction: (fn) => engine.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
    };
  }
  // Refuse to overwrite an existing schema. CI must provide a fresh disposable DB.
  const existing = await db.query(
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'leaderboard_ingestion'",
  );
  assert.equal(existing.rows.length, 0, "test schema already exists; refusing to overwrite it");
  if (url) await engine.query(up);
  else await engine.exec(up);
  store = new InboxStore(db, 3);
  snapshots = new SnapshotStore(db);
});
after(async () => {
  if (engine) await (url ? engine.end() : engine.close());
});
async function resetStore() {
  await db.query(
    "TRUNCATE leaderboard_ingestion.object_suppressions, leaderboard_ingestion.enrichment_jobs, leaderboard_ingestion.collection_items, leaderboard_ingestion.collection_pages, leaderboard_ingestion.source_facts, leaderboard_ingestion.collection_runs, leaderboard_ingestion.lifecycle_receipts, leaderboard_ingestion.repository_access CASCADE",
  );
  await db.query(
    "TRUNCATE leaderboard_ingestion.snapshot_notices, leaderboard_ingestion.snapshot_heads, leaderboard_ingestion.snapshots, leaderboard_ingestion.outbox, leaderboard_ingestion.observations, leaderboard_ingestion.replay_receipts, leaderboard_ingestion.attempt_history, leaderboard_ingestion.inbox, leaderboard_ingestion.delivery_payload_expiry_operations RESTART IDENTITY CASCADE",
  );
  await new CollectionStore(db).verifyPublic(2, 1, null);
}
beforeEach(resetStore);

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function delivery(n = 1) {
  return {
    deliveryId: id(n),
    bodyHash: "a".repeat(64),
    envelope: {
      version: "github-delivery/v1",
      deliveryId: id(n),
      event: "issues",
      action: "reopened",
      installationId: 1,
      repositoryId: 2,
      subjectId: "SYNTHETIC_ISSUE",
      actorId: null,
      occurredAt: null,
      sourceUrl: "https://github.com/synthetic-org/synthetic-repo/issues/3",
    },
  };
}
async function expire() {
  await db.query(
    "UPDATE leaderboard_ingestion.inbox SET lease_until = clock_timestamp() - interval '1 second' WHERE state = 'leased'",
  );
}
async function ready() {
  await db.query("UPDATE leaderboard_ingestion.inbox SET available_at = clock_timestamp() - interval '1 second'");
}
async function counts() {
  return (
    await db.query(`SELECT (SELECT count(*)::int FROM leaderboard_ingestion.observations) AS observations,
    (SELECT count(*)::int FROM leaderboard_ingestion.outbox) AS notices`)
  ).rows[0];
}

test("redelivery is idempotent and a reused delivery ID with different bytes conflicts", async () => {
  assert.equal(await store.insert(delivery()), "accepted");
  assert.equal(await store.insert(delivery()), "duplicate");
  assert.equal(await store.insert({ ...delivery(), bodyHash: "b".repeat(64) }), "conflict");
});

test("signed delivery survives intake and worker restart; tampered redelivery cannot change the receipt", async () => {
  const secret = "synthetic-integration-secret-of-32-characters";
  const receive = createWebhookHandler({ secrets: [secret], scope: new Map([[1, new Set([2])]]), store });
  const body = JSON.stringify({
    action: "opened",
    installation: { id: 1 },
    repository: { id: 2, private: false, visibility: "public", full_name: "synthetic-org/synthetic-repo" },
    sender: null,
    issue: { node_id: "SYNTHETIC_ISSUE", number: 3, created_at: "2026-01-01T00:00:00Z", body: "unretained" },
  });
  const request = (text) =>
    new Request("https://synthetic.invalid/webhook", {
      method: "POST",
      body: text,
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": id(1),
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(text).digest("hex")}`,
      },
    });
  assert.equal((await receive(request(body))).status, 202);
  assert.equal((await receive(request(body))).status, 200);
  assert.equal((await receive(request(body.replace("unretained", "changed")))).status, 409);
  const restarted = new InboxStore(db, 3);
  const lease = await restarted.claim();
  assert.equal(await restarted.complete(lease), true);
  assert.deepEqual(await counts(), { observations: 1, notices: 1 });
  assert.doesNotMatch(
    JSON.stringify((await db.query("SELECT envelope FROM leaderboard_ingestion.inbox")).rows),
    /unretained|changed/,
  );
});

test("acknowledged data survives a new store instance; only one current lease completes", async () => {
  await store.insert(delivery());
  const restarted = new InboxStore(db, 3);
  const lease = await restarted.claim();
  assert.equal(await store.claim(), null);
  assert.equal(await store.complete(lease), true);
  assert.equal(await store.complete(lease), false);
  assert.deepEqual(await counts(), { observations: 1, notices: 1 });
  const observation = (await db.query("SELECT observation FROM leaderboard_ingestion.observations")).rows[0]
    .observation;
  assert.equal(observation.occurredAt, null);
  assert.equal(observation.actorId, null);
  assert.equal(observation.qualification, "not_evaluated");
});

test("HTTP receiver restart retains acknowledged receipt and a restarted worker makes fresh progress", async () => {
  const secret = "synthetic-http-integration-secret-32-characters";
  const options = { secrets: [secret], scope: new Map([[1, new Set([2])]]), store };
  const body = JSON.stringify({
    action: "reopened",
    installation: { id: 1 },
    repository: { id: 2, private: false, visibility: "public", full_name: "synthetic-org/synthetic-repo" },
    sender: null,
    issue: { node_id: "SYNTHETIC_ISSUE", number: 3 },
  });
  const headers = {
    "content-type": "application/json",
    "x-github-event": "issues",
    "x-github-delivery": id(1),
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  };
  for (const expected of [202, 200]) {
    const server = createIngestionServer({ ...options, store: new InboxStore(db, 3) });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/github`, {
        method: "POST",
        headers,
        body,
      });
      assert.equal(response.status, expected);
      await response.json();
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }
  const control = new AbortController();
  const states = [];
  await runWorker(new InboxStore(db, 3), {
    signal: control.signal,
    onStatus: (state) => {
      states.push(state);
      control.abort();
    },
  });
  assert.deepEqual(states, ["processed"]);
  assert.deepEqual(await counts(), { observations: 1, notices: 1 });
});

test("expired worker cannot complete or fail a delivery reclaimed by another worker", async () => {
  await store.insert(delivery());
  const stale = await store.claim();
  await expire();
  assert.equal(await store.complete(stale), false);
  const current = await store.claim();
  assert.notEqual(stale.token, current.token);
  assert.equal(current.attempt, 2);
  assert.equal(await store.fail(stale, "normalization_failed"), false);
  assert.equal(await store.complete(stale), false);
  assert.equal(await store.complete(current), true);
  assert.deepEqual(await counts(), { observations: 1, notices: 1 });
});

test("outbox failure rolls back the observation and acknowledgement together", async () => {
  await store.insert(delivery());
  const lease = await store.claim();
  const broken = new InboxStore({
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          query(sql, params) {
            if (sql.includes("INSERT INTO leaderboard_ingestion.outbox")) throw new Error("synthetic outbox failure");
            return tx.query(sql, params);
          },
        }),
      ),
  });
  await assert.rejects(broken.complete(lease), /synthetic outbox failure/);
  assert.deepEqual(await counts(), { observations: 0, notices: 0 });
  assert.equal(await store.complete(lease), true);
});

test("bounded retries defer delivery then quarantine poison events", async () => {
  await store.insert(delivery());
  for (let attempt = 1; attempt <= 3; attempt++) {
    const lease = await store.claim();
    assert.equal(lease.attempt, attempt);
    assert.equal(await store.fail(lease, "source_unavailable"), true);
    assert.equal(await store.claim(), null);
    await ready();
  }
  const row = (await db.query("SELECT state, attempts, reason_code FROM leaderboard_ingestion.inbox")).rows[0];
  assert.deepEqual(row, { state: "quarantined", attempts: 3, reason_code: "source_unavailable" });
});

test("crash on final attempt quarantines after expiry; permanent failures quarantine immediately", async () => {
  await store.insert(delivery());
  for (let i = 0; i < 3; i++) {
    assert.ok(await store.claim());
    await expire();
  }
  assert.equal(await store.claim(), null);
  assert.equal(
    (await db.query("SELECT reason_code FROM leaderboard_ingestion.inbox")).rows[0].reason_code,
    "attempts_exhausted",
  );
  await store.insert(delivery(2));
  assert.equal(await store.fail(await store.claim(), "unsupported_payload", true), true);
  assert.equal(await store.claim(), null);
});

test(
  "PostgreSQL concurrent delivery and SKIP LOCKED workers preserve exactly one observation per delivery",
  { skip: !url },
  async () => {
    const inserted = await Promise.all(Array.from({ length: 8 }, () => store.insert(delivery())));
    assert.equal(inserted.filter((state) => state === "accepted").length, 1);
    await store.insert(delivery(2));
    const leases = await Promise.all([store.claim(), store.claim(), store.claim()]);
    const claimed = leases.filter(Boolean);
    assert.equal(claimed.length, 2);
    assert.equal(new Set(claimed.map((lease) => lease.deliveryId)).size, 2);
    assert.deepEqual(await Promise.all(claimed.map((lease) => store.complete(lease))), [true, true]);
    assert.deepEqual(await counts(), { observations: 2, notices: 2 });
  },
);

test("operator replay preserves failure history and original delivery identity and receive time", async () => {
  await store.insert(delivery());
  const original = (await db.query("SELECT received_at FROM leaderboard_ingestion.inbox")).rows[0].received_at;
  await store.fail(await store.claim(), "unsupported_payload", true);
  assert.equal(await store.replay(id(1), "synthetic-review-receipt-1"), true);
  assert.equal(await store.replay(id(1), "synthetic-review-receipt-2"), false);
  assert.equal(await store.complete(await store.claim()), true);
  const history = (await db.query("SELECT outcome FROM leaderboard_ingestion.attempt_history ORDER BY started_at"))
    .rows;
  assert.deepEqual(
    history.map((row) => row.outcome),
    ["quarantined", "done"],
  );
  assert.deepEqual(
    (await db.query("SELECT prior_attempts, prior_reason_code FROM leaderboard_ingestion.replay_receipts")).rows,
    [{ prior_attempts: 1, prior_reason_code: "unsupported_payload" }],
  );
  assert.deepEqual(
    (await db.query("SELECT received_at FROM leaderboard_ingestion.inbox")).rows[0].received_at,
    original,
  );
});

test("read-only object replay uses source time, survives store restart and declares retained-only coverage", async () => {
  const open = delivery(1);
  open.envelope.action = "opened";
  open.envelope.occurredAt = "2026-01-01T00:00:00.000Z";
  const closed = delivery(2);
  closed.envelope.action = "closed";
  closed.envelope.occurredAt = "2026-01-02T00:00:00.000Z";
  // Reverse receipt order relative to the source facts.
  for (const item of [closed, open]) {
    await store.insert(item);
    await store.complete(await store.claim());
  }
  const priorCounts = await counts();
  const first = await store.replayObjectState(2, "SYNTHETIC_ISSUE");
  assert.equal(first.coverage, "retained_observations_only");
  assert.equal(first.sourceObservationCount, 2);
  assert.equal(first.replay.facets[0].state, "known");
  assert.equal(first.replay.facets[0].value, "closed");
  assert.deepEqual(await new InboxStore(db, 3).replayObjectState(2, "SYNTHETIC_ISSUE"), first);
  assert.deepEqual(await counts(), priorCounts);
  // A subsequent unknown-time reopen must not silently use database receive time.
  await store.insert(delivery(3));
  await store.complete(await store.claim());
  const after = await store.replayObjectState(2, "SYNTHETIC_ISSUE");
  assert.equal(after.replay.facets[0].state, "ambiguous");
  assert.equal(after.replay.facets[0].value, null);
  await assert.rejects(store.replayObjectState(999, "SYNTHETIC_ISSUE"), /repository_unavailable/);
  await new CollectionStore(db).verifyPublic(999, 1, null);
  assert.equal((await store.replayObjectState(999, "SYNTHETIC_ISSUE")).sourceObservationCount, 0);
  assert.deepEqual((await store.replayObjectState(999, "SYNTHETIC_ISSUE")).replay.facets, []);
});

test("edits do not assert lifecycle and unknown normalization versions fail closed", async () => {
  const edit = delivery();
  edit.envelope.action = "edited";
  await store.insert(edit);
  await store.complete(await store.claim());
  const result = await store.replayObjectState(2, "SYNTHETIC_ISSUE");
  assert.equal(result.sourceObservationCount, 1);
  assert.deepEqual(result.replay.facets, []);
  await db.query("UPDATE leaderboard_ingestion.observations SET normalization_version = 'synthetic-unknown'");
  await assert.rejects(store.replayObjectState(2, "SYNTHETIC_ISSUE"), /unsupported_normalization_version/);
  await assert.rejects(store.replayObjectState(0, "SYNTHETIC_ISSUE"), /invalid_replay_scope/);
});

test("oversized retained history fails instead of returning an apparently complete partial replay", async () => {
  await db.query(
    `INSERT INTO leaderboard_ingestion.inbox (delivery_id, body_hash, envelope)
    SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, repeat('a', 64), $1::jsonb
    FROM generate_series(1, 257) AS n`,
    [JSON.stringify(delivery().envelope)],
  );
  await db.query(`INSERT INTO leaderboard_ingestion.observations (event_key, delivery_id, normalization_version, observation)
    SELECT 'synthetic-limit:' || delivery_id, delivery_id, 'delivery-observation/v1', envelope
    FROM leaderboard_ingestion.inbox`);
  await assert.rejects(store.replayObjectState(2, "SYNTHETIC_ISSUE"), /replay_limit_exceeded/);
});

async function observe(
  n = 1,
  action = "opened",
  occurredAt = "2026-01-01T00:00:00.000Z",
  subjectId = "SYNTHETIC_ISSUE",
) {
  const item = delivery(n);
  Object.assign(item.envelope, { action, occurredAt, subjectId });
  await store.insert(item);
  assert.equal(await store.complete(await store.claim()), true);
}

test("empty snapshot scope remains unavailable, not a published zero", async () => {
  assert.equal(await snapshots.latest(2, "SYNTHETIC_ISSUE"), null);
  assert.equal(await snapshots.byId("0".repeat(64)), null);
  assert.deepEqual(await snapshots.notices(2, "SYNTHETIC_ISSUE", "0"), []);
  await assert.rejects(
    snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "0"),
    /snapshot_no_observations/,
  );
});

test("publication, pinned reads and compact notices agree on one immutable snapshot", async () => {
  await observe();
  const first = await snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "0");
  assert.equal(first.changed, true);
  assert.equal(first.revision, "1");
  assert.equal(first.snapshot.document.coverage, "retained_observations_only");
  assert.equal(first.snapshot.document.replay.facets[0].value, "open");
  const { changed, ...head } = first;
  assert.deepEqual(await snapshots.latest(2, "SYNTHETIC_ISSUE"), head);
  assert.deepEqual(await snapshots.byId(first.snapshot.snapshotId), first.snapshot);
  assert.deepEqual(await snapshots.notices(2, "SYNTHETIC_ISSUE", "0"), [
    { revision: "1", snapshotId: first.snapshot.snapshotId, publishedAt: first.publishedAt },
  ]);
  const unchanged = await new SnapshotStore(db).publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "1");
  assert.equal(unchanged.changed, false);
  assert.deepEqual(unchanged.snapshot, first.snapshot);
  assert.equal(unchanged.revision, "1");
  assert.equal((await snapshots.notices(2, "SYNTHETIC_ISSUE", "0")).length, 1);
});

test("new evidence advances revision while prior IDs and definition versions remain pinned", async () => {
  await observe();
  const first = await snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "0");
  await observe(2, "closed", "2026-01-02T00:00:00.000Z");
  const second = await snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "1");
  assert.equal(second.revision, "2");
  assert.notEqual(second.snapshot.snapshotId, first.snapshot.snapshotId);
  assert.equal(second.snapshot.document.replay.facets[0].value, "closed");
  assert.deepEqual(await snapshots.byId(first.snapshot.snapshotId), first.snapshot);
  assert.deepEqual(
    (await snapshots.notices(2, "SYNTHETIC_ISSUE", "1")).map((notice) => notice.revision),
    ["2"],
  );
  const policy = await snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v2", "2");
  assert.equal(policy.revision, "3");
  assert.notEqual(policy.snapshot.snapshotId, second.snapshot.snapshotId);
  assert.equal((await snapshots.byId(first.snapshot.snapshotId)).document.definitionVersion, "synthetic-policy-v1");
});

test("notice insertion failure rolls back payload, head and notice; recovery makes fresh useful progress", async () => {
  await observe();
  const first = await snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "0");
  await observe(2, "closed", "2026-01-02T00:00:00.000Z");
  const broken = new SnapshotStore({
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          query(sql, params) {
            if (sql.includes("INSERT INTO leaderboard_ingestion.snapshot_notices"))
              throw new Error("synthetic publication failure");
            return tx.query(sql, params);
          },
        }),
      ),
  });
  await assert.rejects(
    broken.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "1"),
    /synthetic publication failure/,
  );
  assert.equal((await snapshots.latest(2, "SYNTHETIC_ISSUE")).snapshot.snapshotId, first.snapshot.snapshotId);
  assert.equal((await snapshots.notices(2, "SYNTHETIC_ISSUE", "0")).length, 1);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM leaderboard_ingestion.snapshots")).rows[0].count, 1);
  assert.equal((await snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "1")).revision, "2");
});

test("failed rebuild and stale publisher retain the last known valid snapshot", async () => {
  await observe();
  const first = await snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "0");
  await assert.rejects(
    snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "0"),
    /snapshot_revision_conflict/,
  );
  await db.query("UPDATE leaderboard_ingestion.observations SET normalization_version = 'synthetic-unknown'");
  await assert.rejects(
    snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "1"),
    /unsupported_normalization_version/,
  );
  assert.deepEqual((await snapshots.latest(2, "SYNTHETIC_ISSUE")).snapshot, first.snapshot);
  await assert.rejects(
    db.query("UPDATE leaderboard_ingestion.snapshots SET document = $1::jsonb", ["{}"]),
    /immutable_snapshot/,
  );
  await assert.rejects(db.query("DELETE FROM leaderboard_ingestion.snapshots"), /immutable_snapshot/);
  assert.deepEqual(await snapshots.byId(first.snapshot.snapshotId), first.snapshot);
});

test("snapshot scope, cursor, version and identifier validation fail closed", async () => {
  await assert.rejects(
    snapshots.publishObjectState(0, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "0"),
    /invalid_snapshot_scope/,
  );
  await assert.rejects(
    snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "bad version", "0"),
    /invalid_definition_version/,
  );
  for (const invalid of ["01", "-1", "9223372036854775808", "1.1"]) {
    await assert.rejects(
      snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", invalid),
      /invalid_snapshot_revision/,
    );
  }
  await assert.rejects(snapshots.byId("invalid"), /invalid_snapshot_id/);
  await assert.rejects(snapshots.notices(2, "SYNTHETIC_ISSUE", "0", 101), /invalid_notice_limit/);
});

test("notice pagination orders numeric revisions across 9/10 without skipping or repeating any publication", async () => {
  await observe();
  for (let n = 1; n <= 12; n++) {
    await snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", `synthetic-policy-v${n}`, String(n - 1));
  }
  const seen = [];
  let cursor = "0";
  while (true) {
    const page = await snapshots.notices(2, "SYNTHETIC_ISSUE", cursor, 2);
    if (!page.length) break;
    for (const notice of page) {
      seen.push(notice.revision);
      assert.equal((await snapshots.byId(notice.snapshotId)).snapshotId, notice.snapshotId);
    }
    cursor = page.at(-1).revision;
  }
  assert.deepEqual(
    seen,
    Array.from({ length: 12 }, (_, index) => String(index + 1)),
  );
});

test("revision cursors retain precision above 2^53 and exhaustion cannot replace a valid snapshot", async () => {
  await observe();
  await snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "0");
  // Synthetic boundary fixture, not an actual claim of this many publications.
  await db.query("UPDATE leaderboard_ingestion.snapshot_heads SET revision = $1", ["9007199254740992"]);
  const high = await snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v2", "9007199254740992");
  assert.equal(high.revision, "9007199254740993");
  assert.equal((await snapshots.notices(2, "SYNTHETIC_ISSUE", "9007199254740992"))[0].revision, "9007199254740993");
  await db.query("UPDATE leaderboard_ingestion.snapshot_heads SET revision = $1", ["9223372036854775807"]);
  const unchanged = await snapshots.publishObjectState(
    2,
    "SYNTHETIC_ISSUE",
    "synthetic-policy-v2",
    "9223372036854775807",
  );
  assert.equal(unchanged.changed, false);
  await assert.rejects(
    snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v3", "9223372036854775807"),
    /snapshot_revision_exhausted/,
  );
  assert.equal((await snapshots.latest(2, "SYNTHETIC_ISSUE")).snapshot.snapshotId, high.snapshot.snapshotId);
});

test("snapshot readers reject mismatched hashes, malformed content and unknown document versions", async () => {
  await observe();
  const published = await snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "0");
  for (const corrupt of [
    (row) => ({ ...row, snapshot_id: "0".repeat(64) }),
    (row) => ({ ...row, document: { ...row.document, version: "synthetic-unknown" } }),
    (row) => ({ ...row, document: { ...row.document, unexpected: "synthetic-private-field" } }),
    (row) => ({ ...row, document: { ...row.document, replay: { ...row.document.replay, facets: [] } } }),
  ]) {
    const broken = new SnapshotStore({
      ...db,
      async query(sql, params) {
        const result = await db.query(sql, params);
        return { rows: result.rows.map(corrupt) };
      },
    });
    await assert.rejects(broken.byId(published.snapshot.snapshotId), /snapshot_integrity_error/);
  }
  await assert.rejects(
    db.query(
      `INSERT INTO leaderboard_ingestion.snapshot_heads (scope_key, revision, snapshot_id)
    VALUES ($1, 1, $2)`,
      [JSON.stringify([2, "SYNTHETIC_OTHER"]), published.snapshot.snapshotId],
    ),
    /foreign key/,
  );
});

test(
  "PostgreSQL competing publishers commit one revision; independent scopes keep independent cursors",
  { skip: !url },
  async () => {
    await observe();
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () => snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "0")),
    );
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      attempts.filter(
        (result) => result.status === "rejected" && /snapshot_revision_conflict/.test(result.reason.message),
      ).length,
      5,
    );
    assert.equal((await snapshots.notices(2, "SYNTHETIC_ISSUE", "0")).length, 1);
    await observe(2, "opened", "2026-01-01T00:00:00.000Z", "SYNTHETIC_OTHER");
    assert.equal((await snapshots.publishObjectState(2, "SYNTHETIC_OTHER", "synthetic-policy-v1", "0")).revision, "1");
    assert.deepEqual(await snapshots.notices(2, "SYNTHETIC_OTHER", "1"), []);
  },
);

test("PostgreSQL readers cannot see half-published heads or notices before commit", { skip: !url }, async () => {
  await observe();
  const first = await snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "0");
  await observe(2, "closed", "2026-01-02T00:00:00.000Z");
  let enter, release, nextId;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const paused = new SnapshotStore({
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          async query(sql, params) {
            if (sql.includes("INSERT INTO leaderboard_ingestion.snapshots")) nextId = params[0];
            if (sql.includes("INSERT INTO leaderboard_ingestion.snapshot_notices")) {
              enter();
              await gate;
            }
            return tx.query(sql, params);
          },
        }),
      ),
  });
  const publish = paused.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "1");
  try {
    await entered;
    assert.equal((await snapshots.latest(2, "SYNTHETIC_ISSUE")).revision, "1");
    assert.equal((await snapshots.latest(2, "SYNTHETIC_ISSUE")).snapshot.snapshotId, first.snapshot.snapshotId);
    assert.deepEqual(await snapshots.notices(2, "SYNTHETIC_ISSUE", "1"), []);
    assert.equal(await snapshots.byId(nextId), null);
  } finally {
    release();
  }
  assert.equal((await publish).revision, "2");
  const notice = (await snapshots.notices(2, "SYNTHETIC_ISSUE", "1"))[0];
  assert.equal((await snapshots.byId(notice.snapshotId)).snapshotId, nextId);
});

test("snapshot migration rollback removes publication tables while preserving retained observations", async () => {
  await observe();
  await snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "0");
  if (url) await engine.query(snapshotDown);
  else await engine.exec(snapshotDown);
  assert.deepEqual(await counts(), { observations: 1, notices: 1 });
  if (url) await engine.query(snapshotUp);
  else await engine.exec(snapshotUp);
  assert.equal(await snapshots.latest(2, "SYNTHETIC_ISSUE"), null);
  assert.equal((await snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "0")).revision, "1");
});

test("migration rollback and reapply work on an empty schema", async () => {
  if (url) {
    await engine.query(down);
    await engine.query(up);
  } else {
    await engine.exec(down);
    await engine.exec(up);
  }
  assert.equal(await store.insert(delivery()), "accepted");
});

const scan = (runId = "synthetic-scan", overrides = {}) => ({
  runId,
  repositoryId: 2,
  family: "issues",
  mode: "backfill",
  since: null,
  until: "2026-01-03T00:00:00.000Z",
  ...overrides,
});
const fact = (subjectId = "SYNTHETIC_ISSUE", overrides = {}) => ({
  subjectId,
  sourceRevision: "synthetic-v1",
  sourceUrl: "https://github.com/synthetic-org/synthetic-repo/issues/3",
  evidence: "current_state",
  actorId: null,
  occurredAt: null,
  state: "closed",
  ...overrides,
});
const page = (facts, nextCursor = null, expectedCount = facts.length) => ({
  repositoryId: 2,
  visibility: "public",
  facts,
  nextCursor,
  expectedCount,
});
async function collection() {
  const result = new CollectionStore(db);
  return result;
}
async function facts() {
  return (await db.query("SELECT fact_key, document FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows;
}

test("resumable paginated backfill checkpoints atomically and recovers source failure without invented history", async () => {
  const collect = await collection();
  await collect.start(scan());
  const calls = [];
  const first = {
    async readPage(request) {
      calls.push(request);
      return page([fact()], "page-2", 2);
    },
  };
  assert.equal(await collect.step("synthetic-scan", first, 1), "progress");
  assert.equal(calls[0].cursor, null);
  assert.equal(
    await collect.step("synthetic-scan", {
      async readPage() {
        throw new Error("synthetic secret never retained");
      },
    }),
    "failed",
  );
  const failed = (await collect.diagnostics(2))[0];
  assert.equal(failed.item_count, 1);
  assert.equal(failed.health, "disconnected");
  assert.equal(failed.reason, "source_read_failed");
  const restarted = new CollectionStore(db);
  assert.equal(
    await restarted.step("synthetic-scan", {
      async readPage(request) {
        assert.equal(request.cursor, "page-2");
        return page([fact("SYNTHETIC_OTHER")], null, 2);
      },
    }),
    "complete",
  );
  assert.equal((await restarted.diagnostics(2))[0].counts_reconciled, true);
  assert.equal((await facts()).length, 2);
  assert.equal((await facts())[0].document.actorId, null);
  assert.equal((await facts())[0].document.occurredAt, null);
  assert.deepEqual(await counts(), { observations: 0, notices: 0 });
});

test("omitted delivery converges through reconciliation; overlap and full audit retain identical evidence", async () => {
  const collect = await collection();
  await store.insert(delivery());
  await store.complete(await store.claim());
  const sourceLedger = await db.query("SELECT event_key, observation FROM leaderboard_ingestion.observations");
  const readOnly = {
    async readPage() {
      return page([fact("SYNTHETIC_MISSING_DELIVERY")]);
    },
  };
  for (const [runId, mode] of [
    ["synthetic-recent", "reconcile"],
    ["synthetic-overlap", "reconcile"],
    ["synthetic-audit", "audit"],
  ]) {
    await collect.start(scan(runId, { mode, since: "2026-01-01T00:00:00.000Z" }));
    assert.equal(await collect.step(runId, readOnly), "complete");
  }
  assert.equal((await facts()).length, 1);
  assert.deepEqual(
    await db.query("SELECT event_key, observation FROM leaderboard_ingestion.observations"),
    sourceLedger,
  );
  assert.deepEqual(
    (await db.query("SELECT changed_count FROM leaderboard_ingestion.collection_pages ORDER BY run_id")).rows
      .map((row) => row.changed_count)
      .sort(),
    [0, 0, 1],
  );
  await assert.rejects(
    db.query("UPDATE leaderboard_ingestion.source_facts SET document = '{}'"),
    /immutable_source_fact/,
  );
});

test("partial counts, duplicate pages, invalid evidence and source drift never certify complete coverage", async () => {
  const collect = await collection();
  await collect.start(scan());
  assert.equal(
    await collect.step("synthetic-scan", {
      async readPage() {
        return page([fact()], null, 2);
      },
    }),
    "failed",
  );
  assert.equal((await facts()).length, 0);
  assert.equal(
    await collect.step("synthetic-scan", {
      async readPage() {
        return page([fact()], "next", 2);
      },
    }),
    "progress",
  );
  for (const result of [
    page([fact()], null, 2),
    page([fact("SYNTHETIC_OTHER")], null, 3),
    page([fact("SYNTHETIC_OTHER", { actorId: "SYNTHETIC_OWNER" })], null, 2),
    { ...page([fact("SYNTHETIC_OTHER")], null, 2), visibility: "private" },
    page(
      [fact("SYNTHETIC_FUTURE", { evidence: "observed_transition", occurredAt: "2027-01-01T00:00:00.000Z" })],
      null,
      2,
    ),
  ]) {
    assert.equal(
      await collect.step("synthetic-scan", {
        async readPage() {
          return result;
        },
      }),
      "failed",
    );
    assert.equal((await facts()).length, 1);
  }
  assert.equal((await collect.diagnostics(2))[0].counts_reconciled, false);
  assert.equal((await collect.diagnostics(2))[0].reason, "source_schema_drift");
});

test("current Project fields cannot become historical attribution, deleted actor remains unknown", async () => {
  const collect = await collection();
  await collect.start(scan("synthetic-current", { family: "project_current" }));
  assert.equal(
    await collect.step("synthetic-current", {
      async readPage() {
        return page([fact("SYNTHETIC_PROJECT_FIELD")]);
      },
    }),
    "complete",
  );
  await collect.start(scan("synthetic-history", { family: "project_history" }));
  assert.equal(
    await collect.step("synthetic-history", {
      async readPage() {
        return page([
          fact("SYNTHETIC_TRANSITION", {
            evidence: "observed_transition",
            occurredAt: "2026-01-02T00:00:00.000Z",
            actorId: null,
          }),
        ]);
      },
    }),
    "complete",
  );
  assert.equal((await facts()).length, 2);
  assert.equal((await facts()).find((row) => row.document.subjectId === "SYNTHETIC_TRANSITION").document.actorId, null);
});

test("empty source read differs from disconnected or never-read collector and stale progress", async () => {
  const collect = await collection();
  await collect.start(scan("synthetic-empty"));
  assert.equal((await collect.diagnostics(2))[0].health, "unproven");
  assert.equal(
    await collect.step("synthetic-empty", {
      async readPage() {
        return page([]);
      },
    }),
    "complete",
  );
  assert.equal((await collect.diagnostics(2))[0].health, "no_activity_in_window");
  await db.query(
    "UPDATE leaderboard_ingestion.collection_runs SET last_success_at = clock_timestamp() - interval '2 hours'",
  );
  assert.equal((await collect.diagnostics(2, 3600))[0].health, "disconnected");
  await collect.suppress(id(44), "a".repeat(64), 1, [2], "private");
  const unavailable = (await collect.diagnostics(2))[0];
  assert.equal(unavailable.health, "unavailable");
  assert.equal(unavailable.coverage, "unavailable");
  assert.equal(unavailable.counts_reconciled, false);
  assert.equal(unavailable.historical_counts_reconciled, true);
});

test("signed privatization hides latest, pinned snapshots, notices and replay while preserving evidence", async () => {
  const collect = await collection();
  await observe();
  const head = await snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "0");
  const original = await db.query("SELECT event_key, observation FROM leaderboard_ingestion.observations");
  const secret = "synthetic-lifecycle-secret-at-least-32-characters";
  const handler = createWebhookHandler({
    secrets: [secret],
    scope: new Map([[1, new Set([2])]]),
    store,
    lifecycle: collect,
  });
  const body = JSON.stringify({ installation: { id: 1 }, repository: { id: 2, private: true }, action: "privatized" });
  const request = (signature) =>
    new Request("https://synthetic.invalid/webhook", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": "repository",
        "x-github-delivery": id(55),
        "x-hub-signature-256": signature,
      },
    });
  assert.equal((await handler(request("sha256=" + "0".repeat(64)))).status, 401);
  assert.ok(await snapshots.latest(2, "SYNTHETIC_ISSUE"));
  const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.equal((await handler(request(signature))).status, 202);
  assert.equal((await handler(request(signature))).status, 200);
  assert.equal(await snapshots.latest(2, "SYNTHETIC_ISSUE"), null);
  assert.equal(await snapshots.byId(head.snapshot.snapshotId), null);
  assert.deepEqual(await snapshots.notices(2, "SYNTHETIC_ISSUE", "0"), []);
  await assert.rejects(store.replayObjectState(2, "SYNTHETIC_ISSUE"), /repository_unavailable/);
  await assert.rejects(
    snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "1"),
    /repository_unavailable/,
  );
  assert.deepEqual(await db.query("SELECT event_key, observation FROM leaderboard_ingestion.observations"), original);
  assert.equal(await collect.verifyPublic(2, 1, "1"), false, "stale pre-revocation probe cannot restore serving");
  assert.equal(await collect.verifyPublic(2, 1, "2"), true);
  assert.ok(await snapshots.byId(head.snapshot.snapshotId));
});

test("unverified repository access fails closed for replay, publication, pinned reads and notices", async () => {
  await observe();
  const head = await snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "0");
  await db.query("DELETE FROM leaderboard_ingestion.repository_access WHERE repository_id = 2");
  assert.equal(await snapshots.latest(2, "SYNTHETIC_ISSUE"), null);
  assert.equal(await snapshots.byId(head.snapshot.snapshotId), null);
  assert.deepEqual(await snapshots.notices(2, "SYNTHETIC_ISSUE", "0"), []);
  await assert.rejects(store.replayObjectState(2, "SYNTHETIC_ISSUE"), /repository_unavailable/);
  await assert.rejects(
    snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "1"),
    /repository_unavailable/,
  );
  assert.deepEqual(await counts(), { observations: 1, notices: 1 });
});

test("App revocation and repository removal fence in-flight scans and stale reactivation", async () => {
  const collect = await collection();
  await collect.start(scan());
  assert.equal(
    await collect.step("synthetic-scan", {
      async readPage() {
        assert.equal(await collect.suppress(id(70), "a".repeat(64), 1, [2], "removed"), "accepted");
        return page([fact()]);
      },
    }),
    "failed",
  );
  assert.equal((await facts()).length, 0);
  assert.equal(await collect.verifyPublic(2, 1, "1"), false);
  assert.equal(await collect.verifyPublic(2, 1, "2"), true);
  assert.equal(
    await collect.step("synthetic-scan", {
      async readPage() {
        return page([fact()]);
      },
    }),
    "failed",
    "pre-revocation run stays fenced",
  );
  await collect.suppress(id(71), "b".repeat(64), 1, [], "revoked");
  assert.equal(await collect.verifyPublic(2, 1, "4"), false, "revoked installation cannot restore access");
  assert.equal(await collect.verifyPublic(3, 1, null), false, "new repositories cannot bypass installation revocation");
  assert.equal(await collect.suppress(id(71), "c".repeat(64), 1, [], "revoked"), "conflict");
});

test("repository rename preserves stable scope identity and scan replay is idempotent", async () => {
  const collect = await collection();
  await collect.start(scan());
  await collect.step("synthetic-scan", {
    async readPage() {
      return page([fact()]);
    },
  });
  await collect.start(scan("synthetic-renamed", { mode: "reconcile" }));
  await collect.step("synthetic-renamed", {
    async readPage() {
      return page([
        fact("SYNTHETIC_ISSUE", {
          sourceUrl: "https://github.com/synthetic-org/synthetic-renamed/issues/3",
        }),
      ]);
    },
  });
  const before = await facts();
  assert.equal(before.length, 2, "retain old and renamed source references");
  assert.equal(
    await collect.step("synthetic-renamed", {
      async readPage() {
        throw new Error("completed scan must not fetch");
      },
    }),
    "complete",
  );
  assert.deepEqual(await facts(), before);
  assert.equal(
    (await db.query("SELECT DISTINCT repository_id FROM leaderboard_ingestion.source_facts")).rows.length,
    1,
  );
});

test("PostgreSQL competing scan workers commit one checkpoint and one fact", { skip: !url }, async () => {
  const collect = await collection();
  await collect.start(scan());
  let arrived = 0,
    release;
  const both = new Promise((resolve) => {
    release = resolve;
  });
  const source = {
    async readPage() {
      if (++arrived === 2) release();
      await both;
      return page([fact()]);
    },
  };
  const results = await Promise.all([collect.step("synthetic-scan", source), collect.step("synthetic-scan", source)]);
  assert.deepEqual(results.sort(), ["complete", "superseded"]);
  assert.equal((await facts()).length, 1);
  assert.equal((await collect.diagnostics(2))[0].page_count, 1);
});

const sourceMetadata = (overrides = {}) => ({
  sourceRevision: "synthetic-v1",
  acceptedOutcome: true,
  reviewState: "approved",
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  ...overrides,
});
async function enrichment() {
  const collect = await collection();
  await collect.start(scan());
  await collect.step("synthetic-scan", {
    async readPage() {
      return page([fact()]);
    },
  });
  const key = (await facts())[0].fact_key;
  const enrich = new EnrichmentStore(db, 3);
  await enrich.enqueue(key, "synthetic-policy-v1");
  return { enrich, collect, key };
}

test("asynchronous enrichment retains revision-pinned metadata, failures stay visible and recover without contribution credit", async () => {
  const { enrich, key } = await enrichment();
  assert.equal((await db.query("SELECT state FROM leaderboard_ingestion.enrichment_jobs")).rows[0].state, "pending");
  assert.equal(
    await enrich.processOne({
      async readMetadata() {
        throw new Error("synthetic secret never retain");
      },
    }),
    "failed",
  );
  let job = (await db.query("SELECT * FROM leaderboard_ingestion.enrichment_jobs")).rows[0];
  assert.equal(job.state, "failed");
  assert.equal(job.reason, "enrichment_unavailable");
  assert.equal(job.metadata, null);
  assert.deepEqual(await counts(), { observations: 0, notices: 0 });
  await db.query(
    "UPDATE leaderboard_ingestion.enrichment_jobs SET available_at = clock_timestamp() - interval '1 second'",
  );
  assert.equal(
    await new EnrichmentStore(db, 3).processOne({
      async readMetadata(request) {
        assert.equal(request.fact.sourceRevision, "synthetic-v1");
        return { ...sourceMetadata(), body: "untrusted instruction text" };
      },
    }),
    "classified",
  );
  job = (await db.query("SELECT * FROM leaderboard_ingestion.enrichment_jobs")).rows[0];
  assert.equal(job.attempts, 2);
  assert.deepEqual(job.metadata, sourceMetadata());
  assert.deepEqual(await counts(), { observations: 0, notices: 0 });
  await enrich.enqueue(key, "synthetic-policy-v1");
  assert.equal(
    await enrich.processOne({
      async readMetadata() {
        throw new Error("must not fetch completed job");
      },
    }),
    "idle",
  );
  await enrich.enqueue(key, "synthetic-policy-v2");
  assert.equal(
    await enrich.processOne({
      async readMetadata() {
        return sourceMetadata({ acceptedOutcome: false });
      },
    }),
    "excluded",
  );
});

test("enrichment keeps its original revision pin when the metadata adapter edits its request", async () => {
  const { enrich } = await enrichment();
  const retained = await facts();
  assert.equal(
    await enrich.processOne({
      async readMetadata(request) {
        await Promise.resolve();
        request.fact.sourceRevision = "synthetic-v2";
        return sourceMetadata({ sourceRevision: request.fact.sourceRevision });
      },
    }),
    "failed",
  );
  let job = (await db.query("SELECT * FROM leaderboard_ingestion.enrichment_jobs")).rows[0];
  assert.equal(job.state, "failed");
  assert.equal(job.reason, "enrichment_unavailable");
  assert.equal(job.metadata, null);
  assert.equal(job.attempts, 1);
  assert.deepEqual(await facts(), retained);
  assert.deepEqual(await counts(), { observations: 0, notices: 0 });

  await db.query(
    "UPDATE leaderboard_ingestion.enrichment_jobs SET available_at = clock_timestamp() - interval '1 second'",
  );
  assert.equal(
    await new EnrichmentStore(db, 3).processOne({
      async readMetadata(request) {
        assert.equal(request.fact.sourceRevision, "synthetic-v1");
        return sourceMetadata();
      },
    }),
    "classified",
  );
  job = (await db.query("SELECT * FROM leaderboard_ingestion.enrichment_jobs")).rows[0];
  assert.equal(job.attempts, 2);
  assert.deepEqual(job.metadata, sourceMetadata());
  assert.deepEqual(await facts(), retained);
  assert.deepEqual(await counts(), { observations: 0, notices: 0 });
});

test("adapter-local fact edits do not reject metadata for the retained enrichment revision", async () => {
  const { enrich } = await enrichment();
  const retained = await facts();
  assert.equal(
    await enrich.processOne({
      async readMetadata(request) {
        request.fact.sourceRevision = "adapter-working-copy";
        request.fact.subjectId = "ADAPTER_LOCAL_SUBJECT";
        return sourceMetadata();
      },
    }),
    "classified",
  );
  const job = (await db.query("SELECT * FROM leaderboard_ingestion.enrichment_jobs")).rows[0];
  assert.deepEqual(job.metadata, sourceMetadata());
  assert.deepEqual(await facts(), retained);
  assert.deepEqual(await counts(), { observations: 0, notices: 0 });
});

test("missing evidence, changed source revision and exhausted attempts never become classified", async () => {
  const { enrich } = await enrichment();
  for (const invalid of [
    sourceMetadata({ acceptedOutcome: null }),
    sourceMetadata({ sourceRevision: "synthetic-v2" }),
    sourceMetadata({ additions: -1 }),
  ]) {
    assert.equal(
      await enrich.processOne({
        async readMetadata() {
          return invalid;
        },
      }),
      "failed",
    );
    await db.query(
      "UPDATE leaderboard_ingestion.enrichment_jobs SET available_at = clock_timestamp() - interval '1 second'",
    );
  }
  assert.equal(
    await enrich.processOne({
      async readMetadata() {
        return sourceMetadata();
      },
    }),
    "idle",
  );
  assert.equal((await db.query("SELECT metadata FROM leaderboard_ingestion.enrichment_jobs")).rows[0].metadata, null);
});

test("enrichment completion rejects lost lease or access suppression and never overwrites a completed classification", async () => {
  const { enrich, collect } = await enrichment();
  let leased;
  assert.equal(
    await enrich.processOne({
      async readMetadata() {
        leased = (await db.query("SELECT * FROM leaderboard_ingestion.enrichment_jobs")).rows[0];
        await collect.suppress(id(88), "a".repeat(64), 1, [2], "private");
        return sourceMetadata();
      },
    }),
    "lease_lost",
  );
  assert.deepEqual((await db.query("SELECT * FROM leaderboard_ingestion.enrichment_jobs")).rows[0], leased);
  assert.equal((await db.query("SELECT metadata FROM leaderboard_ingestion.enrichment_jobs")).rows[0].metadata, null);
  assert.equal(
    await enrich.processOne({
      async readMetadata() {
        return sourceMetadata();
      },
    }),
    "idle",
  );
});

test("reconciled deletion suppresses old artifact snapshots and preserves unaffected scope and audit evidence", async () => {
  const collect = await collection();
  await observe();
  await observe(2, "opened", "2026-01-01T00:00:00.000Z", "SYNTHETIC_OTHER");
  const first = await snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-policy-v1", "0");
  await snapshots.publishObjectState(2, "SYNTHETIC_OTHER", "synthetic-policy-v1", "0");
  await collect.start(scan());
  assert.equal(
    await collect.step("synthetic-scan", {
      async readPage() {
        return page([fact("SYNTHETIC_ISSUE", { state: "deleted" })]);
      },
    }),
    "complete",
  );
  assert.equal(await snapshots.latest(2, "SYNTHETIC_ISSUE"), null);
  assert.equal(await snapshots.byId(first.snapshot.snapshotId), null);
  assert.deepEqual(await snapshots.notices(2, "SYNTHETIC_ISSUE", "0"), []);
  await assert.rejects(store.replayObjectState(2, "SYNTHETIC_ISSUE"), /repository_unavailable/);
  assert.ok(await snapshots.latest(2, "SYNTHETIC_OTHER"));
  assert.deepEqual(await counts(), { observations: 2, notices: 2 });
  assert.equal((await facts())[0].document.state, "deleted");
});

test("health and replay audit retain operator-supplied identity, policy and unknown resulting publication", async () => {
  assert.equal((await store.health()).latest_received_at, null);
  await store.insert(delivery());
  assert.equal((await store.health()).pending, 1);
  const lease = await store.claim();
  assert.equal((await store.health()).leased, 1);
  await store.fail(lease, "source_unavailable", true);
  assert.equal((await store.health()).quarantined, 1);
  const audit = {
    operatorId: "SYNTHETIC_OPERATOR",
    reason: "source_recovered",
    policyVersion: "synthetic-policy-v1",
    resultingRevision: null,
  };
  assert.equal(await store.replay(id(1), "synthetic-recovery", audit), true);
  assert.deepEqual((await db.query("SELECT audit FROM leaderboard_ingestion.replay_receipts")).rows[0].audit, audit);
  const recovered = await store.claim();
  assert.equal(await store.complete(recovered), true);
  assert.equal((await store.health()).completed, 1);
  assert.ok((await store.health()).last_processed_at);
  assert.equal((await store.health()).oldest_unfinished_seconds, null);
  assert.deepEqual(await counts(), { observations: 1, notices: 1 });
});

test(
  "PostgreSQL shared public-read gate permits ordinary scans but blocks deletion and unavailability commits",
  { skip: !url },
  async () => {
    const collect = await collection();
    const bounded = new CollectionStore({
      ...db,
      transaction: (work) =>
        db.transaction(async (tx) => {
          await tx.query("SET LOCAL lock_timeout = '100ms'");
          return work(tx);
        }),
    });
    const reader = await engine.connect();
    try {
      await reader.query("BEGIN");
      await reader.query(
        "SELECT repository_id FROM leaderboard_ingestion.repository_access WHERE repository_id = 2 FOR SHARE",
      );
      await collect.start(scan("synthetic-ordinary"));
      assert.equal(
        await bounded.step("synthetic-ordinary", {
          async readPage() {
            return page([fact()]);
          },
        }),
        "complete",
        "ordinary page retains a shared gate",
      );
      for (const state of ["deleted", "unavailable"]) {
        const runId = `synthetic-gated-${state}`;
        await collect.start(scan(runId));
        assert.equal(
          await bounded.step(runId, {
            async readPage() {
              return page([fact(`SYNTHETIC_${state}`, { state })]);
            },
          }),
          "failed",
          "suppression transaction must wait for existing public reader",
        );
        assert.equal(
          (await db.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.object_suppressions")).rows[0]
            .count,
          0,
        );
        const checkpoint = (await collect.diagnostics(2)).find(
          (row) => row.reason === "source_commit_failed" && row.item_count === 0,
        );
        assert.ok(checkpoint, "blocked suppression does not advance its checkpoint");
      }
      await reader.query("COMMIT");
      for (const state of ["deleted", "unavailable"]) {
        assert.equal(
          await bounded.step(`synthetic-gated-${state}`, {
            async readPage() {
              return page([fact(`SYNTHETIC_${state}`, { state })]);
            },
          }),
          "complete",
        );
      }
      assert.equal(
        (await db.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.object_suppressions")).rows[0]
          .count,
        2,
      );
    } finally {
      await reader.query("ROLLBACK");
      reader.release();
    }
  },
);

test(
  "PostgreSQL suppression writer excludes a new shared public reader until the complete page commits",
  { skip: !url },
  async () => {
    const collect = await collection();
    await collect.start(scan("synthetic-exclusive-writer"));
    let enter, release;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const writer = new CollectionStore({
      ...db,
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            async query(sql, params) {
              const result = await tx.query(sql, params);
              if (sql.startsWith("SELECT state, generation") && sql.endsWith("FOR UPDATE")) {
                enter();
                await gate;
              }
              return result;
            },
          }),
        ),
    });
    const pending = writer.step("synthetic-exclusive-writer", {
      async readPage() {
        return page([fact("SYNTHETIC_REMOVED", { state: "deleted" })]);
      },
    });
    const reader = await engine.connect();
    try {
      await Promise.race([
        entered,
        pending.then(() => {
          throw new Error("suppression page did not acquire exclusive gate");
        }),
      ]);
      await reader.query("BEGIN");
      await reader.query("SET LOCAL lock_timeout = '100ms'");
      await assert.rejects(
        reader.query(
          "SELECT repository_id FROM leaderboard_ingestion.repository_access WHERE repository_id = 2 FOR SHARE",
        ),
        { code: "55P03" },
      );
      await reader.query("ROLLBACK");
      assert.equal(
        (await db.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.object_suppressions")).rows[0]
          .count,
        0,
        "uncommitted suppression cannot leak ahead of page commit",
      );
    } finally {
      release();
      await reader.query("ROLLBACK");
      reader.release();
    }
    assert.equal(await pending, "complete");
    const result = await db.transaction(async (tx) => {
      await tx.query(
        "SELECT repository_id FROM leaderboard_ingestion.repository_access WHERE repository_id = 2 FOR SHARE",
      );
      return tx.query("SELECT subject_id FROM leaderboard_ingestion.object_suppressions WHERE repository_id = 2");
    });
    assert.deepEqual(result.rows, [{ subject_id: "SYNTHETIC_REMOVED" }]);
  },
);

const dispatchBinding = {
  configurationHash: "a".repeat(64),
  configurationVersion: "synthetic-v1",
  configurationRevision: 0,
  normalizationVersion: "issues-creation-dispatch.v1",
  policyVersion: "candidate-0.1.0",
  dataMode: "synthetic",
  cutoff: "2026-10-01T00:00:00.000Z",
};
const dispatchProof = [{ scopeKey: "synthetic-scope", snapshotId: "b".repeat(64), revision: 1 }];
async function outboxNotice(n = 1) {
  await store.insert(delivery(n));
  assert.equal(await store.complete(await store.claim()), true);
  return `github:delivery:${id(n)}`;
}
async function expireOutbox() {
  await db.query(
    "UPDATE leaderboard_ingestion.outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE state='leased'",
  );
}

test("outbox leases preserve frozen operation/cutoff across expiry and fence stale completion", async () => {
  await outboxNotice();
  const outbox = new OutboxStore(db, 3);
  const first = await outbox.claim(dispatchBinding);
  const frozen = await outbox.freeze(first, "2026-10-02T00:00:00.000Z", [{ repositoryId: 2, generation: "1" }]);
  assert.equal(await outbox.claim(dispatchBinding), null);
  await expireOutbox();
  const replacement = await outbox.claim({ ...dispatchBinding, cutoff: "2026-10-03T00:00:00.000Z" });
  assert.deepEqual(replacement.operation, first.operation);
  assert.notEqual(replacement.token, first.token);
  assert.deepEqual(
    await outbox.freeze(replacement, "2026-10-04T00:00:00.000Z", [{ repositoryId: 2, generation: "2" }]),
    frozen,
  );
  assert.equal(await outbox.complete(first, dispatchProof, async () => assert.fail("stale confirmation")), false);
  assert.equal(await outbox.fail(first, "source_unavailable"), "lease_lost");
  assert.equal(await outbox.complete(replacement, dispatchProof, async () => {}), true);
  assert.equal(await outbox.claim(dispatchBinding), null);
  assert.equal((await outbox.health()).completed, 1);
  assert.deepEqual(
    (await db.query("SELECT outcome FROM leaderboard_ingestion.outbox_attempts ORDER BY attempt")).rows.map(
      (row) => row.outcome,
    ),
    ["expired", "done"],
  );
});

test("outbox completion confirmation and receipt commit atomically", async () => {
  await outboxNotice();
  const outbox = new OutboxStore(db);
  const lease = await outbox.claim(dispatchBinding);
  await assert.rejects(
    outbox.complete(lease, dispatchProof, async () => {
      throw Error("synthetic failure");
    }),
    /synthetic failure/,
  );
  const prior = (await db.query("SELECT state,completion FROM leaderboard_ingestion.outbox")).rows[0];
  assert.equal(prior.state, "leased");
  assert.equal(prior.completion, null);
  assert.equal(await outbox.complete(lease, dispatchProof, async () => {}), true);
});

test("outbox completion and replay parsing retain maximal canonical publication scope keys", async () => {
  let deliveryNumber = 0;
  for (const { name, scopeKey } of maximalPublicationScopeCases()) {
    await outboxNotice(++deliveryNumber);
    const outbox = new OutboxStore(db);
    const lease = await outbox.claim(dispatchBinding);
    const publications = [{ scopeKey, snapshotId: "b".repeat(64), revision: 1 }];
    assert.equal(await outbox.complete(lease, publications, async () => {}), true, name);
    const completion = (
      await db.query("SELECT completion FROM leaderboard_ingestion.outbox WHERE event_key=$1", [lease.eventKey])
    ).rows[0].completion;
    assert.deepEqual(parseDispatchPublications(completion, lease.operation.operationKey), publications, name);
    assert.deepEqual(completion.publications, publications, "retain the complete canonical key without truncation");
    assert.equal(parseDispatchPublications(completion, "f".repeat(64)), null, "operation binding remains exact");
  }
});

test("publication scope-key overflow fails before database or confirmation work", async () => {
  const unavailable = new OutboxStore({
    transaction() {
      assert.fail("oversized publication must not reach the database");
    },
  });
  const publications = [{ scopeKey: "S".repeat(16_385), snapshotId: "b".repeat(64), revision: 1 }];
  await assert.rejects(
    unavailable.complete({}, publications, async () => assert.fail("oversized publication must not confirm")),
    /invalid_dispatch_publication/,
  );
  assert.equal(parseDispatchPublications({ operationKey: "a".repeat(64), publications }, "a".repeat(64)), null);
});

test("outbox retries are delayed/bounded, poison is quarantined, and reviewed replay retains identity", async () => {
  const event = await outboxNotice();
  const outbox = new OutboxStore(db, 2);
  let lease = await outbox.claim(dispatchBinding);
  const operation = lease.operation;
  assert.equal(await outbox.fail(lease, "source_unavailable"), "retry_scheduled");
  assert.equal(await outbox.claim(dispatchBinding), null);
  await db.query("UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp()");
  lease = await outbox.claim(dispatchBinding);
  assert.equal(await outbox.fail(lease, "enrichment_unavailable"), "quarantined");
  assert.equal(await outbox.claim(dispatchBinding), null);
  assert.equal(await outbox.replay(event, "synthetic-reviewed-replay"), true);
  lease = await outbox.claim(dispatchBinding);
  assert.equal(lease.attempt, 1);
  assert.deepEqual(lease.operation, operation);
  assert.equal(await outbox.fail(lease, "unsupported_observation", true), "quarantined");
  assert.equal(
    (await db.query("SELECT prior_reason_code FROM leaderboard_ingestion.outbox_replays")).rows[0].prior_reason_code,
    "enrichment_unavailable",
  );
});

test("a crashed final outbox lease quarantines and cannot remain leased indefinitely", async () => {
  await outboxNotice();
  const outbox = new OutboxStore(db, 1);
  await outbox.claim(dispatchBinding);
  await expireOutbox();
  assert.equal(await outbox.claim(dispatchBinding), null);
  assert.equal((await outbox.health()).quarantined, 1);
  assert.equal(
    (await db.query("SELECT reason_code FROM leaderboard_ingestion.outbox")).rows[0].reason_code,
    "attempts_exhausted",
  );
});

test("outbox worker awaits in-flight work and aborts idle/backoff waits without leaking exceptions", async () => {
  const controller = new AbortController();
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let finished = false;
  const running = runOutboxWorker(
    async () => {
      entered();
      await gate;
      finished = true;
      return "processed";
    },
    { signal: controller.signal },
  );
  await started;
  controller.abort();
  assert.equal(finished, false);
  release();
  await running;
  assert.equal(finished, true);
  const failureController = new AbortController();
  const statuses = [];
  await runOutboxWorker(
    async () => {
      throw Error("private source text");
    },
    {
      signal: failureController.signal,
      onStatus(status) {
        statuses.push(status);
        failureController.abort();
        throw Error("observer failure");
      },
    },
  );
  assert.deepEqual(statuses, ["store_unavailable"]);
});

test("independent PostgreSQL outbox workers claim disjoint rows with SKIP LOCKED", { skip: !url }, async () => {
  await outboxNotice(1);
  await outboxNotice(2);
  const outbox = new OutboxStore(db);
  const [first, second] = await Promise.all([outbox.claim(dispatchBinding), outbox.claim(dispatchBinding)]);
  assert.notEqual(first.eventKey, second.eventKey);
  assert.equal(await outbox.complete(first, dispatchProof, async () => {}), true);
  assert.equal(await outbox.complete(second, dispatchProof, async () => {}), true);
  assert.equal((await outbox.health()).completed, 2);
});

const expiryRequest = (operationId = "synthetic-expiry-operation") => ({
  operationId,
  repositoryId: 2,
  installationId: 1,
  completedBefore: "2026-10-02T00:00:00.000Z",
  policyVersion: "synthetic-retention-v1",
  operatorId: "SYNTHETIC_OPERATOR",
  authorizationId: "synthetic-grant",
  batchLimit: 10,
});
async function expiryNotice(n = 1) {
  await outboxNotice(n);
  const outbox = new OutboxStore(db);
  assert.equal(await outbox.complete(await outbox.claim(dispatchBinding), dispatchProof, async () => {}), true);
  await db.query(
    "UPDATE leaderboard_ingestion.attempt_history SET finished_at='2026-10-01T00:00:00Z' WHERE delivery_id=$1 AND outcome='done'",
    [id(n)],
  );
  await db.query(
    "UPDATE leaderboard_ingestion.outbox_attempts SET finished_at='2026-10-01T00:00:00Z' WHERE event_key=$1 AND outcome='done'",
    [`github:delivery:${id(n)}`],
  );
}

test("disposable fixture reset removes parent expiry operations before an operation ID is reused", async () => {
  await expiryNotice();
  const expiry = new DeliveryPayloadExpiryStore(db);
  assert.equal((await expiry.expireCompleted(expiryRequest(), async () => true)).expiredCount, 1);
  await resetStore();
  assert.equal(
    (await db.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.delivery_payload_expiry_operations"))
      .rows[0].count,
    0,
  );
  await expiryNotice();
  assert.notEqual((await db.query("SELECT envelope FROM leaderboard_ingestion.inbox")).rows[0].envelope, null);
  assert.equal((await expiry.expireCompleted(expiryRequest(), async () => true)).expiredCount, 1);
  assert.equal((await db.query("SELECT envelope FROM leaderboard_ingestion.inbox")).rows[0].envelope, null);
});

test("expiry, operation readback, replay, publication and rollback reject unsupported host isolation without changing it", async () => {
  await expiryNotice();
  const expiry = new DeliveryPayloadExpiryStore(db);
  const emptyRequest = { ...expiryRequest("synthetic-empty-operation"), installationId: 99 };
  const existing = await expiry.expireCompleted(emptyRequest, async () => true);
  assert.equal(existing.expiredCount, 0);
  const original = (
    await db.query(`SELECT intake.envelope, evidence.observation FROM leaderboard_ingestion.inbox AS intake
      JOIN leaderboard_ingestion.observations AS evidence USING (delivery_id)`)
  ).rows;
  const rollback = await readFile(new URL("../sql/006_delivery_payload_expiry.down.sql", import.meta.url), "utf8");
  for (const [isolation, setting] of [
    ["repeatable read", "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ"],
    ["serializable", "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE"],
    ["read uncommitted", "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ UNCOMMITTED"],
  ]) {
    // A one-connection pool tests postgresDatabase's inherited plain-BEGIN policy.
    // PGlite uses its real session default and resets it before the next fixture.
    const isolatedPool = url ? new Pool({ connectionString: url, max: 1 }) : null;
    const isolatedDb = isolatedPool ? postgresDatabase(isolatedPool) : db;
    try {
      await isolatedDb.query(setting);
      await isolatedDb.transaction(async (tx) => {
        assert.equal((await tx.query("SHOW transaction_isolation")).rows[0].transaction_isolation, isolation);
      });
      const unsupported = new DeliveryPayloadExpiryStore(isolatedDb);
      await assert.rejects(
        unsupported.expireCompleted(expiryRequest(), async () => true),
        /delivery_expiry_requires_read_committed/,
      );
      await assert.rejects(
        unsupported.expireCompleted(emptyRequest, async () => true),
        /delivery_expiry_requires_read_committed/,
      );
      await assert.rejects(
        new InboxStore(isolatedDb).replayObjectState(2, "SYNTHETIC_ISSUE"),
        /delivery_expiry_requires_read_committed/,
      );
      await assert.rejects(
        new SnapshotStore(isolatedDb).publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-v1", "0"),
        /delivery_expiry_requires_read_committed/,
      );
      await assert.rejects(
        isolatedDb.transaction((tx) => tx.query(rollback)),
        /delivery_expiry_requires_read_committed/,
      );
      assert.equal(
        (await isolatedDb.query("SHOW default_transaction_isolation")).rows[0].default_transaction_isolation,
        isolation,
      );
    } finally {
      await isolatedDb.query("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await isolatedPool?.end();
    }
  }
  assert.deepEqual(
    (
      await db.query(`SELECT intake.envelope, evidence.observation FROM leaderboard_ingestion.inbox AS intake
        JOIN leaderboard_ingestion.observations AS evidence USING (delivery_id)`)
    ).rows,
    original,
  );
  assert.deepEqual(await expiry.expireCompleted(emptyRequest, async () => true), existing);
  assert.deepEqual(
    (
      await db.query(`SELECT
        (SELECT count(*)::integer FROM leaderboard_ingestion.delivery_payload_expiry_operations) AS operations,
        (SELECT count(*)::integer FROM leaderboard_ingestion.delivery_payload_expiries) AS expiries,
        (SELECT count(*)::integer FROM leaderboard_ingestion.snapshots) AS snapshots,
        (SELECT count(*)::integer FROM leaderboard_ingestion.snapshot_heads) AS heads,
        (SELECT count(*)::integer FROM leaderboard_ingestion.snapshot_notices) AS notices`)
    ).rows[0],
    { operations: 1, expiries: 0, snapshots: 0, heads: 0, notices: 0 },
  );
  assert.equal((await expiry.expireCompleted(expiryRequest(), async () => true)).expiredCount, 1);
});

test(
  "PostgreSQL rejects an older repeatable-read snapshot after concurrent expiry commits",
  { skip: !url },
  async () => {
    await expiryNotice();
    const stale = await engine.connect();
    try {
      await stale.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await stale.query("SET LOCAL lock_timeout='2s'");
      // This is the availability read that previously established an old snapshot
      // before the shared replay advisory gate was acquired.
      await stale.query("SELECT state FROM leaderboard_ingestion.repository_access WHERE repository_id=2 FOR SHARE");
      const expiry = new DeliveryPayloadExpiryStore(db);
      assert.equal((await expiry.expireCompleted(expiryRequest(), async () => true)).expiredCount, 1);
      assert.notEqual(
        (await stale.query("SELECT observation FROM leaderboard_ingestion.observations")).rows[0].observation,
        null,
      );
      assert.equal(
        (await stale.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.delivery_payload_expiries"))
          .rows[0].count,
        0,
      );
      const staleDb = {
        query: (sql, params) => stale.query(sql, params),
        transaction: (work) => work(stale),
      };
      await assert.rejects(
        new InboxStore(staleDb).replayObjectState(2, "SYNTHETIC_ISSUE"),
        /delivery_expiry_requires_read_committed/,
      );
      await assert.rejects(
        new SnapshotStore(staleDb).publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-v1", "0"),
        /delivery_expiry_requires_read_committed/,
      );
      await assert.rejects(
        new DeliveryPayloadExpiryStore(staleDb).expireCompleted(expiryRequest(), async () => true),
        /delivery_expiry_requires_read_committed/,
      );
      await assert.rejects(
        stale.query(await readFile(new URL("../sql/006_delivery_payload_expiry.down.sql", import.meta.url), "utf8")),
        /delivery_expiry_requires_read_committed/,
      );
    } finally {
      await stale.query("ROLLBACK");
      stale.release();
    }
    assert.equal((await store.replayObjectState(2, "SYNTHETIC_ISSUE")).reason, "delivery_payload_expired");
    assert.deepEqual(
      (
        await db.query(`SELECT
        (SELECT count(*)::integer FROM leaderboard_ingestion.delivery_payload_expiries) AS expiries,
        (SELECT count(*)::integer FROM leaderboard_ingestion.snapshots) AS snapshots,
        (SELECT count(*)::integer FROM leaderboard_ingestion.snapshot_heads) AS heads,
        (SELECT count(*)::integer FROM leaderboard_ingestion.snapshot_notices) AS notices`)
      ).rows[0],
      { expiries: 1, snapshots: 0, heads: 0, notices: 0 },
    );
  },
);

test(
  "PostgreSQL retained replay excludes expiry until its shared evidence transaction ends",
  { skip: !url },
  async () => {
    await expiryNotice();
    const reader = await engine.connect();
    try {
      await reader.query("BEGIN");
      await reader.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('leaderboard-delivery-expiry:2',0))");
      await assert.rejects(
        new DeliveryPayloadExpiryStore(db).expireCompleted(expiryRequest(), async () => true),
        /delivery_expiry_scope_busy/,
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::integer AS count FROM leaderboard_ingestion.delivery_payload_expiry_operations",
          )
        ).rows[0].count,
        0,
      );
      assert.equal((await store.replayObjectState(2, "SYNTHETIC_ISSUE")).coverage, "retained_observations_only");
    } finally {
      await reader.query("ROLLBACK");
      reader.release();
    }
    assert.equal(
      (await new DeliveryPayloadExpiryStore(db).expireCompleted(expiryRequest(), async () => true)).expiredCount,
      1,
    );
    assert.equal((await store.replayObjectState(2, "SYNTHETIC_ISSUE")).reason, "delivery_payload_expired");
  },
);

test("PostgreSQL expiry skips a locked completed dispatch without removing its payload", { skip: !url }, async () => {
  await expiryNotice(1);
  await expiryNotice(2);
  const worker = await engine.connect();
  try {
    await worker.query("BEGIN");
    await worker.query("SELECT event_key FROM leaderboard_ingestion.outbox WHERE event_key=$1 FOR UPDATE", [
      `github:delivery:${id(1)}`,
    ]);
    const receipt = await new DeliveryPayloadExpiryStore(db).expireCompleted(expiryRequest(), async () => true);
    assert.equal(receipt.expiredCount, 1);
    assert.notEqual(
      (await db.query("SELECT envelope FROM leaderboard_ingestion.inbox WHERE delivery_id=$1", [id(1)])).rows[0]
        .envelope,
      null,
    );
    assert.equal(
      (await db.query("SELECT envelope FROM leaderboard_ingestion.inbox WHERE delivery_id=$1", [id(2)])).rows[0]
        .envelope,
      null,
    );
  } finally {
    await worker.query("ROLLBACK");
    worker.release();
  }
  assert.equal(
    (await new DeliveryPayloadExpiryStore(db).expireCompleted(expiryRequest("synthetic-followup"), async () => true))
      .expiredCount,
    1,
  );
});

test(
  "PostgreSQL waiting replay observes committed expiry, publication refuses it and an uncertain retry returns the original receipt",
  { skip: !url },
  async () => {
    await expiryNotice();
    let enter, release;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const paused = new DeliveryPayloadExpiryStore({
      ...db,
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            async query(sql, params) {
              const result = await tx.query(sql, params);
              if (sql.startsWith("UPDATE leaderboard_ingestion.inbox SET envelope=NULL")) {
                enter();
                await gate;
              }
              return result;
            },
          }),
        ),
    });
    const first = paused.expireCompleted(expiryRequest(), async () => true);
    await Promise.race([entered, first.then(() => assert.fail("expiry did not reach its payload boundary"))]);
    let retry, waitingReplay, waitingPublication;
    try {
      const boundedReader = new InboxStore({
        ...db,
        transaction: (work) =>
          db.transaction(async (tx) => {
            await tx.query("SET LOCAL lock_timeout='100ms'");
            return work(tx);
          }),
      });
      await assert.rejects(boundedReader.replayObjectState(2, "SYNTHETIC_ISSUE"), { code: "55P03" });
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.query("SET LOCAL lock_timeout='100ms'");
          await tx.query(
            await readFile(new URL("../sql/006_delivery_payload_expiry.down.sql", import.meta.url), "utf8"),
          );
        }),
        { code: "55P03" },
      );
      await assert.rejects(
        new DeliveryPayloadExpiryStore(db).expireCompleted(
          expiryRequest("synthetic-competing-operation"),
          async () => true,
        ),
        /delivery_expiry_scope_busy/,
      );
      const readerPids = [];
      const waitingDb = {
        ...db,
        transaction: (work) =>
          db.transaction(async (tx) => {
            await tx.query("SET LOCAL lock_timeout='5s'");
            readerPids.push((await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
            return work(tx);
          }),
      };
      // Both readers start and establish their READ COMMITTED snapshots before
      // expiry commits. Inspect actual waiting locks before allowing that commit.
      const outcome = (promise) =>
        promise.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      waitingReplay = outcome(new InboxStore(waitingDb).replayObjectState(2, "SYNTHETIC_ISSUE"));
      waitingPublication = outcome(
        new SnapshotStore(waitingDb).publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-v1", "0"),
      );
      const deadline = Date.now() + 4000;
      for (;;) {
        const waiting = (
          await db.query(
            "SELECT pid FROM pg_locks WHERE locktype='advisory' AND mode='ShareLock' AND NOT granted AND pid=ANY($1::integer[])",
            [readerPids],
          )
        ).rows;
        if (readerPids.length === 2 && waiting.length === 2) break;
        assert.ok(Date.now() < deadline, "both replay readers must wait at the expiry advisory gate");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      retry = new DeliveryPayloadExpiryStore(db).expireCompleted(expiryRequest(), async () => true);
    } finally {
      release();
      await Promise.allSettled([first, retry, waitingReplay, waitingPublication]);
    }
    const [receipt, readback, replay, publication] = await Promise.all([
      first,
      retry,
      waitingReplay,
      waitingPublication,
    ]);
    assert.deepEqual(readback, receipt);
    assert.equal(receipt.expiredCount, 1);
    assert.equal(replay.error, undefined);
    assert.equal(replay.value.reason, "delivery_payload_expired");
    assert.equal(replay.value.replay, null);
    assert.match(publication.error?.message ?? "", /snapshot_replay_unavailable_payload_expired/);
    assert.deepEqual(
      (
        await db.query(`SELECT
          (SELECT count(*)::integer FROM leaderboard_ingestion.snapshots) AS snapshots,
          (SELECT count(*)::integer FROM leaderboard_ingestion.snapshot_heads) AS heads,
          (SELECT count(*)::integer FROM leaderboard_ingestion.snapshot_notices) AS notices`)
      ).rows[0],
      { snapshots: 0, heads: 0, notices: 0 },
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::integer AS count FROM leaderboard_ingestion.delivery_payload_expiry_operations",
        )
      ).rows[0].count,
      1,
    );
    assert.equal((await store.replayObjectState(2, "SYNTHETIC_ISSUE")).reason, "delivery_payload_expired");
  },
);

test("a current Project subject marker is retained only for matching native snapshot identity", async () => {
  const collect = await collection();
  await collect.start(scan("synthetic-native-current", { family: "project_current" }));
  assert.equal(
    await collect.step("synthetic-native-current", {
      readPage: async () =>
        page([fact("SYNTHETIC_ISSUE", { projectSubjectId: "SYNTHETIC_ISSUE", untrustedExtra: "discard" })]),
    }),
    "complete",
  );
  const saved = (await facts())[0].document;
  assert.equal(saved.subjectId, "SYNTHETIC_ISSUE");
  assert.equal(saved.projectSubjectId, "SYNTHETIC_ISSUE");
  assert.equal(saved.untrustedExtra, undefined);
  for (const [suffix, family, changes] of [
    ["mismatch", "project_current", { projectSubjectId: "SYNTHETIC_OTHER" }],
    ["invalid", "project_current", { projectSubjectId: "not a native ID" }],
    ["history", "project_history", { projectSubjectId: "SYNTHETIC_ISSUE" }],
    ["ordinary", "issues", { projectSubjectId: "SYNTHETIC_ISSUE" }],
    ["transition", "project_current", { projectSubjectId: "SYNTHETIC_ISSUE", evidence: "observed_transition" }],
  ]) {
    const runId = "synthetic-marker-" + suffix;
    await collect.start(scan(runId, { family }));
    assert.equal(
      await collect.step(runId, { readPage: async () => page([fact("SYNTHETIC_ISSUE", changes)]) }),
      "failed",
    );
    assert.equal((await facts()).length, 1, "invalid identity is rejected before its transaction can retain any fact");
  }
});

test("native Project curation retains only its observed subject Project and event binding", async () => {
  const collect = await collection();
  const observed = fact("PVE_SYNTHETIC_CURATED", {
    historySubjectId: "PR_SYNTHETIC_CURATED",
    projectCurationProjectId: "PVT_SYNTHETIC_CURATED",
    sourceUrl: "https://github.com/synthetic-org/synthetic-repo/pull/3",
    evidence: "observed_transition",
    actorId: "202",
    occurredAt: "2026-01-02T00:00:00.000Z",
    state: "present",
    creator: { id: 999 },
    rawPrivateText: "not retained",
  });
  await collect.start(scan("synthetic-curation-valid", { family: "project_curation_history" }));
  assert.equal(
    await collect.step("synthetic-curation-valid", { readPage: async () => page([observed], null, null) }),
    "complete",
  );
  const saved = (await facts())[0].document;
  assert.equal(saved.subjectId, observed.subjectId);
  assert.equal(saved.historySubjectId, observed.historySubjectId);
  assert.equal(saved.projectCurationProjectId, observed.projectCurationProjectId);
  assert.equal(saved.occurredAt, observed.occurredAt);
  assert.equal(saved.actorId, "202");
  assert.equal(saved.creator, undefined);
  assert.equal(saved.rawPrivateText, undefined);
  for (const [suffix, family, patch] of [
    ["missing-subject", "project_curation_history", { historySubjectId: undefined }],
    ["missing-project", "project_curation_history", { projectCurationProjectId: undefined }],
    ["invalid-project", "project_curation_history", { projectCurationProjectId: "invalid project" }],
    ["no-clock", "project_curation_history", { occurredAt: null }],
    ["snapshot", "project_curation_history", { evidence: "current_state", actorId: null, occurredAt: null }],
    ["not-present", "project_curation_history", { state: "closed" }],
    [
      "wrong-route",
      "project_curation_history",
      { sourceUrl: "https://github.com/synthetic-org/synthetic-repo/commit/abc" },
    ],
    ["old-status-family", "project_history", {}],
    ["current-family", "project_current", {}],
    ["ordinary-family", "issues", {}],
  ]) {
    const runId = "synthetic-curation-" + suffix;
    await collect.start(scan(runId, { family }));
    assert.equal(
      await collect.step(runId, { readPage: async () => page([{ ...observed, ...patch }], null, null) }),
      "failed",
      suffix,
    );
    assert.equal((await facts()).length, 1, "invalid native bindings do not enter the source-fact transaction");
  }
});

test("curation admission requires full scans and unknown history counts even for empty pages", async () => {
  const collect = await collection();
  const finiteWindow = scan("synthetic-curation-finite-window", {
    family: "project_curation_history",
    since: "2026-01-01T00:00:00.000Z",
  });
  await assert.rejects(collect.start(finiteWindow), /project_curation_full_scan_required/);
  await assert.rejects(
    db.transaction((tx) => collect.startInTransaction(tx, finiteWindow)),
    /project_curation_full_scan_required/,
  );
  assert.equal(
    (await db.query("SELECT count(*)::int AS total FROM leaderboard_ingestion.collection_runs")).rows[0].total,
    0,
  );
  const observed = fact("PVE_SYNTHETIC_COUNT", {
    historySubjectId: "I_SYNTHETIC_COUNT",
    projectCurationProjectId: "PVT_SYNTHETIC_COUNT",
    evidence: "observed_transition",
    occurredAt: "2026-01-02T00:00:00.000Z",
    state: "present",
  });
  for (const [runId, items, count] of [
    ["synthetic-curation-finite-zero", [], 0],
    ["synthetic-curation-finite-count", [observed], 1],
  ]) {
    await collect.start(scan(runId, { family: "project_curation_history" }));
    assert.equal(await collect.step(runId, { readPage: async () => page(items, null, count) }), "failed");
    assert.deepEqual(await facts(), []);
  }
  await collect.start(scan("synthetic-curation-unknown-empty", { family: "project_curation_history" }));
  assert.equal(
    await collect.step("synthetic-curation-unknown-empty", { readPage: async () => page([], null, null) }),
    "complete",
  );
  const stored = (
    await db.query("SELECT expected_count FROM leaderboard_ingestion.collection_runs WHERE run_id=$1", [
      "synthetic-curation-unknown-empty",
    ])
  ).rows[0];
  assert.equal(stored.expected_count, null);
});
