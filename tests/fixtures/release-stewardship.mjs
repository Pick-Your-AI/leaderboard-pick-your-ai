// Fictional protected-host source and review inputs. No network, real release,
// checklist, named-participant approval or public deployment evidence is claimed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeGithubObservation, applyRecognitionReceipt } from "@pick-your-ai/github";
import { aggregateMetric, getMetricDefinition, metricRegistryV1 } from "@pick-your-ai/metrics";
import { attachSyntheticEvidenceIntake } from "./evidence-intake.mjs";

export const stewardshipMetric = "release_stewardship";
export const publicationAt = "2026-10-07T10:00:00.000Z";
export const stewardshipAcceptedAt = "2026-10-09T10:00:00.000Z";
export const stewardshipCutoff = "2026-10-10T10:00:00.000Z";
const actors = JSON.parse(
  readFileSync(new URL("../../packages/github/test/fixtures/engineering.json", import.meta.url), "utf8"),
);

export function stewardshipSource({
  occurredAt = publicationAt,
  action = "published",
  draft = false,
  bot = false,
  number = 60,
  markerFree = false,
  revision = "opaque-release-revision-v1",
} = {}) {
  const data = markerFree ? JSON.parse(JSON.stringify(actors).replace(/synthetic/gi, "fixture")) : actors;
  const slug = markerFree ? "example-org/example-repo" : "synthetic-owner/repository";
  return normalizeGithubObservation({
    repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
    proof: {
      verified: true,
      source: "github_webhook",
      eventId: `release-publication-${number}`,
      revision,
      isSynthetic: false,
    },
    family: "release",
    action,
    occurredAt,
    observedAt: stewardshipCutoff,
    payload: {
      repository: { ...data.repository, full_name: slug },
      sender: bot ? data.bot : data.author,
      release: {
        id: number,
        node_id: `RE_${markerFree ? "fixture" : "synthetic"}_${number}`,
        html_url: `https://github.com/${slug}/releases/tag/v${number}`,
        author: data.reviewer,
        draft,
        prerelease: false,
        published_at: publicationAt,
      },
    },
  });
}
export const stewardshipTarget = (input) =>
  input.facts.find((fact) => fact.metricId === stewardshipMetric && fact.state !== "qualified");
export const stewardshipProof = (input) =>
  input.evidence.find((entry) => entry.contribution.contributionId === stewardshipTarget(input)?.id);
export function stewardshipReceipt(input, overrides = {}) {
  const target = stewardshipTarget(input);
  assert.ok(target);
  return {
    verified: true,
    id: "private-release-stewardship-review",
    metricId: stewardshipMetric,
    actorId: target.actorId,
    reviewerId: "202",
    acceptedAt: stewardshipAcceptedAt,
    decision: "accepted",
    targetFactId: target.id,
    evidenceIds: [target.id],
    ...overrides,
  };
}
export function stewardshipPolicy(overrides = {}) {
  return {
    metricId: stewardshipMetric,
    version: "stewardship-policy-v1",
    definitionVersion: metricRegistryV1.policy_version,
    unit: getMetricDefinition(stewardshipMetric).definition.unit,
    aggregation: "count",
    roles: ["author", "automation"],
    sources: ["github_webhook"],
    minimumSamples: 1,
    rank: false,
    dateBasis: "occurredAt",
    groupBy: "canonical",
    rankedStates: ["qualified"],
    ...overrides,
  };
}
export function stewardshipBoard(
  input,
  policy = stewardshipPolicy(),
  from = null,
  to = stewardshipCutoff,
  actorFilter = "all",
) {
  return aggregateMetric(
    {
      datasetId: "synthetic-stewardship-regression",
      cutoff: stewardshipCutoff,
      backfillRevision: "1",
      repositoryIds: ["2"],
      actors: input.actors,
      facts: input.facts,
      coverage: [],
    },
    policy,
    {
      timezone: "UTC",
      from,
      to,
      repos: [],
      projects: [],
      workstreams: [],
      roles: [],
      actors: actorFilter,
      context: "event",
    },
  );
}
export const stewardshipValue = (result) => result.rows.reduce((sum, row) => sum + row.value, 0);
export function stewardshipScenario(options = {}) {
  const input = stewardshipSource(options),
    target = stewardshipTarget(input),
    evidence = stewardshipProof(input);
  assert.ok(target);
  assert.ok(evidence);
  const decision = {
    id: "private-stewardship-audit",
    action: "accepted",
    actor: "202",
    at: Date.parse(stewardshipAcceptedAt),
    version: 2,
    policyVersion: stewardshipPolicy().version,
  };
  const request = {
    id: "private-stewardship-request",
    kind: "evidence",
    status: "accepted",
    owner: target.actorId,
    version: 2,
    category: "other",
    scope: "repository:2:release-stewardship",
    policyVersion: decision.policyVersion,
    locator: evidence.artifact.publicUrl,
    collaborators: {},
    history: [decision],
    detail:
      "Fictional protected host reviewed this publisher participation. Checklist content is not a new typed interface.",
  };
  attachSyntheticEvidenceIntake(request);
  const binding = {
    category: request.category,
    scope: request.scope,
    policyVersion: request.policyVersion,
    metricId: stewardshipMetric,
    sourceMetricId: stewardshipMetric,
    repositoryId: "2",
    reviewerIds: ["202"],
  };
  return {
    input,
    target,
    evidence,
    decision,
    request,
    binding,
    state: { requests: { [request.id]: request }, profiles: {}, audit: [decision] },
    policies: [{ policy: stewardshipPolicy() }],
  };
}
export function duplicateStewardshipRequest(s, offset = 1000) {
  const request = structuredClone(s.request);
  request.id = "private-stewardship-alias";
  request.history[0].id = "private-stewardship-alias-review";
  request.history[0].receipt = request.id;
  request.history[0].at += offset;
  attachSyntheticEvidenceIntake(request);
  s.state.requests[request.id] = request;
  s.state.audit.push(structuredClone(request.history[0]));
  return request;
}
export const applyStewardshipReceipt = (input, overrides = {}) =>
  applyRecognitionReceipt(input, stewardshipReceipt(input, overrides), ["202"]);

// Exercise distinct source-admission boundaries through both public APIs.
export const invalidStewardshipSources = {
  "unknown source clock": (s) => {
    s.target.occurredAt = null;
    s.target.state = "unknown";
  },
  "unobserved source": (s) => {
    s.target.state = "reviewed";
  },
  "previous acceptance": (s) => {
    s.target.acceptedAt = stewardshipAcceptedAt;
  },
  "non-release artifact": (s) => {
    s.evidence.artifact.kind = "issue";
  },
  "mismatched artifact identity": (s) => {
    s.evidence.contribution.artifactId = "another-release";
  },
  "mismatched repository": (s) => {
    s.evidence.artifact.repositoryId = "999";
  },
  "mismatched publisher": (s) => {
    s.evidence.contribution.actorId = "303";
  },
  "missing canonical source": (s) => {
    s.target.canonicalKey = null;
  },
  "mismatched canonical source": (s) => {
    s.evidence.contribution.canonicalEventId = "another-source-event";
  },
  "duplicate public proof": (s) => {
    s.input.evidence.push(structuredClone(s.evidence));
  },
  "duplicate publisher identity": (s) => {
    s.input.actors.push(structuredClone(s.input.actors.find((actor) => actor.id === s.target.actorId)));
  },
  "missing opaque source revision": (s) => {
    s.evidence.sourceRevision = " ";
  },
  "different public occurrence": (s) => {
    s.evidence.occurredAt = stewardshipAcceptedAt;
  },
  "different metadata occurrence": (s) => {
    s.evidence.evidenceMetadata.sourceOccurredAt = stewardshipAcceptedAt;
  },
  "nonpublication source action": (s) => {
    s.evidence.evidenceMetadata.sourceAction = "issue_closed";
  },
  "unrecognized publisher role": (s) => {
    s.target.role = "reviewer";
    s.evidence.contribution.roles = ["reviewer"];
  },
  "bot publisher relabelled as author": (s) => {
    // Start from the actual bot normalization, with its own bound owner/review.
    Object.assign(s, stewardshipScenario({ bot: true }));
    s.target.role = "author";
    s.evidence.contribution.roles = ["author"];
  },
  "human publisher relabelled as automation": (s) => {
    s.target.role = "automation";
    s.evidence.contribution.roles = ["automation"];
  },
};
