import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createPipeline } from "../src/index.mjs";
import { harness, components, publicScope, ago, clock } from "./harness.mjs";

const family = "issue_field_history";
const metric = "issue_field_updates";
const slug = "synthetic-org/synthetic-repo";
const filter = components.contracts.canonicalPublicScope(publicScope);
const windowsUrl = `/api/v1/windows?${new URLSearchParams(components.contracts.publicScopeParameters(filter))}`;
const hash = (value) => createHash("sha256").update(components.metrics.stableJSON(value)).digest("hex");
const denialKind = "issue_field_scope_denial";
const denialReason = "issue_field_scope_unavailable";
// Named windows use a whole-second endpoint; source event and observation
// timestamps retain their actual precision throughout these fixtures.
const namedCutoff = () => clock().slice(0, 19) + ".000Z";

// A trusted synthetic source/normalizer seam isolates runtime privacy from the
// separately tested GraphQL reader. Collection SQL, stored normalizations,
// publication, current/pinned HTTP reads and restart use the real runtime.
async function nativeHarness(t, { eventCount = 1 } = {}) {
  const event = {
    id: "E_SYNTHETIC_FIELD_CHANGED",
    issueId: "I_SYNTHETIC_FIELD_ISSUE",
    fieldId: "IF_SYNTHETIC_PUBLIC",
    createdAt: ago(1),
    before: "synthetic-before-value",
    after: "synthetic-after-value",
  };
  const entries = Array.from({ length: eventCount }, (_, index) => {
    const selected =
      index === 0
        ? event
        : {
            ...event,
            id: `${event.id}_${index + 1}`,
            before: event.after,
            after: "synthetic-later-value",
          };
    return {
      event: selected,
      fact: {
        subjectId: selected.id,
        historySubjectId: selected.issueId,
        issueFieldId: selected.fieldId,
        sourceRevision: hash(selected),
        sourceUrl: `https://github.com/${slug}/issues/1`,
        evidence: "observed_transition",
        actorId: "101",
        occurredAt: selected.createdAt,
        state: "present",
      },
    };
  });
  const batches = [];
  let failure = null;
  let normalized = 0;
  let collected = 0;
  const h = await harness(t, {
    discoveryAuthority: true,
    configure(config) {
      config.repositories[0].families = [family];
      const policy = {
        ...config.policies[0].policy,
        metricId: metric,
        unit: components.metrics.getMetricDefinition(metric).definition.unit,
        roles: ["triager"],
        sources: ["github_graphql"],
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-native-policy" },
      ];
      config.scopes = [{ ...publicScope, period: "30d" }];
    },
    source: {
      async readPage(request) {
        assert.equal(request.family, family);
        collected++;
        return {
          repositoryId: 2,
          visibility: "public",
          facts: entries.map((entry) => structuredClone(entry.fact)),
          nextCursor: null,
          expectedCount: entries.length,
        };
      },
    },
    normalizerFactory: () => async (input) => {
      normalized++;
      assert.equal(input.family, family);
      const selected = entries.find((entry) => entry.fact.subjectId === input.fact.subjectId);
      assert.ok(selected, "only collected native events can reach normalization");
      const { event, fact } = selected;
      assert.deepEqual(input.fact, fact);
      batches.push(input.issueFieldHistoryBatch);
      if (failure) throw failure;
      return components.github.normalizeGithubObservation({
        repository: { id: 2, slug, visibility: "public" },
        proof: {
          verified: true,
          source: "github_graphql",
          revision: fact.sourceRevision,
          eventId: event.id,
          isSynthetic: true,
        },
        family: "field_change",
        action: "issue_field_changed",
        observedAt: input.observedAt,
        occurredAt: event.createdAt,
        payload: {
          issue: { id: event.issueId, url: fact.sourceUrl },
          sender: { id: "U_SYNTHETIC_FIELD_EDITOR", databaseId: 101, __typename: "User", login: "synthetic-editor" },
          change: { before: event.before, after: event.after },
        },
      });
    },
  });
  return {
    ...h,
    fact: entries[0].fact,
    batchTokens: () => batches.slice(),
    setFailure(value) {
      failure = value;
    },
    counts: () => ({ normalized, collected }),
  };
}

async function publishedBoard(runtime) {
  const response = await runtime.app.inject(windowsUrl);
  assert.equal(response.statusCode, 200, response.body);
  const windows = components.contracts.parsePublicWindows(
    response.json(),
    filter,
    components.metrics.resolveMetricWindow,
  ).windows;
  assert.equal(windows.length, 1);
  const current = `/api/v1/boards?${new URLSearchParams({
    ...components.contracts.publicScopeParameters(windows[0].scope),
    metric,
  })}`;
  const pinned = `${current}&snapshot=${windows[0].snapshotId}`;
  for (const url of [current, pinned]) {
    const board = await runtime.app.inject(url);
    assert.equal(board.statusCode, 200, board.body);
    assert.deepEqual(
      board.json().rows.map((row) => row.result.value),
      [1],
    );
  }
  return { current, pinned, snapshotId: windows[0].snapshotId };
}
async function assertClosed(runtime, links) {
  for (const url of [links.current, links.pinned, windowsUrl]) {
    const response = await runtime.app.inject(url);
    assert.notEqual(response.statusCode, 200, `${url}: ${response.body}`);
    assert.doesNotMatch(response.body, /IF_SYNTHETIC_PUBLIC|synthetic-before-value|synthetic-after-value/);
  }
}
const denials = async (h) =>
  (
    await h.db.query("SELECT operation_key,kind,document FROM leaderboard_pipeline.receipts WHERE kind=$1", [
      denialKind,
    ])
  ).rows;

test("an unchanged native transition is revalidated on a completed scan and normalization cache", async (t) => {
  const h = await nativeHarness(t);
  const cutoff = namedCutoff();
  assert.equal((await h.runtime.runOnce({ cutoff })).state, "published");
  await publishedBoard(h.runtime);
  assert.deepEqual(h.counts(), { normalized: 1, collected: 1 });
  const first = (await h.db.query("SELECT fact_key,document FROM leaderboard_ingestion.source_facts")).rows;
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].document, h.fact);
  assert.equal((await h.db.query("SELECT fact_key FROM leaderboard_pipeline.normalizations")).rows.length, 1);
  assert.equal((await h.runtime.runOnce({ cutoff })).state, "published");
  await publishedBoard(h.runtime);
  assert.deepEqual(h.counts(), { normalized: 2, collected: 1 });
  assert.deepEqual((await h.db.query("SELECT fact_key,document FROM leaderboard_ingestion.source_facts")).rows, first);
  assert.doesNotMatch(JSON.stringify(first), /synthetic-before-value|synthetic-after-value/);
  assert.deepEqual(await denials(h), []);
});

test("native normalization shares one ephemeral batch token and replaces it on the next run", async (t) => {
  const h = await nativeHarness(t, { eventCount: 2 });
  const cutoff = namedCutoff();
  // The existing fixture policy groups actor/artifact, so the engine correctly
  // publishes one unit for these two events. Both distinct native transitions
  // must still pass fresh verification before that aggregation on every run.
  assert.equal((await h.runtime.runOnce({ cutoff })).state, "published");
  await publishedBoard(h.runtime);
  assert.deepEqual(h.counts(), { normalized: 2, collected: 1 });
  assert.equal((await h.runtime.runOnce({ cutoff })).state, "published");
  await publishedBoard(h.runtime);
  assert.deepEqual(h.counts(), { normalized: 4, collected: 1 });
  const normalized = (await h.db.query("SELECT document FROM leaderboard_pipeline.normalizations")).rows.flatMap(
    (row) => row.document.facts,
  );
  assert.equal(normalized.length, 2);
  assert.equal(new Set(normalized.map((fact) => fact.id)).size, 2, "both source transitions remain distinct");
  const [first, sameFirst, second, sameSecond] = h.batchTokens();
  for (const token of [first, second]) {
    assert.equal(typeof token, "object");
    assert.notEqual(token, null);
    assert.ok(Object.isFrozen(token));
    assert.deepEqual(Reflect.ownKeys(token), []);
  }
  assert.equal(first, sameFirst, "all native events in the batch share membership verification");
  assert.equal(second, sameSecond);
  assert.notEqual(first, second, "a later run must not inherit the earlier verification cache");
  const retained = (await h.db.query("SELECT document FROM leaderboard_ingestion.source_facts")).rows;
  assert.equal(retained.length, 2);
  assert.equal(JSON.stringify(retained).includes("issueFieldHistoryBatch"), false);
});

const scopeLosses = [
  ["field visibility", () => Error("issue_field_public_scope_unverified"), false],
  ["subject identity", () => Error("issue_field_subject_identity_unverified"), false],
  ["missing event", () => Error("issue_field_event_unavailable"), false],
  ...[401, 403, 404].map((status) => [
    `HTTP ${status}`,
    () =>
      new components.github.GithubClientError(
        components.github.classifyGithubFailure({ status }),
        "synthetic-installation",
      ),
    false,
  ]),
  ["field visibility with failed controls retention", () => Error("issue_field_public_scope_unverified"), true],
];
for (const [loss, error, controlsFailure] of scopeLosses) {
  test(`confirmed native ${loss} loss closes current, pinned and restarted publications`, async (t) => {
    const h = await nativeHarness(t);
    const cutoff = namedCutoff();
    assert.equal((await h.runtime.runOnce({ cutoff })).state, "published");
    const links = await publishedBoard(h.runtime);
    assert.deepEqual(h.counts(), { normalized: 1, collected: 1 });
    const transaction = h.controlsStore.transaction.bind(h.controlsStore);
    if (controlsFailure) {
      h.controlsStore.transaction = (change, options) =>
        transaction((state) => {
          change(state);
          if (state.pipelineSourceDenials) throw Error("synthetic_native_controls_write_failure");
        }, options);
    }
    const failure = error();
    h.setFailure(failure);
    try {
      await assert.rejects(
        h.runtime.runOnce({ cutoff }),
        controlsFailure ? /synthetic_native_controls_write_failure/ : (observed) => observed === failure,
      );
    } finally {
      h.controlsStore.transaction = transaction;
    }
    assert.deepEqual(
      h.counts(),
      { normalized: 2, collected: 1 },
      "the original cached fact must reach the fresh verifier",
    );
    await assertClosed(h.runtime, links);
    const saved = await denials(h);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].operation_key, `issue-field-scope-denial:2:${hash(h.config.version)}`);
    assert.equal(saved[0].document.reason, denialReason);
    assert.equal(saved[0].document.configurationVersion, h.config.version);
    assert.equal(
      (await h.db.query("SELECT state FROM leaderboard_ingestion.repository_access WHERE repository_id=2")).rows[0]
        .state,
      "unavailable",
    );
    if (controlsFailure) assert.equal(h.controlsStore.read().pipelineSourceDenials, undefined);
    else assert.equal(h.controlsStore.read().pipelineSourceDenials[2].reason, denialReason);
    assert.equal(JSON.stringify(h.controlsStore.publicSnapshot()).includes("pipelineSourceDenials"), false);
    assert.equal(
      (await h.db.query("SELECT 1 FROM leaderboard_pipeline.receipts WHERE kind='project_scope_denial'")).rows.length,
      0,
    );

    // Merely restoring a public source does not approve a previously denied
    // publication or configuration. The SQL receipt survives a real DB reopen.
    h.setFailure(null);
    await assert.rejects(h.runtime.runOnce({ cutoff }), /issue_field_source_scope_requires_reapproval/);
    await h.runtime.stop();
    await h.reopenDatabase();
    const restarted = await createPipeline(h.options);
    t.after(() => restarted.stop());
    await assert.rejects(restarted.runOnce({ cutoff }), /issue_field_source_scope_requires_reapproval/);
    await assertClosed(restarted, links);
    assert.deepEqual(h.counts(), { normalized: 2, collected: 1 });

    const approvedConfig = { ...h.config, version: h.config.version + "-reapproved" };
    h.discoveryAuthority.approve(approvedConfig);
    const recovered = await createPipeline({ ...h.options, config: approvedConfig });
    t.after(() => recovered.stop());
    assert.notEqual((await recovered.app.inject(links.pinned)).statusCode, 200);
    assert.equal((await recovered.runOnce({ cutoff })).state, "published");
    const replacement = await publishedBoard(recovered);
    assert.notEqual(replacement.snapshotId, links.snapshotId);
    assert.notEqual((await recovered.app.inject(links.pinned)).statusCode, 200);
    assert.equal((await denials(h)).length, 1, "reapproval preserves the original denial receipt");
  });
}

test("native transient, rate and schema failures do not create a permanent privacy denial", async (t) => {
  const h = await nativeHarness(t);
  const cutoff = namedCutoff();
  assert.equal((await h.runtime.runOnce({ cutoff })).state, "published");
  await publishedBoard(h.runtime);
  const rateLimited = components.github.classifyGithubFailure({
    status: 403,
    headers: new Headers({ "retry-after": "60" }),
  });
  assert.equal(rateLimited.kind, "rate_limited", "an HTTP 403 retry response is not a permission verdict");
  for (const outcome of [
    components.github.classifyGithubFailure({ status: 503 }),
    rateLimited,
    { kind: "invalid_response" },
  ]) {
    h.setFailure(new components.github.GithubClientError(outcome, "synthetic-installation"));
    await assert.rejects(h.runtime.runOnce({ cutoff }));
    assert.deepEqual(await denials(h), []);
    assert.equal(h.controlsStore.read().pipelineSourceDenials, undefined);
    h.setFailure(null);
    assert.equal((await h.runtime.runOnce({ cutoff })).state, "published");
    await publishedBoard(h.runtime);
  }
  assert.deepEqual(h.counts(), { normalized: 7, collected: 1 });
});

test("final discovery admission observes a new native SQL denial after captured window reads", async (t) => {
  const h = await nativeHarness(t);
  assert.equal((await h.runtime.runOnce()).state, "published");
  await publishedBoard(h.runtime);
  const transaction = h.db.transaction.bind(h.db);
  let captured = 0;
  let injected = 0;
  h.db.transaction = (work) =>
    transaction((tx) =>
      work({
        query: async (sql, params) => {
          if (sql.includes("SELECT selected.document")) captured++;
          if (sql.includes("UNION ALL SELECT 'denial'")) {
            assert.ok(captured > 0, "the denial must follow the captured authorized window read");
            injected++;
            const operationKey = `issue-field-scope-denial:2:${hash(h.config.version)}`;
            const document = {
              repositoryId: 2,
              configurationVersion: h.config.version,
              reason: denialReason,
              checkedAt: clock(),
            };
            // Model a newly visible receipt before final SQL admission without
            // changing runtime memory or controls. This deterministic hook writes
            // through the test's transaction; it does not run a second publisher.
            await tx.query(
              `INSERT INTO leaderboard_pipeline.receipts (receipt_id,operation_key,kind,document,document_hash,operation_hash)
           VALUES ($1,$2,$3,$4::jsonb,$5,pg_catalog.sha256(pg_catalog.convert_to($2,'UTF8')))`,
              [hash([operationKey, denialKind]), operationKey, denialKind, JSON.stringify(document), hash(document)],
            );
          }
          return tx.query(sql, params);
        },
      }),
    );
  let response;
  try {
    response = await h.runtime.app.inject(windowsUrl);
  } finally {
    h.db.transaction = transaction;
  }
  assert.equal(injected, 1);
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.json().windows, undefined);
  assert.equal(h.controlsStore.read().pipelineSourceDenials, undefined);
  assert.equal(
    (await h.db.query("SELECT state FROM leaderboard_ingestion.repository_access WHERE repository_id=2")).rows[0].state,
    "public",
  );
  assert.equal((await denials(h)).length, 1);
});
