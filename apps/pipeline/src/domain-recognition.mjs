import { createHash } from "node:crypto";
import { publicEvidenceMetadataSchema, sourceEventSchema } from "@pick-your-ai/contracts";
import { bindOrderingReview, validateOrderingSource } from "@pick-your-ai/github";
import { qualifyProjectConfiguration } from "./project-configuration-recognition.mjs";

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
  data_quality: "accepted_at",
  reproductions: "accepted_at",
  documentation: "merged_at",
  tests: "merged_at",
  regressions_prevented: "accepted_at",
  accessibility: "accepted_at",
  design: "accepted_at",
  usability: "accepted_at",
  performance: "accepted_at",
  security: "published_at",
  governance: "accepted_at",
  deployment_work: "accepted_at",
  incidents: "accepted_at",
};
export const domainMetricIds = Object.freeze(Object.keys(clocks));
export const domainDateBasis = (metricId) =>
  metricId === "project_configuration" || metricId === "issue_ordering"
    ? "acceptedAt"
    : Object.hasOwn(clocks, metricId)
      ? clocks[metricId] === "accepted_at"
        ? "acceptedAt"
        : "occurredAt"
      : null;
const authorMetrics = new Set([
  "catalog_proposals",
  "pricebook_proposals",
  "compatibility_proposals",
  "primary_sources",
  "negative_findings",
  "rights_reviews",
  "evidence_manifests",
  "data_quality",
  "reproductions",
  "documentation",
  "tests",
  "governance",
  "deployment_work",
  "incidents",
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
  for (let index = 0; index < value.length; index++) {
    require(Object.hasOwn(value, index));
    id(value[index]);
  }
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
const gitRevision = (value) => {
  require(
    typeof value === "string" && [40, 64].includes(value.length) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value),
  );
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

const operationsMetrics = new Set(["governance", "deployment_work", "incidents"]);
const operationId = (value) => {
  id(value);
  require(value.trim() === value);
  return value;
};

// A protected narrative describes source work; it cannot create that work or
// turn an execution, merge operator, prior qualification or unknown role into authorship.
function requireOperationSource(input, binding, candidate, target, acceptedAt) {
  require(
    binding.sourceMetricId === "pr_merged" &&
      candidate.metricId === "pr_merged" &&
      candidate.role === "author" &&
      candidate.state === "observed" &&
      candidate.acceptedAt == null &&
      candidate.acceptedBy == null &&
      candidate.acceptanceReceipt == null &&
      typeof candidate.rawState === "string" &&
      candidate.rawState.startsWith("target:") &&
      candidate.rawState.length > 7 &&
      input.facts.filter((fact) => fact.id === candidate.id).length === 1 &&
      input.actors.filter((actor) => actor.id === candidate.actorId).length === 1 &&
      typeof candidate.canonicalKey === "string" &&
      candidate.canonicalKey.trim().length > 0 &&
      typeof candidate.artifactId === "string" &&
      candidate.artifactId.trim().length > 0 &&
      candidate.repoId === binding.repositoryId &&
      target.artifact.source === "github" &&
      target.artifact.kind === "pull_request" &&
      target.artifact.stableId === candidate.artifactId &&
      target.contribution.artifactId === candidate.artifactId &&
      target.contribution.canonicalEventId === candidate.canonicalKey &&
      target.contribution.qualification === "eligible" &&
      Array.isArray(target.contribution.metricIds) &&
      target.contribution.metricIds.length === 1 &&
      target.contribution.metricIds[0] === "pr_merged" &&
      Array.isArray(target.contribution.roles) &&
      target.contribution.roles.length === 1 &&
      target.contribution.roles[0] === "author",
  );
  require(instant(candidate.occurredAt) <= instant(acceptedAt));
  require(instant(target.occurredAt) === instant(candidate.occurredAt));
  const metadata = target.evidenceMetadata;
  if (metadata !== undefined) {
    require(
      publicEvidenceMetadataSchema.safeParse(metadata).success &&
        metadata.sourceAction === "pull_request_merged" &&
        metadata.activityState === "observed" &&
        metadata.acceptedAt === null,
    );
    require(instant(metadata.sourceOccurredAt) === instant(candidate.occurredAt));
  }
}

// Only a pinned public file in the already collected repository/revision can
// describe the reviewed work. Its contents/hash still require actual host review.
function requireOperationRecord(value, record) {
  const pin = object(value, ["revision", "sourceRevisionUrl", "contentHash"]);
  require(typeof pin.revision === "string" && [40, 64].includes(pin.revision.length));
  pinnedGithubUrl(pin.sourceRevisionUrl, pin.revision);
  require(digest(pin.contentHash).length === 64);
  const path = new URL(pin.sourceRevisionUrl).pathname.split("/");
  const source = new URL(record.sourceRevisionUrl).pathname.split("/");
  require(
    pin.revision === record.sourceRevision &&
      path[1] === source[1] &&
      path[2] === source[2] &&
      path[3] === "blob" &&
      path.slice(1).every((part) => part.length > 0),
  );
}

// Only list shapes newly rejected above need a saved-authority fence. Explicit
// undefined shares both legacy recognition/configuration hashes with a hole.
const sparseIdAuthority = (value) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return false;
  for (let index = 0; index < value.length; index++)
    if (!Object.hasOwn(value, index) || value[index] === undefined) return true;
  return false;
};

// Keep this limited to lists consumed by the selected metric and request. An
// unused roster, another request's record or unrelated binding retains its exact
// prior authority. No public proof detail is added to the fingerprint marker.
export function hasSparseDomainIdentifierAuthority(binding, request) {
  const domain = binding?.domainEvidence;
  if (domain?.version !== "domain-evidence/v1" || !Array.isArray(domain.records) || domain.records.length > 1000)
    return false;
  const records = domain.records.filter((record) => record?.requestId === request.id);
  if (records.length !== 1) return false;
  const record = records[0];
  const decision = request.history?.findLast((event) => event.action === "accepted");
  if (
    !Number.isSafeInteger(record.requestVersion) ||
    record.requestVersion < 1 ||
    record.requestVersion !== request.version ||
    record.requestVersion !== decision?.version ||
    record.decisionId !== decision?.id
  )
    return false;
  const metric = binding.metricId;
  if (
    [
      "catalog_proposals",
      "pricebook_proposals",
      "compatibility_proposals",
      "evidence_manifests",
      "data_quality",
      "reproductions",
      "governance",
      "deployment_work",
      "incidents",
    ].includes(metric) &&
    sparseIdAuthority(domain.ownerIds)
  )
    return true;
  if (metric === "compatibility_proposals" && sparseIdAuthority(domain.contractReviewerIds)) return true;
  if (metric === "security" && sparseIdAuthority(domain.disclosureReviewerIds)) return true;
  const detail = record.details;
  if (
    [
      "catalog_proposals",
      "pricebook_proposals",
      "negative_findings",
      "assumptions_resolved",
      "market_research",
      "usability",
      "evidence_manifests",
    ].includes(metric) &&
    sparseIdAuthority(detail?.sourceIds)
  )
    return true;
  if (metric === "pricebook_proposals" && sparseIdAuthority(detail?.units)) return true;
  if (metric === "deployment_work" && sparseIdAuthority(detail?.deploymentIds)) return true;
  return metric === "accessibility" && sparseIdAuthority(detail?.criteria);
}

/**
 * Qualify one protected, independently reviewed record against current collected
 * evidence. This consumes attestations; it does not scrape or certify their facts.
 * No caller-supplied text, source manifest or private receipt enters public output.
 */
export function qualifyDomainRecognition({ input, request, decision, binding, candidate, acceptedAt, cutoff }) {
  if (binding.metricId === "issue_ordering") {
    const review = bindOrderingReview(decision.ordering, request, decision.sourceUseReview.references);
    const ordering = validateOrderingSource(input, candidate.id, acceptedAt, review, binding.orderingAuthority);
    return {
      changesetId: ordering.unit,
      dateBasis: "acceptedAt",
      occurredAt: acceptedAt,
      publicReasonCodes: ["independent_recognition_receipt"],
      ordering: ordering.review,
      orderingAuthority: ordering.authority,
    };
  }
  const metric = binding.metricId;
  if (metric === "project_configuration")
    return qualifyProjectConfiguration({ input, request, decision, binding, candidate, acceptedAt, cutoff });
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

  if (
    [
      "catalog_proposals",
      "pricebook_proposals",
      "compatibility_proposals",
      "evidence_manifests",
      "data_quality",
      "reproductions",
      "governance",
      "deployment_work",
      "incidents",
    ].includes(metric)
  )
    approvedOwner(domain.ownerIds, decision.actor);
  if (metric === "compatibility_proposals") approvedOwner(domain.contractReviewerIds, decision.actor);
  if (metric === "security") approvedOwner(domain.disclosureReviewerIds, decision.actor);

  if (operationsMetrics.has(metric)) requireOperationSource(input, binding, candidate, target, acceptedAt);

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
      choice(detail.outcome, ["available", "changed", "unavailable", "unknown", "contradicted"]);
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
    case "data_quality": {
      object(detail, [
        "canonicalKind",
        "canonicalId",
        "correctionId",
        "correctionVersion",
        "correctionType",
        "factualReview",
        "sourceIds",
        "before",
        "after",
        "origin",
      ]);
      // A correction's canonical identity does not change when its proof or
      // private review version changes. No receipt or source line is a unit.
      const exactId = (value) => {
        id(value);
        require(value.trim() === value);
        return value;
      };
      const exactIds = (value) => ids(value).map(exactId);
      unit = [exactId(detail.canonicalKind), exactId(detail.canonicalId), exactId(detail.correctionId)];
      exactId(detail.correctionVersion);
      exactIds(detail.sourceIds);
      choice(detail.correctionType, ["incorrect", "stale"]);
      require(detail.factualReview === true);
      const pins = [detail.before, detail.after].map((pin) => {
        object(pin, ["revision", "sourceRevisionUrl", "contentHash"]);
        require(typeof pin.revision === "string" && [40, 64].includes(pin.revision.length));
        pinnedGithubUrl(pin.sourceRevisionUrl, pin.revision);
        require(digest(pin.contentHash).length === 64);
        const locator = new URL(pin.sourceRevisionUrl).pathname.split("/");
        require(locator.slice(1).every((part) => part.length > 0));
        locator[4] = "";
        return JSON.stringify(locator);
      });
      // Both versions describe the same repository and artifact locator. The
      // reviewed after version must be the exact currently collected evidence.
      require(
        pins[0] === pins[1] &&
          detail.before.revision !== detail.after.revision &&
          detail.before.contentHash !== detail.after.contentHash &&
          detail.after.revision === record.sourceRevision &&
          detail.after.sourceRevisionUrl === record.sourceRevisionUrl,
      );
      const origin = object(detail.origin, ["kind", "complete", "contributorIds"]);
      require(origin.complete === true);
      choice(origin.kind, ["prior_contributors", "external_source_change"]);
      if (origin.kind === "prior_contributors") {
        const contributors = exactIds(origin.contributorIds);
        require(
          contributors.every(
            (contributor) => contributor !== request.owner && !Object.hasOwn(request.collaborators ?? {}, contributor),
          ),
        );
      } else {
        // External staleness needs a reviewed cause, not an inference that an
        // absent or incomplete contributor history proves independence.
        require(
          detail.correctionType === "stale" && Array.isArray(origin.contributorIds) && !origin.contributorIds.length,
        );
      }
      break;
    }
    case "reproductions": {
      object(detail, [
        "targetKind",
        "targetId",
        "scenarioId",
        "scenarioVersion",
        "runId",
        "completedAt",
        "executionComplete",
        "scenarioAccepted",
        "outcome",
        "scenario",
        "environment",
        "result",
      ]);
      require(
        binding.sourceMetricId === "pr_merged" &&
          candidate.metricId === "pr_merged" &&
          target.artifact.kind === "pull_request" &&
          candidate.rawState?.startsWith("target:"),
      );
      const exactId = (value) => {
        id(value);
        require(value.trim() === value);
        return value;
      };
      // A new result, environment, run or review version does not create a new
      // accepted scenario. Its source author and canonical target stay bound.
      unit = [exactId(detail.targetKind), exactId(detail.targetId), exactId(detail.scenarioId)];
      exactId(detail.scenarioVersion);
      exactId(detail.runId);
      require(detail.executionComplete === true && detail.scenarioAccepted === true);
      choice(detail.outcome, ["reproduced", "not_reproduced", "inconclusive"]);
      require(
        instant(detail.completedAt) <= instant(candidate.occurredAt) &&
          instant(candidate.occurredAt) <= instant(acceptedAt),
      );
      const sourcePath = new URL(record.sourceRevisionUrl).pathname.split("/");
      const hashesByUrl = new Map();
      for (const pin of [detail.scenario, detail.environment, detail.result]) {
        object(pin, ["revision", "sourceRevisionUrl", "contentHash"]);
        require(typeof pin.revision === "string" && [40, 64].includes(pin.revision.length));
        pinnedGithubUrl(pin.sourceRevisionUrl, pin.revision);
        require(digest(pin.contentHash).length === 64);
        const path = new URL(pin.sourceRevisionUrl).pathname.split("/");
        require(
          pin.revision === record.sourceRevision &&
            path[1] === sourcePath[1] &&
            path[2] === sourcePath[2] &&
            path[3] === "blob" &&
            path.slice(1).every((part) => part.length > 0),
        );
        // A combined proof artifact may serve several roles, but one exact
        // immutable URL cannot assert contradictory content hashes.
        const previous = hashesByUrl.get(pin.sourceRevisionUrl);
        require(previous === undefined || previous === pin.contentHash);
        hashesByUrl.set(pin.sourceRevisionUrl, pin.contentHash);
      }
      break;
    }
    case "governance":
      object(detail, ["decisionId", "decisionVersion", "kind", "disposition", "publicRecord"]);
      choice(detail.kind, [
        "governance_decision",
        "repository_rules",
        "public_repository_settings",
        "repository_process",
      ]);
      require(detail.disposition === "accepted");
      unit = [operationId(detail.decisionId), operationId(detail.decisionVersion)];
      break;
    case "deployment_work":
      object(detail, ["workArtifactId", "workVersion", "workKind", "deploymentIds", "sourceUse", "publicRecord"]);
      require(detail.workKind === "deployment_improvement" && detail.sourceUse === "approved_public");
      ids(detail.deploymentIds).forEach(operationId);
      operationId(detail.workVersion);
      unit = [operationId(detail.workArtifactId)];
      break;
    case "incidents":
      object(detail, ["contributionId", "contributionVersion", "workKind", "narrativeApproved", "publicRecord"]);
      choice(detail.workKind, ["postmortem", "remediation"]);
      require(detail.narrativeApproved === true);
      operationId(detail.contributionVersion);
      unit = [operationId(detail.contributionId)];
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
        detail.failsBefore === true &&
          detail.passesAfter === true &&
          gitRevision(detail.beforeRevision) !== gitRevision(detail.afterRevision) &&
          detail.beforeRevision.length === detail.afterRevision.length,
      );
      unit = [id(detail.scenarioId)];
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
      require(
        gitRevision(before.revision) !== gitRevision(after.revision) &&
          before.revision.length === after.revision.length &&
          after.revision === record.sourceRevision,
      );
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
  if (operationsMetrics.has(metric)) requireOperationRecord(detail.publicRecord, record);
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
  if (metric === "reproductions") publicReasonCodes.push("accepted_reproduction_scenario_not_bug_confirmation");
  for (const key of ["evidenceClass", "method", "outcome", "phase", "reviewMethod", "authorship", "disposition"])
    if (Object.hasOwn(detail, key)) publicReasonCodes.push(`domain_${key}:${detail[key]}`);
  return {
    changesetId,
    occurredAt,
    dateBasis: domainDateBasis(metric),
    publicReasonCodes,
    ...(operationsMetrics.has(metric)
      ? { reviewedArtifact: { url: detail.publicRecord.sourceRevisionUrl, hash: detail.publicRecord.contentHash } }
      : {}),
  };
}
