import assert from "node:assert/strict";
import test from "node:test";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { createPipeline } from "../src/index.mjs";
import { harness, components } from "./harness.mjs";

const initialClassification = {
  schemaVersion: "leaderboard-service-account/v1",
  classificationId: "synthetic-source-time-review",
  githubDatabaseId: 101,
  githubNodeId: "U_SYNTHETIC_A",
  source: "reviewed_configuration",
  evidenceIds: ["synthetic-source-time-evidence"],
  reviewerActorId: "202",
  reviewedAt: "2026-01-01T00:00:00Z",
};

const reviewTime = (observedAt, kind) => {
  const source = new Date(observedAt).toISOString();
  if (kind === "later") return source.replace(/Z$/, "000001Z");
  if (kind === "equal") return source.replace(/Z$/, "000000Z");
  return new Date(Date.parse(source) + 2 * 60 * 60 * 1000).toISOString().replace(/Z$/, "000000+02:00");
};

async function retainedClassification(t, kind, bindSources = false) {
  let normalizations = 0;
  const h = await harness(t, {
    // The metric cutoff is later than the immutable source observation. It must
    // not repair a classification reviewed after that earlier observation.
    now: () => new Date(Date.now() + 2000).toISOString(),
    authorizePolicyPreview: async () => true,
    normalizerFactory: (options) => {
      const normalize = components.github.createGithubEvidenceNormalizer({
        client: options.githubClient,
        source: options.sourceId,
        allowedRepositoryIds: [2],
        isSynthetic: true,
        reviewedServiceAccounts: [initialClassification],
        authorizedClassifierIds: ["202"],
      });
      return async (input) => {
        normalizations++;
        return normalize(input);
      };
    },
  });
  const publication = (await h.runtime.runOnce()).publications[0];
  assert.equal(normalizations, 2);
  const rows = (
    await h.db.query(
      `SELECT n.*,f.observed_at,f.first_run_id,f.document AS source_document
       FROM leaderboard_pipeline.normalizations AS n
       JOIN leaderboard_ingestion.source_facts AS f USING(fact_key) ORDER BY n.fact_key`,
    )
  ).rows;
  const source = rows.find((row) => row.document.actors.some((actor) => actor.id === "101"));
  const document = structuredClone(source.document);
  const classification = document.actors.find((actor) => actor.id === "101").serviceAccountClassification;
  classification.reviewedAt = reviewTime(source.observed_at, kind);
  components.contracts.serviceAccountClassificationSchema.parse(classification);
  const documentHash = comparisonHash(document);
  const frozen = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      publication.snapshotId,
    ])
  ).rows[0].document;
  assert.ok(components.contracts.compareSourceInstants(classification.reviewedAt, frozen.frozen.cutoff) < 0);

  // Model a correctly hashed legacy normalization and frozen receipt in this
  // disposable database. Production denial must preserve these historical bytes.
  await h.db.query(
    "UPDATE leaderboard_pipeline.normalizations SET document=$3::jsonb,document_hash=$4 WHERE fact_key=$1 AND policy_signature=$2",
    [source.fact_key, source.policy_signature, JSON.stringify(document), documentHash],
  );
  const binding = frozen.identityAuthorization.identityEvidence;
  binding.normalizationHashes = binding.normalizationHashes
    .map((hash) => (hash === source.document_hash ? documentHash : hash))
    .sort();
  if (bindSources)
    binding.normalizationSources = rows.map((row) => ({
      factKey: row.fact_key,
      documentHash: row.fact_key === source.fact_key ? documentHash : row.document_hash,
    }));
  else delete binding.normalizationSources;
  const saveFrozen = () =>
    h.db.query(
      "UPDATE leaderboard_pipeline.frozen_inputs SET document=$2::jsonb,document_hash=$3 WHERE snapshot_id=$1",
      [publication.snapshotId, JSON.stringify(frozen), comparisonHash(frozen)],
    );
  await saveFrozen();
  const stored = async () => {
    const result = {};
    for (const [name, query] of [
      ["sources", "SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key"],
      ["normalizations", "SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature"],
      ["frozen", "SELECT * FROM leaderboard_pipeline.frozen_inputs ORDER BY snapshot_id"],
      [
        "snapshots",
        "SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id",
      ],
      ["heads", "SELECT * FROM leaderboard_pipeline.heads ORDER BY scope_key"],
    ])
      result[name] = (await h.db.query(query)).rows;
    result.privateInputs = h.controlsStore.db.prepare("SELECT * FROM policy_preview_inputs ORDER BY id").all();
    return result;
  };
  const restart = async () => {
    await h.runtime.stop();
    await h.reopenDatabase();
    h.runtime = await createPipeline(h.options);
    t.after(() => h.runtime.stop());
  };
  const request = {
    snapshotId: publication.snapshotId,
    policy: { ...h.config.policies[0].policy, version: "synthetic-source-time-preview", rank: false },
    operatorId: "201",
  };
  return {
    h,
    source,
    document,
    documentHash,
    frozen,
    saveFrozen,
    stored,
    restart,
    request,
    normalizationCount: () => normalizations,
  };
}

for (const kind of ["later", "equal", "offset"])
  test(`cached classification keeps its source observation cutoff across restart: ${kind}`, async (t) => {
    const setup = await retainedClassification(t, kind);
    const before = await setup.stored();
    for (const restarted of [false, true]) {
      if (restarted) await setup.restart();
      if (kind === "later") {
        await assert.rejects(setup.h.runtime.runOnce(), /conflicting_actor_metadata/);
        assert.deepEqual(await setup.stored(), before);
      } else {
        const published = (await setup.h.runtime.runOnce()).publications[0];
        assert.equal(published.comparisonInput.state, "retained");
        const input = setup.h.runtime.policyComparisons.comparisons.input(published.comparisonInput.inputId);
        assert.equal(input.input.actors.find((actor) => actor.id === "101").kind, "service_account");
        assert.deepEqual((await setup.stored()).normalizations, before.normalizations);
      }
      assert.equal(setup.normalizationCount(), 2, "the actual cached path must not re-normalize the sources");
    }
  });

for (const bindSources of [false, true])
  for (const kind of ["later", "equal", "offset"])
    test(`frozen classification preserves its source cutoff: sources=${bindSources}, ${kind}`, async (t) => {
      const setup = await retainedClassification(t, kind, bindSources);
      const before = await setup.stored();
      for (const restarted of [false, true]) {
        if (restarted) await setup.restart();
        if (kind === "later")
          await assert.rejects(setup.h.runtime.previewPolicy(setup.request), /Frozen identity evidence conflict/);
        else {
          const preview = await setup.h.runtime.previewPolicy(setup.request);
          assert.equal(preview.comparison.before.rows.find((row) => row.actorId === "101").value, 1);
          assert.doesNotMatch(JSON.stringify(preview), /serviceAccountClassification|reviewedAt|normalizationSources/);
        }
        assert.deepEqual(await setup.stored(), before);
        assert.equal(setup.normalizationCount(), 2);
      }
    });

for (const bindSources of [false, true])
  test(`one valid retained classification cannot hide an earlier invalid source copy: sources=${bindSources}`, async (t) => {
    const setup = await retainedClassification(t, "equal", bindSources);
    const { h, source, document, documentHash, frozen } = setup;
    assert.equal(
      (await h.runtime.previewPolicy(setup.request)).comparison.before.rows.find((row) => row.actorId === "101").value,
      1,
    );
    const factKey = "e".repeat(64);
    const earlier = new Date(new Date(source.observed_at).getTime() - 1).toISOString();
    // A second retained source may carry the identical normalized hash. Its own
    // observation boundary still applies, even beside the valid original copy.
    await h.db.query(
      `INSERT INTO leaderboard_ingestion.source_facts
       (fact_key,repository_id,family,subject_id,source_revision,document,first_run_id,observed_at)
       VALUES($1,2,'issues','SYNTHETIC_EARLIER_CLASSIFICATION','synthetic-review-time-v1',$2::jsonb,$3,$4)`,
      [factKey, JSON.stringify(source.source_document), source.first_run_id, earlier],
    );
    await h.db.query(
      "INSERT INTO leaderboard_pipeline.normalizations(fact_key,policy_signature,document,document_hash) VALUES($1,$2,$3::jsonb,$4)",
      [factKey, source.policy_signature, JSON.stringify(document), documentHash],
    );
    if (bindSources) frozen.identityAuthorization.identityEvidence.normalizationSources.push({ factKey, documentHash });
    await setup.saveFrozen();
    const before = await setup.stored();
    await assert.rejects(h.runtime.previewPolicy(setup.request), /Frozen identity evidence conflict/);
    assert.deepEqual(await setup.stored(), before);
    await setup.restart();
    await assert.rejects(setup.h.runtime.previewPolicy(setup.request), /Frozen identity evidence conflict/);
    assert.deepEqual(await setup.stored(), before);
  });
