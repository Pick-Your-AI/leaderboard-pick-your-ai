import assert from "node:assert/strict";
import test from "node:test";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { createPipeline } from "../src/index.mjs";
import { normalizationDocumentVersion } from "../src/private-attribution.mjs";
import { harness } from "./harness.mjs";

async function retainedContexts(t, count, bindSources) {
  const h = await harness(t, {
    authorizePolicyPreview: async () => true,
    policyComparisonAuthorityCurrent: () => true,
  });
  const publication = (await h.runtime.runOnce()).publications[0];
  const originals = (
    await h.db.query(
      `SELECT n.*,f.first_run_id,f.document AS source_document,f.observed_at
       FROM leaderboard_pipeline.normalizations AS n
       JOIN leaderboard_ingestion.source_facts AS f USING(fact_key) ORDER BY n.fact_key`,
    )
  ).rows;
  assert.equal(originals.length, 2);
  const seed = originals.find((row) => row.document.actors.some((actor) => actor.id === "101"));
  const context = {
    ...seed.document,
    facts: [],
    evidence: [],
    assistance: [],
    participation: [],
    reasons: ["synthetic_actor_context_without_credited_event"],
  };
  const contextHash = comparisonHash(context);
  const policySignature = comparisonHash([
    "current-state-selection-v1",
    "synthetic",
    h.config.policies.map((entry) => entry.signature),
  ]);
  const attributionSignature = comparisonHash([normalizationDocumentVersion, policySignature]);
  const standaloneLocaleSignature = comparisonHash([normalizationDocumentVersion, policySignature, []]);
  assert.equal(
    seed.policy_signature,
    comparisonHash([
      "project-membership-context/v1",
      comparisonHash(["verified-default-branch-merge-pins/v1", attributionSignature]),
      [],
    ]),
  );
  // These disposable actor-only source contexts carry no credited event. Their
  // identical documents still belong to distinct retained source observations.
  const addContexts = async (first, last) => {
    await h.db.query(
      `INSERT INTO leaderboard_ingestion.source_facts
       (fact_key,repository_id,family,subject_id,source_revision,document,first_run_id,observed_at)
       SELECT lpad(to_hex(i),64,'0'),2,'issues','SYNTHETIC_CONTEXT_'||i,'synthetic-context-v1',
         jsonb_set($1::jsonb,'{subjectId}',to_jsonb('SYNTHETIC_CONTEXT_'||i)),$2,$3
       FROM generate_series($4::int,$5::int) AS i`,
      [JSON.stringify(seed.source_document), seed.first_run_id, seed.observed_at, first, last],
    );
    await h.db.query(
      `INSERT INTO leaderboard_pipeline.source_modes(fact_key,data_mode)
       SELECT lpad(to_hex(i),64,'0'),'synthetic' FROM generate_series($1::int,$2::int) AS i`,
      [first, last],
    );
    await h.db.query(
      `INSERT INTO leaderboard_pipeline.normalizations(fact_key,policy_signature,document,document_hash)
       SELECT lpad(to_hex(i),64,'0'),$1,$2::jsonb,$3 FROM generate_series($4::int,$5::int) AS i`,
      [seed.policy_signature, JSON.stringify(context), contextHash, first, last],
    );
  };
  await addContexts(10000, 10000 + count - originals.length - 1);
  const frozen = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      publication.snapshotId,
    ])
  ).rows[0].document;
  frozen.identityAuthorization.identityEvidence.normalizationHashes.push(contextHash);
  if (bindSources)
    frozen.identityAuthorization.identityEvidence.normalizationSources = (
      await h.db.query(
        `SELECT fact_key,document_hash FROM leaderboard_pipeline.normalizations
         WHERE policy_signature=$1 ORDER BY fact_key`,
        [seed.policy_signature],
      )
    ).rows.map((row) => ({ factKey: row.fact_key, documentHash: row.document_hash }));
  const replaceFrozen = (document) =>
    h.db.query(
      "UPDATE leaderboard_pipeline.frozen_inputs SET document=$2::jsonb,document_hash=$3 WHERE snapshot_id=$1",
      [publication.snapshotId, JSON.stringify(document), comparisonHash(document)],
    );
  await replaceFrozen(frozen);
  const duplicateGeneration = (signature) =>
    h.db.query(
      `INSERT INTO leaderboard_pipeline.normalizations(fact_key,policy_signature,document,document_hash)
       SELECT fact_key,$1,document,document_hash FROM leaderboard_pipeline.normalizations
       WHERE policy_signature=$2 ON CONFLICT DO NOTHING`,
      [signature, seed.policy_signature],
    );
  const counts = async () =>
    (
      await h.db.query(
        `SELECT count(*)::int AS rows,count(DISTINCT fact_key)::int AS sources,
         count(DISTINCT document_hash)::int AS hashes FROM leaderboard_pipeline.normalizations`,
      )
    ).rows[0];
  const request = {
    snapshotId: publication.snapshotId,
    policy: { ...h.config.policies[0].policy, version: "synthetic-cache-migration-preview", rank: false },
    operatorId: "201",
  };
  return {
    h,
    seed,
    frozen,
    replaceFrozen,
    addContexts,
    duplicateGeneration,
    counts,
    request,
    policySignature,
    attributionSignature,
    standaloneLocaleSignature,
  };
}

test("legacy frozen identity admits 10,000 source pairs across cache generations and retains integrity and budget denial", async (t) => {
  const setup = await retainedContexts(t, 10000, false);
  const { h, seed, request, policySignature, attributionSignature } = setup;
  const before = await h.runtime.previewPolicy(request);
  assert.equal(before.comparison.before.rows.find((row) => row.actorId === "101").value, 1);
  await setup.duplicateGeneration(attributionSignature);
  await setup.duplicateGeneration(policySignature);
  await setup.duplicateGeneration(setup.standaloneLocaleSignature);
  assert.deepEqual(await setup.counts(), { rows: 40000, sources: 10000, hashes: 3 });
  await h.runtime.stop();
  await h.reopenDatabase();
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  assert.deepEqual(await restarted.previewPolicy(request), before);
  assert.doesNotMatch(
    JSON.stringify(before),
    /normalizationSources|factKey|documentHash|githubNodeId|githubDatabaseId/,
  );

  // A valid copy must not hide corruption in another accepted cache generation.
  await h.db.query(
    `UPDATE leaderboard_pipeline.normalizations
     SET document=jsonb_set(document,'{actors,0,githubNodeId}','"U_SYNTHETIC_TAMPERED"'::jsonb)
     WHERE fact_key=$1 AND policy_signature=$2`,
    [seed.fact_key, attributionSignature],
  );
  await assert.rejects(restarted.previewPolicy(request), /Frozen identity evidence integrity failure/);
  await h.db.query(
    "UPDATE leaderboard_pipeline.normalizations SET document=$3::jsonb WHERE fact_key=$1 AND policy_signature=$2",
    [seed.fact_key, attributionSignature, JSON.stringify(seed.document)],
  );
  await setup.addContexts(20000, 20000);
  await setup.duplicateGeneration(attributionSignature);
  await setup.duplicateGeneration(policySignature);
  await setup.duplicateGeneration(setup.standaloneLocaleSignature);
  assert.deepEqual(await setup.counts(), { rows: 40004, sources: 10001, hashes: 3 });
  await assert.rejects(restarted.previewPolicy(request), /Frozen identity evidence unavailable/);
});

test("exact frozen source bindings survive duplicate cache generations without accepting a missing bound source", async (t) => {
  const setup = await retainedContexts(t, 5001, true);
  const { h, request } = setup;
  const before = await h.runtime.previewPolicy(request);
  await setup.duplicateGeneration(setup.attributionSignature);
  assert.deepEqual(await setup.counts(), { rows: 10002, sources: 5001, hashes: 3 });
  await h.runtime.stop();
  await h.reopenDatabase();
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  assert.deepEqual(await restarted.previewPolicy(request), before);
  const missing = structuredClone(setup.frozen);
  missing.identityAuthorization.identityEvidence.normalizationSources[0].factKey = "f".repeat(64);
  await setup.replaceFrozen(missing);
  await assert.rejects(restarted.previewPolicy(request), /Frozen identity evidence unavailable/);
});
