import assert from "node:assert/strict";
import test from "node:test";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { harness, components, clock } from "./harness.mjs";

test("an issues-only configuration preserves retained legacy Project-history cache receipts", async (t) => {
  let historyNormalizations = 0;
  const h = await harness(t, {
    configure(config) {
      config.version = "synthetic-after-project-family-removal-v2";
    },
    fieldChangeNormalizationVersion: components.github.fieldChangeNormalizationVersion,
    normalizerFactory(options) {
      const ordinary = components.github.createGithubEvidenceNormalizer({
        client: options.githubClient,
        source: options.sourceId,
        allowedRepositoryIds: [2],
        isSynthetic: true,
      });
      return async (input) => {
        if (input.family !== "project_history") return ordinary(input);
        historyNormalizations++;
        return { facts: [], actors: [], evidence: [], reasons: [], isSynthetic: true };
      };
    },
  });
  assert.deepEqual(h.options.config.repositories[0].families, ["issues"]);
  assert.equal((await h.runtime.runOnce()).state, "published");

  // A previously collected family remains in the immutable ledger after the
  // approved configuration stops collecting it. No historical action is claimed.
  const collection = new components.ingestion.CollectionStore(h.db);
  const runId = "synthetic-retained-project-history";
  await collection.start({
    runId,
    repositoryId: 2,
    family: "project_history",
    mode: "reconcile",
    since: null,
    until: clock(),
  });
  assert.equal(
    await collection.step(runId, {
      readPage: async () => ({
        repositoryId: 2,
        visibility: "public",
        nextCursor: null,
        expectedCount: 1,
        facts: [
          {
            subjectId: "E_synthetic_retained",
            historySubjectId: "I_synthetic_retained",
            sourceRevision: "synthetic-retained-revision",
            sourceUrl: "https://github.com/synthetic-org/synthetic-repo/issues/1",
            evidence: "observed_transition",
            actorId: null,
            occurredAt: null,
            state: "present",
          },
        ],
      }),
    }),
    "complete",
  );
  const source = (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts WHERE first_run_id=$1", [runId]))
    .rows[0];
  await h.db.query("INSERT INTO leaderboard_pipeline.source_modes(fact_key,data_mode) VALUES($1,'synthetic')", [
    source.fact_key,
  ]);

  // Reconstruct the published pre-context namespace, deliberately independent
  // of whether the current configuration still names a Project source family.
  const legacySignature = comparisonHash([
    "verified-default-branch-merge-pins/v1",
    comparisonHash([
      "pipeline-private-attribution/v1",
      comparisonHash([
        "current-state-selection-v1",
        "synthetic",
        h.options.config.policies.map((entry) => entry.signature),
      ]),
    ]),
  ]);
  const legacyDocument = {
    projectHistoryNormalizationVersion: "collected-subject/v1",
    suppressArtifactIds: [],
    isSynthetic: true,
    facts: [],
    actors: [],
    evidence: [],
    assistance: [],
    participation: [],
    reasons: [],
  };
  await h.db.query(
    "INSERT INTO leaderboard_pipeline.normalizations(fact_key,policy_signature,document,document_hash) VALUES($1,$2,$3::jsonb,$4)",
    [source.fact_key, legacySignature, JSON.stringify(legacyDocument), comparisonHash(legacyDocument)],
  );
  const before = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2", [
      source.fact_key,
      legacySignature,
    ])
  ).rows[0];

  assert.equal((await h.runtime.runOnce()).state, "published");
  assert.equal(historyNormalizations, 1);
  const retained = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations WHERE fact_key=$1", [source.fact_key])
  ).rows;
  assert.equal(retained.length, 2);
  assert.deepEqual(
    retained.find((row) => row.policy_signature === legacySignature),
    before,
  );
  const current = retained.find((row) => row.policy_signature !== legacySignature);
  assert.ok(current, "new semantics need a separate cache key even without configured Project families");
  assert.equal(current.document.projectHistoryNormalizationVersion, "collected-subject/v2");
  assert.equal(current.document_hash, comparisonHash(current.document));
  assert.deepEqual(current.document.facts, []);
  assert.deepEqual(current.document.actors, []);
  assert.deepEqual(current.document.evidence, []);
  assert.deepEqual(
    (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts WHERE fact_key=$1", [source.fact_key])).rows[0],
    source,
  );
});
