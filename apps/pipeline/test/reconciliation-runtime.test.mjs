import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPipeline } from "../src/index.mjs";
import { harness, components, clock, ago, getBoard } from "./harness.mjs";
import { insertOperatorDelivery, operatorAllow, operatorSettings } from "./operator-harness.mjs";

const day = 86400000;
const policy = { lookbackMs: 7 * day, overlapMs: day, fullAuditsPerCycle: 1 };
const configure =
  (families = ["issues"]) =>
  (config) => {
    config.reconciliation = { ...policy };
    config.repositories[0].families = [...families];
  };
const digest = (value) => createHash("sha256").update(components.metrics.stableJSON(value)).digest("hex");
const iso = (value) => new Date(value).toISOString();
const pending = async (h) => (await h.db.query("SELECT * FROM leaderboard_pipeline.scan_continuations")).rows;
const runs = async (h) =>
  (await h.db.query("SELECT * FROM leaderboard_ingestion.collection_runs ORDER BY run_id")).rows;
const frozen = async (h, snapshotId) =>
  (await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [snapshotId]))
    .rows[0].document.frozen;
const planIdentity = (row) => ({
  runId: row.run_id,
  repositoryId: Number(row.repository_id),
  family: row.family,
  mode: row.mode,
  since: row.since_at === null ? null : iso(row.since_at),
  until: iso(row.until_at),
  generation: String(row.access_generation),
});
const scheduledIdentity = (runId) => {
  const match = /^rc1:([a-f0-9]{64}):([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}):(\d{4}):(\d{4})$/.exec(runId);
  assert.ok(match, "scheduled collection must retain its versioned context, token and plan position");
  return { context: match[1], token: match[2], ordinal: Number(match[3]), total: Number(match[4]) };
};

function issue(number, overrides = {}) {
  return {
    id: 1000 + number,
    node_id: `SYNTHETIC_ISSUE_${number}`,
    number,
    html_url: `https://github.com/synthetic-org/synthetic-repo/issues/${number}`,
    created_at: ago(2),
    updated_at: ago(1),
    user: { id: 100 + number, node_id: `U_SYNTHETIC_${number}`, login: `synthetic-${number}`, type: "User" },
    ...overrides,
  };
}

function paginatedSource() {
  const payloads = [issue(1), issue(2)];
  const requests = [];
  return {
    payloads,
    requests,
    source: {
      async readPage(request) {
        requests.push(structuredClone(request));
        if (request.family !== "issues")
          return { repositoryId: 2, visibility: "public", nextCursor: null, expectedCount: 0, facts: [] };
        assert.ok(request.cursor === null || request.cursor === "page-2");
        const payload = payloads[request.cursor === null ? 0 : 1];
        return {
          repositoryId: 2,
          visibility: "public",
          nextCursor: request.cursor === null ? "page-2" : null,
          expectedCount: 2,
          facts: [
            {
              subjectId: payload.node_id,
              sourceRevision: payload.updated_at,
              sourceUrl: payload.html_url,
              evidence: "current_state",
              actorId: null,
              occurredAt: null,
              state: "open",
            },
          ],
        };
      },
    },
  };
}

async function health(h) {
  const response = await h.runtime.app.inject("/api/v1/health");
  assert.equal(response.statusCode, 200, response.body);
  return {
    publicCollection: response.json().sources[0].currentCollection,
    privateCollector: (await h.runtime.operations.readHealth(2, operatorAllow)).collector,
  };
}

test("scheduled default GitHub collection recovers omitted webhooks without inventing actors or action times", async (t) => {
  const h = await harness(t, {
    source: undefined,
    probeRepository: undefined,
    payloads: [],
    configure: configure(),
  });
  const initial = await h.runtime.runOnce();
  assert.equal(initial.state, "published");
  assert.deepEqual((await getBoard(h.runtime)).rows, []);
  const known = issue(1, { created_at: ago(0.5), updated_at: clock() });
  const unknown = issue(2, { created_at: null, user: null, updated_at: clock() });
  h.add(known);
  h.add(unknown);
  const recovered = await h.runtime.runOnce();
  assert.equal(recovered.state, "published");
  assert.notEqual(recovered.publications[0].snapshotId, initial.publications[0].snapshotId);
  const observations = (
    await h.db.query("SELECT subject_id,document FROM leaderboard_ingestion.source_facts ORDER BY subject_id")
  ).rows;
  assert.deepEqual(
    observations.map((row) => row.subject_id),
    [known.node_id, unknown.node_id],
  );
  for (const { document } of observations) {
    assert.equal(document.evidence, "current_state");
    assert.equal(document.actorId, null);
    assert.equal(document.occurredAt, null);
  }
  const retained = await frozen(h, recovered.publications[0].snapshotId);
  const knownFact = retained.facts.find(
    (fact) => fact.metricId === "issues_opened" && fact.artifactId === known.node_id,
  );
  const unknownFact = retained.facts.find(
    (fact) => fact.metricId === "issues_opened" && fact.artifactId === unknown.node_id,
  );
  assert.ok(knownFact);
  assert.equal(knownFact.actorId, "101");
  assert.equal(knownFact.occurredAt, known.created_at);
  assert.equal(knownFact.state, "observed");
  assert.ok(unknownFact);
  assert.equal(unknownFact.actorId, null);
  assert.equal(unknownFact.occurredAt, null);
  assert.equal(unknownFact.state, "unknown");
  assert.ok(retained.facts.every((fact) => fact.metricId !== "issue_closure_stewardship"));
  assert.deepEqual(
    (await getBoard(h.runtime)).rows.map((row) => [row.actorId, row.result.value]),
    [["101", 1]],
  );
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.inbox")).rows[0].n, 0);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.outbox")).rows[0].n, 0);
  assert.ok(recovered.progress.every((row) => scheduledIdentity(row.runId).total === 1));
  assert.ok(retained.coverage.every((row) => row.state === "partial" && row.knownStart === null));
});

test("the entire bounded plan and page cursor survive database and runtime reopen with their original identities", async (t) => {
  const fixture = paginatedSource();
  const h = await harness(t, { ...fixture, configure: configure(["issues", "relationships"]) });
  const first = await h.runtime.runOnce({ maxPages: 1 });
  assert.equal(first.state, "collecting");
  const [saved] = await pending(h);
  const originalRows = await runs(h);
  const originalPlan = originalRows.map(planIdentity);
  assert.equal(originalPlan.length, 2, "all family requests must exist before the first bounded page returns");
  assert.deepEqual(
    originalPlan.map((row) => [row.family, row.mode]),
    [
      ["issues", "audit"],
      ["relationships", "reconcile"],
    ],
  );
  assert.equal(originalPlan[0].since, null);
  assert.equal(originalPlan[1].since, new Date(Date.parse(originalPlan[1].until) - policy.lookbackMs).toISOString());
  assert.ok(originalPlan.every((row) => row.until === iso(saved.event_cutoff)));
  originalPlan.forEach((row, index) =>
    assert.deepEqual(scheduledIdentity(row.runId), {
      context: scheduledIdentity(originalPlan[0].runId).context,
      token: saved.cycle_token,
      ordinal: index,
      total: 2,
    }),
  );
  assert.equal(originalRows[0].cursor, "page-2");
  assert.equal(originalRows[1].page_count, 0);
  assert.equal(saved.observation_cutoff, null);
  const firstPage = (await h.db.query("SELECT * FROM leaderboard_ingestion.collection_pages")).rows;
  assert.equal(firstPage.length, 1);
  await h.runtime.stop();
  await h.reopenDatabase();
  h.controlsStore.transaction(() => {});
  assert.deepEqual(await pending(h), [saved]);
  const resumed = await createPipeline(h.options);
  try {
    const complete = await resumed.runOnce({ maxPages: 1 });
    assert.equal(complete.state, "published");
    assert.deepEqual((await runs(h)).map(planIdentity), originalPlan);
    assert.deepEqual(
      fixture.requests.map((row) => [row.family, row.cursor]),
      [
        ["issues", null],
        ["issues", "page-2"],
        ["relationships", null],
      ],
    );
    for (const request of fixture.requests) {
      const expected = originalPlan.find((row) => row.runId === request.runId);
      assert.ok(expected);
      assert.equal(request.since, expected.since);
      assert.equal(request.until, expected.until);
    }
    assert.deepEqual(
      (
        await h.db.query("SELECT * FROM leaderboard_ingestion.collection_pages WHERE run_id=$1 AND page_number=1", [
          originalPlan[0].runId,
        ])
      ).rows,
      firstPage,
    );
    assert.ok((await runs(h)).every((row) => row.state === "complete" && row.cursor === null));
    assert.deepEqual(await pending(h), []);
    const retained = await frozen(h, complete.publications[0].snapshotId);
    assert.ok(retained.cutoff >= iso(saved.event_cutoff));
    assert.ok(
      retained.coverage.every((row) => row.sourceWatermark === null),
      "a recent relationship window is not a full baseline",
    );
  } finally {
    await resumed.stop();
  }
});

test("unknown-count full traversals rotate across all families while public, private and frozen coverage stay conservative", async (t) => {
  const requests = [];
  const families = ["reviews", "pull_requests", "commits"];
  const h = await harness(t, {
    configure: configure(families),
    operatorDiagnostics: operatorSettings(),
    source: {
      async readPage(request) {
        requests.push(structuredClone(request));
        return { repositoryId: 2, visibility: "public", nextCursor: null, expectedCount: null, facts: [] };
      },
    },
  });
  const publications = [];
  for (let cycle = 0; cycle < families.length; cycle++) {
    const result = await h.runtime.runOnce({ maxPages: 1 });
    assert.equal(result.state, "published");
    assert.equal(result.progress.length, 1);
    publications.push(result.publications[0].snapshotId);
  }
  assert.deepEqual(
    requests.map((request) => request.family),
    ["commits", "pull_requests", "reviews"],
  );
  assert.equal(new Set(requests.map((request) => scheduledIdentity(request.runId).token)).size, 3);
  assert.ok(requests.every((request) => request.mode === "audit" && request.since === null));
  const completed = await runs(h);
  assert.equal(completed.length, 3);
  assert.ok(completed.every((row) => row.state === "complete" && row.expected_count === null && row.page_count === 1));
  for (const snapshotId of publications) {
    const coverage = (await frozen(h, snapshotId)).coverage[0];
    assert.equal(coverage.state, "partial");
    assert.equal(coverage.knownStart, null);
    assert.equal(coverage.sourceWatermark, null);
    assert.ok(coverage.sourceErrors.includes("reconciliation_baseline_unavailable"));
    assert.ok(coverage.sourceErrors.includes("reconciliation_count_unknown"));
  }
  const { publicCollection, privateCollector } = await health(h);
  assert.equal(publicCollection.state, "unknown");
  assert.equal(publicCollection.reconciledThrough, null);
  assert.equal(publicCollection.lastSuccessfulSync, completed.map((row) => iso(row.last_success_at)).sort()[0]);
  assert.equal(publicCollection.webhookState, "unknown");
  assert.equal(privateCollector.state, "unknown");
  assert.equal(privateCollector.families.length, 3);
  assert.ok(
    privateCollector.families.every(
      (row) => row.expectedItems === null && row.reconciledThrough === null && row.lastSuccessAt !== null,
    ),
  );
  assert.deepEqual(await pending(h), []);
});

test("a completed recent window cannot replace a missing full baseline and the next exact audit can establish it", async (t) => {
  const requests = [];
  const h = await harness(t, {
    configure: configure(["issues", "relationships"]),
    operatorDiagnostics: operatorSettings(),
    source: {
      async readPage(request) {
        requests.push(structuredClone(request));
        return { repositoryId: 2, visibility: "public", nextCursor: null, expectedCount: 0, facts: [] };
      },
    },
  });
  const first = await h.runtime.runOnce();
  assert.equal(first.state, "published");
  const prior = await frozen(h, first.publications[0].snapshotId);
  assert.equal(prior.coverage[0].sourceWatermark, null);
  assert.ok(prior.coverage[0].sourceErrors.includes("reconciliation_baseline_unavailable"));
  assert.ok(!prior.coverage[0].sourceErrors.includes("reconciliation_count_unknown"));
  let current = await health(h);
  assert.equal(current.publicCollection.state, "unknown");
  assert.equal(current.publicCollection.reconciledThrough, null);
  assert.ok(current.publicCollection.lastSuccessfulSync !== null);
  assert.equal(current.privateCollector.families.find((row) => row.family === "relationships").reconciledThrough, null);
  const second = await h.runtime.runOnce();
  assert.equal(second.state, "published");
  assert.deepEqual(
    requests.map((request) => [request.family, request.mode]),
    [
      ["issues", "audit"],
      ["relationships", "reconcile"],
      ["relationships", "audit"],
      ["issues", "reconcile"],
    ],
  );
  assert.equal(requests[3].since, new Date(Date.parse(requests[0].until) - policy.overlapMs).toISOString());
  const established = await frozen(h, second.publications[0].snapshotId);
  assert.equal(established.coverage[0].sourceWatermark, requests[2].until);
  assert.equal(established.coverage[0].state, "partial");
  assert.equal(established.coverage[0].knownStart, null);
  assert.deepEqual(established.coverage[0].sourceErrors, ["historical_capability_not_certified"]);
  current = await health(h);
  assert.equal(current.publicCollection.state, "no_activity_in_window");
  assert.equal(current.publicCollection.reconciledThrough, requests[2].until);
  assert.equal(current.privateCollector.state, "quiet");
  assert.ok(current.privateCollector.families.every((row) => row.reconciledThrough === requests[2].until));
  assert.deepEqual(
    await frozen(h, first.publications[0].snapshotId),
    prior,
    "later progress cannot rewrite retained coverage",
  );
});

for (const kind of ["legacy implicit", "explicit cutoff", "explicit audit mode"])
  test(`${kind} retains its original collection identity and continuation path`, async (t) => {
    const fixture = paginatedSource();
    const h = await harness(t, { ...fixture, ...(kind === "legacy implicit" ? {} : { configure: configure() }) });
    const options = {
      maxPages: 1,
      ...(kind === "explicit cutoff" ? { cutoff: clock() } : {}),
      ...(kind === "explicit audit mode" ? { mode: "audit" } : {}),
    };
    assert.equal((await h.runtime.runOnce(options)).state, "collecting");
    const row = (await runs(h))[0];
    const saved = await pending(h);
    const request = fixture.requests[0];
    assert.equal(saved.length, kind === "explicit cutoff" ? 0 : 1);
    const expected = digest([
      h.config.version,
      2,
      "issues",
      request.until,
      options.mode ?? "reconcile",
      "synthetic",
      ...(saved.length ? [saved[0].cycle_token] : []),
    ]);
    assert.equal(row.run_id, expected);
    assert.match(row.run_id, /^[a-f0-9]{64}$/);
    assert.equal(row.since_at, null);
    assert.equal(row.mode, options.mode ?? "reconcile");
    assert.equal((await h.runtime.runOnce(options)).state, "published");
    assert.deepEqual(
      fixture.requests.map((item) => [item.runId, item.cursor]),
      [
        [expected, null],
        [expected, "page-2"],
      ],
    );
    assert.equal((await runs(h)).length, 1);
    assert.deepEqual(await pending(h), []);
  });

test("webhook dispatch retains its explicit operation-bound collection rather than starting a scheduled plan", async (t) => {
  const h = await harness(t, {
    source: undefined,
    probeRepository: undefined,
    webhookDispatch: true,
    configure: configure(),
  });
  await insertOperatorDelivery(h, 640);
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  const [outbox] = (
    await h.db.query("SELECT operation,collection_revision,state,completion FROM leaderboard_ingestion.outbox")
  ).rows;
  assert.equal(outbox.state, "done");
  assert.ok(outbox.completion);
  const [row] = await runs(h);
  assert.equal(
    row.run_id,
    digest([
      h.config.version,
      2,
      "issues",
      outbox.operation.cutoff,
      "reconcile",
      "synthetic",
      outbox.operation.operationKey,
      outbox.collection_revision,
    ]),
  );
  assert.equal(row.since_at, null);
  assert.match(row.run_id, /^[a-f0-9]{64}$/);
  assert.deepEqual(await pending(h), []);
  assert.equal(await h.runtime.dispatchOnce(), "idle");
  assert.equal((await runs(h)).length, 1);
});

test("revoked approval performs no resumed read and a new controls revision replaces the old scheduled authority", async (t) => {
  const fixture = paginatedSource();
  let approved = true;
  const h = await harness(t, { ...fixture, configure: configure(), verifyConfiguration: async () => approved });
  h.controlsStore.transaction((state) => {
    state.configuration = { revision: 0, active: null };
  });
  assert.equal((await h.runtime.runOnce({ maxPages: 1 })).state, "collecting");
  const original = (await pending(h))[0];
  const originalRow = (await runs(h))[0];
  const reads = { ...h.githubReads };
  approved = false;
  assert.deepEqual(await h.runtime.runOnce({ maxPages: 1 }), {
    state: "blocked",
    reason: "approved_configuration_required",
  });
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(h.githubReads, reads);
  assert.deepEqual(await pending(h), [original]);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
  h.controlsStore.transaction((state) => {
    state.configuration.revision++;
  });
  approved = true;
  assert.equal((await h.runtime.runOnce({ maxPages: 1 })).state, "collecting");
  const [replacement] = await pending(h);
  assert.equal(replacement.configuration_key, original.configuration_key);
  assert.notEqual(replacement.cycle_token, original.cycle_token);
  assert.notEqual(replacement.context_hash, original.context_hash);
  assert.notEqual(
    scheduledIdentity(fixture.requests[1].runId).context,
    scheduledIdentity(fixture.requests[0].runId).context,
  );
  assert.equal((await h.runtime.runOnce({ maxPages: 1 })).state, "published");
  assert.deepEqual(
    fixture.requests.map((request) => request.cursor),
    [null, null, "page-2"],
  );
  assert.deepEqual(
    (await runs(h)).find((row) => row.run_id === originalRow.run_id),
    originalRow,
  );
  assert.deepEqual(await pending(h), []);
});

test("a changed public-source generation fences the old scheduled plan and cannot reuse its cursor or baseline", async (t) => {
  const fixture = paginatedSource();
  const h = await harness(t, { ...fixture, configure: configure() });
  assert.equal((await h.runtime.runOnce({ maxPages: 1 })).state, "collecting");
  const [original] = await pending(h);
  const [originalRow] = await runs(h);
  h.setPrivate(true);
  await assert.rejects(h.runtime.runOnce({ maxPages: 1 }), /public_source_not_verified/);
  assert.equal(fixture.requests.length, 1);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
  h.setPrivate(false);
  assert.equal((await h.runtime.runOnce({ maxPages: 1 })).state, "collecting");
  const [replacement] = await pending(h);
  const replacementRow = (await runs(h)).find((row) => row.run_id === fixture.requests[1].runId);
  assert.notEqual(replacement.cycle_token, original.cycle_token);
  assert.notEqual(replacement.context_hash, original.context_hash);
  assert.notEqual(String(replacementRow.access_generation), String(originalRow.access_generation));
  assert.equal(replacementRow.since_at, null, "an earlier generation does not establish a new generation's baseline");
  assert.equal((await h.runtime.runOnce({ maxPages: 1 })).state, "published");
  assert.deepEqual(
    fixture.requests.map((request) => request.cursor),
    [null, null, "page-2"],
  );
  assert.deepEqual(
    (await runs(h)).find((row) => row.run_id === originalRow.run_id),
    originalRow,
  );
  assert.deepEqual(await pending(h), []);
});

for (const mode of ["reconcile", "audit", "backfill"])
  test(`opted-in explicit ${mode} cannot publish normalized evidence after its captured source generation changes`, async (t) => {
    let changed = false;
    let generations;
    const h = await harness(t, {
      payloads: [issue(1)],
      configure: configure(),
      normalizerFactory(options) {
        const normalize = components.github.createGithubEvidenceNormalizer({
          client: options.githubClient,
          source: options.sourceId,
          allowedRepositoryIds: [2],
          isSynthetic: true,
        });
        return async (input) => {
          const result = await normalize(input);
          if (!changed) {
            changed = true;
            const before = (
              await options.db.query(
                "SELECT generation,state FROM leaderboard_ingestion.repository_access WHERE repository_id=2",
              )
            ).rows[0];
            const after = (
              await options.db.query(
                "UPDATE leaderboard_ingestion.repository_access SET generation=generation+1 WHERE repository_id=2 RETURNING generation,state",
              )
            ).rows[0];
            generations = [before, after];
          }
          return result;
        };
      },
    });
    const outcome = await h.runtime.runOnce({ cutoff: clock(), mode }).then(
      (result) => ({ state: result.state }),
      (error) => ({ error: error.message }),
    );
    assert.equal(changed, true, "the actual awaited normalizer must cross the source-generation boundary");
    assert.equal(generations[0].state, "public");
    assert.equal(generations[1].state, "public");
    assert.equal(BigInt(generations[1].generation), BigInt(generations[0].generation) + 1n);
    assert.deepEqual(outcome, { error: "source_revoked_before_publication" });
    for (const table of ["heads", "snapshots", "frozen_inputs"])
      assert.equal((await h.db.query(`SELECT count(*)::int AS n FROM leaderboard_pipeline.${table}`)).rows[0].n, 0);
    assert.equal(Object.keys(h.controlsStore.read().pipelinePublications ?? {}).length, 0);
    assert.deepEqual(await pending(h), [], "explicit work never acquires a scheduled token");
  });
