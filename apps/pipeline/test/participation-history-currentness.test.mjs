import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { harness, components, publicScope } from "./harness.mjs";

const origin = "2020-01-01T00:00:00.000Z";
const scope = { ...publicScope, repository: "2" };
const hash = (value) => createHash("sha256").update(components.metrics.stableJSON(value)).digest("hex");
const deferred = () => {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};
const waitFor = (promise) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("synthetic host boundary not reached")), 5000);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });

// These real stored publications deliberately need no accepted recognition: the
// tests inspect the private paired-read boundary, not a fabricated known result.
async function fixture(t, { extraHistoryIssue = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "synthetic-history-currentness-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cutoff = new Date(Date.now() + 60_000).toISOString();
  const repositories = [
    { id: 2, slug: "synthetic-org/synthetic-repo" },
    { id: 3, slug: "synthetic-org/synthetic-other" },
  ];
  let requests = 0,
    epoch = "synthetic-currentness-1",
    admission = null,
    onEpoch = () => {},
    onResolve = async () => {};
  const githubClient = new components.github.GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => "synthetic-test-token",
    maxRetries: 0,
    checkpoints: new components.github.FileCheckpointStore(join(directory, "cache")),
    fetch: async (value) => {
      requests++;
      const path = new URL(value).pathname;
      const repo = repositories.find(
        (entry) => path === `/repos/${entry.slug}` || path.startsWith(`/repos/${entry.slug}/`),
      );
      assert.ok(repo);
      const issues = Array.from({ length: extraHistoryIssue && repo.id === 3 ? 2 : 1 }, (_, index) => ({
        id: 1000 + repo.id + index * 100,
        node_id: `SYNTHETIC_HISTORY_CURRENT_${repo.id}${index ? "_SECOND" : ""}`,
        number: index + 1,
        title: "Synthetic currentness",
        html_url: `https://github.com/${repo.slug}/issues/${index + 1}`,
        created_at: "2020-01-02T00:00:00.000Z",
        updated_at: "2020-01-02T00:00:00.000Z",
        user: { id: 101, node_id: "U_SYNTHETIC_HISTORY_101", login: "synthetic-history-user", type: "User" },
      }));
      const body =
        path === `/repos/${repo.slug}`
          ? { id: repo.id, private: false, full_name: repo.slug, default_branch: "main" }
          : path === `/repos/${repo.slug}/issues`
            ? issues
            : issues.find((issue) => path === `/repos/${repo.slug}/issues/${issue.number}`);
      assert.ok(body, `Unexpected synthetic request ${path}`);
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    },
  });
  const h = await harness(t, {
    githubClient,
    source: undefined,
    probeRepository: undefined,
    now: () => cutoff,
    participationHistoryAuthority: {
      epoch: () => {
        onEpoch();
        return epoch;
      },
      resolve: async (request, signal) => {
        await onResolve(request, signal);
        return structuredClone(admission);
      },
    },
    configure(config) {
      config.repositories.push({
        id: 3,
        installationId: 1,
        slug: repositories[1].slug,
        families: ["issues"],
        approvalReceipt: "synthetic-other-approval",
      });
      config.scopes = [publicScope, scope];
    },
  });
  assert.equal((await h.runtime.runOnce({ cutoff })).state, "published");
  const snapshots = (await h.db.query("SELECT snapshot_id,document FROM leaderboard_pipeline.snapshots")).rows;
  const find = (selectedScope) => {
    const rows = snapshots.filter(
      (row) =>
        components.contracts.publicScopeKey(row.document.scope) === components.contracts.publicScopeKey(selectedScope),
    );
    assert.equal(rows.length, 1);
    return rows[0];
  };
  const selected = find(scope),
    history = find(publicScope);
  const frozen = (await h.db.query("SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.frozen_inputs"))
    .rows;
  const binding = (row) => ({
    snapshotId: row.snapshot_id,
    revision: row.document.snapshot.revision,
    sha256: frozen.find((entry) => entry.snapshot_id === row.snapshot_id).document_hash,
    cutoff,
  });
  const inventory = [
    { repositoryId: "2", source: "github_rest" },
    { repositoryId: "3", source: "github_rest" },
  ];
  const policy = h.config.policies[0];
  admission = {
    schemaVersion: "pipeline-participation-history-admission/v1",
    selectedInput: binding(selected),
    historyInput: binding(history),
    admission: {
      decisionId: "synthetic-currentness-admission",
      organization: "Pick-Your-AI",
      origin,
      reviewedAt: origin,
      sourceInventory: inventory,
      policies: [
        {
          metricId: policy.policy.metricId,
          version: policy.policy.version,
          signature: hash(policy.policy),
          roles: [...policy.policy.roles],
          sources: [...policy.policy.sources],
        },
      ],
    },
    coverage: inventory.map(({ repositoryId, source }) => ({
      schemaVersion: "leaderboard/v1",
      state: "complete",
      source,
      scopeId: repositoryId,
      windowStart: origin,
      windowEnd: cutoff,
      knownStart: origin,
      lastSuccessfulSync: cutoff,
      sourceWatermark: cutoff,
      missingPages: 0,
      permissionsMissing: [],
      sourceErrors: [],
    })),
    proofSources: history.document.portfolioEvidence.map((entry) => ({
      contributionId: entry.contribution.contributionId,
      repositoryId: entry.artifact.repositoryId,
      source: "github_rest",
    })),
    unresolved: [],
  };
  const abort = new AbortController();
  const read = () => h.runtime.source.readParticipationHistory(scope, selected.snapshot_id, "101", abort.signal);
  assert.ok((await read()).history);
  return {
    ...h,
    selected,
    history,
    admission,
    abort,
    read,
    requests: () => requests,
    revoke: () => {
      epoch = null;
    },
    onResolve: (callback) => {
      onResolve = callback;
    },
    onEpoch: (callback) => {
      onEpoch = callback;
    },
    url: `/api/v1/contributors/101/participation-history?repository=2&snapshot=${selected.snapshot_id}`,
  };
}

for (const change of [
  "unchanged",
  "host epoch",
  "abort",
  "profile",
  "history head",
  "history confirmation",
  "retirement tombstone",
  "history explanation",
])
  test(`actual COMMIT return fence checks ${change}`, async (t) => {
    const h = await fixture(t);
    const transaction = h.db.transaction.bind(h.db),
      reads = h.requests();
    let completed = 0;
    h.db.transaction = async (work) => {
      const result = await transaction(work);
      if (++completed !== 2) return result;
      assert.ok(result.history, "the actual transaction produced a valid pair before its return boundary");
      if (change === "host epoch") h.revoke();
      else if (change === "abort") h.abort.abort();
      else if (change === "retirement tombstone") {
        h.controlsStore.db.exec(
          "CREATE TABLE IF NOT EXISTS pipeline_derived_retirements(operation_id TEXT PRIMARY KEY,repository_id INTEGER NOT NULL UNIQUE,authority_hash TEXT NOT NULL,source_generation TEXT NOT NULL)",
        );
        h.controlsStore.db
          .prepare("INSERT INTO pipeline_derived_retirements VALUES(?,3,?,?)")
          .run("synthetic-history-retired", "synthetic-authority", "1");
      } else if (change === "history explanation")
        h.controlsStore.db
          .prepare("DELETE FROM pipeline_aggregate_explanations WHERE snapshot_id=?")
          .run(h.history.snapshot_id);
      else if (change !== "unchanged")
        h.controlsStore.transaction((state) => {
          if (change === "profile") state.profiles["101"] = { suppressed: true };
          else if (change === "history head")
            delete state.pipelineHeads[components.contracts.publicScopeKey(publicScope)];
          else delete state.pipelinePublications[h.history.snapshot_id];
        });
      return result;
    };
    try {
      if (change === "retirement tombstone") await assert.rejects(h.read(), /pipeline_repository_retired/);
      else if (change === "history explanation") await assert.rejects(h.read(), /aggregate_explanation_required/);
      else {
        const result = await h.read();
        if (change === "unchanged") assert.ok(result.history);
        else assert.equal(result, null, "a detached pre-COMMIT pair must not escape a changed private authority");
      }
      assert.equal(completed, 2);
      assert.equal(h.requests(), reads);
    } finally {
      h.db.transaction = transaction;
    }
  });

test("the final same-epoch callback cannot return a pair after changing a separate private dependency", async (t) => {
  const h = await fixture(t),
    privateState = h.controlsStore.read(),
    reads = h.requests();
  for (const change of ["retirement tombstone", "history explanation", "abort"])
    await t.test(change, async () => {
      const transaction = h.db.transaction.bind(h.db);
      let completed = 0,
        afterCommit = false,
        postCommitEpochCalls = 0;
      h.controlsStore.db.exec("SAVEPOINT synthetic_final_history_epoch");
      h.db.transaction = async (work) => {
        const result = await transaction(work);
        if (++completed === 2) {
          assert.ok(result.history, "the actual second transaction produced a valid pair");
          afterCommit = true;
        }
        return result;
      };
      h.onEpoch(() => {
        if (!afterCommit || ++postCommitEpochCalls !== 2) return;
        assert.equal(completed, 2, "the mutation occurs in the final epoch callback after the real COMMIT");
        if (change === "retirement tombstone") {
          h.controlsStore.db.exec(
            "CREATE TABLE IF NOT EXISTS pipeline_derived_retirements(operation_id TEXT PRIMARY KEY,repository_id INTEGER NOT NULL UNIQUE,authority_hash TEXT NOT NULL,source_generation TEXT NOT NULL)",
          );
          h.controlsStore.db
            .prepare("INSERT INTO pipeline_derived_retirements VALUES(?,3,?,?)")
            .run("synthetic-final-epoch-retired", "synthetic-authority", "1");
        } else if (change === "history explanation")
          h.controlsStore.db
            .prepare("DELETE FROM pipeline_aggregate_explanations WHERE snapshot_id=?")
            .run(h.history.snapshot_id);
        else h.abort.abort();
      });
      try {
        let result, failure;
        try {
          result = await h.read();
        } catch (error) {
          failure = error;
        }
        assert.equal(postCommitEpochCalls, 2, "the same-epoch final callback actually executed");
        assert.deepEqual(h.controlsStore.read(), privateState, "the canonical controls alone did not change");
        assert.equal(h.requests(), reads, "the private read performs no additional source collection");
        if (change === "abort") {
          assert.equal(failure, undefined);
          assert.equal(result, null, "aborting in the last callback must withhold the captured pair");
        } else
          assert.match(
            failure?.message ?? "no failure",
            change === "retirement tombstone" ? /pipeline_repository_retired/ : /aggregate_explanation_required/,
          );
      } finally {
        h.onEpoch(() => {});
        h.db.transaction = transaction;
        h.controlsStore.db.exec("ROLLBACK TO synthetic_final_history_epoch; RELEASE synthetic_final_history_epoch");
      }
    });
});

for (const change of ["unchanged", "lifecycle", "installation", "generation", "project denial", "issue field denial"])
  test(`host wait releases SQL locks and rechecks full-inventory ${change}`, async (t) => {
    const h = await fixture(t),
      reached = deferred(),
      release = deferred();
    const original = h.controlsStore.read(),
      reads = h.requests();
    const transaction = h.db.transaction.bind(h.db);
    let completed = 0;
    h.db.transaction = async (work) => {
      const result = await transaction(work);
      completed++;
      return result;
    };
    h.onResolve(async () => {
      reached.resolve();
      await release.promise;
    });
    const pending = h.runtime.app.inject(h.url);
    try {
      await waitFor(reached.promise);
      assert.equal(completed, 1, "the asynchronous host decision runs after the real first COMMIT");
      if (change === "lifecycle")
        await waitFor(
          h.db.query(
            "UPDATE leaderboard_ingestion.repository_access SET state='unavailable',generation=generation+1 WHERE repository_id=3",
          ),
        );
      else if (change === "installation")
        await waitFor(
          h.db.query("UPDATE leaderboard_ingestion.repository_access SET installation_id=3 WHERE repository_id=3"),
        );
      else if (change === "generation")
        await waitFor(
          h.db.query(
            "UPDATE leaderboard_ingestion.repository_access SET generation=generation+1 WHERE repository_id=3",
          ),
        );
      else if (change.endsWith("denial")) {
        const kind = change === "project denial" ? "project_scope_denial" : "issue_field_scope_denial";
        const prefix = change === "project denial" ? "project-scope-denial" : "issue-field-scope-denial";
        const key = `${prefix}:3:${hash(h.config.version)}`;
        const document = { repositoryId: 3, configurationVersion: h.config.version, reason: kind };
        await waitFor(
          h.db.query(
            "INSERT INTO leaderboard_pipeline.receipts(receipt_id,operation_key,kind,document,document_hash,operation_hash) VALUES($1,$2,$3,$4::jsonb,$5,pg_catalog.sha256(pg_catalog.convert_to($2,'UTF8')))",
            [hash(key), key, kind, JSON.stringify(document), hash(document)],
          ),
        );
      }
      assert.deepEqual(
        h.controlsStore.read(),
        original,
        "unselected-repository SQL changes need not advance private controls",
      );
      release.resolve();
      const response = await pending;
      assert.equal(
        response.statusCode,
        change === "unchanged"
          ? 200
          : ["generation", "project denial", "issue field denial"].includes(change)
            ? 503
            : 410,
        response.body,
      );
      if (response.statusCode === 410) assert.equal(response.json().error, "snapshot_expired_refetch");
      if (response.statusCode === 503) assert.equal(response.json().error, "public_projection_unavailable");
      if (change !== "unchanged") assert.equal(response.json().history, undefined);
      assert.equal(h.requests(), reads);
    } finally {
      release.resolve();
      h.db.transaction = transaction;
      await pending;
    }
  });

test("a newly suppressed history-only artifact reaches both paired control sets", async (t) => {
  const h = await fixture(t),
    reached = deferred(),
    release = deferred();
  h.onResolve(async () => {
    reached.resolve();
    await release.promise;
  });
  const original = h.controlsStore.read(),
    pending = h.read();
  try {
    await waitFor(reached.promise);
    await waitFor(
      h.db.query(
        "INSERT INTO leaderboard_ingestion.object_suppressions(repository_id,subject_id,reason) VALUES(3,'SYNTHETIC_HISTORY_CURRENT_3','unavailable')",
      ),
    );
    assert.deepEqual(h.controlsStore.read(), original);
    release.resolve();
    const paired = await pending;
    assert.ok(paired.history);
    assert.ok(paired.current.controls.suppressedArtifactIds.includes("SYNTHETIC_HISTORY_CURRENT_3"));
    assert.deepEqual(paired.current.controls, paired.history.publication.controls);
  } finally {
    release.resolve();
    await pending;
  }
});

for (const damaged of ["selected snapshot", "history snapshot", "frozen history", "normalization aggregate"])
  test(`SQL byte admission withholds ${damaged} before returning its JSON`, async (t) => {
    const h = await fixture(t, { extraHistoryIssue: damaged === "normalization aggregate" });
    if (damaged.endsWith("snapshot"))
      await h.db.query(
        "UPDATE leaderboard_pipeline.snapshots SET document=jsonb_set(document,'{syntheticPadding}',to_jsonb(repeat('x',8000001))) WHERE snapshot_id=$1",
        [damaged === "selected snapshot" ? h.selected.snapshot_id : h.history.snapshot_id],
      );
    else if (damaged === "frozen history")
      await h.db.query(
        "UPDATE leaderboard_pipeline.frozen_inputs SET document=jsonb_set(document,'{syntheticPadding}',to_jsonb(repeat('x',8000001))) WHERE snapshot_id=$1",
        [h.history.snapshot_id],
      );
    else {
      await h.db.query(
        "UPDATE leaderboard_pipeline.normalizations SET document=jsonb_set(document,'{syntheticPadding}',to_jsonb(repeat('x',4000001))) WHERE fact_key IN (SELECT fact_key FROM leaderboard_ingestion.source_facts WHERE repository_id=3)",
      );
      const footprint = (
        await h.db.query(
          "SELECT max(octet_length(document::text)) AS largest,sum(octet_length(document::text)) AS total FROM leaderboard_pipeline.normalizations WHERE fact_key IN (SELECT fact_key FROM leaderboard_ingestion.source_facts WHERE repository_id=3)",
        )
      ).rows[0];
      assert.ok(
        Number(footprint.largest) < 8_000_000 && Number(footprint.total) > 8_000_000,
        "the aggregate bound is stricter than an individual document bound",
      );
    }
    const transaction = h.db.transaction.bind(h.db);
    let deniedJSON = 0;
    h.db.transaction = (work) =>
      transaction((tx) =>
        work({
          query: async (sql, params) => {
            const result = await tx.query(sql, params);
            if (sql.includes("CASE WHEN") && result.rows.some((row) => row.document === null)) {
              deniedJSON++;
              if (damaged.endsWith("snapshot"))
                assert.equal(
                  result.rows[0].head_document,
                  null,
                  "both selected and latest snapshot projections are bounded",
                );
            }
            return result;
          },
        }),
      );
    try {
      await assert.rejects(
        h.read(),
        /participation_history_(snapshot_budget_exceeded|normalization_budget_exceeded|input_unavailable)|operator_publication_proof_budget_exceeded/,
      );
      assert.ok(deniedJSON > 0, "the actual SQL result contains null instead of the oversized stored JSON");
    } finally {
      h.db.transaction = transaction;
    }
  });

test("missing immutable normalization evidence cannot borrow a current publication confirmation", async (t) => {
  const h = await fixture(t);
  await h.db.query(
    "DELETE FROM leaderboard_pipeline.normalizations WHERE fact_key IN (SELECT fact_key FROM leaderboard_ingestion.source_facts WHERE repository_id=3)",
  );
  await assert.rejects(h.read(), /Frozen identity evidence unavailable/);
});
