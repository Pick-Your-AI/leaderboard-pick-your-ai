// Fictional merged-source and authenticated-review prerequisites, never live recognition.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeGithubObservation, applyRecognitionReceipt } from "@pick-your-ai/github";
import { getMetricDefinition, metricRegistryV1 } from "@pick-your-ai/metrics";
import { materializeRecognition } from "../../apps/pipeline/src/recognition-adapter.mjs";
import { attachSyntheticEvidenceIntake } from "./evidence-intake.mjs";

const engineering = JSON.parse(
  readFileSync(new URL("../../packages/github/test/fixtures/engineering.json", import.meta.url), "utf8"),
);
export const classificationSchema = "maintenance-classification/v1";
export const classificationKinds = ["dependency_maintenance", "build_fix", "accepted_bug_fix"];
export const mergeTime = "2026-10-07T10:00:00.000Z";
export const reviewTime = "2026-10-09T10:00:00.000Z";
export const classificationCutoff = "2026-10-10T10:00:00.000Z";
export const publicClassificationCodes = (kinds) => [
  "maintenance_classification_policy:maintenance-classification/v1",
  ...[...kinds].sort().map((kind) => "maintenance_kind:" + kind),
];

export function maintenanceClassificationScenario({
  kinds = ["dependency_maintenance"],
  number = 10,
  coauthor = false,
  bot = false,
  lifecycle = "merged",
  markerFree = false,
} = {}) {
  const data = markerFree ? JSON.parse(JSON.stringify(engineering).replace(/synthetic/gi, "fixture")) : engineering;
  const slug = markerFree ? "example-org/example-repo" : "synthetic-owner/repository";
  const prefix = markerFree ? "fixture" : "synthetic";
  const payload = {
    ...structuredClone(data.pull_request),
    id: 1000 + number,
    node_id: "PR_" + prefix + "_classification_" + number,
    number,
    user: bot ? data.bot : data.author,
    merged_by: data.merger,
    html_url: "https://github.com/" + slug + "/pull/" + number,
    title: "Dependency build bug labels are not qualification",
    labels: [{ id: 77, name: "accepted bug fix" }],
    state: lifecycle === "open" ? "open" : "closed",
    merged: lifecycle === "merged",
    merged_at: lifecycle === "merged" ? mergeTime : null,
    closed_at: lifecycle === "open" ? null : mergeTime,
  };
  const input = normalizeGithubObservation({
    repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_rest", revision: "collection-scan:maintenance-7", isSynthetic: false },
    family: "pull_request",
    action: lifecycle === "open" ? "opened" : "closed",
    occurredAt: lifecycle === "open" ? payload.created_at : mergeTime,
    observedAt: reviewTime,
    payload: { repository: { ...data.repository, full_name: slug }, pull_request: payload },
    ...(coauthor ? { verifiedCoauthors: [{ actor: data.reviewer, verificationReceipt: "synthetic-coauthor" }] } : {}),
  });
  const sourceMetricId = coauthor ? "pr_coauthored" : lifecycle === "merged" ? "pr_merged" : "pr_opened";
  const target = input.facts.find((fact) => fact.metricId === sourceMetricId);
  assert.ok(target);
  const evidence = input.evidence.find((entry) => entry.contribution.contributionId === target.id);
  assert.ok(evidence);
  const reviewer = target.actorId === "202" ? "303" : "202";
  const policyVersion = "maintenance-classification-policy-v1";
  const record = {
    schemaVersion: classificationSchema,
    policyVersion,
    targetFactId: target.id,
    sourceRevision: evidence.sourceRevision,
    classifications: kinds.map((kind) => ({
      kind,
      references: [{ locator: evidence.artifact.publicUrl, revision: evidence.sourceRevision }],
    })),
  };
  const decision = {
    id: "synthetic-classification-decision-" + number,
    action: "accepted",
    version: 2,
    actor: reviewer,
    at: Date.parse(reviewTime),
    policyVersion,
  };
  const request = {
    id: "synthetic-classification-request-" + number,
    kind: "evidence",
    status: "accepted",
    version: 2,
    owner: target.actorId,
    category: "other",
    scope: "repository:2:maintenance:classification",
    locator: evidence.artifact.publicUrl,
    collaborators: {},
    policyVersion,
    detail: JSON.stringify(record),
    history: [decision],
  };
  const state = { requests: { [request.id]: request }, profiles: {}, audit: [] };
  const binding = {
    category: request.category,
    scope: request.scope,
    policyVersion,
    metricId: "maintenance",
    sourceMetricId,
    repositoryId: target.repoId,
    reviewerIds: [reviewer],
    maintenanceClassification: { schemaVersion: classificationSchema },
  };
  const policy = {
    metricId: "maintenance",
    version: policyVersion,
    definitionVersion: metricRegistryV1.policy_version,
    unit: getMetricDefinition("maintenance").definition.unit,
    aggregation: "count",
    dateBasis: "occurredAt",
    groupBy: "canonical",
    rankedStates: ["qualified"],
    roles: ["author", "coauthor"],
    sources: ["github_rest"],
    minimumSamples: 1,
    rank: false,
  };
  const s = { input, target, evidence, record, decision, request, state, binding, policies: [{ policy }], payload };
  refreshMaintenanceClassificationReview(s);
  return s;
}

export function refreshMaintenanceClassificationReview(s, references) {
  const selected = references ?? s.record?.classifications?.flatMap((item) => item.references) ?? [];
  const unique = [...new Map(selected.map((reference) => [JSON.stringify(reference), reference])).values()];
  attachSyntheticEvidenceIntake(s.request, {
    sourceUseReview: {
      references: unique.length ? unique : [{ locator: s.request.locator, revision: s.evidence.sourceRevision }],
    },
  });
  s.state.audit = [structuredClone(s.decision)];
}

export function maintenanceReceipt(s, classification = s.record) {
  return {
    verified: true,
    id: s.decision.id,
    metricId: "maintenance",
    actorId: s.target.actorId,
    reviewerId: s.decision.actor,
    acceptedAt: reviewTime,
    decision: "accepted",
    targetFactId: s.target.id,
    evidenceIds: [s.target.id],
    ...(classification === undefined ? {} : { maintenanceClassification: structuredClone(classification) }),
  };
}
export const applyMaintenanceClassification = (s, receipt = maintenanceReceipt(s)) =>
  applyRecognitionReceipt(s.input, receipt, s.binding.reviewerIds);
export const materializeMaintenanceClassification = (s, callback = applyRecognitionReceipt) =>
  materializeRecognition(s.input, s.state, [s.binding], s.policies, callback, classificationCutoff);
export function maintenanceProof(output) {
  const facts = output.facts.filter((fact) => fact.metricId === "maintenance");
  assert.equal(facts.length, 1);
  return {
    fact: facts[0],
    evidence: output.evidence.find((entry) => entry.contribution.contributionId === facts[0].id),
  };
}
