import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createPipeline } from "../src/index.mjs";
import { aggregateExplanationHash } from "../src/aggregate-explanations.mjs";
import { retainedRankHistory } from "../src/rank-history.mjs";
import { harness, components, clock, ago, boardUrl, fiveAuthorIssuePayloads } from "./harness.mjs";

async function twoSnapshots(t, extra = {}, beforePublish) {
  const scope = {
    organization: "Pick-Your-AI",
    repository: null,
    workstream: null,
    start: ago(60).replace(/\.\d{3}Z$/, ".000Z"),
    end: ago(1).replace(/\.\d{3}Z$/, ".000Z"),
  };
  const h = await harness(t, {
    ...extra,
    transformPayloads: fiveAuthorIssuePayloads,
    configure(config) {
      extra.configure?.(config);
      config.scopes = [scope];
    },
  });
  await beforePublish?.(h);
  const first = (await h.runtime.runOnce({ cutoff: ago(0.01) })).publications[0].snapshotId;
  const cutoff = clock();
  const second = (await h.runtime.runOnce({ cutoff })).publications[0].snapshotId;
  assert.notEqual(first, second);
  const url = `${boardUrl}&${new URLSearchParams({ start: scope.start, end: scope.end })}`;
  return { ...h, first, second, cutoff, url, comparisonUrl: `${url}&snapshot=${second}&compare=${first}` };
}
const recognitionPair = (t) =>
  twoSnapshots(
    t,
    {
      configure(config) {
        const policy = {
          ...config.policies[0].policy,
          version: "synthetic-paired-recognition-v1",
          dateBasis: "acceptedAt",
          rankedStates: ["qualified"],
        };
        config.policies = [
          { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-paired-policy" },
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
    },
    (h) => {
      h.controlsStore.transaction((state) => {
        // Keep the original claim and audit event used by the withdrawal/race
        // mutations; independent accepted peers make the baseline rankable.
        for (const [actor, number] of [
          ["101", 1],
          ["102", 2],
          ["103", 103],
          ["104", 104],
          ["105", 105],
        ]) {
          const id = actor === "101" ? "claim" : `claim-${actor}`;
          const event = {
            id: actor === "101" ? "synthetic-paired-recognition-receipt" : `synthetic-paired-recognition-${actor}`,
            actor: "202",
            action: "accepted",
            at: Date.parse(ago(1.5)),
            policyVersion: h.config.policies[0].policy.version,
          };
          state.requests[id] = {
            id,
            kind: "evidence",
            status: "accepted",
            owner: actor,
            category: "finding",
            scope: "repository:2",
            policyVersion: event.policyVersion,
            locator: `https://github.com/synthetic-org/synthetic-repo/issues/${number}`,
            collaborators: {},
            history: [event],
          };
          state.audit.push(event);
        }
      });
    },
  );
const stored = (h, id) =>
  h.controlsStore.db.prepare("SELECT * FROM pipeline_aggregate_explanations WHERE snapshot_id=?").get(id);
const safe = (response) =>
  assert.doesNotMatch(
    response.body,
    /rankEvidence|comparisonSignature|backfillRevision|inputHash|authorization|private-rank-evidence|history_integrity/,
  );
const unavailable = (response, reason) => {
  assert.equal(response.statusCode, 200, response.body);
  safe(response);
  assert.ok(response.json().rows.length > 0);
  for (const row of response.json().rows)
    assert.deepEqual(row.movement, { actorId: row.actorId, state: "unavailable", delta: null, reason });
};
async function restarted(h) {
  await h.runtime.stop();
  await h.reopenDatabase();
  const controlsStore = new components.controls.ControlStore(join(h.directory, "controls.sqlite"));
  const runtime = await createPipeline({ ...h.options, controlsStore });
  return {
    runtime,
    controlsStore,
    close: async () => {
      await runtime.stop();
      controlsStore.close();
    },
  };
}

test("actual persisted bounded partial history is unavailable and immutable across restart", async (t) => {
  const h = await twoSnapshots(t);
  const before = [stored(h, h.first), stored(h, h.second)];
  for (const row of before)
    assert.equal(JSON.parse(row.document).rankEvidence.schemaVersion, "private-rank-evidence/v1");
  const response = await h.runtime.app.inject(h.comparisonUrl);
  unavailable(response, "insufficient_history");
  assert.equal(response.json().comparison.snapshotId, h.first);
  const next = await restarted(h);
  try {
    const again = await next.runtime.app.inject(h.comparisonUrl);
    unavailable(again, "insufficient_history");
    assert.deepEqual(again.json(), response.json());
    assert.deepEqual([stored(h, h.first), stored(h, h.second)], before);
  } finally {
    await next.close();
  }
});

test("configured recognition preserves paired public values and retained history across restart", async (t) => {
  const h = await recognitionPair(t);
  const before = [stored(h, h.first), stored(h, h.second)];
  const current = await h.runtime.app.inject(`${h.url}&snapshot=${h.second}`);
  assert.equal(current.statusCode, 200, current.body);
  assert.equal(current.json().rows.find((row) => row.actorId === "101").result.value, 1);
  const response = await h.runtime.app.inject(h.comparisonUrl);
  unavailable(response, "insufficient_history");
  assert.equal(response.json().comparison.snapshotId, h.first);
  assert.deepEqual(
    response.json().rows.map((row) => [row.actorId, row.result.value, row.rank]),
    current.json().rows.map((row) => [row.actorId, row.result.value, row.rank]),
  );
  assert.doesNotMatch(response.body, /synthetic-paired-recognition-receipt|recognitionFingerprint|recognitionBindings/);
  const next = await restarted(h);
  try {
    const again = await next.runtime.app.inject(h.comparisonUrl);
    unavailable(again, "insufficient_history");
    assert.deepEqual(again.json(), response.json());
    assert.deepEqual([stored(h, h.first), stored(h, h.second)], before);
  } finally {
    await next.close();
  }
});

for (const changed of ["withdrawal", "audit"])
  test(`final paired fence rejects recognition ${changed} after both snapshot reads`, async (t) => {
    const h = await recognitionPair(t);
    unavailable(await h.runtime.app.inject(h.comparisonUrl), "insufficient_history");
    const transaction = h.db.transaction.bind(h.db);
    let reads = 0,
      finalChecks = 0,
      finalFence = false;
    h.db.transaction = (work) =>
      transaction((tx) =>
        work({
          query: async (sql, params) => {
            const result = await tx.query(sql, params);
            if (sql.includes("SELECT selected.document")) reads++;
            if (sql.startsWith("SELECT repository_id,state,generation FROM leaderboard_ingestion.repository_access"))
              finalFence = true;
            if (
              finalFence &&
              sql.includes("UNION SELECT artifact_id AS subject_id FROM leaderboard_pipeline.corrections")
            ) {
              finalChecks++;
              assert.equal(reads, 2, "recognition edit must follow both individually authorized snapshot reads");
              h.controlsStore.transaction((state) => {
                if (changed === "withdrawal") state.requests.claim.status = "withdrawn";
                else state.audit.find((event) => event.id === "synthetic-paired-recognition-receipt").actor = "303";
              });
            }
            return result;
          },
        }),
      );
    const revision = h.controlsStore.read().revision;
    const response = await h.runtime.app.inject(h.comparisonUrl);
    assert.equal(response.statusCode, 410, response.body);
    assert.equal(response.json().rows, undefined);
    safe(response);
    assert.equal(reads, 2);
    assert.equal(finalChecks, 1);
    assert.equal(h.controlsStore.read().revision, revision, "recognition edits must be fenced without a revision bump");
  });

test("pre-extension confirmed receipt remains readable and replayable without adding missing history", async (t) => {
  const h = await twoSnapshots(t),
    original = stored(h, h.second),
    legacy = JSON.parse(original.document);
  delete legacy.rankEvidence;
  const digest = aggregateExplanationHash(legacy);
  h.controlsStore.db
    .prepare("UPDATE pipeline_aggregate_explanations SET document=?,digest=? WHERE snapshot_id=?")
    .run(JSON.stringify(legacy), digest, h.second);
  h.controlsStore.transaction((state) => {
    state.pipelinePublications[h.second].aggregateExplanationHash = digest;
    for (const head of Object.values(state.pipelineHeads))
      if (head.snapshotId === h.second) head.aggregateExplanationHash = digest;
  });
  const saved = stored(h, h.second);
  assert.equal((await h.runtime.app.inject(h.url)).statusCode, 200);
  unavailable(await h.runtime.app.inject(h.comparisonUrl), "insufficient_evidence_history");
  await h.runtime.runOnce({ cutoff: h.cutoff });
  assert.deepEqual(stored(h, h.second), saved);
  const next = await restarted(h);
  try {
    assert.equal((await next.runtime.app.inject(h.url)).statusCode, 200);
    unavailable(await next.runtime.app.inject(h.comparisonUrl), "insufficient_evidence_history");
    await next.runtime.runOnce({ cutoff: h.cutoff });
    assert.deepEqual(stored(h, h.second), saved);
  } finally {
    await next.close();
  }
});

for (const changed of ["actor", "artifact", "source", "approval"])
  test(`second-snapshot ${changed} revocation rejects entire paired response under one transaction`, async (t) => {
    let approved = true;
    const h = await twoSnapshots(t, { verifyConfiguration: async () => approved });
    const transaction = h.db.transaction.bind(h.db),
      query = h.db.query.bind(h.db);
    let paired = false,
      acquisitions = 0,
      reads = 0;
    h.db.query = (...args) => {
      assert.equal(paired, false, "paired read acquired another connection");
      return query(...args);
    };
    h.db.transaction = (work) => {
      if (!paired) return transaction(work);
      acquisitions++;
      return transaction((tx) =>
        work({
          query: async (sql, params) => {
            const result = await tx.query(sql, params);
            if (sql.includes("SELECT selected.document") && ++reads === 2) {
              if (changed === "actor")
                h.controlsStore.transaction((state) => {
                  state.profiles["101"] = { suppressed: true };
                });
              if (changed === "artifact")
                await tx.query(
                  "INSERT INTO leaderboard_ingestion.object_suppressions(repository_id,subject_id,reason) VALUES(2,'SYNTHETIC_ISSUE_1','unavailable')",
                );
              if (changed === "source")
                await tx.query(
                  "UPDATE leaderboard_ingestion.repository_access SET state='unavailable',generation=generation+1 WHERE repository_id=2",
                );
              if (changed === "approval") approved = false;
            }
            return result;
          },
        }),
      );
    };
    const revision = h.controlsStore.read().revision;
    paired = true;
    const response = await h.runtime.app.inject(h.comparisonUrl);
    paired = false;
    assert.equal(response.statusCode, 410, response.body);
    safe(response);
    assert.equal(acquisitions, 1);
    assert.equal(reads, 2);
    assert.equal(response.json().rows, undefined);
    if (changed === "actor") {
      assert.equal(h.controlsStore.read().revision, revision, "test must cover privacy edits without revision bump");
      const current = await h.runtime.app.inject(h.url);
      assert.equal(current.statusCode, 200, current.body);
      assert.ok(current.json().rows.every((row) => row.actorId !== "101"));
    }
  });

test("new comparison metadata is bound to publication confirmation even if its storage digest is recomputed", async (t) => {
  const h = await twoSnapshots(t),
    original = stored(h, h.first),
    forged = JSON.parse(original.document);
  forged.rankEvidence.metrics[0].rows[0].evidence[0].comparisonSignature = "f".repeat(64);
  h.controlsStore.db
    .prepare("UPDATE pipeline_aggregate_explanations SET document=?,digest=? WHERE snapshot_id=?")
    .run(JSON.stringify(forged), aggregateExplanationHash(forged), h.first);
  const response = await h.runtime.app.inject(h.comparisonUrl);
  assert.equal(response.statusCode, 503, response.body);
  safe(response);
  assert.equal(h.controlsStore.read().pipelinePublications[h.first].aggregateExplanationHash, original.digest);
  assert.equal((await h.runtime.app.inject(h.url)).statusCode, 200);
  h.controlsStore.db
    .prepare("UPDATE pipeline_aggregate_explanations SET document=?,digest=? WHERE snapshot_id=?")
    .run(original.document, original.digest, h.first);
  unavailable(await h.runtime.app.inject(h.comparisonUrl), "insufficient_history");
});

test("accepted duplicate-source policy publishes canonical retained history across restart", async (t) => {
  const h = await twoSnapshots(t, {
    configure(config) {
      const entry = config.policies[0];
      entry.policy.sources.push(...entry.policy.sources);
      components.metrics.validateMetricPolicy(entry.policy);
      entry.signature = components.metrics.stableJSON(entry.policy);
    },
  });
  assert.deepEqual(h.config.policies[0].policy.sources, ["github_rest", "github_rest"]);
  const before = [stored(h, h.first), stored(h, h.second)];
  for (const row of before) {
    const document = JSON.parse(row.document);
    assert.deepEqual(document.rankEvidence.metrics[0].sources, ["github_rest"]);
    assert.deepEqual(retainedRankHistory(document).metrics[0].sources, ["github_rest"]);
    // Canonicalization applies only to capture. A malformed retained receipt
    // must still fail rather than being silently repaired on read.
    document.rankEvidence.metrics[0].sources.push("github_rest");
    assert.throws(() => retainedRankHistory(document), /rank_history_integrity_error/);
  }
  const response = await h.runtime.app.inject(h.comparisonUrl);
  unavailable(response, "insufficient_history");
  assert.equal(response.json().comparison.snapshotId, h.first);
  const next = await restarted(h);
  try {
    const again = await next.runtime.app.inject(h.comparisonUrl);
    unavailable(again, "insufficient_history");
    assert.deepEqual(again.json(), response.json());
    assert.deepEqual([stored(h, h.first), stored(h, h.second)], before);
  } finally {
    await next.close();
  }
});
