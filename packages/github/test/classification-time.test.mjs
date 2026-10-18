import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGithubObservation, createGithubEvidenceNormalizer } from "../dist/index.js";
import { syntheticRepositoryClient } from "./synthetic-client.mjs";
import {
  classification,
  classificationTimes,
  cutoff,
  observation,
} from "../../../tests/fixtures/service-account-time.mjs";

for (const source of ["github_rest", "github_graphql"])
  for (const [label, reviewedAt, admitted] of classificationTimes)
    test(source + " classification review cutoff preserves " + label, () => {
      const input = observation(reviewedAt, source);
      const original = structuredClone(input);
      const run = () => normalizeGithubObservation(input);
      if (!admitted) assert.throws(run, /independently authorized service-account classification/);
      else {
        const output = run();
        assert.equal(output.actors[0].id, "101");
        assert.equal(output.actors[0].kind, "service_account");
        assert.equal(output.actors[0].executionMode, "unknown");
        assert.deepEqual(output.actors[0].serviceAccountClassification, classification(reviewedAt));
        assert.equal(output.facts[0].actorId, "101");
        assert.equal(output.facts[0].role, "author");
      }
      assert.deepEqual(input, original);
    });

for (const enriched of [false, true])
  for (const [label, reviewedAt, admitted] of classificationTimes.filter((_, index) => [2, 5].includes(index)))
    test((enriched ? "enriched" : "hydrated") + " protected classification preserves " + label, async () => {
      const input = {
        repository: { id: 2, slug: "synthetic-owner/repository" },
        family: "pull_requests",
        factKey: "synthetic-classification-time-source",
        policyVersion: "synthetic-classification-time/v1",
        observedAt: cutoff,
        fact: {
          subjectId: "PR_synthetic_10",
          sourceRevision: cutoff,
          sourceUrl: observation().payload.html_url,
          evidence: "current_state",
          actorId: "101",
          occurredAt: "2026-10-02T00:00:00Z",
          state: "open",
        },
      };
      const normalize = createGithubEvidenceNormalizer({
        client: syntheticRepositoryClient(2, {
          rest: async (_source, path) =>
            path.endsWith("/pulls/10") ? observation().payload : { id: 2, private: false },
        }),
        source: "synthetic-source",
        allowedRepositoryIds: [2],
        isSynthetic: true,
        reviewedServiceAccounts: [classification(reviewedAt)],
        authorizedClassifierIds: ["202"],
        ...(enriched ? { enrich: async () => observation() } : {}),
      });
      if (!admitted)
        await assert.rejects(() => normalize(input), /independently authorized service-account classification/);
      else
        assert.deepEqual((await normalize(input)).actors[0].serviceAccountClassification, classification(reviewedAt));
    });

test("classification source instants do not widen normalized observation clocks", () => {
  for (const observedAt of [
    "2026-10-03T01:00:00.123+01:00",
    "2026-10-03T00:00:00.123000001Z",
    "2026-10-03T00:00:00.1230Z",
  ])
    assert.throws(() => normalizeGithubObservation({ ...observation(), observedAt }), /Explicit observation time/);
});
