import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import {
  compareSourceInstants,
  sourceEventSchema,
  reviewedWorkstreamHelpBindingSchema,
  publicWorkstreamHelpSchema,
  publicEvidenceMetadataSchema,
  parseWorkstreamHelpStatement,
  workstreamHelpEvidenceKey,
  workstreamHelpUnit,
  workstreamHelpLimits,
  workstreamHelpMetricIds,
} from "@pick-your-ai/contracts";
import { hasConsentedEvidenceIntake, hasReviewedEvidenceIntake } from "../../controls/src/evidence-intake.mjs";
import { hasReviewedParticipantConsent } from "../../controls/src/evidence-consent.mjs";

const fail = () => {
  throw new Error("workstream_help_evidence_unverified");
};
const require = (condition) => {
  if (!condition) fail();
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const instant = (value) => {
  require(typeof value === "string" && sourceEventSchema.shape.occurredAt.safeParse(value).success);
  return value;
};
const notAfter = (left, right) => require(compareSourceInstants(instant(left), instant(right)) <= 0);

/** Bound the protected extension before a schema, hash, clone or callback touches it. */
function boundedJSON(value, budget) {
  const ancestors = new Set();
  const take = (count) => {
    require(count <= 8_000_000 - budget.bytes);
    budget.bytes += count;
  };
  // Count the well-formed JSON representation without allocating an escaped string.
  const addString = (text) => {
    take(2);
    require(text.length <= 8_000_000 - budget.bytes);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 0x22 || code === 0x5c) take(2);
      else if (code <= 0x1f) take(code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6);
      else if (code < 0x80) take(1);
      else if (code < 0x800) take(2);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          take(4);
          index++;
        } else take(6);
      } else if (code >= 0xdc00 && code <= 0xdfff) take(6);
      else take(3);
    }
  };
  const visit = (item, depth) => {
    require(++budget.nodes <= 250_000 && depth <= 24);
    if (typeof item === "string") addString(item);
    else if (item === null || typeof item === "boolean") take(5);
    else if (typeof item === "number" && Number.isFinite(item)) take(32);
    else if (item && typeof item === "object") {
      require(!isProxy(item) && !ancestors.has(item));
      const array = Array.isArray(item);
      require(
        array
          ? Object.getPrototypeOf(item) === Array.prototype
          : [Object.prototype, null].includes(Object.getPrototypeOf(item)),
      );
      if (array) require(item.length <= workstreamHelpLimits.records && item.length <= 250_000 - budget.nodes);
      // Inventory keys once, then bound their count before obtaining any descriptors.
      const keys = Reflect.ownKeys(item);
      require(array ? keys.length === item.length + 1 : keys.length <= 250_000 - budget.nodes);
      require(keys.every((key) => typeof key === "string"));
      ancestors.add(item);
      take(2);
      if (array) {
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          require(descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable);
          take(1);
          visit(descriptor.value, depth + 1);
        }
      } else {
        for (const key of keys) {
          addString(key);
          take(2);
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          require(descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable);
          visit(descriptor.value, depth + 1);
        }
      }
      ancestors.delete(item);
    } else fail();
  };
  visit(value, 0);
}

/** Current host configuration supplies the workstream identities and factual admission.
 * An immutable URL, a digest or a submitted statement alone cannot grant authority.
 */
export function validateWorkstreamHelpBindings(bindings) {
  const configured = new Map();
  const catalogs = new Map();
  const statementHashes = new Map();
  const budget = { bytes: 0, nodes: 0 };
  let recordCount = 0;
  for (const binding of bindings) {
    require(binding && typeof binding === "object" && !isProxy(binding));
    const descriptor = Object.getOwnPropertyDescriptor(binding, "workstreamHelp");
    if (!descriptor) continue;
    require(Object.hasOwn(descriptor, "value") && descriptor.enumerable);
    boundedJSON(descriptor.value, budget);
    const parsed = reviewedWorkstreamHelpBindingSchema.safeParse(descriptor.value);
    require(parsed.success);
    const config = parsed.data;
    require(binding.sourceMetricId === "pr_merged" && workstreamHelpMetricIds.includes(binding.metricId));
    recordCount += config.records.length;
    require(recordCount <= workstreamHelpLimits.records);
    const catalog = [...config.workstreams].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const catalogKey = JSON.stringify([config.organization, config.definitionVersion]);
    require(!catalogs.has(catalogKey) || catalogs.get(catalogKey) === JSON.stringify(catalog));
    catalogs.set(catalogKey, JSON.stringify(catalog));
    const records = new Map();
    for (const record of config.records) {
      let statement;
      try {
        statement = parseWorkstreamHelpStatement(record.statement.content);
      } catch {
        fail();
      }
      require(createHash("sha256").update(record.statement.content, "utf8").digest("hex") === record.statement.sha256);
      require(
        !statementHashes.has(record.statement.url) ||
          statementHashes.get(record.statement.url) === record.statement.sha256,
      );
      statementHashes.set(record.statement.url, record.statement.sha256);
      require(
        statement.organization === config.organization &&
          statement.definitionVersion === config.definitionVersion &&
          config.workstreams.some((entry) => same(entry, statement.from)) &&
          config.workstreams.some((entry) => same(entry, statement.to)),
      );
      // This exercises the same exact repository/blob-revision binding as the public contract.
      const publicShape = publicWorkstreamHelpSchema.safeParse({
        ruleVersion: config.ruleVersion,
        contributionId: record.factId,
        acceptedAt: statement.occurredAt,
        reviewedAt: statement.occurredAt,
        statement,
        statementRevision: record.statement.revision,
        statementUrl: record.statement.url,
        statementHash: record.statement.sha256,
      });
      require(publicShape.success);
      records.set(record.requestId, { record, statement });
    }
    configured.set(binding, { config, records });
  }
  return configured;
}

/** Called only after the existing exact policy, private audit and reviewer checks. */
export function qualifyWorkstreamHelp({
  input,
  state,
  request,
  decision,
  binding,
  candidate,
  acceptedAt,
  cutoff,
  configured,
}) {
  if (!configured) return null;
  const selected = configured.records.get(request.id);
  if (!selected) return null; // Other accepted source work does not acquire inferred help.
  const { record, statement } = selected;
  require(
    request.status === "accepted" &&
      hasReviewedEvidenceIntake(request) &&
      request.version === record.requestVersion &&
      decision.version === request.version &&
      record.decisionId === decision.id &&
      record.factId === candidate.id &&
      request.intake.roles.submitter === "author",
  );
  const sourceRequest = state.requests?.[record.sourceAcceptance.requestId];
  if (
    !sourceRequest ||
    sourceRequest.status !== "accepted" ||
    state.profiles?.[sourceRequest.owner]?.suppressed ||
    !hasReviewedParticipantConsent(sourceRequest) ||
    !hasConsentedEvidenceIntake(sourceRequest) ||
    !hasReviewedEvidenceIntake(sourceRequest)
  )
    return null;
  const sourceDecision = sourceRequest.history?.findLast((entry) => entry.action === "accepted");
  const sourceAudit = (state.audit ?? []).filter((entry) => entry.id === sourceDecision?.id);
  require(
    sourceRequest.kind === "evidence" &&
      sourceRequest.owner === request.owner &&
      sourceRequest.locator === request.locator &&
      sourceRequest.category === binding.category &&
      sourceRequest.scope === binding.scope &&
      sourceRequest.policyVersion === binding.policyVersion &&
      sourceRequest.version === record.sourceAcceptance.requestVersion &&
      sourceDecision?.id === record.sourceAcceptance.decisionId &&
      sourceDecision.version === sourceRequest.version &&
      sourceDecision.policyVersion === binding.policyVersion &&
      sourceDecision.actor !== sourceRequest.owner &&
      !Object.hasOwn(sourceRequest.collaborators ?? {}, sourceDecision.actor) &&
      binding.reviewerIds.includes(sourceDecision.actor) &&
      sourceAudit.length === 1 &&
      same(sourceAudit[0], sourceDecision),
  );
  const sourceAcceptedAt =
    typeof sourceDecision.at === "number"
      ? Number.isSafeInteger(sourceDecision.at) &&
        sourceDecision.at >= 0 &&
        Number.isFinite(new Date(sourceDecision.at).getTime())
        ? new Date(sourceDecision.at).toISOString()
        : null
      : sourceDecision.at;
  require(typeof sourceAcceptedAt === "string");
  notAfter(candidate.occurredAt, sourceAcceptedAt);
  notAfter(sourceAcceptedAt, acceptedAt);
  require(input.isSynthetic !== true && !(input.syntheticFactIds ?? []).includes(candidate.id));
  require(
    candidate.metricId === "pr_merged" &&
      binding.sourceMetricId === "pr_merged" &&
      candidate.state === "observed" &&
      candidate.role === "author" &&
      candidate.actorId === request.owner &&
      candidate.repoId === binding.repositoryId &&
      typeof candidate.rawState === "string" &&
      candidate.rawState.startsWith("target:") &&
      candidate.acceptedAt === null &&
      candidate.acceptedBy === null &&
      candidate.acceptanceReceipt === null,
  );
  const actors = input.actors.filter((entry) => entry.id === request.owner);
  require(
    actors.length === 1 &&
      actors[0].kind === "user" &&
      actors[0].publicState === "visible" &&
      actors[0].executionMode !== "automated",
  );
  const sources = input.evidence.filter((entry) => entry.contribution.contributionId === candidate.id);
  require(sources.length === 1);
  const source = sources[0];
  const metadata = publicEvidenceMetadataSchema.safeParse(source.evidenceMetadata);
  require(
    metadata.success &&
      metadata.data.sourceAction === "pull_request_merged" &&
      metadata.data.activityState === "observed" &&
      metadata.data.acceptedAt === null &&
      metadata.data.sourceOccurredAt === candidate.occurredAt &&
      metadata.data.observedAt === candidate.observedAt,
  );
  require(
    source.artifact.source === "github" &&
      source.artifact.kind === "pull_request" &&
      source.artifact.visibility === "public" &&
      source.artifact.stableId === candidate.artifactId &&
      source.artifact.repositoryId === candidate.repoId &&
      source.artifact.publicUrl === request.locator &&
      source.contribution.actorId === candidate.actorId &&
      source.contribution.artifactId === candidate.artifactId &&
      source.contribution.canonicalEventId === candidate.canonicalKey &&
      same(source.contribution.roles, ["author"]) &&
      same(source.contribution.metricIds, ["pr_merged"]) &&
      source.contribution.qualification === "eligible" &&
      source.occurredAt === candidate.occurredAt,
  );
  require(
    statement.actorId === candidate.actorId &&
      statement.repositoryId === candidate.repoId &&
      statement.artifactId === candidate.artifactId &&
      statement.sourceUrl === source.artifact.publicUrl &&
      statement.sourceRevision === source.sourceRevision &&
      statement.occurredAt === candidate.occurredAt,
  );
  require(
    decision.sourceUseReview.references.some(
      (reference) => reference.locator === record.statement.url && reference.revision === record.statement.revision,
    ),
  );
  notAfter(candidate.occurredAt, acceptedAt);
  notAfter(candidate.observedAt, cutoff);
  notAfter(acceptedAt, cutoff);
  notAfter(cutoff, record.validUntil);
  return {
    ruleVersion: configured.config.ruleVersion,
    reviewedAt: acceptedAt,
    sourceAcceptance: { ...record.sourceAcceptance, acceptedAt: sourceAcceptedAt },
    statement,
    statementRevision: record.statement.revision,
    statementUrl: record.statement.url,
    statementHash: record.statement.sha256,
  };
}

/** Validate every qualifying alias before the existing metric-unit deduplication. */
export function verifyWorkstreamHelpConsistency(help, seen) {
  if (!help) return;
  const temporary = { ...help, contributionId: "qualified-source" };
  const key = workstreamHelpUnit(temporary);
  const signature = JSON.stringify([workstreamHelpEvidenceKey(temporary), help.sourceAcceptance]);
  require(!seen.has(key) || seen.get(key) === signature);
  seen.set(key, signature);
}

/** Do not let even a custom receipt callback relabel the source being recognized. */
export function bindWorkstreamHelp(help, facts, evidence) {
  require(facts.length === 1 && evidence.length === 1);
  const fact = facts[0],
    proof = evidence[0],
    source = help.statement;
  require(
    fact.state === "qualified" &&
      fact.actorId === source.actorId &&
      fact.repoId === source.repositoryId &&
      fact.artifactId === source.artifactId &&
      fact.role === "author" &&
      fact.occurredAt === source.occurredAt &&
      fact.acceptanceReceipt === help.sourceAcceptance.decisionId &&
      fact.acceptedAt === help.sourceAcceptance.acceptedAt &&
      typeof fact.acceptedAt === "string" &&
      compareSourceInstants(source.occurredAt, fact.acceptedAt) <= 0 &&
      compareSourceInstants(fact.acceptedAt, help.reviewedAt) <= 0 &&
      workstreamHelpMetricIds.includes(fact.metricId) &&
      proof.contribution.contributionId === fact.id &&
      proof.contribution.actorId === fact.actorId &&
      proof.contribution.artifactId === fact.artifactId &&
      proof.contribution.canonicalEventId === fact.canonicalKey &&
      same(proof.contribution.roles, ["author"]) &&
      same(proof.contribution.metricIds, [fact.metricId]) &&
      proof.contribution.qualification === "eligible" &&
      proof.artifact.stableId === source.artifactId &&
      proof.artifact.repositoryId === source.repositoryId &&
      proof.artifact.publicUrl === source.sourceUrl &&
      proof.artifact.visibility === "public" &&
      proof.artifact.kind === "pull_request" &&
      proof.artifact.source === "github" &&
      proof.occurredAt === source.occurredAt &&
      proof.sourceRevision === source.sourceRevision,
  );
  const { sourceAcceptance: _privateAcceptance, ...publicHelp } = help;
  return publicWorkstreamHelpSchema.parse({ ...publicHelp, contributionId: fact.id, acceptedAt: fact.acceptedAt });
}

/** A later help review may recognize an already retained accepted source unit.
 * It never replaces the metric's original canonical receipt or acceptance time.
 */
export function materializedWorkstreamHelp(jobs, facts, evidence) {
  const byUnit = new Map(),
    byId = new Map();
  const key = (actor, repository, artifact, metric) => JSON.stringify([actor, repository, artifact, metric]);
  for (const fact of facts) {
    const identity = key(fact.actorId, fact.repoId, fact.artifactId, fact.metricId);
    const entries = byUnit.get(identity) ?? [];
    entries.push(fact);
    byUnit.set(identity, entries);
  }
  for (const proof of evidence) {
    const id = proof.contribution.contributionId;
    const entries = byId.get(id) ?? [];
    entries.push(proof);
    byId.set(id, entries);
  }
  const units = new Set(),
    result = [],
    sourceDecisions = [];
  for (const { help, metricId } of jobs) {
    const source = help.statement;
    const matches = (byUnit.get(key(source.actorId, source.repositoryId, source.artifactId, metricId)) ?? []).filter(
      (fact) =>
        fact.role === "author" &&
        fact.occurredAt === source.occurredAt &&
        fact.acceptanceReceipt === help.sourceAcceptance.decisionId &&
        fact.acceptedAt === help.sourceAcceptance.acceptedAt &&
        (byId.get(fact.id) ?? []).some((proof) => proof.sourceRevision === source.sourceRevision),
    );
    if (matches.length === 0) continue; // No exact retained accepted public source proof.
    require(matches.length === 1);
    const value = bindWorkstreamHelp(help, matches, byId.get(matches[0].id) ?? []);
    const unit = workstreamHelpUnit(value);
    if (!units.has(unit)) {
      units.add(unit);
      result.push(value);
      sourceDecisions.push({ contributionId: value.contributionId, decisionId: help.sourceAcceptance.decisionId });
    }
  }
  return { records: result, sourceDecisions };
}

/** Reuse the actual corrected, scoped portfolio selection. No Project or category inference. */
export function selectWorkstreamHelp(records, portfolioFacts, evidence, sourceDecisions) {
  require(
    Array.isArray(records) &&
      records.length <= workstreamHelpLimits.records &&
      Array.isArray(sourceDecisions) &&
      sourceDecisions.length === records.length,
  );
  const dependencies = new Map(sourceDecisions.map((entry) => [entry.contributionId, entry.decisionId]));
  require(
    dependencies.size === sourceDecisions.length && records.every((entry) => dependencies.has(entry.contributionId)),
  );
  const selected = new Map(portfolioFacts.map((fact) => [fact.id, fact]));
  const result = [];
  for (const input of records) {
    const help = publicWorkstreamHelpSchema.parse(input);
    const fact = selected.get(help.contributionId);
    const proof = evidence.get(help.contributionId);
    const source = help.statement;
    // A corrected attribution, clock, eligibility or source needs a fresh help review.
    if (
      !fact ||
      !proof ||
      !["qualified", "reviewed"].includes(fact.state) ||
      fact.actorId !== source.actorId ||
      fact.repoId !== source.repositoryId ||
      fact.artifactId !== source.artifactId ||
      fact.role !== "author" ||
      fact.occurredAt !== source.occurredAt ||
      fact.acceptedAt !== help.acceptedAt ||
      fact.acceptanceReceipt !== dependencies.get(help.contributionId) ||
      !workstreamHelpMetricIds.includes(fact.metricId) ||
      proof.sourceRevision !== source.sourceRevision ||
      proof.artifact.publicUrl !== source.sourceUrl ||
      proof.artifact.visibility !== "public"
    )
      continue;
    result.push(help);
  }
  return result;
}
