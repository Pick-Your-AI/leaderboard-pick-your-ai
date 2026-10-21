import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { applyRecognitionReceipt } from "@pick-your-ai/github";
import { maintenanceClassificationVersion } from "@pick-your-ai/contracts";
import { aggregateMetric, metricRegistryV1 } from "@pick-your-ai/metrics";
import { hasRequiredParticipantConsent } from "../../controls/src/evidence-consent.mjs";
import { evidenceIntakeAuthority } from "../../controls/src/evidence-intake.mjs";
import { attachSyntheticEvidenceIntake } from "../../../tests/fixtures/evidence-intake.mjs";
import { validateMaintenanceClassificationBinding } from "../src/maintenance-classification.mjs";
import { recognitionFingerprint } from "../src/recognition-adapter.mjs";
import {
  authoredNotesScenario as scenario,
  authoredNotesProof as proof,
  materializeAuthoredNotes as run,
  refreshAuthoredNotesReview as refresh,
  notesAcceptedReasons,
  notesCandidate,
  notesPurpose,
  notesDomainReasons,
  notesPathReason,
  notesMergeTime,
  notesReviewTime,
  notesCutoff,
} from "../../../tests/fixtures/authored-release-notes.mjs";

test("authored notes review: current exact source/detail/reference approval adds only the fixed purpose", () => {
  const s = scenario(),
    original = structuredClone(s.input);
  let calls = 0;
  const out = run(s, (input, receipt, reviewers) => {
    calls++;
    assert.equal(receipt.documentationPurpose, "release_notes");
    assert.equal(receipt.sourceRevision, s.evidence.sourceRevision);
    return applyRecognitionReceipt(input, receipt, reviewers);
  });
  assert.equal(calls, 1);
  const accepted = proof(out);
  assert.deepEqual(accepted.evidence.contribution.reasonCodes, notesAcceptedReasons);
  assert.equal(accepted.fact.occurredAt, notesMergeTime);
  assert.equal(accepted.evidence.occurredAt, notesMergeTime);
  assert.equal(accepted.fact.acceptedAt, notesReviewTime);
  assert.equal(accepted.fact.actorId, s.target.actorId);
  assert.deepEqual(s.input, original);
  assert.doesNotMatch(
    JSON.stringify(accepted.evidence),
    /fixture-notes-request|fixture-notes-review|sourceUseReview|reviewedInputDigest|docs\/releases|substantiveReview/,
  );
});
test("authored notes review: positive purpose conserves the existing documentation unit and amount", () => {
  const s = scenario({
    files: [
      { path: "docs/releases/one.md", additions: 10, deletions: 0 },
      { path: "docs/releases/two.md", additions: 0, deletions: 3 },
    ],
  });
  const classified = run(s),
    generic = structuredClone(s);
  delete generic.binding.documentationPurpose;
  const old = proof(run(generic)),
    current = proof(classified);
  assert.equal(current.fact.id, old.fact.id);
  assert.equal(current.fact.canonicalKey, old.fact.canonicalKey);
  const from = "2026-10-01T00:00:00.000Z";
  const aggregate = aggregateMetric(
    {
      datasetId: "fixture-notes",
      cutoff: notesCutoff,
      backfillRevision: "v1",
      repositoryIds: ["2"],
      actors: classified.actors,
      facts: classified.facts,
      coverage: [
        {
          schemaVersion: "leaderboard/v1",
          state: "complete",
          source: "github_rest",
          scopeId: "2",
          windowStart: from,
          windowEnd: notesCutoff,
          knownStart: from,
          lastSuccessfulSync: notesCutoff,
          sourceWatermark: notesCutoff,
          missingPages: 0,
          permissionsMissing: [],
          sourceErrors: [],
        },
      ],
    },
    s.policies[0].policy,
    {
      timezone: "UTC",
      from,
      to: notesCutoff,
      repos: [],
      projects: [],
      workstreams: [],
      roles: [],
      actors: "all",
      context: "event",
    },
  );
  assert.equal(aggregate.rows[0].value, 1);
  assert.ok(current.evidence.contribution.reasonCodes.includes(notesPurpose));
});
test("authored notes review: unselected and omitted private purpose stay ordinary documentation", () => {
  for (const mode of ["unselected", "narrative"]) {
    const s = scenario();
    if (mode === "unselected") delete s.binding.documentationPurpose;
    else {
      s.request.detail = "Reviewed documentation without a specific notes purpose.";
      attachSyntheticEvidenceIntake(s.request);
      s.state.audit = [structuredClone(s.decision)];
    }
    assert.deepEqual(proof(run(s)).evidence.contribution.reasonCodes, [
      "independent_recognition_receipt",
      ...notesDomainReasons,
      notesPathReason,
    ]);
  }
});
for (const [name, mutate] of [
  ["different purpose", (s) => (s.purpose.purpose = "release_publication")],
  ["unsupported schema", (s) => (s.purpose.schemaVersion = "documentation-purpose/v2")],
  ["wrong source fact", (s) => (s.purpose.targetFactId = "unrelated-source")],
  ["wrong immutable revision", (s) => (s.purpose.sourceRevision = "d".repeat(40))],
  ["different path policy", (s) => (s.purpose.pathPolicyVersion = "old-paths-v0")],
  ["extra private field", (s) => (s.purpose.secret = "PRIVATE_PURPOSE")],
  ["reviewed category disagreement", (s) => (s.purpose.details.category = "guide")],
  ["false authored declaration", (s) => (s.purpose.details.authorship = "generated")],
  ["missing substantive review", (s) => (s.purpose.details.substantiveReview = false)],
  [
    "source candidate missing",
    (s) =>
      (s.evidence.contribution.reasonCodes = s.evidence.contribution.reasonCodes.filter((x) => x !== notesCandidate)),
  ],
  ["duplicate source candidate", (s) => s.evidence.contribution.reasonCodes.push(notesCandidate)],
  [
    "contradictory source purpose",
    (s) => s.evidence.contribution.reasonCodes.push("documentation_purpose_candidate:publication"),
  ],
  ["source role disagreement", (s) => (s.evidence.contribution.roles = ["merger"])],
  ["source clock disagreement", (s) => (s.evidence.occurredAt = notesReviewTime)],
])
  test("authored notes review: " + name + " fails before any host receipt callback", () => {
    const s = scenario();
    mutate(s);
    refresh(s);
    let calls = 0;
    assert.throws(
      () =>
        run(s, () => {
          calls++;
          return s.input;
        }),
      /documentation.purpose|domain.recognition/i,
    );
    assert.equal(calls, 0);
  });
test("authored notes review: unrelated permitted references cannot approve the immutable notes source", () => {
  const s = scenario();
  refresh(s, [{ locator: s.request.locator, revision: "different-reviewed-source" }]);
  let calls = 0;
  assert.throws(
    () =>
      run(s, () => {
        calls++;
        return s.input;
      }),
    /documentation.purpose/i,
  );
  assert.equal(calls, 0);
});
for (const status of ["pending", "rejected", "withdrawn", "appealed"]) {
  test("authored notes review: " + status + " authority preserves the unchanged source and makes no callback", () => {
    const s = scenario();
    s.request.status = status;
    let calls = 0;
    assert.deepEqual(
      run(s, () => {
        calls++;
        return s.input;
      }),
      s.input,
    );
    assert.equal(calls, 0);
  });
}
test("authored notes review: changed detail cannot reuse its earlier accepted digest", () => {
  const s = scenario();
  s.purpose.pathPolicyVersion = "later-path-policy";
  s.request.detail = JSON.stringify(s.purpose);
  let calls = 0;
  assert.deepEqual(
    run(s, () => {
      calls++;
      return s.input;
    }),
    s.input,
  );
  assert.equal(calls, 0);
});
test("authored notes review: review before merge cannot acquire a later source", () => {
  const s = scenario();
  s.decision.at = Date.parse(notesMergeTime) - 1;
  refresh(s);
  let calls = 0;
  assert.throws(() =>
    run(s, () => {
      calls++;
      return s.input;
    }),
  );
  assert.equal(calls, 0);
});
for (const reverse of [false, true])
  test("authored notes review: receipt aliases keep earliest purpose and one unit in order " + reverse, () => {
    const s = scenario(),
      later = scenario();
    later.request.id += "-later";
    later.decision.id += "-later";
    later.decision.at += 1000;
    refresh(later);
    s.binding.domainEvidence.records.push(later.record);
    const requests = [s.request, later.request];
    if (reverse) requests.reverse();
    s.state.requests = Object.fromEntries(requests.map((x) => [x.id, x]));
    s.state.audit.push(later.decision);
    let calls = 0;
    const result = proof(
      run(s, (...args) => {
        calls++;
        return applyRecognitionReceipt(...args);
      }),
    );
    assert.equal(calls, 1);
    assert.equal(result.fact.acceptedAt, notesReviewTime);
    assert.deepEqual(result.evidence.contribution.reasonCodes, notesAcceptedReasons);
  });
test("authored notes review: a later invalid duplicate cannot hide behind canonical deduplication", () => {
  const s = scenario(),
    later = scenario();
  later.request.id += "-later";
  later.decision.id += "-later";
  later.decision.at += 1000;
  later.purpose.pathPolicyVersion = "contradictory-policy";
  refresh(later);
  s.binding.domainEvidence.records.push(later.record);
  s.state.requests[later.request.id] = later.request;
  s.state.audit.push(later.decision);
  let calls = 0;
  assert.throws(
    () =>
      run(s, (...args) => {
        calls++;
        return applyRecognitionReceipt(...args);
      }),
    /documentation.purpose/i,
  );
  assert.equal(calls, 1);
});

// Historical authority stays exact by default for the stale-publication cases.
// The explicit Project option composes its separately versioned authority into
// current-format comparisons without changing the historical default.
function previousPurposeAuthority(state, bindings = [], includeProjectAuthority = false) {
  // An unsupported opt-in cannot keep an old saved hash current without rematerialization.
  for (const binding of bindings) validateMaintenanceClassificationBinding(binding);
  const requests = Object.values(state.requests ?? {})
    .filter((r) => r.kind === "evidence")
    .sort((a, b) => a.id.localeCompare(b.id));
  const suppressed = Object.entries(state.profiles ?? {})
    .filter(([, p]) => p.suppressed)
    .map(([id]) => id)
    .sort();
  const decisionIds = new Set(
    requests.flatMap((r) => (r.history ?? []).filter((event) => event.action === "accepted").map((event) => event.id)),
  );
  // A receipt's current audit entry is part of the authority used below. Fence
  // publication and pinned reads when it disappears, changes or is duplicated.
  const audit = (state.audit ?? [])
    .filter((event) => decisionIds.has(event.id))
    .map((event) => JSON.stringify(event))
    .sort();
  // Version the target/clock authority and include exact current bindings. An old
  // unbound locale publication cannot remain authorized after this correction.
  const authority = ["localization-review-target/v1", requests, suppressed, audit, bindings];
  // Retire old authority for participant-bearing or malformed consent records.
  // An explicit empty collaborator set keeps its unchanged prior semantics.
  if (requests.some((request) => !hasRequiredParticipantConsent(request) || Object.keys(request.collaborators).length))
    authority.push("required-participant-consent/v1");
  // Earlier generic data-quality receipts did not qualify correction provenance.
  // Retire their publication authority without changing unaffected bindings.
  if (bindings.some((binding) => binding.metricId === "data_quality")) authority.push("data-quality-recognition/v1");
  // Generic reproduction receipts had no scenario/environment/result boundary.
  if (bindings.some((binding) => binding.metricId === "reproductions")) authority.push("reproduction-recognition/v1");
  // The reviewed Project boundary retires generic manual receipt authority.
  // Automatic-only states retain the historical fingerprint exactly.
  if (
    includeProjectAuthority &&
    requests.length &&
    bindings.some((binding) => binding.metricId === "project_configuration")
  )
    authority.push("project-configuration-evidence/v1");
  // Earlier generic bug receipts admitted non-issue and explicitly synthetic sources.
  if (bindings.some((binding) => binding.metricId === "confirmed_bugs"))
    authority.push("confirmed-bug-source-admission/v1");
  // Earlier answer receipts could precede their known source occurrence. Retire
  // only configurations whose destination is affected by that missing bound.
  if (bindings.some((binding) => binding.metricId === "issue_answers")) authority.push("issue-answer-source-time/v1");
  // Prior maintenance receipts lacked merged-participant, clock and unit admission.
  if (bindings.some((binding) => binding.metricId === "maintenance"))
    authority.push("maintenance-merged-participant/v1");
  // Retire only explicitly opted-in classification authority. Generic maintenance
  // and every unrelated binding keep their exact established fingerprint format.
  if (bindings.some((binding) => binding.metricId === "maintenance" && binding.maintenanceClassification !== undefined))
    authority.push(maintenanceClassificationVersion);
  // Tooling receipts independently require verified merged participation as well.
  if (bindings.some((binding) => binding.metricId === "automation")) authority.push("automation-merged-participant/v1");
  // Older generic operations receipts lack the current source, public artifact
  // and affected-owner evidence boundary. Unrelated configurations stay exact.
  if (bindings.some((binding) => ["governance", "deployment_work", "incidents"].includes(binding.metricId)))
    authority.push("operations-contribution-evidence/v1");
  // Retire generic receipts and the earlier pre-collection release observation authority.
  if (bindings.some((binding) => binding.metricId === "release_changes"))
    authority.push("release-inclusion-recognition/v2");
  // Missing legacy intake cannot keep manual recognition current, even without collaborators.
  // No-manual-request automatic source authority keeps its existing exact format.
  if (requests.length) authority.push(evidenceIntakeAuthority());
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

test("authored notes authority: all98 fingerprints preserve historical defaults and compose reviewed Project authority", () => {
  const s = scenario(),
    empty = { requests: {}, profiles: {}, audit: [] };
  for (const metric of metricRegistryV1.metrics) {
    const binding = { ...s.binding, metricId: metric.id };
    delete binding.documentationPurpose;
    for (const state of [empty, s.state]) {
      // The old generic helpful binding is now explicitly unsupported.
      if (metric.id === "helpful_feedback") {
        assert.throws(() => recognitionFingerprint(state, [binding]), /invalid_discussion_feedback_contract/);
        continue;
      }
      const actual = recognitionFingerprint(state, [binding]);
      const historical = previousPurposeAuthority(state, [binding]);
      const expected = previousPurposeAuthority(state, [binding], true);
      if (["issue_ordering", "release_stewardship", "performance", "regressions_prevented"].includes(metric.id))
        assert.notEqual(actual, expected, metric.id);
      else assert.equal(actual, expected, metric.id);
      if (metric.id === "project_configuration" && state === s.state) assert.notEqual(expected, historical, metric.id);
      else assert.equal(expected, historical, metric.id);
    }
  }
  for (const state of [empty, s.state]) {
    assert.equal(recognitionFingerprint(state, []), previousPurposeAuthority(state, []));
    assert.notEqual(recognitionFingerprint(state, [s.binding]), previousPurposeAuthority(state, [s.binding]));
  }
});
for (const [name, mutate] of [
  ["wrong destination", (b) => (b.metricId = "release_changes")],
  ["wrong source", (b) => (b.sourceMetricId = "pr_merged")],
  ["unsupported value", (b) => (b.documentationPurpose = "release_stewardship")],
  ["null purpose", (b) => (b.documentationPurpose = null)],
  ["object purpose", (b) => (b.documentationPurpose = { purpose: "release_notes" })],
])
  test("authored notes authority: " + name + " rejects saved authority even with no requests", () => {
    const s = scenario();
    mutate(s.binding);
    for (const state of [s.state, { requests: {}, profiles: {}, audit: [] }])
      assert.throws(() => recognitionFingerprint(state, [s.binding]), /documentation.purpose/i);
  });
test("authored notes authority: valid first binding cannot hide a later malformed opt-in", () => {
  const s = scenario(),
    malformed = { ...s.binding, metricId: "maintenance" };
  assert.throws(() => recognitionFingerprint(s.state, [s.binding, malformed]), /documentation.purpose/i);
});

test("authored notes publication: current and pinned purposes survive real store reopen and retire obsolete authority", async (t) => {
  const { harness, components, publicScope } = await import("./harness.mjs");
  const { createPipeline } = await import("../src/runtime.mjs");
  const { projectRead } = await import("../../service/dist/public-source.js");
  const s = scenario({ markerFree: true });
  const h = await harness(t, {
    markerFreeConfig: true,
    dataMode: "public",
    payloads: [s.envelope.payload.pull_request],
    normalizerFactory:
      () =>
      async ({ observedAt }) => {
        const output = components.github.normalizeGithubObservation({ ...s.envelope, observedAt }, s.pathPolicy);
        assert.ok(output.physicalContext, "the stock adapter retains its source-bound physical receipt");
        return output;
      },
    defaultDeliveryNormalizationVersion: components.github.defaultDeliveryNormalizationVersion,
    configure(config) {
      config.repositories[0].families = ["pull_requests"];
      config.documentationPolicies = [s.pathPolicy];
      config.recognitionBindings = [s.binding];
      const policy = { ...config.policies[0].policy, ...s.policies[0].policy };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "fixture-notes-policy-approval" },
      ];
    },
  });
  h.controlsStore.transaction((state) => {
    state.requests = s.state.requests;
    state.audit = s.state.audit;
  });
  const publication = await h.runtime.runOnce({ cutoff: notesCutoff });
  assert.equal(publication.state, "published");
  const snapshot = publication.publications[0].snapshotId;
  async function visible(runtime) {
    for (const pin of [null, snapshot]) {
      const read = await runtime.source.read(publicScope, pin, new AbortController().signal);
      assert.ok(read);
      const projected = projectRead(read, publicScope, pin);
      assert.equal(projected.selected.rows[0].result.value, 1);
      const primary = projected.selected.evidence.find((entry) =>
        entry.contribution.metricIds.includes("documentation"),
      );
      const portfolio = projected.selected.portfolioEvidence.find(
        (entry) => entry.contribution.contributionId === primary.contribution.contributionId,
      );
      for (const entry of [primary, portfolio]) {
        assert.ok(entry.contribution.reasonCodes.includes(notesPurpose));
        assert.equal(entry.occurredAt, notesMergeTime);
        assert.equal(entry.sourceRevision, s.evidence.sourceRevision);
        assert.equal(entry.sourceRevisionUrl, s.evidence.sourceRevisionUrl);
      }
      const route = await runtime.app.inject(
        "/api/v1/contributors/101?metric=documentation" + (pin ? "&snapshot=" + pin : ""),
      );
      assert.equal(route.statusCode, 200, route.body);
      assert.ok(route.body.includes(notesPurpose));
      assert.doesNotMatch(
        route.body,
        /pathPolicyVersion|sourceUseReview|reviewedInputDigest|fixture-notes-request|docs\/releases/,
      );
    }
  }
  await visible(h.runtime);
  await h.runtime.stop();
  await h.reopenDatabase();
  const reopened = await createPipeline(h.options);
  t.after(() => reopened.stop());
  await visible(reopened);
  h.controlsStore.transaction((state) => {
    state.pipelinePublications[snapshot].recognitionFingerprint = previousPurposeAuthority(state, [s.binding]);
  });
  for (const pin of [null, snapshot])
    assert.equal(await reopened.source.read(publicScope, pin, new AbortController().signal), null);
  const repaired = await reopened.runOnce({ cutoff: notesCutoff });
  assert.equal(repaired.state, "published");
  const repairedId = repaired.publications[0].snapshotId;
  assert.ok(await reopened.source.read(publicScope, repairedId, new AbortController().signal));
  h.controlsStore.transaction((state) => {
    state.requests[s.request.id].status = "withdrawn";
  });
  for (const pin of [null, snapshot, repairedId])
    assert.equal(await reopened.source.read(publicScope, pin, new AbortController().signal), null);
});

// A configured field could be hash-bound before an older adapter interpreted it.
// Preserve the exact ae/fd7 generation as historical authority, never fresh output.
function priorNotesNormalizationSignature(config, components) {
  const digest = (value) => createHash("sha256").update(components.metrics.stableJSON(value)).digest("hex");
  const policy = digest([
    "current-state-selection-v2",
    "public",
    config.policies.map((x) => x.signature),
    { documentation: config.documentationPolicies, research: config.researchPolicies ?? [] },
  ]);
  const attribution = digest(["pipeline-private-attribution/v1", policy]);
  const documentation = digest(["documentation-locales/v2", attribution]);
  const merged = digest(["verified-default-branch-merge-pins/v1", documentation]);
  const project = digest(["project-membership-context/v2", merged, config.projectWorkstreamMappings ?? []]);
  const selected = config.releaseInclusionTargets?.length
    ? digest(["github-release-inclusion/v2", project, config.releaseInclusionTargets])
    : project;
  return digest([components.github.defaultDeliveryNormalizationVersion, selected]);
}

for (const selectedRelease of [false, true])
  test(
    "authored notes normalization: prior " +
      (selectedRelease ? "release-wrapped" : "plain") +
      " cache remains frozen while the new generation reclassifies after reopen",
    async (t) => {
      const { harness, components } = await import("./harness.mjs");
      const { createPipeline } = await import("../src/runtime.mjs");
      const { normalizeGithubObservation } = await import("@pick-your-ai/github");
      const s = scenario({ markerFree: true });
      let interpretPurpose = false;
      const oldPolicy = structuredClone(s.pathPolicy);
      delete oldPolicy.releaseNotesPaths;
      const h = await harness(t, {
        markerFreeConfig: true,
        dataMode: "public",
        payloads: [s.envelope.payload.pull_request],
        authorizePolicyPreview: async () => true,
        defaultDeliveryNormalizationVersion: components.github.defaultDeliveryNormalizationVersion,
        normalizerFactory:
          () =>
          async ({ observedAt }) => {
            const output = normalizeGithubObservation(
              { ...s.envelope, observedAt },
              interpretPurpose ? s.pathPolicy : oldPolicy,
            );
            assert.ok(output.physicalContext, "both policy generations retain their source-bound physical receipt");
            return output;
          },
        configure(config) {
          config.repositories[0].families = ["pull_requests"];
          config.documentationPolicies = [s.pathPolicy];
          config.recognitionBindings = [];
          // The optional release is for another PR, so this documentation source is
          // not a release inclusion proof or a release collector fixture.
          if (selectedRelease)
            config.releaseInclusionTargets = [{ repositoryId: 2, releaseId: 700, pullRequestNumber: 11 }];
          const policy = { ...config.policies[0].policy, ...s.policies[0].policy, rankedStates: ["observed"] };
          config.policies = [
            { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "fixture-notes-cache-policy" },
          ];
        },
      });
      const first = (await h.runtime.runOnce({ cutoff: notesCutoff })).publications[0];
      assert.ok(first);
      const saved = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows[0];
      assert.ok(saved.document.facts.some((fact) => fact.metricId === "documentation"));
      assert.ok(
        saved.document.evidence
          .filter((entry) => entry.contribution.metricIds.includes("documentation"))
          .every((entry) => !entry.contribution.reasonCodes.includes(notesCandidate)),
      );
      const legacySignature = priorNotesNormalizationSignature(h.config, components);
      await h.db.query(
        "UPDATE leaderboard_pipeline.normalizations SET policy_signature=$1 WHERE fact_key=$2 AND policy_signature=$3",
        [legacySignature, saved.fact_key, saved.policy_signature],
      );
      const retained = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows[0];
      const frozenSnapshot = (
        await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [
          first.snapshotId,
        ])
      ).rows[0];
      await h.runtime.stop();
      await h.reopenDatabase();
      interpretPurpose = true;
      const current = await createPipeline(h.options);
      t.after(() => current.stop());
      const preview = () =>
        current.previewPolicy({
          snapshotId: first.snapshotId,
          policy: { ...h.config.policies[0].policy, version: "fixture-before-notes-preview", rank: false },
          operatorId: "201",
        });
      const original = (await preview()).comparison.before;
      const later = (await current.runOnce({ cutoff: new Date(Date.parse(notesCutoff) + 1).toISOString() }))
        .publications[0];
      assert.ok(later);
      const rows = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows;
      const fresh = rows.find((row) => row.policy_signature !== legacySignature);
      assert.ok(fresh, "the formerly ignored notes selection requires a fresh immutable normalization generation");
      assert.ok(
        fresh.document.evidence
          .find((entry) => entry.contribution.metricIds.includes("documentation"))
          .contribution.reasonCodes.includes(notesCandidate),
      );
      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.find((row) => row.policy_signature === legacySignature),
        retained,
      );
      assert.deepEqual((await preview()).comparison.before, original);
      assert.deepEqual(
        (
          await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [
            first.snapshotId,
          ])
        ).rows[0],
        frozenSnapshot,
      );
    },
  );
