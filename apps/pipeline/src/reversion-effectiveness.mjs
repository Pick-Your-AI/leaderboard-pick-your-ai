import { createHash } from "node:crypto";

export const reversionAuthorityVersion = "pipeline-reversion-effectiveness/v1";
const fail = (reason) => {
  throw new Error("reversion_" + reason);
};
const object = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const full = (pattern, value) => typeof value === "string" && pattern.exec(value)?.[0] === value;
const token = (value) => (full(/[A-Za-z0-9_.:-]{1,200}/, value) ? value : fail("invalid_identity"));
const sha = (value) => (full(/[a-f0-9]{64}/, value) ? value : fail("invalid_hash"));
const keys = (value, expected) => {
  if (!object(value) || Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) fail("invalid_shape");
};
const instant = (value) => {
  if (
    !full(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/, value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail("invalid_clock");
  return value;
};
const positive = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) fail("invalid_version");
  return value;
};
const unique = (values, maximum = 128) => {
  if (!Array.isArray(values) || values.length < 1 || values.length > maximum) fail("invalid_identity_set");
  values.forEach(token);
  if (new Set(values).size !== values.length) fail("duplicate_identity");
  return [...values].sort();
};
const stable = (value) => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (object(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + stable(value[key]))
        .join(",") +
      "}"
    );
  return fail("invalid_json");
};
export const reversionHash = (value) => createHash("sha256").update(stable(value)).digest("hex");
const clone = (value) => structuredClone(value);
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const equal = (left, right) => stable(left) === stable(right);
const publicReceipt = (value) => {
  try {
    const url = new URL(value);
    if (
      url.href !== value ||
      url.origin !== "https://github.com" ||
      url.username ||
      url.password ||
      url.search ||
      !full(/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[1-9]\d*/, url.pathname) ||
      (url.hash && !full(/#(?:issuecomment|pullrequestreview)-[1-9]\d*/, url.hash))
    )
      fail("invalid_public_receipt");
    return value;
  } catch {
    return fail("invalid_public_receipt");
  }
};

// Membership projection and collection time do not change which reviewed unit
// the decision concerns. All other qualification/source-fact fields stay bound.
export function reversionFactHash(fact) {
  if (!object(fact)) fail("invalid_fact");
  const { observedAt, currentContext, eventContext, ...identity } = fact;
  return reversionHash(identity);
}
const sourceFields = [
  "factId",
  "artifactId",
  "actorId",
  "occurredAt",
  "sourceRevision",
  "sourceRevisionUrl",
  "factHash",
];
const targetFields = [
  "factId",
  "canonicalKey",
  "metricId",
  "actorId",
  "artifactId",
  "baseRevision",
  "baseState",
  "semanticHash",
  "policyHash",
];
const operationFields = [
  "requestId",
  "expectedVersion",
  "snapshotId",
  "originalFactId",
  "revertingFactId",
  "targetFactIds",
  "effect",
  "supersedes",
  "effectiveAt",
  "reviewedAt",
  "operatorId",
  "approvalReceipt",
  "publicReceiptUrl",
];
const candidateFields = ["kind", "operation", "source", "targets", "binding"];

function sourceIdentity(value) {
  keys(value, sourceFields);
  for (const field of ["factId", "artifactId", "actorId"]) token(value[field]);
  instant(value.occurredAt);
  sha(value.factHash);
  if (!full(/(?:[a-f0-9]{40}|[a-f0-9]{64})/, value.sourceRevision)) fail("immutable_merge_pin_required");
  try {
    const url = new URL(value.sourceRevisionUrl);
    if (
      url.href !== value.sourceRevisionUrl ||
      url.origin !== "https://github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !full(/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/commit\/[a-f0-9]+/, url.pathname) ||
      !url.pathname.endsWith("/commit/" + value.sourceRevision)
    )
      fail("immutable_merge_pin_required");
    return url.pathname.split("/").slice(1, 3).join("/");
  } catch {
    return fail("immutable_merge_pin_required");
  }
}

function validateCandidate(candidate) {
  keys(candidate, candidateFields);
  if (candidate.kind !== reversionAuthorityVersion) fail("unknown_authority_version");
  const { operation, source, targets, binding } = candidate;
  keys(operation, operationFields);
  for (const field of ["requestId", "snapshotId", "originalFactId", "revertingFactId", "operatorId", "approvalReceipt"])
    token(operation[field]);
  positive(operation.expectedVersion);
  if (!equal(operation.targetFactIds, unique(operation.targetFactIds))) fail("noncanonical_targets");
  if (!["inactive", "active"].includes(operation.effect)) fail("invalid_effect");
  if (operation.supersedes !== null) token(operation.supersedes);
  if (operation.supersedes === operation.requestId || (operation.effect === "active" && operation.supersedes === null))
    fail("invalid_supersession");
  instant(operation.effectiveAt);
  instant(operation.reviewedAt);
  if (operation.effectiveAt > operation.reviewedAt) fail("review_precedes_effect");
  publicReceipt(operation.publicReceiptUrl);
  keys(source, ["repositoryId", "original", "reverting"]);
  if (!full(/[1-9]\d{0,18}/, source.repositoryId)) fail("invalid_repository");
  const originalRepo = sourceIdentity(source.original);
  if (
    sourceIdentity(source.reverting) !== originalRepo ||
    source.original.factId !== operation.originalFactId ||
    source.reverting.factId !== operation.revertingFactId ||
    source.original.artifactId === source.reverting.artifactId ||
    source.original.factId === source.reverting.factId
  )
    fail("source_identity_mismatch");
  if (source.original.occurredAt > source.reverting.occurredAt || source.reverting.occurredAt > operation.effectiveAt)
    fail("effect_precedes_source");
  if ([source.original.actorId, source.reverting.actorId].includes(operation.operatorId))
    fail("independent_reviewer_required");
  if (!Array.isArray(targets) || targets.length !== operation.targetFactIds.length) fail("target_set_mismatch");
  for (const target of targets) {
    keys(target, targetFields);
    for (const field of ["factId", "canonicalKey", "metricId", "actorId", "artifactId"]) token(target[field]);
    if (
      target.artifactId !== source.original.artifactId ||
      target.metricId === "pr_merged" ||
      !["qualified", "reviewed"].includes(target.baseState) ||
      !Number.isSafeInteger(target.baseRevision) ||
      target.baseRevision < 0 ||
      target.actorId === operation.operatorId
    )
      fail("qualified_unit_required");
    sha(target.semanticHash);
    sha(target.policyHash);
  }
  if (
    !equal(
      targets.map((target) => target.factId),
      operation.targetFactIds,
    )
  )
    fail("target_set_mismatch");
  keys(binding, ["configurationHash", "sourceGeneration", "dataMode", "lineageEvidenceIds"]);
  sha(binding.configurationHash);
  if (!full(/[1-9]\d{0,18}/, binding.sourceGeneration) || !["public", "synthetic"].includes(binding.dataMode))
    fail("invalid_source_binding");
  if (
    !equal(binding.lineageEvidenceIds, unique(binding.lineageEvidenceIds)) ||
    ![source.original.factId, source.reverting.factId].every((id) => binding.lineageEvidenceIds.includes(id))
  )
    fail("explicit_lineage_required");
  return candidate;
}

/** Prepare a review candidate from an authorized frozen input. This grants no
 * authority: the host must independently approve the exact candidate hash and
 * explicit original-to-revert relationship before recording it. */
export function prepareReversionDecision({ operation, input, binding }) {
  if (
    !object(input) ||
    input.snapshotId !== operation?.snapshotId ||
    !Array.isArray(input.facts) ||
    !Array.isArray(input.evidence) ||
    !Array.isArray(input.policies)
  )
    fail("frozen_input_required");
  instant(input.cutoff);
  const fact = (id) => {
    const values = input.facts.filter((entry) => entry?.id === id);
    if (values.length !== 1) fail("ambiguous_frozen_fact");
    return values[0];
  };
  const evidence = (id) => {
    const values = input.evidence.filter((entry) => entry?.contribution?.contributionId === id);
    if (values.length !== 1) fail("ambiguous_frozen_evidence");
    return values[0];
  };
  const merge = (id) => {
    const selected = fact(id),
      proof = evidence(id);
    if (
      selected.metricId !== "pr_merged" ||
      selected.state !== "observed" ||
      selected.role !== "author" ||
      proof.artifact?.kind !== "pull_request" ||
      proof.artifact.visibility !== "public" ||
      proof.artifact.stableId !== selected.artifactId ||
      proof.artifact.repositoryId !== selected.repoId ||
      proof.contribution.actorId !== selected.actorId ||
      proof.contribution.artifactId !== selected.artifactId
    )
      fail("observed_merge_required");
    instant(selected.occurredAt);
    instant(selected.observedAt);
    if (
      selected.occurredAt > selected.observedAt ||
      selected.occurredAt > input.cutoff ||
      selected.observedAt > input.cutoff
    )
      fail("source_after_capture");
    return {
      factId: selected.id,
      artifactId: selected.artifactId,
      actorId: selected.actorId,
      occurredAt: selected.occurredAt,
      sourceRevision: proof.sourceRevision,
      sourceRevisionUrl: proof.sourceRevisionUrl,
      factHash: reversionFactHash(selected),
    };
  };
  const original = merge(operation.originalFactId),
    reverting = merge(operation.revertingFactId);
  const originalFact = fact(operation.originalFactId);
  if (fact(operation.revertingFactId).repoId !== originalFact.repoId) fail("source_identity_mismatch");
  const selectedIds = unique(operation.targetFactIds);
  const targets = selectedIds.map((id) => {
    const selected = fact(id),
      proof = evidence(id);
    const policies = input.policies.filter((entry) => entry?.policy?.metricId === selected.metricId);
    if (policies.length !== 1) fail("qualified_policy_required");
    const policy = policies[0];
    if (
      typeof policy.signature !== "string" ||
      !policy.signature ||
      !Array.isArray(policy.policy.rankedStates) ||
      policy.policy.rankedStates.length !== 1 ||
      !["qualified", "reviewed"].includes(policy.policy.rankedStates[0]) ||
      !policy.policy.rankedStates.includes(selected.state) ||
      selected.repoId !== originalFact.repoId ||
      selected.acceptedBy === selected.actorId ||
      !selected.acceptedBy ||
      !selected.acceptanceReceipt ||
      proof.contribution?.qualification !== "eligible" ||
      proof.contribution.artifactId !== original.artifactId ||
      proof.contribution.actorId !== selected.actorId ||
      proof.sourceRevision !== original.sourceRevision ||
      proof.sourceRevisionUrl !== original.sourceRevisionUrl
    )
      fail("qualified_policy_required");
    instant(selected.acceptedAt);
    instant(selected.occurredAt);
    instant(selected.observedAt);
    if (
      selected.quantity !== undefined &&
      (typeof selected.quantity !== "number" || !Number.isFinite(selected.quantity) || selected.quantity < 0)
    )
      fail("nonnegative_quantity_required");
    if (
      selected.acceptedAt < selected.occurredAt ||
      selected.acceptedAt > input.cutoff ||
      selected.observedAt > input.cutoff
    )
      fail("qualification_after_capture");
    return {
      factId: id,
      canonicalKey: selected.canonicalKey,
      metricId: selected.metricId,
      actorId: selected.actorId,
      artifactId: selected.artifactId,
      baseRevision: selected.revision,
      baseState: selected.state,
      semanticHash: reversionFactHash(selected),
      policyHash: reversionHash(policy),
    };
  });
  const candidate = {
    kind: reversionAuthorityVersion,
    operation: { ...clone(operation), targetFactIds: selectedIds },
    source: { repositoryId: originalFact.repoId, original, reverting },
    targets,
    binding: { ...clone(binding), lineageEvidenceIds: unique(binding.lineageEvidenceIds) },
  };
  validateCandidate(candidate);
  if (
    candidate.binding.lineageEvidenceIds.some(
      (id) => !input.evidence.some((entry) => entry?.contribution?.contributionId === id),
    )
  )
    fail("lineage_evidence_unavailable");
  if (candidate.operation.reviewedAt < input.cutoff) fail("review_precedes_capture");
  return freeze(candidate);
}

/** Serialization after protected host approval; this function is not an
 * authorization API. Its digest and the existing receipt must be stored atomically. */
export function recordReversionDecision(candidate, recordedAt) {
  validateCandidate(candidate);
  instant(recordedAt);
  if (recordedAt < candidate.operation.reviewedAt) fail("recording_precedes_review");
  return freeze({ ...clone(candidate), recordedAt, decisionHash: reversionHash(candidate) });
}
function validateRecord(document) {
  keys(document, [...candidateFields, "recordedAt", "decisionHash"]);
  const { recordedAt, decisionHash, ...candidate } = document;
  validateCandidate(candidate);
  instant(recordedAt);
  if (recordedAt < candidate.operation.reviewedAt || sha(decisionHash) !== reversionHash(candidate))
    fail("record_integrity");
  return document;
}
export function reversionOperationKey(document) {
  validateRecord(document);
  return "reversion:" + document.operation.requestId + ":" + document.operation.expectedVersion;
}
export function reversionReceiptDocument(document) {
  validateRecord(document);
  return {
    schemaVersion: reversionAuthorityVersion,
    requestId: document.operation.requestId,
    factId: document.operation.originalFactId,
    operatorId: document.operation.operatorId,
    approvalReceipt: document.operation.approvalReceipt,
    decisionHash: document.decisionHash,
    correctionDocumentHash: reversionHash(document),
  };
}

/** Unknown tags cannot opt out of legacy whole-artifact suppression. A valid
 * tagged row additionally needs the exact, hash-verified correction_applied receipt. */
export function classifyCorrectionRows(rows) {
  if (!Array.isArray(rows) || rows.length > 10000) fail("correction_budget");
  const legacy = [],
    decisions = [],
    ids = new Map();
  for (const row of rows) {
    if (!object(row) || !object(row.document)) fail("invalid_correction_row");
    const document = row.document;
    if (!Object.hasOwn(document, "kind")) {
      legacy.push(clone(row));
      continue;
    }
    validateRecord(document);
    if (
      row.request_id !== document.operation.requestId ||
      row.fact_id !== document.operation.originalFactId ||
      row.artifact_id !== document.source.original.artifactId ||
      String(row.repository_id) !== document.source.repositoryId
    )
      fail("correction_column_mismatch");
    const receipt = row.receipt;
    const expected = reversionReceiptDocument(document);
    if (
      !object(receipt) ||
      receipt.kind !== "correction_applied" ||
      receipt.operation_key !== reversionOperationKey(document) ||
      !equal(receipt.document, expected) ||
      receipt.document_hash !== reversionHash(expected)
    )
      fail("unsealed_correction");
    const previous = ids.get(row.request_id);
    if (previous && !equal(previous, document)) fail("retry_mismatch");
    if (!previous) decisions.push(clone(document));
    ids.set(row.request_id, document);
  }
  return freeze({
    legacy,
    decisions: decisions.sort((a, b) => a.operation.requestId.localeCompare(b.operation.requestId)),
  });
}

function decisionChains(decisions) {
  const byId = new Map(),
    children = new Map(),
    roots = [];
  for (const document of decisions) {
    validateRecord(document);
    const id = document.operation.requestId;
    if (byId.has(id)) fail("duplicate_decision");
    byId.set(id, document);
  }
  for (const document of decisions) {
    const parentId = document.operation.supersedes;
    if (parentId === null) {
      roots.push(document);
      continue;
    }
    const parent = byId.get(parentId);
    if (
      !parent ||
      children.has(parentId) ||
      document.source.original.factId !== parent.source.original.factId ||
      document.source.repositoryId !== parent.source.repositoryId ||
      !equal(document.targets, parent.targets) ||
      document.operation.effect === parent.operation.effect ||
      document.operation.effectiveAt < parent.operation.effectiveAt ||
      document.operation.reviewedAt < parent.operation.reviewedAt ||
      document.recordedAt < parent.recordedAt
    )
      fail("ambiguous_supersession");
    children.set(parentId, document);
  }
  const visited = new Set(),
    targetRoots = new Set();
  const chains = roots.map((root) => {
    for (const target of root.targets) {
      const key = root.source.repositoryId + ":" + target.factId;
      if (targetRoots.has(key)) fail("ambiguous_target_roots");
      targetRoots.add(key);
    }
    const chain = [];
    for (let next = root; next; next = children.get(next.operation.requestId)) {
      if (visited.has(next.operation.requestId)) fail("supersession_cycle");
      visited.add(next.operation.requestId);
      chain.push(next);
    }
    return chain;
  });
  if (visited.size !== decisions.length) fail("supersession_cycle");
  return chains;
}
const effective = (document, cutoff) =>
  document.operation.effectiveAt <= cutoff && document.operation.reviewedAt <= cutoff && document.recordedAt <= cutoff;
export function reversionAuthority(decisions, cutoff) {
  instant(cutoff);
  const prefixes = decisionChains(decisions).flatMap((chain) => {
    const selected = chain.filter((document) => effective(document, cutoff));
    return selected.length ? [selected] : [];
  });
  const hashes = prefixes.map(reversionHash).sort();
  return freeze({
    version: reversionAuthorityVersion,
    hashes,
    digest: reversionHash([reversionAuthorityVersion, hashes]),
  });
}

/** Preserve raw facts. Revisions only replace the explicitly reviewed qualified
 * units; restoration needs the next independently reviewed decision in that chain. */
export function materializeReversionEffectiveness(input, decisions, cutoff) {
  instant(cutoff);
  const { facts, policies, evidence } = input;
  if (!Array.isArray(facts) || !Array.isArray(policies)) fail("invalid_materialization_input");
  const overlays = [];
  for (const chain of decisionChains(decisions)) {
    for (const [index, document] of chain.entries()) {
      if (!effective(document, cutoff)) continue;
      for (const target of document.targets) {
        const selected = facts.filter((fact) => fact.id === target.factId);
        if (selected.length === 0) continue;
        if (selected.length !== 1 || reversionFactHash(selected[0]) !== target.semanticHash)
          fail("qualified_unit_changed");
        if (instant(selected[0].observedAt) > cutoff) fail("qualification_after_cutoff");
        for (const bound of [document.source.original, document.source.reverting]) {
          const sourceFacts = facts.filter((fact) => fact.id === bound.factId);
          const proofs = evidence?.filter((entry) => entry.contribution?.contributionId === bound.factId);
          if (
            sourceFacts.length !== 1 ||
            reversionFactHash(sourceFacts[0]) !== bound.factHash ||
            proofs?.length !== 1 ||
            proofs[0].sourceRevision !== bound.sourceRevision ||
            proofs[0].sourceRevisionUrl !== bound.sourceRevisionUrl
          )
            fail("reviewed_source_changed");
          if (instant(sourceFacts[0].observedAt) > cutoff) fail("source_after_cutoff");
        }
        const policy = policies.filter((entry) => entry.policy?.metricId === target.metricId);
        if (policy.length !== 1 || reversionHash(policy[0]) !== target.policyHash) fail("qualified_policy_changed");
        const revision = target.baseRevision + index + 1;
        if (!Number.isSafeInteger(revision)) fail("revision_exhausted");
        overlays.push({
          ...clone(selected[0]),
          revision,
          correctionReceipt: document.operation.approvalReceipt,
          observedAt: document.recordedAt,
          state: document.operation.effect === "inactive" ? "excluded" : target.baseState,
        });
      }
    }
  }
  return freeze({ facts: [...clone(facts), ...overlays], overlays, authority: reversionAuthority(decisions, cutoff) });
}

/** Current controls also restrict an old pin. Inactive units are always withheld;
 * a restored unit needs a rebuilt snapshot carrying the exact current authority. */
export function reversionProjection(decisions, snapshotAuthority, cutoff) {
  const authority = reversionAuthority(decisions, cutoff);
  const current = snapshotAuthority !== undefined && equal(snapshotAuthority, authority);
  const suppressedContributionIds = new Set(),
    notices = [];
  for (const chain of decisionChains(decisions)) {
    const tail = chain.filter((document) => effective(document, cutoff)).at(-1);
    if (!tail) continue;
    if (tail.operation.effect === "inactive" || !current)
      for (const target of tail.targets) suppressedContributionIds.add(target.factId);
    notices.push({
      artifactId: tail.source.original.artifactId,
      kind: "correction",
      occurredAt: tail.recordedAt,
      publicUrl: tail.operation.publicReceiptUrl,
    });
  }
  return freeze({
    authority,
    suppressedContributionIds: [...suppressedContributionIds].sort(),
    notices: notices.sort((a, b) => stable(a).localeCompare(stable(b))),
  });
}
