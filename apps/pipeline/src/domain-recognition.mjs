import { createHash } from "node:crypto";
import { sourceEventSchema } from "@pick-your-ai/contracts";

// These are existing registry definitions, not new metrics or source permissions.
const clocks = {
  catalog_proposals: "accepted_at",
  pricebook_proposals: "accepted_at",
  compatibility_proposals: "accepted_at",
  primary_sources: "accepted_at",
  freshness_checks: "checked_at",
  reproduced_measurements: "accepted_at",
  negative_findings: "accepted_at",
  rights_reviews: "accepted_at",
  assumptions_resolved: "accepted_at",
  market_research: "accepted_at",
  evidence_manifests: "accepted_at",
  documentation: "merged_at",
  tests: "merged_at",
  regressions_prevented: "accepted_at",
  accessibility: "accepted_at",
  design: "accepted_at",
  usability: "accepted_at",
  performance: "accepted_at",
  security: "published_at",
};
export const domainMetricIds = Object.freeze(Object.keys(clocks));
export const domainDateBasis = (metricId) =>
  Object.hasOwn(clocks, metricId) ? (clocks[metricId] === "accepted_at" ? "acceptedAt" : "occurredAt") : null;
const authorMetrics = new Set([
  "catalog_proposals",
  "pricebook_proposals",
  "compatibility_proposals",
  "primary_sources",
  "negative_findings",
  "rights_reviews",
  "evidence_manifests",
  "documentation",
  "tests",
]);

const fail = () => {
  // Do not serialize private evidence, actor identities or receipt IDs in errors.
  throw new Error("domain_recognition_evidence_unverified");
};
const require = (condition) => {
  if (!condition) fail();
};
const object = (value, keys) => {
  require(value && typeof value === "object" && !Array.isArray(value));
  require(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
  return value;
};
const id = (value) => {
  require(typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value));
  return value;
};
const ids = (value, maximum = 32) => {
  require(Array.isArray(value) && value.length > 0 && value.length <= maximum);
  value.forEach(id);
  require(new Set(value).size === value.length);
  return [...value].sort();
};
const digest = (value) => {
  require(typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
  return value;
};
const instant = (value) => {
  require(
    typeof value === "string" && value.length <= 40 && sourceEventSchema.shape.occurredAt.safeParse(value).success,
  );
  // The metric engine consumes millisecond instants. Refuse finer precision
  // rather than round a future event or two distinct as-of units together.
  require(!/\.\d{4,}(?:Z|[+-]\d\d:\d\d)$/.test(value));
  require(Number.isFinite(Date.parse(value)));
  return Date.parse(value);
};
const choice = (value, values) => {
  require(values.includes(value));
  return value;
};
const pinnedGithubUrl = (value, revision) => {
  require(typeof value === "string" && value.length <= 2048);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail();
  }
  require(
    url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href === value,
  );
  require(typeof revision === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision));
  const path = url.pathname.split("/");
  require(path.length >= 5 && /^[A-Za-z0-9_.-]+$/.test(path[1]) && /^[A-Za-z0-9_.-]+$/.test(path[2]));
  require((path[3] === "commit" && path.length === 5) || (path[3] === "blob" && path.length > 5));
  require(path[4] === revision && !/%|\\/.test(url.pathname) && !path.some((part) => part === "." || part === ".."));
  return value;
};
const decimal = (value) => {
  require(typeof value === "string" && value.length <= 100 && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value));
  const [whole, fraction = ""] = value.split(".");
  return { coefficient: BigInt(whole + fraction), scale: fraction.length };
};
const compareDecimals = (before, after) => {
  const a = decimal(before),
    b = decimal(after),
    scale = Math.max(a.scale, b.scale);
  const left = a.coefficient * 10n ** BigInt(scale - a.scale);
  const right = b.coefficient * 10n ** BigInt(scale - b.scale);
  return left < right ? -1 : left > right ? 1 : 0;
};
const approvedOwner = (roster, reviewer) => require(ids(roster).includes(reviewer));

/**
 * Qualify one protected, independently reviewed record against current collected
 * evidence. This consumes attestations; it does not scrape or certify their facts.
 * No caller-supplied text, source manifest or private receipt enters public output.
 */
export function qualifyDomainRecognition({ input, request, decision, binding, candidate, acceptedAt, cutoff }) {
  const metric = binding.metricId;
  if (!Object.hasOwn(clocks, metric)) return null;
  require(input.isSynthetic !== true && !(input.syntheticFactIds ?? []).includes(candidate.id));
  const domain = object(binding.domainEvidence, [
    "version",
    "ownerIds",
    "contractReviewerIds",
    "disclosureReviewerIds",
    "freshnessIntervalSeconds",
    "records",
  ]);
  require(domain.version === "domain-evidence/v1");
  require(Array.isArray(domain.records) && domain.records.length <= 1000);
  const matching = domain.records.filter((record) => record?.requestId === request.id);
  require(matching.length === 1);
  const record = object(matching[0], [
    "requestId",
    "requestVersion",
    "decisionId",
    "factId",
    "sourceRevision",
    "sourceRevisionUrl",
    "validUntil",
    "synthetic",
    "publicSafe",
    "details",
  ]);
  require(
    id(record.requestId) === request.id &&
      Number.isSafeInteger(record.requestVersion) &&
      record.requestVersion > 0 &&
      record.requestVersion === request.version &&
      decision.version === record.requestVersion &&
      id(record.decisionId) === decision.id &&
      id(record.factId) === candidate.id,
  );
  require(record.synthetic === false && record.publicSafe === true);
  require(instant(acceptedAt) <= instant(cutoff) && instant(record.validUntil) >= instant(cutoff));
  require(instant(record.validUntil) >= instant(acceptedAt));
  const evidence = input.evidence.filter((entry) => entry.contribution.contributionId === candidate.id);
  require(evidence.length === 1);
  const target = evidence[0];
  require(
    target.artifact.repositoryId === binding.repositoryId &&
      target.artifact.publicUrl === request.locator &&
      target.artifact.visibility === "public" &&
      target.contribution.actorId === request.owner &&
      target.sourceRevision === record.sourceRevision &&
      target.sourceRevisionUrl === record.sourceRevisionUrl,
  );
  pinnedGithubUrl(record.sourceRevisionUrl, record.sourceRevision);
  require(
    candidate.actorId === request.owner &&
      typeof candidate.role === "string" &&
      candidate.role !== "unknown" &&
      candidate.role !== "automation",
  );
  require(candidate.state !== "excluded" && candidate.state !== "pending" && candidate.state !== "unknown");
  // Authorship is source attribution, not a consequence of owning a request or
  // reviewing someone else's change. Other roles need their own future adapter.
  if (authorMetrics.has(metric)) require(["author", "coauthor"].includes(candidate.role));

  if (["catalog_proposals", "pricebook_proposals", "compatibility_proposals", "evidence_manifests"].includes(metric))
    approvedOwner(domain.ownerIds, decision.actor);
  if (metric === "compatibility_proposals") approvedOwner(domain.contractReviewerIds, decision.actor);
  if (metric === "security") approvedOwner(domain.disclosureReviewerIds, decision.actor);

  const detail = record.details;
  let unit,
    occurredAt = acceptedAt;
  switch (metric) {
    case "catalog_proposals":
      object(detail, [
        "canonicalKind",
        "canonicalId",
        "recordVersion",
        "contractVersion",
        "factualReview",
        "sourceIds",
      ]);
      unit = [id(detail.canonicalKind), id(detail.canonicalId), id(detail.recordVersion)];
      id(detail.contractVersion);
      require(detail.factualReview === true);
      ids(detail.sourceIds);
      break;
    case "pricebook_proposals":
      object(detail, [
        "pricebookId",
        "pricebookVersion",
        "asOf",
        "currency",
        "units",
        "conditionsHash",
        "sourceIds",
        "factualReview",
      ]);
      require(typeof detail.currency === "string" && /^[A-Z]{3}$/.test(detail.currency));
      instant(detail.asOf);
      require(instant(detail.asOf) <= instant(acceptedAt) && detail.factualReview === true);
      digest(detail.conditionsHash);
      unit = [id(detail.pricebookId), id(detail.pricebookVersion), new Date(detail.asOf).toISOString()];
      ids(detail.units);
      ids(detail.sourceIds);
      break;
    case "compatibility_proposals":
      object(detail, ["proposalId", "proposalVersion", "contractVersion", "reviewIssue", "centralDisposition"]);
      require(detail.reviewIssue === "https://github.com/Pick-Your-AI/pick-your-ai-research/issues/40");
      choice(detail.centralDisposition, ["accepted", "narrowed"]);
      id(detail.contractVersion);
      unit = [id(detail.proposalId), id(detail.proposalVersion)];
      break;
    case "primary_sources":
      object(detail, ["canonicalSourceId", "claimId", "sourceState", "evidenceClass"]);
      require(detail.sourceState === "available");
      choice(detail.evidenceClass, ["primary_source", "publisher_statement", "independent_measurement"]);
      unit = [id(detail.canonicalSourceId), id(detail.claimId)];
      break;
    case "freshness_checks": {
      object(detail, ["canonicalSourceId", "claimId", "checkedAt", "outcome"]);
      const interval = domain.freshnessIntervalSeconds;
      require(Number.isSafeInteger(interval) && interval >= 1 && interval <= 366 * 86400);
      occurredAt = new Date(instant(detail.checkedAt)).toISOString();
      choice(detail.outcome, ["available", "changed", "unavailable", "unknown"]);
      unit = [id(detail.canonicalSourceId), id(detail.claimId), Math.floor(instant(occurredAt) / (interval * 1000))];
      break;
    }
    case "reproduced_measurements":
      object(detail, ["experimentId", "runId", "conditionsHash", "resultHash", "evidenceClass"]);
      require(detail.evidenceClass === "independent_measurement");
      digest(detail.conditionsHash);
      digest(detail.resultHash);
      unit = [id(detail.experimentId), id(detail.runId)];
      break;
    case "negative_findings":
      object(detail, ["findingId", "findingVersion", "outcome", "sourceIds"]);
      choice(detail.outcome, ["limitation", "disproved", "unknown"]);
      ids(detail.sourceIds);
      id(detail.findingVersion);
      unit = [id(detail.findingId)];
      break;
    case "rights_reviews":
      object(detail, ["artifactId", "questionId", "termsRevision", "disposition"]);
      choice(detail.disposition, ["allowed", "excluded", "unknown"]);
      id(detail.termsRevision);
      unit = [id(detail.artifactId), id(detail.questionId)];
      break;
    case "assumptions_resolved":
      object(detail, ["decisionId", "outcome", "sourceIds"]);
      choice(detail.outcome, ["supported", "rejected", "unknown"]);
      ids(detail.sourceIds);
      unit = [id(detail.decisionId)];
      break;
    case "market_research":
      object(detail, ["studyId", "studyVersion", "method", "participantData", "sourceIds"]);
      choice(detail.method, ["desk_research", "publisher_statement", "independent_measurement", "user_study"]);
      choice(detail.participantData, ["none", "approved_sanitized_aggregate"]);
      require(detail.method !== "user_study" || detail.participantData === "approved_sanitized_aggregate");
      ids(detail.sourceIds);
      id(detail.studyVersion);
      unit = [id(detail.studyId)];
      break;
    case "usability":
      object(detail, [
        "studyId",
        "studyVersion",
        "findingId",
        "findingVersion",
        "findingAccepted",
        "method",
        "participantData",
        "sourceIds",
      ]);
      require(detail.findingAccepted === true);
      choice(detail.method, ["desk_research", "publisher_statement", "independent_measurement", "user_study"]);
      choice(detail.participantData, ["none", "approved_sanitized_aggregate"]);
      require(detail.method !== "user_study" || detail.participantData === "approved_sanitized_aggregate");
      ids(detail.sourceIds);
      id(detail.studyVersion);
      id(detail.findingVersion);
      unit = [id(detail.studyId), id(detail.findingId)];
      break;
    case "evidence_manifests":
      object(detail, ["artifactIdentity", "artifactHash", "sourceUse", "sourceIds"]);
      require(detail.sourceUse === "approved");
      ids(detail.sourceIds);
      unit = [id(detail.artifactIdentity), digest(detail.artifactHash)];
      break;
    case "documentation":
    case "tests":
      object(detail, ["authorship", "category", "substantiveReview"]);
      require(detail.authorship === "authored" && detail.substantiveReview === true);
      choice(detail.category, metric === "documentation" ? ["documentation", "example", "guide"] : ["test_artifact"]);
      unit = [target.artifact.stableId, detail.category];
      break;
    case "regressions_prevented":
      object(detail, ["scenarioId", "fixtureHash", "beforeRevision", "afterRevision", "failsBefore", "passesAfter"]);
      digest(detail.fixtureHash);
      require(
        detail.failsBefore === true && detail.passesAfter === true && detail.beforeRevision !== detail.afterRevision,
      );
      unit = [id(detail.scenarioId)];
      id(detail.beforeRevision);
      id(detail.afterRevision);
      require(detail.afterRevision === record.sourceRevision);
      break;
    case "accessibility":
      object(detail, ["artifactId", "artifactVersion", "phase", "criteria", "reviewMethod"]);
      choice(detail.phase, ["audit", "discovery", "delivered_fix"]);
      choice(detail.reviewMethod, ["automated", "manual", "assistive_technology"]);
      ids(detail.criteria);
      unit = [id(detail.artifactId), id(detail.artifactVersion), detail.phase];
      break;
    case "design":
      object(detail, ["componentOrFlowId", "designVersion", "role", "publicAttribution"]);
      require(detail.publicAttribution === true);
      choice(detail.role, ["author", "coauthor", "reviewer"]);
      require(detail.role === candidate.role);
      unit = [id(detail.componentOrFlowId), id(detail.designVersion)];
      break;
    case "performance": {
      object(detail, ["resultId", "scopeId", "runId", "evidenceClass", "before", "after", "direction"]);
      require(detail.evidenceClass === "independent_measurement");
      const keys = ["revision", "conditionsHash", "metric", "unit", "value"];
      object(detail.before, keys);
      object(detail.after, keys);
      const before = detail.before,
        after = detail.after;
      require(id(before.revision) !== id(after.revision) && after.revision === record.sourceRevision);
      require(
        digest(before.conditionsHash) === digest(after.conditionsHash) &&
          id(before.metric) === id(after.metric) &&
          id(before.unit) === id(after.unit),
      );
      choice(detail.direction, ["lower_is_better", "higher_is_better"]);
      require(compareDecimals(before.value, after.value) === (detail.direction === "lower_is_better" ? 1 : -1));
      id(detail.runId);
      unit = [id(detail.resultId), id(detail.scopeId)];
      break;
    }
    case "security":
      object(detail, [
        "disclosureId",
        "disclosureVersion",
        "publishedAt",
        "publicDisclosureApproved",
        "contributorConsent",
      ]);
      require(detail.publicDisclosureApproved === true && detail.contributorConsent === true);
      occurredAt = new Date(instant(detail.publishedAt)).toISOString();
      id(detail.disclosureVersion);
      unit = [id(detail.disclosureId)];
      break;
    default:
      fail();
  }
  if (clocks[metric] === "merged_at") {
    require(["pr_merged", "documentation", "tests"].includes(binding.sourceMetricId));
    require(
      target.artifact.kind === "pull_request" &&
        (candidate.rawState?.startsWith("target:") ||
          candidate.rawState === "merged_documentation_participation_not_reviewed_quality"),
    );
    occurredAt = candidate.occurredAt;
  }
  require(instant(occurredAt) <= instant(acceptedAt));
  const changesetId =
    "domain:" +
    createHash("sha256")
      .update(JSON.stringify(["domain-evidence/v1", metric, binding.repositoryId, unit]))
      .digest("hex");
  const publicReasonCodes = [
    "independent_recognition_receipt",
    `domain_metric:${metric}`,
    `domain_clock:${clocks[metric]}`,
  ];
  if (["catalog_proposals", "pricebook_proposals", "compatibility_proposals"].includes(metric))
    publicReasonCodes.push("reviewed_artifact_not_issue_completion_or_production_publication");
  for (const key of ["evidenceClass", "method", "outcome", "phase", "reviewMethod", "authorship", "disposition"])
    if (Object.hasOwn(detail, key)) publicReasonCodes.push(`domain_${key}:${detail[key]}`);
  return { changesetId, occurredAt, dateBasis: domainDateBasis(metric), publicReasonCodes };
}
