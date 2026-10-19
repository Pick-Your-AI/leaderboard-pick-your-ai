import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createPipeline } from "../src/index.mjs";
import { harness, components, publicScope, fixtureId } from "./harness.mjs";

const { canonicalPublicScope, publicScopeKey, publicScopeParameters, publicWindowPeriods, parsePublicWindows } =
  components.contracts;
const cutoff = "2026-10-18T12:00:00.000Z";
const olderCutoff = "2026-10-17T12:00:00.000Z";
const beforeCutoff = (days) => new Date(Date.parse(cutoff) - days * 86400000).toISOString();
const filter = canonicalPublicScope({
  ...publicScope,
  repository: "2",
  context: "current",
  projects: [],
  roles: ["reporter"],
});
const url = (scope = filter) => `/api/v1/windows?${new URLSearchParams(publicScopeParameters(scope))}`;
const board = (entry) =>
  `/api/v1/boards?${new URLSearchParams({
    ...publicScopeParameters(entry.scope),
    metric: "issues_opened",
    snapshot: entry.snapshotId,
  })}`;
const countSnapshots = async (h) =>
  (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n;
const unavailable = (response) => {
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.json().windows, undefined);
  assert.doesNotMatch(
    response.body,
    /pipelineWindowIndex|pipelinePublications|pipelineHeads|configurationHash|recognitionFingerprint|aggregateExplanation/,
  );
};
async function menu(runtime, scope = filter) {
  const response = await runtime.app.inject(url(scope));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  return parsePublicWindows(response.json(), scope, components.metrics.resolveMetricWindow);
}
async function namedHarness(t, periods = ["7d", "30d"], extra = {}) {
  return harness(t, {
    discoveryAuthority: true,
    ...extra,
    transformPayloads(payloads) {
      const dated = payloads.map((payload, index) => ({
        ...payload,
        created_at: beforeCutoff(index === 0 ? 2 : 45),
        updated_at: beforeCutoff(1),
      }));
      return extra.transformPayloads ? extra.transformPayloads(dated) : dated;
    },
    configure(config) {
      extra.configure?.(config);
      config.scopes = periods.map((period) => ({ ...filter, period }));
    },
  });
}

test("all seven confirmed choices share one captured transaction and coalesced aliases share one materialization", async (t) => {
  const h = await namedHarness(t, publicWindowPeriods);
  const published = await h.runtime.runOnce({ cutoff });
  assert.equal(published.state, "published");
  assert.equal(published.publications.length, 6, "October month and quarter have the same complete scope");
  assert.equal(await countSnapshots(h), 6);
  const before = h.controlsStore.read();
  const githubReads = { ...h.githubReads };
  const transaction = h.db.transaction.bind(h.db);
  const query = h.db.query.bind(h.db);
  let acquisitions = 0;
  let selectedReads = 0;
  h.db.query = () => assert.fail("discovery must not acquire a connection outside its transaction");
  h.db.transaction = (work) => {
    acquisitions++;
    return transaction((tx) =>
      work({
        query: async (sql, params) => {
          if (sql.includes("SELECT selected.document")) selectedReads++;
          return tx.query(sql, params);
        },
      }),
    );
  };
  let result;
  try {
    result = await menu(h.runtime);
  } finally {
    h.db.query = query;
    h.db.transaction = transaction;
  }
  assert.equal(acquisitions, 2, "one shared capture plus one final SQL admission");
  assert.equal(selectedReads, 6, "coincident labels reuse the same captured authorized read");
  assert.deepEqual(result.scope, filter);
  assert.deepEqual(
    result.windows.map((entry) => entry.period),
    publicWindowPeriods,
  );
  const month = result.windows.find((entry) => entry.period === "month");
  const quarter = result.windows.find((entry) => entry.period === "quarter");
  assert.equal(month.snapshotId, quarter.snapshotId);
  assert.equal(month.revision, quarter.revision);
  assert.deepEqual(month.scope, quarter.scope);
  for (const entry of result.windows) {
    const response = await h.runtime.app.inject(board(entry));
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().snapshotId, entry.snapshotId);
    assert.equal(response.json().head.snapshotId, entry.snapshotId);
    assert.equal(response.json().head.revision, entry.revision);
    const confirmation = before.pipelinePublications[entry.snapshotId];
    assert.deepEqual(before.pipelineHeads[publicScopeKey(entry.scope)], confirmation);
    assert.equal(confirmation.scopeKey, publicScopeKey(entry.scope));
  }
  assert.deepEqual(h.githubReads, githubReads);
  assert.equal(await countSnapshots(h), 6);
  assert.deepEqual(h.controlsStore.read(), before, "discovery and pinned reads cannot repair or publish authority");
  assert.doesNotMatch(JSON.stringify(h.controlsStore.publicSnapshot()), /pipelineWindowIndex/);
});

test("exact UTC calendar opening has no empty publication and one second later confirms every coincident label", async (t) => {
  const h = await namedHarness(t, ["month", "quarter", "year"]);
  const empty = await h.runtime.runOnce({ cutoff: "2026-01-01T00:00:00.000Z" });
  assert.equal(empty.state, "published");
  assert.deepEqual(empty.publications, []);
  assert.equal(await countSnapshots(h), 0);
  assert.deepEqual((await menu(h.runtime)).windows, []);
  const started = await h.runtime.runOnce({ cutoff: "2026-01-01T00:00:01.000Z" });
  assert.equal(started.publications.length, 1);
  const choices = (await menu(h.runtime)).windows;
  assert.deepEqual(
    choices.map((entry) => entry.period),
    ["month", "quarter", "year"],
  );
  assert.equal(new Set(choices.map((entry) => entry.snapshotId)).size, 1);
  for (const entry of choices) {
    assert.equal(entry.scope.start, "2026-01-01T00:00:00.000Z");
    assert.equal(entry.scope.end, "2026-01-01T00:00:01.000Z");
  }
  assert.equal(await countSnapshots(h), 1);
});

test("discovery preserves every filter dimension and never infers a label from an approved legacy duration", async (t) => {
  const h = await namedHarness(t, ["30d"]);
  await h.runtime.runOnce({ cutoff });
  assert.equal((await menu(h.runtime)).windows.length, 1);
  for (const changed of [
    { organization: "another-organization" },
    { repository: "3" },
    { workstream: "triage" },
    { context: "event" },
    { projects: ["PVT_unapproved"] },
    { roles: ["author"] },
  ]) {
    unavailable(await h.runtime.app.inject(url(canonicalPublicScope({ ...filter, ...changed }))));
  }
  const bounds = components.metrics.resolveMetricWindow("30d", cutoff);
  const scope = canonicalPublicScope({ ...filter, start: bounds.from, end: bounds.to });
  const legacy = await harness(t, {
    configure: (config) => {
      config.scopes = [scope];
    },
  });
  const publication = (await legacy.runtime.runOnce({ cutoff })).publications[0];
  const response = await legacy.runtime.app.inject(board({ scope, snapshotId: publication.snapshotId }));
  assert.equal(response.statusCode, 200, response.body);
  unavailable(await legacy.runtime.app.inject(url()));
});

test("failed confirmation rolls back the window index with its private head and exact replay advances both", async (t) => {
  const h = await namedHarness(t, ["30d"]);
  await h.runtime.runOnce({ cutoff: olderCutoff });
  const original = await menu(h.runtime);
  const before = h.controlsStore.read();
  const transaction = h.controlsStore.transaction.bind(h.controlsStore);
  let failed = false;
  h.controlsStore.transaction = (change, options) =>
    transaction((state) => {
      const prior = JSON.stringify(state.pipelineWindowIndex);
      const result = change(state);
      if (JSON.stringify(state.pipelineWindowIndex) !== prior) {
        failed = true;
        throw new Error("synthetic_window_confirmation_failure");
      }
      return result;
    }, options);
  try {
    await assert.rejects(h.runtime.runOnce({ cutoff }), /synthetic_window_confirmation_failure/);
  } finally {
    h.controlsStore.transaction = transaction;
  }
  assert.equal(failed, true, "the fault must follow the actual private index write");
  assert.equal(await countSnapshots(h), 2, "the newer SQL allocation remains unconfirmed");
  assert.deepEqual(h.controlsStore.read().pipelineWindowIndex, before.pipelineWindowIndex);
  assert.deepEqual(h.controlsStore.read().pipelineHeads, before.pipelineHeads);
  assert.deepEqual(await menu(h.runtime), original);
  const retry = (await h.runtime.runOnce({ cutoff })).publications[0];
  assert.equal(retry.changed, false);
  const current = await menu(h.runtime);
  assert.equal(current.windows[0].snapshotId, retry.snapshotId);
  assert.notEqual(current.windows[0].snapshotId, original.windows[0].snapshotId);
  assert.equal(current.windows[0].scope.end, cutoff);
  assert.equal(current.windows[0].revision, 1, "revisions belong to the concrete scope, not the preset label");
  assert.equal((await h.runtime.app.inject(board(original.windows[0]))).statusCode, 200);
  assert.equal(await countSnapshots(h), 2);
});

test("a delayed older cutoff cannot rewind a newer confirmed preset, even when both concrete revisions are one", async (t) => {
  const h = await namedHarness(t, ["30d"]);
  let entered, release;
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  const resume = new Promise((resolve) => {
    release = resolve;
  });
  const transaction = h.db.transaction.bind(h.db);
  let paused = false;
  h.db.transaction = async (work) => {
    let publishing = false;
    const result = await transaction((tx) =>
      work({
        query: async (sql, params) => {
          const result = await tx.query(sql, params);
          if (sql.includes("INSERT INTO leaderboard_pipeline.snapshots")) publishing = true;
          return result;
        },
      }),
    );
    if (publishing && !paused) {
      paused = true;
      entered();
      await resume;
    }
    return result;
  };
  const pending = h.runtime.runOnce({ cutoff: olderCutoff });
  await reached;
  const newer = await createPipeline(h.options);
  t.after(() => newer.stop());
  try {
    const later = (await newer.runOnce({ cutoff })).publications[0];
    assert.equal(later.revision, 1);
    const current = await menu(newer);
    assert.equal(current.windows[0].snapshotId, later.snapshotId);
    release();
    const earlier = (await pending).publications[0];
    assert.equal(earlier.revision, 1);
    assert.notEqual(earlier.snapshotId, later.snapshotId);
    assert.deepEqual(await menu(h.runtime), current);
    const bounds = components.metrics.resolveMetricWindow("30d", olderCutoff);
    const retained = await h.runtime.app.inject(
      board({
        scope: canonicalPublicScope({ ...filter, start: bounds.from, end: bounds.to }),
        snapshotId: earlier.snapshotId,
      }),
    );
    assert.equal(retained.statusCode, 200, retained.body);
  } finally {
    release();
    await pending;
  }
});

test("the confirmed index survives a real database restart and an absent index never scans or repairs snapshot history", async (t) => {
  const h = await namedHarness(t, ["30d"]);
  await h.runtime.runOnce({ cutoff });
  const original = await menu(h.runtime);
  const saved = h.controlsStore.read().pipelineWindowIndex;
  const githubReads = { ...h.githubReads };
  await h.reopenDatabase();
  const reopened = new components.controls.ControlStore(join(h.directory, "controls.sqlite"));
  const restarted = await createPipeline({ ...h.options, controlsStore: reopened });
  try {
    assert.deepEqual(await menu(restarted), original);
    assert.deepEqual(reopened.read().pipelineWindowIndex, saved);
    reopened.transaction((state) => {
      delete state.pipelineWindowIndex;
    });
    const before = reopened.read();
    assert.deepEqual((await menu(restarted)).windows, []);
    assert.deepEqual(reopened.read(), before);
    assert.equal((await restarted.app.inject(board(original.windows[0]))).statusCode, 200);
    assert.equal(await countSnapshots(h), 1);
    assert.deepEqual(h.githubReads, githubReads);
  } finally {
    await restarted.stop();
    reopened.close();
  }
});

test("current configuration approval, exact configuration namespace and source revocation gate discovery", async (t) => {
  let approved = true;
  const h = await namedHarness(t, ["30d"], { verifyConfiguration: async () => approved });
  await h.runtime.runOnce({ cutoff });
  const original = await menu(h.runtime);
  approved = false;
  h.discoveryAuthority.revoke(h.config);
  unavailable(await h.runtime.app.inject(url()));
  approved = true;
  h.discoveryAuthority.approve(h.config);
  const changed = structuredClone(h.config);
  changed.policies[0].policy.rank = false;
  changed.policies[0].signature = components.metrics.stableJSON(changed.policies[0].policy);
  h.discoveryAuthority.approve(changed);
  const other = await createPipeline({ ...h.options, config: changed });
  t.after(() => other.stop());
  assert.deepEqual((await menu(other)).windows, [], "another configuration cannot borrow retained index entries");
  assert.deepEqual(await menu(h.runtime), original);
  assert.equal(await h.runtime.collection.suppress(fixtureId(391), "a".repeat(64), 1, [2], "revoked"), "accepted");
  unavailable(await h.runtime.app.inject(url()));
});

function finalReadFault(h, change) {
  const transaction = h.db.transaction.bind(h.db);
  const observed = { reads: 0, authorityQueries: 0, changes: 0 };
  h.db.transaction = (work) =>
    transaction((tx) =>
      work({
        query: async (sql, params) => {
          const result = await tx.query(sql, params);
          if (sql.includes("SELECT selected.document")) observed.reads++;
          if (sql.includes("UNION SELECT artifact_id AS subject_id FROM leaderboard_pipeline.corrections")) {
            observed.authorityQueries++;
            if (observed.authorityQueries === 3) {
              assert.equal(observed.reads, 2, "the edit must follow both complete individually authorized reads");
              observed.changes++;
              change();
            }
          }
          return result;
        },
      }),
    );
  return observed;
}

for (const changed of ["actor", "head", "confirmation", "index", "explanation", "approval"])
  test(`the final discovery fence rejects ${changed} changes after all individual window reads`, async (t) => {
    let approved = true;
    const h = await namedHarness(t, ["7d", "30d"], { verifyConfiguration: async () => approved });
    await h.runtime.runOnce({ cutoff });
    const initial = await menu(h.runtime);
    const target = initial.windows[0];
    const revision = h.controlsStore.read().revision;
    const observed = finalReadFault(h, () => {
      if (changed === "approval") {
        approved = false;
        h.discoveryAuthority.revoke(h.config);
      } else if (changed === "explanation")
        h.controlsStore.db
          .prepare("UPDATE pipeline_aggregate_explanations SET document=? WHERE snapshot_id=?")
          .run("{}", target.snapshotId);
      else
        h.controlsStore.transaction((state) => {
          if (changed === "actor") state.profiles["101"] = { suppressed: true, public: false, bio: "", highlights: [] };
          else if (changed === "head") delete state.pipelineHeads[publicScopeKey(target.scope)];
          else if (changed === "confirmation") delete state.pipelinePublications[target.snapshotId];
          else delete state.pipelineWindowIndex;
        });
    });
    unavailable(await h.runtime.app.inject(url()));
    assert.deepEqual(observed, { reads: 2, authorityQueries: 3, changes: 1 });
    assert.equal(h.controlsStore.read().revision, revision, "the fence cannot depend only on a public revision bump");
  });

test("the final discovery fence rechecks recognition withdrawal after every captured window read", async (t) => {
  const h = await namedHarness(t, ["7d", "30d"], {
    configure(config) {
      const policy = {
        ...config.policies[0].policy,
        version: "synthetic-discoverable-recognition-v1",
        dateBasis: "acceptedAt",
        rankedStates: ["qualified"],
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-window-policy" },
      ];
      config.recognitionBindings = [
        {
          category: "finding",
          scope: "repository:2",
          policyVersion: policy.version,
          metricId: "issues_opened",
          sourceMetricId: "issues_opened",
          repositoryId: "2",
          reviewerIds: ["202"],
        },
      ];
    },
  });
  const event = {
    id: "synthetic-discoverable-recognition-receipt",
    actor: "202",
    action: "accepted",
    at: Date.parse(beforeCutoff(1.5)),
    policyVersion: h.config.policies[0].policy.version,
  };
  h.controlsStore.transaction((state) => {
    state.requests.claim = {
      id: "claim",
      kind: "evidence",
      status: "accepted",
      owner: "101",
      category: "finding",
      scope: "repository:2",
      policyVersion: event.policyVersion,
      locator: "https://github.com/synthetic-org/synthetic-repo/issues/1",
      collaborators: {},
      history: [event],
    };
    state.audit.push(event);
  });
  await h.runtime.runOnce({ cutoff });
  const initial = await menu(h.runtime);
  for (const entry of initial.windows) {
    const response = await h.runtime.app.inject(board(entry));
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().rows.find((row) => row.actorId === "101")?.result.value, 1);
  }
  const revision = h.controlsStore.read().revision;
  const observed = finalReadFault(h, () =>
    h.controlsStore.transaction((state) => {
      state.requests.claim.status = "withdrawn";
    }),
  );
  unavailable(await h.runtime.app.inject(url()));
  assert.deepEqual(observed, { reads: 2, authorityQueries: 3, changes: 1 });
  assert.equal(h.controlsStore.read().revision, revision);
});
