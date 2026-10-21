import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { applyRecognitionReceipt, parseMaintenanceClassification } from "@pick-your-ai/github";
import { hasRequiredParticipantConsent } from "../../controls/src/evidence-consent.mjs";
import { evidenceIntakeAuthority } from "../../controls/src/evidence-intake.mjs";
import { recognitionFingerprint } from "../src/recognition-adapter.mjs";
import { aggregateMetric, metricRegistryV1 } from "@pick-your-ai/metrics";
import {
  maintenanceClassificationScenario as scenario,
  maintenanceReceipt,
  applyMaintenanceClassification,
  materializeMaintenanceClassification as run,
  maintenanceProof,
  refreshMaintenanceClassificationReview,
  classificationKinds,
  publicClassificationCodes,
  mergeTime,
  reviewTime,
  classificationCutoff,
} from "../../../tests/fixtures/maintenance-classification.mjs";

const expected = (kinds) => ["independent_recognition_receipt", ...publicClassificationCodes(kinds)];
for (const kind of classificationKinds) {
  test("maintenance classification: direct accepted " + kind + " preserves source, identity and clocks", () => {
    const s = scenario({ kinds: [kind] }),
      original = structuredClone(s.input);
    const { fact, evidence } = maintenanceProof(applyMaintenanceClassification(s));
    assert.deepEqual(evidence.contribution.reasonCodes, expected([kind]));
    assert.equal(fact.occurredAt, mergeTime);
    assert.equal(fact.acceptedAt, reviewTime);
    assert.equal(fact.actorId, s.target.actorId);
    assert.equal(fact.role, s.target.role);
    assert.equal(evidence.sourceRevision, "collection-scan:maintenance-7");
    assert.equal(evidence.sourceRevisionUrl, null);
    assert.deepEqual(s.input, original);
  });
  test("maintenance classification: current audited " + kind + " passes only reviewed record to callback", () => {
    const s = scenario({ kinds: [kind] });
    let calls = 0;
    const out = run(s, (input, receipt, reviewers) => {
      calls++;
      assert.deepEqual(receipt.maintenanceClassification, s.record);
      return applyRecognitionReceipt(input, receipt, reviewers);
    });
    assert.equal(calls, 1);
    assert.deepEqual(maintenanceProof(out).evidence.contribution.reasonCodes, expected([kind]));
  });
}
test("maintenance classification: mixed facets conserve the original single PR/actor unit", () => {
  const s = scenario({ kinds: classificationKinds });
  const classified = run(s),
    genericReceipt = maintenanceReceipt(s);
  delete genericReceipt.maintenanceClassification;
  const generic = applyMaintenanceClassification(s, genericReceipt);
  assert.equal(maintenanceProof(classified).fact.id, maintenanceProof(generic).fact.id);
  assert.equal(maintenanceProof(classified).fact.canonicalKey, maintenanceProof(generic).fact.canonicalKey);
  assert.deepEqual(maintenanceProof(classified).evidence.contribution.reasonCodes, expected(classificationKinds));
  const result = aggregateMetric(
    {
      datasetId: "synthetic-classification",
      cutoff: classificationCutoff,
      backfillRevision: "synthetic-v1",
      repositoryIds: ["2"],
      actors: classified.actors,
      facts: classified.facts,
      coverage: [
        {
          schemaVersion: "leaderboard/v1",
          state: "complete",
          source: "github_rest",
          scopeId: "2",
          windowStart: "2026-10-01T00:00:00.000Z",
          windowEnd: classificationCutoff,
          knownStart: "2026-10-01T00:00:00.000Z",
          lastSuccessfulSync: classificationCutoff,
          sourceWatermark: classificationCutoff,
          missingPages: 0,
          permissionsMissing: [],
          sourceErrors: [],
        },
      ],
    },
    s.policies[0].policy,
    {
      timezone: "UTC",
      from: "2026-10-01T00:00:00.000Z",
      to: classificationCutoff,
      repos: [],
      projects: [],
      workstreams: [],
      roles: [],
      actors: "all",
      context: "event",
    },
  );
  assert.equal(result.rows[0].value, 1);
});
test("maintenance classification: title, labels and absent review never classify generic maintenance", () => {
  const s = scenario();
  s.request.detail = "Accepted maintenance without a reviewed subtype.";
  refreshMaintenanceClassificationReview(s);
  assert.deepEqual(maintenanceProof(run(s)).evidence.contribution.reasonCodes, ["independent_recognition_receipt"]);
  const unselected = scenario();
  delete unselected.binding.maintenanceClassification;
  assert.deepEqual(maintenanceProof(run(unselected)).evidence.contribution.reasonCodes, [
    "independent_recognition_receipt",
  ]);
});
for (const [name, mutate] of [
  ["unsupported schema", (r) => (r.schemaVersion = "maintenance-classification/v2")],
  ["unknown kind", (r) => (r.classifications[0].kind = "green_workflow")],
  ["repeated kind", (r) => r.classifications.push(structuredClone(r.classifications[0]))],
  ["wrong source fact", (r) => (r.targetFactId = "different-source")],
  ["wrong source revision", (r) => (r.sourceRevision = "different-revision")],
  ["private extra field", (r) => (r.privateNotes = "never public")],
  ["unbounded reference revision", (r) => (r.classifications[0].references[0].revision = "x".repeat(129))],
  ["unsafe reference", (r) => (r.classifications[0].references[0].locator = "https://private.invalid/claim")],
  ["empty references", (r) => (r.classifications[0].references = [])],
]) {
  test("maintenance classification: direct " + name + " is rejected before output mutation", () => {
    const s = scenario();
    mutate(s.record);
    const before = structuredClone(s.input);
    assert.throws(() => applyMaintenanceClassification(s), /maintenance.classification/i);
    assert.deepEqual(s.input, before);
  });
}
for (const [name, mutate] of [
  ["source revision mismatch", (s) => (s.record.sourceRevision = "later-private-revision")],
  ["source fact mismatch", (s) => (s.record.targetFactId = "different-source")],
  ["policy mismatch", (s) => (s.record.policyVersion = "unapproved-classification")],
  ["unknown facet", (s) => (s.record.classifications[0].kind = "green_workflow")],
]) {
  test("maintenance classification: audited " + name + " stops before host callback", () => {
    const s = scenario();
    mutate(s);
    s.request.detail = JSON.stringify(s.record);
    refreshMaintenanceClassificationReview(s);
    let calls = 0;
    assert.throws(
      () =>
        run(s, () => {
          calls++;
          return s.input;
        }),
      /maintenance.classification/i,
    );
    assert.equal(calls, 0);
  });
}
test("maintenance classification: a permitted but different reference cannot authorize the classified artifact", () => {
  const s = scenario();
  refreshMaintenanceClassificationReview(s, [{ locator: s.request.locator, revision: "different-review-reference" }]);
  let calls = 0;
  assert.throws(
    () =>
      run(s, () => {
        calls++;
        return s.input;
      }),
    /maintenance.classification/i,
  );
  assert.equal(calls, 0);
});
test("maintenance classification: current digest prevents post-review detail changes", () => {
  const s = scenario();
  s.record.classifications[0].kind = "accepted_bug_fix";
  s.request.detail = JSON.stringify(s.record);
  let calls = 0;
  const out = run(s, () => {
    calls++;
    return s.input;
  });
  assert.equal(calls, 0);
  assert.deepEqual(out, s.input);
});
for (const status of ["pending", "appealed", "withdrawn", "rejected"]) {
  test("maintenance classification: " + status + " claim remains unqualified", () => {
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
for (const args of [{ bot: true }, { coauthor: true }]) {
  test("maintenance classification: " + (args.bot ? "bot" : "coauthor") + " source role is conserved", () => {
    const s = scenario(args),
      out = run(s),
      { fact, evidence } = maintenanceProof(out);
    assert.equal(fact.actorId, s.target.actorId);
    assert.equal(fact.role, s.target.role);
    assert.deepEqual(out.actors, s.input.actors);
    assert.notEqual(fact.actorId, s.decision.actor);
    assert.deepEqual(evidence.contribution.reasonCodes, expected(["dependency_maintenance"]));
  });
}
test("maintenance classification: unmerged source remains denied before callback", () => {
  const s = scenario({ lifecycle: "open" });
  let calls = 0;
  assert.throws(
    () =>
      run(s, () => {
        calls++;
        return s.input;
      }),
    /merged pull-request participant/,
  );
  assert.equal(calls, 0);
});

test("maintenance classification: earliest reviewed canonical receipt retains its facets without alias unions", () => {
  for (const reverse of [false, true]) {
    const first = scenario({ kinds: ["dependency_maintenance"] }),
      later = scenario({ kinds: ["accepted_bug_fix"] });
    later.request.id += "-later";
    later.decision.id += "-later";
    later.decision.receipt = later.request.id;
    later.decision.at += 1;
    refreshMaintenanceClassificationReview(later);
    const requests = [first.request, later.request];
    if (reverse) requests.reverse();
    first.state.requests = Object.fromEntries(requests.map((r) => [r.id, r]));
    first.state.audit.push(structuredClone(later.decision));
    let calls = 0;
    const output = run(first, (input, receipt, reviewers) => {
      calls++;
      return applyRecognitionReceipt(input, receipt, reviewers);
    });
    assert.equal(calls, 1);
    assert.deepEqual(maintenanceProof(output).evidence.contribution.reasonCodes, expected(["dependency_maintenance"]));
  }
});
test("maintenance classification: a later malformed duplicate cannot disappear behind unit deduplication", () => {
  const first = scenario(),
    later = scenario();
  later.request.id += "-later";
  later.decision.id += "-later";
  later.decision.receipt = later.request.id;
  later.decision.at += 1;
  later.record.sourceRevision = "wrong";
  later.request.detail = JSON.stringify(later.record);
  refreshMaintenanceClassificationReview(later);
  first.state.requests[later.request.id] = later.request;
  first.state.audit.push(structuredClone(later.decision));
  let calls = 0;
  assert.throws(
    () =>
      run(first, (input, receipt, reviewers) => {
        calls++;
        return applyRecognitionReceipt(input, receipt, reviewers);
      }),
    /maintenance.classification/i,
  );
  assert.equal(calls, 1);
});

// Historical authority stays exact by default for the stale-publication cases.
// The explicit Project option composes its separately versioned authority into
// current-format comparisons without changing the historical default.
function previousClassificationAuthority(state, bindings = [], includeProjectAuthority = false) {
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

test("maintenance classification: all98 fingerprints preserve historical defaults and compose reviewed Project authority", () => {
  const s = scenario(),
    empty = { requests: {}, profiles: {}, audit: [] };
  for (const metric of metricRegistryV1.metrics) {
    const binding = { ...s.binding, metricId: metric.id };
    delete binding.maintenanceClassification;
    for (const state of [empty, s.state]) {
      // The old generic helpful binding is now explicitly unsupported.
      if (metric.id === "helpful_feedback") {
        assert.throws(() => recognitionFingerprint(state, [binding]), /invalid_discussion_feedback_contract/);
        continue;
      }
      const actual = recognitionFingerprint(state, [binding]);
      const historical = previousClassificationAuthority(state, [binding]);
      const expected = previousClassificationAuthority(state, [binding], true);
      if (["issue_ordering", "release_stewardship", "performance", "regressions_prevented"].includes(metric.id))
        assert.notEqual(actual, expected, metric.id);
      else assert.equal(actual, expected, metric.id);
      if (metric.id === "project_configuration" && state === s.state) assert.notEqual(expected, historical, metric.id);
      else assert.equal(expected, historical, metric.id);
    }
  }
  for (const state of [empty, s.state]) {
    assert.notEqual(recognitionFingerprint(state, [s.binding]), previousClassificationAuthority(state, [s.binding]));
    assert.equal(recognitionFingerprint(state, []), previousClassificationAuthority(state, []));
  }
});

for (const [name, mutate] of [
  ["option schema", (s) => (s.binding.maintenanceClassification.schemaVersion = "maintenance-classification/v2")],
  ["option extra field", (s) => (s.binding.maintenanceClassification.included = true)],
  [
    "wrong destination",
    (s) => {
      s.binding.metricId = "automation";
      s.policies[0].policy.metricId = "automation";
    },
  ],
  ["malformed JSON", (s) => (s.request.detail = "{broken")],
])
  test("maintenance classification: " + name + " cannot call a host receipt", () => {
    const s = scenario();
    mutate(s);
    refreshMaintenanceClassificationReview(s);
    let calls = 0;
    assert.throws(
      () =>
        run(s, () => {
          calls++;
          return s.input;
        }),
      /maintenance.classification/i,
    );
    assert.equal(calls, 0);
  });

// Direct JavaScript host inputs can contain array holes; JSON HTTP cannot encode them.
for (const field of ["classifications", "references"])
  test("maintenance classification review boundary: sparse " + field + " cannot claim a validated element", () => {
    const { record } = scenario();
    if (field === "classifications") record.classifications = Array(1);
    else record.classifications[0].references = Array(1);
    assert.throws(() => parseMaintenanceClassification(record), /maintenance.classification/i);
  });

for (const field of ["classifications", "references"])
  test("maintenance classification review boundary: custom iteration cannot hide sparse " + field, () => {
    const { record } = scenario();
    const values = Array(1);
    values[Symbol.iterator] = function* () {};
    assert.equal(Object.hasOwn(values, 0), false);
    if (field === "classifications") record.classifications = values;
    else record.classifications[0].references = values;
    assert.throws(() => parseMaintenanceClassification(record), /maintenance.classification/i);
  });

const boundedReferences = (count) =>
  Array.from({ length: count }, (_, index) => ({
    locator: "https://github.com/example/repo/pull/" + (index + 1),
    revision: "reviewed-" + (index + 1),
  }));
test("maintenance classification review boundary: six distinct pairs across kinds exceed the direct record bound", () => {
  const { record } = scenario({ kinds: ["dependency_maintenance", "build_fix"] });
  const references = boundedReferences(6);
  record.classifications[0].references = references.slice(0, 3);
  record.classifications[1].references = references.slice(3);
  assert.ok(JSON.stringify(record).length < 2000);
  assert.throws(() => parseMaintenanceClassification(record), /maintenance.classification/i);
});
test("maintenance classification review boundary: five distinct pairs across kinds remain supported", () => {
  const { record } = scenario({ kinds: ["dependency_maintenance", "build_fix"] });
  const references = boundedReferences(5);
  record.classifications[0].references = references.slice(0, 3);
  record.classifications[1].references = references.slice(3);
  assert.equal(parseMaintenanceClassification(record).classifications.flatMap((entry) => entry.references).length, 5);
});
test("maintenance classification review boundary: all kinds can share the same five reviewed pairs", () => {
  const { record } = scenario({ kinds: classificationKinds });
  for (const classification of record.classifications) classification.references = boundedReferences(5);
  assert.ok(JSON.stringify(record).length < 2000);
  const parsed = parseMaintenanceClassification(record);
  assert.equal(parsed.classifications.length, 3);
  for (const classification of parsed.classifications)
    assert.deepEqual(classification.references, boundedReferences(5));
});

for (const current of [false, true])
  test(
    "maintenance classification review boundary: non-maintenance option cannot preserve " +
      (current ? "current reviewed" : "empty-request") +
      " legacy authority",
    () => {
      const s = scenario();
      s.binding.metricId = "automation";
      const state = current ? s.state : { requests: {}, profiles: {}, audit: [] };
      const historical = previousClassificationAuthority(state, [s.binding]);
      let returned;
      try {
        returned = recognitionFingerprint(state, [s.binding]);
      } catch (error) {
        assert.match(error.message, /maintenance.classification/i);
        return;
      }
      // The original defect returns exactly the saved historical hash; the corrected
      // current-read path must reject this unsupported option before issuing any hash.
      assert.equal(returned, historical);
      assert.fail("unsupported classification option retained legacy current-read authority");
    },
  );
for (const [name, option] of [
  ["unsupported version", { schemaVersion: "maintenance-classification/v2" }],
  ["extra option field", { schemaVersion: "maintenance-classification/v1", included: true }],
  ["null option", null],
  ["array option", []],
  ["text option", "maintenance-classification/v1"],
  ["missing version", {}],
])
  test("maintenance classification review boundary: " + name + " cannot issue current authority", () => {
    const s = scenario();
    s.binding.maintenanceClassification = option;
    assert.throws(() => recognitionFingerprint(s.state, [s.binding]), /maintenance.classification/i);
  });
test("maintenance classification review boundary: a valid selection cannot hide a later invalid binding", () => {
  const s = scenario();
  const invalid = { ...s.binding, metricId: "automation" };
  assert.throws(() => recognitionFingerprint(s.state, [s.binding, invalid]), /maintenance.classification/i);
});

test("maintenance classification: persisted current and pinned proofs preserve facets and withdraw obsolete authority", async (t) => {
  const { harness, components, publicScope } = await import("./harness.mjs");
  const { createPipeline } = await import("../src/runtime.mjs");
  const { projectRead } = await import("../../service/dist/public-source.js");
  const s = scenario({ markerFree: true, kinds: classificationKinds });
  const h = await harness(t, {
    markerFreeConfig: true,
    dataMode: "public",
    payloads: [s.payload],
    normalizerFactory: () => async () => structuredClone(s.input),
    defaultDeliveryNormalizationVersion: components.github.defaultDeliveryNormalizationVersion,
    configure(config) {
      config.repositories[0].families = ["pull_requests"];
      config.recognitionBindings = [s.binding];
      const policy = { ...config.policies[0].policy, ...s.policies[0].policy };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "fixture-policy-approval" },
      ];
    },
  });
  h.controlsStore.transaction((state) => {
    state.requests = s.state.requests;
    state.audit = s.state.audit;
  });
  const publication = await h.runtime.runOnce({ cutoff: classificationCutoff });
  assert.equal(publication.state, "published");
  const snapshot = publication.publications[0].snapshotId;
  async function visible(runtime) {
    for (const pin of [null, snapshot]) {
      const read = await runtime.source.read(publicScope, pin, new AbortController().signal);
      assert.ok(read);
      projectRead(read, publicScope, pin);
      assert.equal(read.selected.rows[0].result.value, 1);
      const proof = read.selected.evidence.find((entry) => entry.contribution.metricIds.includes("maintenance"));
      const portfolio = read.selected.portfolioEvidence.find(
        (entry) => entry.contribution.contributionId === proof.contribution.contributionId,
      );
      assert.deepEqual(proof.contribution.reasonCodes, expected(classificationKinds));
      assert.deepEqual(portfolio.contribution.reasonCodes, [
        "public_accepted_work",
        ...publicClassificationCodes(classificationKinds),
      ]);
      assert.equal(proof.occurredAt, mergeTime);
      assert.equal(proof.sourceRevision, s.evidence.sourceRevision);
      for (const route of [
        "boards?metric=maintenance",
        "contributors/101?metric=maintenance",
        "evidence/" + proof.contribution.contributionId,
        "exports?metric=maintenance&format=json",
        "exports?metric=maintenance&format=csv",
      ]) {
        const response = await runtime.app.inject(
          "/api/v1/" + route + (pin ? (route.includes("?") ? "&" : "?") + "snapshot=" + pin : ""),
        );
        assert.equal(response.statusCode, 200, response.body);
        assert.doesNotMatch(response.body, /classifications|sourceUseReview|reviewedInputDigest|privateNotes/);
      }
    }
  }
  await visible(h.runtime);
  await h.runtime.stop();
  await h.reopenDatabase();
  const reopened = await createPipeline(h.options);
  t.after(() => reopened.stop());
  await visible(reopened);
  h.controlsStore.transaction((state) => {
    state.pipelinePublications[snapshot].recognitionFingerprint = previousClassificationAuthority(state, [s.binding]);
  });
  for (const pin of [null, snapshot])
    assert.equal(await reopened.source.read(publicScope, pin, new AbortController().signal), null);
  const repaired = await reopened.runOnce({ cutoff: classificationCutoff });
  assert.equal(repaired.state, "published");
  const repairedId = repaired.publications[0].snapshotId;
  assert.ok(await reopened.source.read(publicScope, repairedId, new AbortController().signal));
  h.controlsStore.transaction((state) => {
    state.requests[s.request.id].status = "withdrawn";
  });
  for (const pin of [null, snapshot, repairedId])
    assert.equal(await reopened.source.read(publicScope, pin, new AbortController().signal), null);
});
