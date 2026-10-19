import test from "node:test";
import assert from "node:assert/strict";
import { createPipeline } from "../src/index.mjs";
import { runWorker } from "../../worker/dist/runner.js";
import { harness, clock, ago, components, publicScope } from "./harness.mjs";
import { hash, projects } from "./scope-storage-harness.mjs";

const normalizerFor = (options) =>
  components.github.createGithubEvidenceNormalizer({
    client: options.githubClient,
    source: options.sourceId,
    allowedRepositoryIds: [2],
    isSynthetic: true,
  });
const controlledClock = () => {
  let milliseconds = Date.now() + 60_000;
  const now = () => new Date(milliseconds).toISOString();
  return {
    now,
    advance() {
      milliseconds += 60_000;
    },
    probeRepository: async (repo) => ({
      repositoryId: repo.id,
      installationId: repo.installationId,
      visibility: "public",
      checkedAt: now(),
    }),
  };
};
const pendingScans = async (h) => (await h.db.query("SELECT * FROM leaderboard_pipeline.scan_continuations")).rows;

function paginatedSource() {
  const payloads = [1, 2].map((number) => ({
    id: 1000 + number,
    node_id: `SYNTHETIC_ISSUE_${number}`,
    number,
    html_url: `https://github.com/synthetic-org/synthetic-repo/issues/${number}`,
    created_at: ago(2),
    updated_at: ago(1),
    user: { id: 100 + number, node_id: `U_SYNTHETIC_${number}`, login: `synthetic-${number}`, type: "User" },
  }));
  const requests = [];
  return {
    payloads,
    requests,
    source: {
      async readPage(request) {
        requests.push({ runId: request.runId, cutoff: request.until, cursor: request.cursor });
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

test("explicit fixed cutoff retains its original bounded collection behavior", async (t) => {
  const fixture = paginatedSource();
  const h = await harness(t, fixture);
  const cutoff = clock();
  assert.equal((await h.runtime.runOnce({ cutoff, maxPages: 1 })).state, "collecting");
  assert.equal((await h.runtime.runOnce({ cutoff, maxPages: 1 })).state, "published");
  assert.deepEqual(
    fixture.requests.map((r) => r.cursor),
    [null, "page-2"],
  );
  assert.equal(new Set(fixture.requests.map((r) => r.runId)).size, 1);
  assert.ok(fixture.requests.every((r) => r.cutoff === cutoff));
});

test("actual continuous worker completes a bounded scan while the wall clock advances", async (t) => {
  const fixture = paginatedSource();
  const h = await harness(t, fixture);
  const controller = new AbortController();
  const results = [];
  const lifecycle = [];
  const host = {
    authorize: async () => true,
    open: async () => ({
      runtime: {
        async runOnce(options) {
          const result = await h.runtime.runOnce(options);
          results.push(result);
          if (results.length === 2) controller.abort();
          return result;
        },
        async stop() {
          await h.runtime.stop();
          lifecycle.push("drained");
        },
      },
      async close() {
        lifecycle.push("closed");
      },
    }),
  };
  assert.equal(await runWorker(host, { maxPages: 1, intervalMs: 1000, signal: controller.signal }), "stopped");
  assert.deepEqual(
    results.map((r) => r.state),
    ["collecting", "published"],
  );
  assert.deepEqual(
    fixture.requests.map((r) => r.cursor),
    [null, "page-2"],
  );
  assert.equal(new Set(fixture.requests.map((r) => r.runId)).size, 1);
  assert.equal(new Set(fixture.requests.map((r) => r.cutoff)).size, 1);
  assert.equal(results[1].publications.length, 1);
  assert.deepEqual(lifecycle, ["drained", "closed"]);
});

test("implicit scan resumes after database and runtime reopen despite unrelated controls revisions", async (t) => {
  const fixture = paginatedSource();
  let offset = 0;
  const now = () => new Date(Date.now() + offset).toISOString();
  const h = await harness(t, {
    ...fixture,
    now,
    probeRepository: async (repo) => ({
      repositoryId: repo.id,
      installationId: repo.installationId,
      visibility: "public",
      checkedAt: now(),
    }),
  });
  assert.equal((await h.runtime.runOnce({ maxPages: 1 })).state, "collecting");
  const cutoff = fixture.requests[0].cutoff;
  await h.runtime.stop();
  await h.reopenDatabase();
  offset = 60000;
  h.controlsStore.transaction(() => {});
  const resumed = await createPipeline(h.options);
  try {
    assert.equal((await resumed.runOnce({ maxPages: 1 })).state, "published");
    assert.deepEqual(
      fixture.requests.map((r) => r.cursor),
      [null, "page-2"],
    );
    assert.ok(fixture.requests.every((r) => r.cutoff === cutoff));
    assert.equal(new Set(fixture.requests.map((r) => r.runId)).size, 1);
  } finally {
    await resumed.stop();
  }
});

test("last-page failure before publication preserves separate event and observation cutoffs through restart", async (t) => {
  const fixture = paginatedSource();
  const time = controlledClock();
  let failOnce = true;
  const page = fixture.source.readPage;
  fixture.source.readPage = async (request) => {
    const result = await page(request);
    if (result.nextCursor === null) time.advance();
    return result;
  };
  const h = await harness(t, {
    ...fixture,
    ...time,
    normalizerFactory(options) {
      const normalize = normalizerFor(options);
      return async (input) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("synthetic_normalization_interrupted");
        }
        return normalize(input);
      };
    },
  });
  const eventCutoff = time.now();
  await assert.rejects(h.runtime.runOnce({ maxPages: 2 }), /synthetic_normalization_interrupted/);
  const observationCutoff = time.now();
  assert.ok(observationCutoff > eventCutoff);
  assert.equal((await h.db.query("SELECT state FROM leaderboard_ingestion.collection_runs")).rows[0].state, "complete");
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
  await h.runtime.stop();
  await h.reopenDatabase();
  time.advance();
  const resumed = await createPipeline(h.options);
  try {
    const result = await resumed.runOnce({ maxPages: 1 });
    assert.equal(result.state, "published");
    assert.equal(fixture.requests.length, 2, "completed pages must not be fetched again after restart");
    const retained = (await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs")).rows[0].document;
    assert.equal(retained.frozen.cutoff, observationCutoff);
    assert.equal(retained.frozen.coverage[0].sourceWatermark, eventCutoff);
    assert.equal(retained.frozen.coverage[0].state, "partial");
    assert.deepEqual(await pendingScans(h), []);
  } finally {
    await resumed.stop();
  }
});

for (const scopeCount of [1, 2])
  test(`private confirmation failure after ${scopeCount} SQL scope publications resumes without another scan or snapshot`, async (t) => {
    const fixture = paginatedSource();
    const time = controlledClock();
    const h = await harness(t, {
      ...fixture,
      ...time,
      configure(config) {
        if (scopeCount === 2) config.scopes.push({ ...config.scopes[0], repository: "2" });
      },
    });
    let failOnce = true;
    const transaction = h.controlsStore.transaction.bind(h.controlsStore);
    h.controlsStore.transaction = (work) =>
      transaction((state) => {
        const result = work(state);
        if (failOnce && Object.keys(state.pipelinePublications ?? {}).length === scopeCount) {
          failOnce = false;
          throw new Error("synthetic_private_confirmation_interrupted");
        }
        return result;
      });
    await assert.rejects(h.runtime.runOnce({ maxPages: 2 }), /synthetic_private_confirmation_interrupted/);
    const committed = (await h.db.query("SELECT snapshot_id,revision FROM leaderboard_pipeline.heads")).rows;
    assert.equal(committed.length, scopeCount, "the SQL commits must precede the injected private-store failure");
    assert.equal(Object.keys(h.controlsStore.read().pipelinePublications ?? {}).length, scopeCount - 1);
    await h.runtime.stop();
    await h.reopenDatabase();
    time.advance();
    const resumed = await createPipeline(h.options);
    try {
      const result = await resumed.runOnce({ maxPages: 1 });
      assert.equal(result.state, "published");
      const retainedIds = committed.map((row) => row.snapshot_id).sort();
      assert.deepEqual(result.publications.map((item) => item.snapshotId).sort(), retainedIds);
      assert.ok(result.publications.every((item) => item.changed === false));
      assert.equal(fixture.requests.length, 2);
      assert.equal(
        (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n,
        scopeCount,
      );
      assert.deepEqual(
        Object.values(h.controlsStore.read().pipelineHeads)
          .map((head) => head.snapshotId)
          .sort(),
        retainedIds,
      );
      assert.deepEqual(await pendingScans(h), []);
    } finally {
      await resumed.stop();
    }
  });

for (const nextBudget of [1, 2])
  test(`a delayed older batch preserves the next worker's ${nextBudget === 1 ? "pending" : "completed"} cycle and head`, async (t) => {
    const fixture = paginatedSource();
    const time = controlledClock();
    let entered;
    const normalizing = new Promise((resolve) => {
      entered = resolve;
    });
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    let normalize;
    let first = true;
    const h = await harness(t, {
      ...fixture,
      ...time,
      normalizerFactory(options) {
        normalize = normalizerFor(options);
        return async (input) => {
          if (first) {
            first = false;
            entered();
            await blocked;
          }
          return normalize(input);
        };
      },
    });
    const older = h.runtime.runOnce({ maxPages: 2 }).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    await normalizing;
    const other = await createPipeline({ ...h.options, normalizer: normalize });
    try {
      const completed = await other.runOnce({ maxPages: 2 });
      assert.equal(completed.state, "published");
      time.advance();
      let newer = await other.runOnce({ maxPages: nextBudget });
      assert.equal(newer.state, nextBudget === 1 ? "collecting" : "published");
      const pending = await pendingScans(h);
      release();
      assert.match((await older).error?.message ?? "", /pipeline_scan_superseded/);
      const head = (await h.db.query("SELECT snapshot_id,revision FROM leaderboard_pipeline.heads")).rows[0];
      assert.equal(head.snapshot_id, (nextBudget === 1 ? completed : newer).publications[0].snapshotId);
      assert.equal(Object.values(h.controlsStore.read().pipelineHeads)[0].snapshotId, head.snapshot_id);
      if (nextBudget === 1) {
        assert.equal(pending.length, 1);
        assert.deepEqual(await pendingScans(h), pending, "retiring the old token must preserve its replacement");
        newer = await other.runOnce({ maxPages: 1 });
        assert.equal(newer.state, "published");
      }
      assert.ok(newer.publications[0].revision > completed.publications[0].revision);
      assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 2);
      assert.deepEqual(await pendingScans(h), []);
    } finally {
      release();
      await older;
      await other.stop();
    }
  });

test("head identity is retained from the first bounded page, before the observation cutoff is frozen", async (t) => {
  const fixture = paginatedSource();
  const time = controlledClock();
  const h = await harness(t, { ...fixture, ...time });
  assert.equal((await h.runtime.runOnce({ maxPages: 1 })).state, "collecting");
  time.advance();
  const explicit = await h.runtime.runOnce({ cutoff: time.now(), maxPages: 2 });
  assert.equal(explicit.state, "published");
  time.advance();
  await assert.rejects(h.runtime.runOnce({ maxPages: 1 }), /pipeline_scan_superseded/);
  assert.equal(
    (await h.db.query("SELECT snapshot_id FROM leaderboard_pipeline.heads")).rows[0].snapshot_id,
    explicit.publications[0].snapshotId,
  );
  assert.deepEqual(await pendingScans(h), []);
  time.advance();
  assert.equal((await h.runtime.runOnce({ maxPages: 2 })).state, "published");
});

test("full approved configuration and mode separate pending scans even when the version label is reused", async (t) => {
  const fixture = paginatedSource();
  const h = await harness(t, { ...fixture, verifyConfiguration: async () => true });
  assert.equal((await h.runtime.runOnce({ maxPages: 1 })).state, "collecting");
  assert.equal((await h.runtime.runOnce({ mode: "audit", maxPages: 1 })).state, "collecting");
  const config = structuredClone(h.options.config);
  config.approvalReceipt = "synthetic-second-configuration-approval";
  const changed = await createPipeline({ ...h.options, config });
  try {
    assert.equal((await changed.runOnce({ maxPages: 1 })).state, "collecting");
    assert.equal(new Set(fixture.requests.map((request) => request.runId)).size, 3);
    assert.ok(fixture.requests.every((request) => request.cursor === null));
    assert.equal((await pendingScans(h)).length, 3);
    assert.equal((await changed.runOnce({ maxPages: 1 })).state, "published");
    assert.equal((await pendingScans(h)).length, 2, "completing one configuration must not delete other pending scans");
  } finally {
    await changed.stop();
  }
});

test("a relevant controls revision replaces the pending context without accumulating abandoned rows", async (t) => {
  const fixture = paginatedSource();
  const time = controlledClock();
  const h = await harness(t, { ...fixture, ...time });
  h.controlsStore.transaction((state) => {
    state.configuration = { revision: 0, active: null };
  });
  assert.equal((await h.runtime.runOnce({ maxPages: 1 })).state, "collecting");
  const original = (await pendingScans(h))[0];
  h.controlsStore.transaction((state) => {
    state.configuration.revision++;
  });
  time.advance();
  assert.equal((await h.runtime.runOnce({ maxPages: 1 })).state, "collecting");
  const replaced = await pendingScans(h);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].configuration_key, original.configuration_key);
  assert.notEqual(replaced[0].cycle_token, original.cycle_token);
  assert.equal((await h.runtime.runOnce({ maxPages: 1 })).state, "published");
  assert.deepEqual(
    fixture.requests.map((request) => request.cursor),
    [null, null, "page-2"],
  );
  assert.deepEqual(await pendingScans(h), []);
});

test("an explicit publisher supersedes only the old implicit cycle and the next implicit cycle can progress", async (t) => {
  const fixture = paginatedSource();
  const time = controlledClock();
  let entered;
  const normalizing = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let normalize;
  let first = true;
  const h = await harness(t, {
    ...fixture,
    ...time,
    normalizerFactory(options) {
      normalize = normalizerFor(options);
      return async (input) => {
        if (first) {
          first = false;
          entered();
          await blocked;
        }
        return normalize(input);
      };
    },
  });
  const older = h.runtime.runOnce({ maxPages: 2 }).then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  await normalizing;
  const explicit = await createPipeline({ ...h.options, normalizer: normalize });
  try {
    time.advance();
    const newer = await explicit.runOnce({ cutoff: time.now(), maxPages: 2 });
    assert.equal(newer.state, "published");
    release();
    const outcome = await older;
    assert.equal(
      (await h.db.query("SELECT snapshot_id FROM leaderboard_pipeline.heads")).rows[0].snapshot_id,
      newer.publications[0].snapshotId,
      "the delayed implicit batch must not replace the newer explicit head",
    );
    assert.match(outcome.error?.message ?? "", /pipeline_scan_superseded/);
    assert.equal(Object.values(h.controlsStore.read().pipelineHeads)[0].snapshotId, newer.publications[0].snapshotId);
    assert.deepEqual(await pendingScans(h), [], "the exact superseded pending cycle must not starve on every restart");
    time.advance();
    const resumed = await h.runtime.runOnce({ maxPages: 2 });
    assert.equal(resumed.state, "published");
    assert.ok(resumed.publications[0].revision > newer.publications[0].revision);
    assert.deepEqual(await pendingScans(h), []);
  } finally {
    release();
    await older;
    await explicit.stop();
  }
});

test("a fresh public-source generation does not resume a page cursor authorized by the old generation", async (t) => {
  const fixture = paginatedSource();
  const h = await harness(t, fixture);
  assert.equal((await h.runtime.runOnce({ maxPages: 1 })).state, "collecting");
  const original = (await pendingScans(h))[0];
  h.setPrivate(true);
  await assert.rejects(h.runtime.runOnce({ maxPages: 1 }), /public_source_not_verified/);
  assert.equal(fixture.requests.length, 1);
  h.setPrivate(false);
  assert.equal((await h.runtime.runOnce({ maxPages: 1 })).state, "collecting");
  const replaced = await pendingScans(h);
  assert.equal(replaced.length, 1);
  assert.notEqual(replaced[0].cycle_token, original.cycle_token);
  assert.equal((await h.runtime.runOnce({ maxPages: 1 })).state, "published");
  assert.deepEqual(
    fixture.requests.map((request) => request.cursor),
    [null, null, "page-2"],
  );
  assert.deepEqual(await pendingScans(h), []);
});

test("invalid bounds and explicit invalid cutoffs cannot start a durable implicit scan", async (t) => {
  const fixture = paginatedSource();
  const h = await harness(t, fixture);
  for (const maxPages of [0, 10001, 1.5, null])
    await assert.rejects(h.runtime.runOnce({ maxPages }), /invalid_pipeline_page_budget/);
  await assert.rejects(h.runtime.runOnce({ cutoff: null }), /invalid_pipeline_time/);
  await assert.rejects(h.runtime.runOnce({ mode: "unknown" }), /invalid_scan_scope/);
  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(await pendingScans(h), []);
});

const namedClock = () => {
  const today = new Date();
  const boundary = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1);
  let instant = new Date(boundary - 1000).toISOString();
  return {
    first: instant,
    next: new Date(boundary + 10000).toISOString(),
    fractional: new Date(boundary + 10123).toISOString(),
    following: new Date(boundary + 11000).toISOString(),
    now: () => instant,
    set: (value) => {
      instant = value;
    },
    probeRepository: async (repo) => ({
      repositoryId: repo.id,
      installationId: repo.installationId,
      visibility: "public",
      checkedAt: instant,
    }),
  };
};
const namedScopesAt = (templates, cutoff) =>
  templates.map(({ period, ...scope }) => {
    if (period === "month") {
      const window = components.metrics.resolveMetricWindow(period, cutoff);
      scope.start = window.from;
      scope.end = window.to;
    }
    return components.contracts.canonicalPublicScope(scope);
  });

test("implicit named scan retains mixed month and role scopes across a database reopen and fractional later clock", async (t) => {
  const fixture = paginatedSource();
  const time = namedClock();
  const templates = [
    { ...publicScope, period: "month" },
    { ...publicScope, repository: "2", roles: ["reporter"], period: "month" },
    { ...publicScope },
    {
      ...publicScope,
      repository: "2",
      start: new Date(Date.parse(time.first) - 7 * 86400000).toISOString(),
      end: new Date(Date.parse(time.first) - 86400000).toISOString(),
      period: "custom",
    },
  ];
  const h = await harness(t, {
    ...fixture,
    ...time,
    configure(config) {
      config.scopes = structuredClone(templates);
    },
  });
  assert.equal((await h.runtime.runOnce({ maxPages: 1 })).state, "collecting");
  const retained = (await pendingScans(h))[0];
  assert.equal(new Date(retained.event_cutoff).toISOString(), time.first);
  await h.runtime.stop();
  await h.reopenDatabase();
  time.set(time.fractional);
  const resumed = await createPipeline(h.options);
  try {
    const result = await resumed.runOnce({ maxPages: 1 });
    assert.equal(result.state, "published");
    assert.equal(result.publications.length, templates.length);
    assert.deepEqual(
      fixture.requests.map((request) => request.cursor),
      [null, "page-2"],
    );
    assert.equal(new Set(fixture.requests.map((request) => request.runId)).size, 1);
    assert.ok(fixture.requests.every((request) => request.cutoff === time.first));
    const expected = namedScopesAt(templates, time.first);
    assert.deepEqual(
      Object.keys(retained.scope_heads).sort(),
      expected.map(components.contracts.publicScopeKey).sort(),
    );
    assert.ok(Object.values(retained.scope_heads).every((head) => head === null));
    const originalHeads = (
      await h.db.query("SELECT scope_key,snapshot_id FROM leaderboard_pipeline.heads ORDER BY scope_key")
    ).rows;
    assert.deepEqual(
      originalHeads.map((head) => head.scope_key),
      expected.map(components.contracts.publicScopeKey).sort(),
    );
    const frozen = (await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs")).rows;
    assert.equal(frozen.length, templates.length);
    assert.ok(frozen.every(({ document }) => document.frozen.cutoff === time.fractional));
    assert.ok(
      frozen.every(({ document }) => document.frozen.coverage.every((row) => row.sourceWatermark === time.first)),
    );
    assert.deepEqual(await pendingScans(h), []);
    assert.deepEqual(h.config.scopes, templates, "neither retry nor resolution may mutate the approved templates");

    await assert.rejects(
      resumed.runOnce({ cutoff: time.fractional, maxPages: 1 }),
      /named_period_requires_whole_second_cutoff/,
    );
    assert.equal(fixture.requests.length, 2, "an explicit invalid cutoff cannot collect a replacement page");
    assert.deepEqual(await pendingScans(h), [], "an explicit invalid cutoff must not create a cycle");
    assert.equal((await resumed.runOnce({ maxPages: 1 })).state, "collecting");
    assert.equal(new Date((await pendingScans(h))[0].event_cutoff).toISOString(), time.next);
    time.set(time.following);
    assert.equal((await resumed.runOnce({ maxPages: 1 })).state, "published");
    assert.deepEqual(
      fixture.requests.map((request) => request.cursor),
      [null, "page-2", null, "page-2"],
    );
    assert.equal(new Set(fixture.requests.map((request) => request.runId)).size, 2);
    assert.ok(fixture.requests.slice(2).every((request) => request.cutoff === time.next));
    const nextHeads = (await h.db.query("SELECT scope_key,snapshot_id FROM leaderboard_pipeline.heads")).rows;
    const oldMonthKeys = expected.slice(0, 2).map(components.contracts.publicScopeKey);
    for (const key of oldMonthKeys)
      assert.equal(
        nextHeads.find((head) => head.scope_key === key)?.snapshot_id,
        originalHeads.find((head) => head.scope_key === key)?.snapshot_id,
      );
    const nextKeys = namedScopesAt(templates, time.next).map(components.contracts.publicScopeKey);
    assert.equal(nextHeads.length, 6, "two new named heads coexist with the prior month and the two exact scopes");
    assert.ok(nextKeys.every((key) => nextHeads.some((head) => head.scope_key === key)));
    assert.deepEqual(await pendingScans(h), []);
  } finally {
    await resumed.stop();
  }
});

test("a new fractional implicit named clock binds the preceding whole second before collection", async (t) => {
  const fixture = paginatedSource();
  const time = namedClock();
  time.set(time.fractional);
  const h = await harness(t, {
    ...fixture,
    ...time,
    configure(config) {
      config.scopes = [{ ...publicScope, period: "month" }];
    },
  });
  assert.equal((await h.runtime.runOnce({ maxPages: 1 })).state, "collecting");
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].cutoff, time.next);
  const runs = (await h.db.query("SELECT until_at FROM leaderboard_ingestion.collection_runs")).rows;
  assert.equal(runs.length, 1);
  assert.equal(new Date(runs[0].until_at).toISOString(), time.next);
  const pending = await pendingScans(h);
  assert.equal(pending.length, 1);
  assert.equal(new Date(pending[0].event_cutoff).toISOString(), time.next);
});

test("a new named cycle resolves its head keys from the event cutoff selected under its row lock", async (t) => {
  const fixture = paginatedSource();
  const time = namedClock();
  const templates = [{ ...publicScope, repository: "2", roles: ["reporter"], period: "month" }];
  const h = await harness(t, {
    ...fixture,
    ...time,
    configure(config) {
      config.scopes = structuredClone(templates);
    },
  });
  const transaction = h.db.transaction;
  let advance = true;
  h.db.transaction = (work) =>
    transaction((tx) =>
      work({
        query: async (sql, parameters) => {
          const result = await tx.query(sql, parameters);
          if (
            advance &&
            sql === "SELECT * FROM leaderboard_pipeline.scan_continuations WHERE configuration_key=$1 FOR UPDATE"
          ) {
            advance = false;
            time.set(time.fractional);
          }
          return result;
        },
      }),
    );
  assert.equal((await h.runtime.runOnce({ maxPages: 1 })).state, "collecting");
  assert.equal(advance, false, "the actual new-cycle transaction must hold its row before selecting the window");
  const retained = (await pendingScans(h))[0];
  assert.equal(new Date(retained.event_cutoff).toISOString(), time.next);
  assert.deepEqual(
    Object.keys(retained.scope_heads),
    namedScopesAt(templates, time.next).map(components.contracts.publicScopeKey),
  );
  time.set(time.following);
  assert.equal((await h.runtime.runOnce({ maxPages: 1 })).state, "published");
  assert.ok(fixture.requests.every((request) => request.cutoff === time.next));
  assert.deepEqual(await pendingScans(h), []);
});

for (const roles of [false, true])
  test(`implicit maximum-Project v${roles ? 3 : 2} publication keeps scan binding atomic through confirmation failure and reopen`, async (t) => {
    const fixture = paginatedSource();
    const time = controlledClock();
    const scope = components.contracts.canonicalPublicScope({
      ...publicScope,
      context: "current",
      projects,
      ...(roles ? { roles: components.contracts.publicContributionRoles } : {}),
    });
    const key = components.contracts.publicScopeKey(scope);
    assert.ok(key.length > 13000, "use the real high-entropy key beyond the old B-tree bound");
    const h = await harness(t, {
      ...fixture,
      ...time,
      configure(config) {
        config.scopes = [scope];
        config.repositories[0].allowedProjectIds = projects;
      },
    });
    const version = (await h.db.query("SELECT * FROM leaderboard_pipeline.storage_migrations")).rows;
    const transaction = h.db.transaction;
    let interruptBinding = true;
    let bindings = 0;
    h.db.transaction = (work) =>
      transaction((tx) =>
        work({
          query: async (sql, parameters) => {
            const result = await tx.query(sql, parameters);
            if (sql.includes("SET scope_heads=jsonb_set")) {
              bindings++;
              if (interruptBinding) {
                interruptBinding = false;
                throw new Error("SYNTHETIC_SCAN_BINDING_INTERRUPTION");
              }
            }
            return result;
          },
        }),
      );
    await assert.rejects(h.runtime.runOnce({ maxPages: 2 }), /SYNTHETIC_SCAN_BINDING_INTERRUPTION/);
    assert.equal(bindings, 1);
    assert.deepEqual((await h.db.query("SELECT snapshot_id FROM leaderboard_pipeline.snapshots")).rows, []);
    assert.deepEqual((await h.db.query("SELECT snapshot_id FROM leaderboard_pipeline.heads")).rows, []);
    assert.deepEqual((await pendingScans(h))[0].scope_heads, { [key]: null });

    const confirm = h.controlsStore.transaction.bind(h.controlsStore);
    let interruptConfirmation = true;
    h.controlsStore.transaction = (work, options) =>
      confirm((state) => {
        const result = work(state);
        if (interruptConfirmation && state.pipelinePublications) {
          interruptConfirmation = false;
          throw new Error("SYNTHETIC_LONG_SCOPE_CONFIRMATION_INTERRUPTION");
        }
        return result;
      }, options);
    await assert.rejects(h.runtime.runOnce({ maxPages: 2 }), /SYNTHETIC_LONG_SCOPE_CONFIRMATION_INTERRUPTION/);
    assert.equal(bindings, 2);
    const head = (
      await h.db.query(
        "SELECT scope_key,snapshot_id,encode(scope_hash,'hex') AS digest FROM leaderboard_pipeline.heads",
      )
    ).rows[0];
    assert.equal(head.scope_key, key);
    assert.equal(head.digest, hash(key));
    const savedScan = (await pendingScans(h))[0];
    assert.deepEqual(savedScan.scope_heads, { [key]: head.snapshot_id });
    assert.equal(h.controlsStore.read().pipelineHeads?.[key], undefined);
    const receipts = (
      await h.db.query(
        "SELECT receipt_id,operation_key,encode(operation_hash,'hex') AS digest FROM leaderboard_pipeline.receipts WHERE kind='snapshot_published'",
      )
    ).rows;
    const operation = `publish:${key}:${head.snapshot_id}`;
    assert.deepEqual(receipts, [
      {
        receipt_id: hash(JSON.stringify([operation, "snapshot_published"])),
        operation_key: operation,
        digest: hash(operation),
      },
    ]);
    await h.runtime.stop();
    await h.reopenDatabase();
    time.advance();
    const resumed = await createPipeline(h.options);
    try {
      const result = await resumed.runOnce({ maxPages: 1 });
      assert.equal(result.state, "published");
      assert.deepEqual(
        result.publications.map(({ snapshotId, changed }) => ({ snapshotId, changed })),
        [{ snapshotId: head.snapshot_id, changed: false }],
      );
      assert.equal(bindings, 3, "the unchanged-publication path must retain its same-transaction scan binding");
      assert.equal(fixture.requests.length, 2, "recovery must not fetch an already completed page again");
      assert.ok(fixture.requests.every((request) => request.cutoff === new Date(savedScan.event_cutoff).toISOString()));
      assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 1);
      assert.equal(h.controlsStore.read().pipelineHeads[key].snapshotId, head.snapshot_id);
      assert.deepEqual(await pendingScans(h), []);
      assert.deepEqual((await h.db.query("SELECT * FROM leaderboard_pipeline.storage_migrations")).rows, version);
    } finally {
      await resumed.stop();
    }
  });
