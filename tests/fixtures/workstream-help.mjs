// Fictional finite source and proof bytes only; no live permission, acceptance or rollout.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeGithubObservation, applyRecognitionReceipt } from "@pick-your-ai/github";
import { encodeWorkstreamHelpStatement, workstreamHelpVersion } from "@pick-your-ai/contracts";
import { getMetricDefinition, metricRegistryV1 } from "@pick-your-ai/metrics";
import { materializeRecognition } from "../../apps/pipeline/src/recognition-adapter.mjs";
import { materializeEvidenceMetadata } from "../../apps/pipeline/src/evidence-metadata.mjs";
import { attachSyntheticEvidenceIntake } from "./evidence-intake.mjs";

const engineering = JSON.parse(
  readFileSync(new URL("../../packages/github/test/fixtures/engineering.json", import.meta.url), "utf8"),
);
export const helpMergedAt = "2026-10-07T10:00:00.000Z";
export const helpAcceptedAt = "2026-10-09T10:00:00.000Z";
export const helpCutoff = "2026-10-10T10:00:00.000Z";
export const helpScope = { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null };
export const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

export function helpScenario(number = 10) {
  // This explicit fixture flag controls code-path qualification, not a claim that these actors or reviews exist.
  const data = JSON.parse(JSON.stringify(engineering).replace(/synthetic/gi, "fixture"));
  const slug = "example-org/example-repo";
  const payload = {
    ...structuredClone(data.pull_request),
    id: 1000 + number,
    node_id: "PR_fixture_" + number,
    number,
    user: data.author,
    html_url: "https://github.com/" + slug + "/pull/" + number,
    state: "closed",
    merged: true,
    merged_at: helpMergedAt,
    closed_at: helpMergedAt,
    updated_at: helpAcceptedAt,
    merged_by: data.merger,
  };
  const input = normalizeGithubObservation({
    repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_rest", revision: helpAcceptedAt, isSynthetic: false },
    family: "pull_request",
    action: "closed",
    occurredAt: helpMergedAt,
    observedAt: helpAcceptedAt,
    payload: { repository: { ...data.repository, full_name: slug }, pull_request: payload },
  });
  const candidate = input.facts.find((fact) => fact.metricId === "pr_merged");
  assert.ok(candidate);
  const evidence = input.evidence.find((entry) => entry.contribution.contributionId === candidate.id);
  assert.ok(evidence);
  const statement = {
    schemaVersion: "cross-workstream-help-statement/v1",
    organization: "Pick-Your-AI",
    definitionVersion: "fixture-workstreams-v1",
    from: { id: "platform", label: "Platform" },
    to: { id: "docs-team", label: "Documentation team" },
    actorId: candidate.actorId,
    repositoryId: candidate.repoId,
    artifactId: candidate.artifactId,
    sourceUrl: evidence.artifact.publicUrl,
    sourceRevision: evidence.sourceRevision,
    occurredAt: candidate.occurredAt,
    role: "author",
    helpKind: "authored_merged_change",
  };
  const revision = "b".repeat(40);
  const url = "https://github.com/" + slug + "/blob/" + revision + "/docs/workstream-help-" + number + ".json";
  const decision = {
    id: "private-help-review-" + number,
    action: "accepted",
    version: 2,
    actor: "202",
    at: Date.parse(helpAcceptedAt),
    policyVersion: "fixture-maintenance-policy-v1",
  };
  const request = {
    id: "private-help-request-" + number,
    kind: "evidence",
    status: "accepted",
    version: 2,
    owner: candidate.actorId,
    category: "maintenance",
    scope: "repository:2:maintenance",
    policyVersion: decision.policyVersion,
    locator: evidence.artifact.publicUrl,
    collaborators: {},
    history: [decision],
  };
  attachSyntheticEvidenceIntake(request, {
    intake: { roles: { submitter: "author", collaborators: {} } },
    sourceUseReview: { references: [{ locator: url, revision }] },
  });
  const state = { requests: { [request.id]: request }, profiles: {}, audit: [structuredClone(decision)] };
  const record = {
    requestId: request.id,
    requestVersion: request.version,
    decisionId: decision.id,
    factId: candidate.id,
    sourceAcceptance: { requestId: request.id, requestVersion: request.version, decisionId: decision.id },
    validUntil: "2026-10-11T00:00:00.000Z",
    statement: { revision, url, sha256: "", content: "" },
  };
  const binding = {
    category: request.category,
    scope: request.scope,
    policyVersion: request.policyVersion,
    metricId: "maintenance",
    sourceMetricId: "pr_merged",
    repositoryId: candidate.repoId,
    reviewerIds: ["202"],
    workstreamHelp: {
      ruleVersion: workstreamHelpVersion,
      organization: statement.organization,
      definitionVersion: statement.definitionVersion,
      workstreams: [structuredClone(statement.from), structuredClone(statement.to)],
      records: [record],
    },
  };
  const policy = {
    metricId: "maintenance",
    version: binding.policyVersion,
    definitionVersion: metricRegistryV1.policy_version,
    unit: getMetricDefinition("maintenance").definition.unit,
    aggregation: "count",
    dateBasis: "occurredAt",
    groupBy: "canonical",
    rankedStates: ["qualified"],
    roles: ["author"],
    sources: ["github_rest"],
    minimumSamples: 1,
    rank: false,
  };
  const scenario = {
    input,
    candidate,
    evidence,
    statement,
    decision,
    request,
    state,
    record,
    binding,
    policies: [{ policy }],
    payload,
  };
  updateHelpStatement(scenario);
  return scenario;
}
export function updateHelpStatement(scenario) {
  scenario.record.statement.content = encodeWorkstreamHelpStatement(scenario.statement);
  scenario.record.statement.sha256 = sha256(scenario.record.statement.content);
}
export function runHelp(scenario, callback = applyRecognitionReceipt) {
  return materializeRecognition(
    scenario.input,
    scenario.state,
    [scenario.binding],
    scenario.policies,
    callback,
    helpCutoff,
  );
}
export function publicHelpFixture(count = 3) {
  const scenarios = Array.from({ length: count }, (_, index) => helpScenario(10 + index));
  const outputs = scenarios.map((scenario) => runHelp(scenario));
  const evidence = outputs.flatMap((output) =>
    output.evidence
      .filter((entry) =>
        output.reviewedWorkstreamHelp.some((help) => help.contributionId === entry.contribution.contributionId),
      )
      .map((entry) => ({
        ...entry,
        ...materializeEvidenceMetadata(
          entry,
          output.facts.find((fact) => fact.id === entry.contribution.contributionId),
        ),
      })),
  );
  const actors = [
    ...new Map(
      outputs
        .flatMap((output) => output.actors)
        .map((actor) => [actor.id, actor]),
    ).values(),
  ].map((actor) => ({
    actorId: actor.id,
    state: "public",
    actor: {
      schemaVersion: "leaderboard/v1",
      identityState: "resolved",
      githubDatabaseId: Number(actor.id),
      ...(actor.githubNodeId ? { githubNodeId: actor.githubNodeId } : {}),
      login: actor.login,
      displayName: actor.login,
      kind: actor.kind,
      executionMode: actor.executionMode ?? "unknown",
    },
  }));
  const coverage = {
    schemaVersion: "leaderboard/v1",
    state: "partial",
    source: "github_rest",
    scopeId: "2",
    windowStart: "2026-10-01T00:00:00.000Z",
    windowEnd: helpCutoff,
    knownStart: null,
    lastSuccessfulSync: helpCutoff,
    sourceWatermark: helpCutoff,
    missingPages: 0,
    permissionsMissing: [],
    sourceErrors: ["historical_capability_not_certified"],
  };
  return {
    head: { snapshotId: "fixture-help", revision: 1, publishedAt: helpCutoff },
    controls: {
      version: "fixture-help-controls-1",
      suppressedActorIds: [],
      suppressedArtifactIds: [],
      revokedSnapshotIds: [],
    },
    selected: {
      approvedPublic: true,
      scope: structuredClone(helpScope),
      snapshot: {
        schemaVersion: "leaderboard/v1",
        snapshotId: "fixture-help",
        revision: 1,
        generatedAt: helpCutoff,
        metricDefinitionVersion: metricRegistryV1.policy_version,
        computationVersion: "fixture-help-only",
        coverage: [coverage],
        results: [],
      },
      actors,
      evidence: structuredClone(evidence),
      portfolioEvidence: evidence.map((entry) => ({
        ...structuredClone(entry),
        activityState: "accepted",
        observedAt: helpAcceptedAt,
      })),
      reviewedWorkstreamHelp: outputs.flatMap((output) => output.reviewedWorkstreamHelp),
      rows: [
        {
          actorId: "101",
          result: {
            schemaVersion: "leaderboard/v1",
            metricId: "maintenance",
            state: "partial",
            value: count,
            coverage,
          },
          evidenceIds: evidence.map((entry) => entry.contribution.contributionId),
        },
      ],
      ranking: [{ metricId: "maintenance", direction: "descending", rank: false }],
    },
  };
}
