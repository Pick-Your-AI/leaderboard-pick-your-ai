// Synthetic source and current private-control fixtures; no real checklist or publication rollout.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { applyRecognitionReceipt } from "@pick-your-ai/github";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import { materializeRecognition, recognitionFingerprint } from "../src/recognition-adapter.mjs";
import { attachSyntheticEvidenceIntake } from "../../../tests/fixtures/evidence-intake.mjs";
import {
  stewardshipSource,
  stewardshipScenario,
  stewardshipTarget,
  stewardshipReceipt,
  stewardshipBoard,
  stewardshipValue,
  stewardshipPolicy,
  invalidStewardshipSources,
  duplicateStewardshipRequest,
  publicationAt,
  stewardshipAcceptedAt,
  stewardshipCutoff,
} from "../../../tests/fixtures/release-stewardship.mjs";

const run = (s, apply = applyRecognitionReceipt) =>
  materializeRecognition(s.input, s.state, [s.binding], s.policies, apply, stewardshipCutoff);
const recognized = (input) =>
  input.facts.filter((fact) => fact.metricId === "release_stewardship" && fact.state === "qualified");

test("release stewardship pipeline: publication policy admits one current reviewed publisher and preserves both clocks", () => {
  const s = stewardshipScenario(),
    original = structuredClone(s.input),
    output = run(s),
    facts = recognized(output);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].occurredAt, publicationAt);
  assert.equal(facts[0].acceptedAt, stewardshipAcceptedAt);
  const proof = output.evidence.at(-1);
  assert.equal(proof.occurredAt, publicationAt);
  assert.equal(proof.evidenceMetadata.sourceOccurredAt, publicationAt);
  assert.equal(proof.evidenceMetadata.acceptedAt, stewardshipAcceptedAt);
  assert.deepEqual(proof.contribution.reasonCodes, ["independent_recognition_receipt"]);
  assert.equal(
    stewardshipValue(stewardshipBoard(output, s.policies[0].policy, publicationAt, "2026-10-08T00:00:00.000Z")),
    1,
  );
  assert.equal(
    stewardshipValue(stewardshipBoard(output, s.policies[0].policy, stewardshipAcceptedAt, stewardshipCutoff)),
    0,
  );
  assert.deepEqual(s.input, original);
});
for (const [name, patch] of Object.entries({
  "acceptance clock": { dateBasis: "acceptedAt" },
  "artifact grouping": { groupBy: "actor_artifact" },
  "raw publisher state": { rankedStates: ["observed"] },
  "reviewed state": { rankedStates: ["reviewed"] },
  "mixed states": { rankedStates: ["qualified", "reviewed"] },
}))
  test(`release stewardship pipeline: rejects ${name} policy before callback`, () => {
    const s = stewardshipScenario();
    Object.assign(s.policies[0].policy, patch);
    let calls = 0;
    assert.throws(
      () =>
        run(s, (input) => {
          calls++;
          return input;
        }),
      /recognition_policy_not_configured/,
    );
    assert.equal(calls, 0);
  });
for (const [name, mutate] of Object.entries(invalidStewardshipSources))
  test(`release stewardship pipeline: rejects ${name} before host callback`, () => {
    const s = stewardshipScenario();
    mutate(s);
    let calls = 0;
    assert.throws(
      () =>
        run(s, (input) => {
          calls++;
          return input;
        }),
      /Release stewardship/,
    );
    assert.equal(calls, 0);
  });
test("release stewardship pipeline: early independent review is denied before callback", () => {
  const s = stewardshipScenario();
  s.decision.at = Date.parse("2026-10-06T10:00:00.000Z");
  attachSyntheticEvidenceIntake(s.request);
  let calls = 0;
  assert.throws(
    () =>
      run(s, (input) => {
        calls++;
        return input;
      }),
    /Release stewardship/,
  );
  assert.equal(calls, 0);
});
test("release stewardship pipeline: receipt aliases retain earliest valid unit in either insertion order", () => {
  const identities = [];
  for (const reverse of [false, true]) {
    const s = stewardshipScenario();
    duplicateStewardshipRequest(s);
    if (reverse) s.state.requests = Object.fromEntries(Object.entries(s.state.requests).reverse());
    let calls = 0;
    const output = run(s, (...args) => {
      calls++;
      return applyRecognitionReceipt(...args);
    });
    assert.equal(calls, 1);
    assert.equal(recognized(output).length, 1);
    assert.equal(recognized(output)[0].acceptanceReceipt, s.decision.id);
    assert.equal(recognized(output)[0].acceptedAt, stewardshipAcceptedAt);
    assert.equal(stewardshipValue(stewardshipBoard(output)), 1);
    identities.push(recognized(output)[0].canonicalKey);
  }
  assert.equal(identities[0], identities[1]);
});
test("release stewardship pipeline: every repeated review is validated before unit deduplication", () => {
  for (const earlier of [false, true]) {
    const s = stewardshipScenario(),
      duplicate = duplicateStewardshipRequest(s, earlier ? -1000 : 1000);
    s.state.audit = s.state.audit.filter((entry) => entry.id !== duplicate.history[0].id);
    let calls = 0;
    assert.throws(
      () =>
        run(s, (...args) => {
          calls++;
          return applyRecognitionReceipt(...args);
        }),
      /recognition_decision_unverified/,
    );
    assert.equal(calls, earlier ? 0 : 1);
  }
});
test("release stewardship pipeline: current consent, source-use review, withdrawal and suppression withhold callbacks", () => {
  for (const mutate of [
    (s) => {
      s.request.status = "withdrawn";
    },
    (s) => {
      s.state.profiles[s.request.owner] = { suppressed: true };
    },
    (s) => {
      delete s.request.intake;
    },
    (s) => {
      s.request.detail += " amended";
    },
    (s) => {
      s.request.collaborators["303"] = "pending";
      attachSyntheticEvidenceIntake(s.request);
    },
    (s) => {
      s.request.collaborators["303"] = "declined";
      attachSyntheticEvidenceIntake(s.request);
    },
  ]) {
    const s = stewardshipScenario();
    mutate(s);
    let calls = 0;
    assert.deepEqual(
      run(s, (input) => {
        calls++;
        return input;
      }),
      s.input,
    );
    assert.equal(calls, 0);
  }
});
test("release stewardship pipeline: self review and altered current audit remain errors", () => {
  for (const mutate of [
    (s) => {
      s.decision.actor = s.request.owner;
      attachSyntheticEvidenceIntake(s.request);
    },
    (s) => {
      s.state.audit = [];
    },
  ]) {
    const s = stewardshipScenario();
    mutate(s);
    let calls = 0;
    assert.throws(
      () =>
        run(s, (input) => {
          calls++;
          return input;
        }),
      /recognition_decision_unverified/,
    );
    assert.equal(calls, 0);
  }
});
const historicalAuthority = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/release-stewardship-authority-v1.json", import.meta.url), "utf8"),
);

test("release stewardship pipeline: literal accepted-f80 authority preserves independently reviewed destination fences", () => {
  assert.deepEqual(
    historicalAuthority.destinations.map(({ metricId }) => metricId),
    metricRegistryV1.metrics.map(({ id }) => id),
  );
  for (const entry of historicalAuthority.destinations)
    for (const key of ["empty", "currentIntake"]) {
      const bindings = [{ ...historicalAuthority.binding, metricId: entry.metricId }];
      if (entry.metricId === "helpful_feedback") {
        assert.throws(
          () => recognitionFingerprint(historicalAuthority.states[key], bindings),
          /invalid_discussion_feedback_contract/,
        );
        continue;
      }
      const actual = recognitionFingerprint(historicalAuthority.states[key], bindings);
      // These literal hashes predate the independently reviewed Project,
      // ordering and comparison boundaries. Preserve every unaffected comparison.
      const independentlyRetired =
        ["issue_ordering", "performance", "regressions_prevented"].includes(entry.metricId) ||
        (entry.metricId === "project_configuration" && key === "currentIntake");
      if (entry.metricId === "release_stewardship" || independentlyRetired)
        assert.notEqual(actual, entry[key], `${entry.metricId}:${key}`);
      else assert.equal(actual, entry[key], `${entry.metricId}:${key}`);
    }
  assert.equal(
    recognitionFingerprint(historicalAuthority.states.currentIntake, []),
    historicalAuthority.unselectedCurrentIntake,
  );
});

test("release stewardship pipeline: obsolete publication authority is denied on current and pinned reads across database reopen", async (t) => {
  const { harness, components, publicScope } = await import("./harness.mjs");
  const { createPipeline } = await import("../src/runtime.mjs");
  const s = stewardshipScenario({ markerFree: true });
  assert.deepEqual(s.state, historicalAuthority.states.publicPersisted);
  assert.deepEqual(s.binding, historicalAuthority.publicBinding);
  // This is the existing protected host source seam, with a fictional observed
  // release transition. It is not a stock REST snapshot claiming publisher history.
  const source = {
    async readPage() {
      return {
        repositoryId: 2,
        visibility: "public",
        isSynthetic: false,
        nextCursor: null,
        expectedCount: 1,
        facts: [
          {
            subjectId: s.target.artifactId,
            sourceRevision: s.evidence.sourceRevision,
            sourceUrl: s.evidence.artifact.publicUrl,
            evidence: "observed_transition",
            actorId: s.target.actorId,
            occurredAt: publicationAt,
            state: "present",
          },
        ],
      };
    },
  };
  const h = await harness(t, {
    markerFreeConfig: true,
    dataMode: "public",
    source,
    normalizerFactory: () => async () => structuredClone(s.input),
    configure(config) {
      config.repositories[0].families = ["releases"];
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
  const publication = await h.runtime.runOnce({ cutoff: stewardshipCutoff });
  assert.equal(publication.state, "published");
  const snapshotId = publication.publications[0].snapshotId;
  const read = await h.runtime.source.read(publicScope, snapshotId, new AbortController().signal);
  assert.equal(read.selected.rows[0].result.value, 1);
  const proof = read.selected.evidence.find((entry) => entry.contribution.metricIds.includes("release_stewardship"));
  assert.ok(proof);
  assert.equal(proof.occurredAt, publicationAt);
  assert.equal(proof.evidenceMetadata.acceptedAt, stewardshipAcceptedAt);
  const path = `/api/v1/evidence/${proof.contribution.contributionId}?snapshot=${snapshotId}`;
  const response = await h.runtime.app.inject(path);
  assert.equal(response.statusCode, 200, response.body);
  assert.doesNotMatch(response.body, /private-stewardship|sourceUseReview|reviewedInputDigest/);
  const current = recognitionFingerprint(h.controlsStore.read(), [s.binding]),
    old = historicalAuthority.publicPersisted;
  assert.equal(h.controlsStore.read().pipelinePublications[snapshotId].recognitionFingerprint, current);
  assert.notEqual(old, current);
  h.controlsStore.transaction((state) => {
    state.pipelinePublications[snapshotId].recognitionFingerprint = old;
  });
  const denied = async (runtime) => {
    for (const pin of [null, snapshotId])
      assert.equal(await runtime.source.read(publicScope, pin, new AbortController().signal), null);
    const result = await runtime.app.inject(path);
    assert.equal(result.statusCode, 410);
    assert.match(result.headers["cache-control"], /no-store/);
  };
  await denied(h.runtime);
  await h.runtime.stop();
  await h.reopenDatabase();
  const reopened = await createPipeline(h.options);
  t.after(() => reopened.stop());
  await denied(reopened);
  const repaired = await reopened.runOnce({ cutoff: stewardshipCutoff });
  assert.equal(repaired.state, "published");
  const restoredId = repaired.publications[0].snapshotId;
  assert.equal(
    (await reopened.source.read(publicScope, restoredId, new AbortController().signal)).selected.rows[0].result.value,
    1,
  );
  h.controlsStore.transaction((state) => {
    state.requests[s.request.id].status = "withdrawn";
  });
  assert.equal(await reopened.source.read(publicScope, restoredId, new AbortController().signal), null);
});
