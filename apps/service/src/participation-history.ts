import { createHash } from "node:crypto";
import {
  actorSchema,
  artifactSchema,
  contributionSchema,
  sourceAdapterSchema,
  sourceEventSchema,
  achievementProofSchema,
  canonicalPublicScope,
  publicScopeKey,
  compareSourceInstants,
  participationHistoryBasisSchema,
  participationHistoryPeriod,
  participationHistoryVersion,
  publicParticipationHistorySchema,
  type ParticipationHistoryBasis,
  type ParticipationHistoryUnknownReason,
  type PublicParticipationHistory,
  type MetricDefinition,
} from "@pick-your-ai/contracts";
import { stableJSON } from "@pick-your-ai/metrics";
import {
  projectRead,
  PublicReadError,
  readSuppressedContributionIds,
  type PublicRead,
  type PortfolioEvidence,
} from "./public-source.js";

export interface ParticipationSelectedInput {
  snapshotId: string;
  revision: number;
  sha256: string;
  cutoff: string;
}
/** Provider-private protocol. These records describe an already authenticated
 * protected decision; their text, hashes and structural validity do not authorize it.
 * publication is an unfiltered organization history projection containing the
 * complete portfolio universe, with empty rows/primary/pending collections.
 */
export interface ReviewedParticipationHistory {
  schemaVersion: "participation-history-provider/v1";
  selectedInput: ParticipationSelectedInput;
  admission: {
    decisionId: string;
    organization: string;
    origin: string;
    reviewedAt: string;
    sourceInventory: ParticipationHistoryBasis["sourceInventory"];
    policies: ParticipationHistoryBasis["policies"];
  };
  dataset: {
    id: string;
    sha256: string;
    backfillRevision: string;
    cutoff: string;
    sourceInventory: ParticipationHistoryBasis["sourceInventory"];
  };
  publication: PublicRead;
  proofSources: {
    contributionId: string;
    repositoryId: string;
    source: ParticipationHistoryBasis["sourceInventory"][number]["source"];
  }[];
  unresolved: {
    actorId: string | null;
    reason: "unknown_actor" | "unknown_time" | "unknown_qualification" | "withheld" | "conflicting";
  }[];
}
export interface ParticipationHistoryRead {
  current: PublicRead;
  selectedInput: ParticipationSelectedInput | null;
  history: ReviewedParticipationHistory | null;
}

function invalid(): never {
  throw new PublicReadError(503, "participation_history_invalid");
}
const identity = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) && value !== "." && value !== "..";
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const instant = (value: unknown): value is string => sourceEventSchema.shape.observedAt.safeParse(value).success;
const same = (left: unknown, right: unknown) => stableJSON(left) === stableJSON(right);
const inventoryKey = (value: ParticipationHistoryBasis["sourceInventory"]) =>
  stableJSON(value.map((pair) => [pair.repositoryId, pair.source]).sort());
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
}

/** Bound all supplied JSON before schemas, hashes or privacy projection. A trusted
 * provider can still malfunction; no recursive/cyclic/accessor/oversized input runs unbounded.
 */
function boundedJSON(value: unknown) {
  let bytes = 0,
    nodes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 250_000 || depth > 32 || bytes > 8_000_000) invalid();
    if (typeof item === "string") {
      if (item.length > 8_000_000 - bytes) invalid();
      bytes += Buffer.byteLength(JSON.stringify(item));
    } else if (item === null || typeof item === "boolean") bytes += 5;
    else if (typeof item === "number" && Number.isFinite(item)) bytes += 32;
    else if (item && typeof item === "object") {
      if (seen.has(item)) invalid();
      seen.add(item);
      if (Object.getOwnPropertySymbols(item).length) invalid();
      if (Array.isArray(item)) {
        if (
          item.length > 20_000 ||
          Object.keys(item).length !== item.length ||
          Object.getOwnPropertyNames(item).length !== item.length + 1
        )
          invalid();
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, index)!;
          if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
          visit(descriptor.value, depth + 1);
          bytes++; // Include array separators in the conservative JSON byte bound.
        }
      } else {
        if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) invalid();
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
          if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
          if (key.length > 8_000_000 - bytes) invalid();
          bytes += Buffer.byteLength(JSON.stringify(key)) + 2;
          visit(descriptor.value, depth + 1);
        }
      }
      seen.delete(item);
      bytes += 2;
    } else invalid();
    if (bytes > 8_000_000) invalid();
  };
  visit(value, 0);
}
function selectedInput(value: unknown): asserts value is ParticipationSelectedInput {
  exact(value, ["snapshotId", "revision", "sha256", "cutoff"]);
  if (
    !identity(value.snapshotId) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !hash(value.sha256) ||
    !instant(value.cutoff)
  )
    invalid();
}

export function validateParticipationHistoryRead(value: unknown): ParticipationHistoryRead | null {
  if (value === null) return null;
  boundedJSON(value);
  exact(value, ["current", "selectedInput", "history"]);
  if (value.selectedInput !== null) selectedInput(value.selectedInput);
  if (value.history === null) return value as unknown as ParticipationHistoryRead;
  const history = value.history;
  exact(history, [
    "schemaVersion",
    "selectedInput",
    "admission",
    "dataset",
    "publication",
    "proofSources",
    "unresolved",
  ]);
  if (history.schemaVersion !== "participation-history-provider/v1" || value.selectedInput === null) invalid();
  selectedInput(history.selectedInput);
  if (!same(value.selectedInput, history.selectedInput)) invalid();
  const admission = history.admission,
    dataset = history.dataset;
  exact(admission, ["decisionId", "organization", "origin", "reviewedAt", "sourceInventory", "policies"]);
  exact(dataset, ["id", "sha256", "backfillRevision", "cutoff", "sourceInventory"]);
  if (
    !identity(admission.decisionId) ||
    !instant(admission.reviewedAt) ||
    !identity(dataset.id) ||
    !hash(dataset.sha256) ||
    !identity(dataset.backfillRevision) ||
    dataset.cutoff !== history.selectedInput.cutoff
  )
    invalid();
  const basis = participationHistoryBasisSchema.parse({
    scope: { organization: admission.organization, repository: null, workstream: null, start: null, end: null },
    origin: admission.origin,
    cutoff: dataset.cutoff,
    sourceInventory: admission.sourceInventory,
    policies: admission.policies,
  });
  const supplied = participationHistoryBasisSchema.parse({ ...basis, sourceInventory: dataset.sourceInventory });
  if (
    inventoryKey(basis.sourceInventory) !== inventoryKey(supplied.sourceInventory) ||
    compareSourceInstants(admission.reviewedAt, basis.cutoff) > 0
  )
    invalid();
  if (
    !Array.isArray(history.proofSources) ||
    history.proofSources.length > 20_000 ||
    !Array.isArray(history.unresolved) ||
    history.unresolved.length > 20_000
  )
    invalid();
  const sources = new Set<string>();
  for (const entry of history.proofSources) {
    exact(entry, ["contributionId", "repositoryId", "source"]);
    if (
      !identity(entry.contributionId) ||
      !identity(entry.repositoryId) ||
      !sourceAdapterSchema.safeParse(entry.source).success ||
      entry.source === "unknown" ||
      sources.has(entry.contributionId) ||
      !basis.sourceInventory.some((pair) => pair.repositoryId === entry.repositoryId && pair.source === entry.source)
    )
      invalid();
    sources.add(entry.contributionId);
  }
  for (const entry of history.unresolved) {
    exact(entry, ["actorId", "reason"]);
    if (
      (entry.actorId !== null && !identity(entry.actorId)) ||
      !["unknown_actor", "unknown_time", "unknown_qualification", "withheld", "conflicting"].includes(
        String(entry.reason),
      ) ||
      (entry.reason === "unknown_actor" && entry.actorId !== null)
    )
      invalid();
  }
  return value as unknown as ParticipationHistoryRead;
}

export function unknownParticipationHistory(reason: ParticipationHistoryUnknownReason): PublicParticipationHistory {
  return {
    schemaVersion: "leaderboard-participation-history/v1",
    ruleVersion: participationHistoryVersion,
    dateBasis: "accepted_source_occurrence",
    ranked: false,
    state: "unknown",
    reason,
    historyKey: null,
    basis: null,
    firstProof: null,
    newcomer: null,
    periodReason: null,
  };
}

/** All arguments have passed the bounded protocol check and the current normal
 * projection. No public query or receipt string grants the provider its capability.
 */
export function publicOrganizationHistory(
  paired: ParticipationHistoryRead | null,
  current: PublicRead,
  actorId: string,
  category: string | null,
  definitions: readonly MetricDefinition[],
): PublicParticipationHistory {
  const history = paired?.history;
  if (!history) return unknownParticipationHistory("reviewed_history_unavailable");
  const binding = paired.selectedInput!;
  if (
    binding.snapshotId !== current.selected.snapshot.snapshotId ||
    binding.revision !== current.selected.snapshot.revision ||
    compareSourceInstants(binding.cutoff, current.selected.snapshot.generatedAt) > 0
  )
    invalid();
  const { admission, dataset, publication } = history;
  const basis = participationHistoryBasisSchema.parse({
    scope: { organization: admission.organization, repository: null, workstream: null, start: null, end: null },
    origin: admission.origin,
    cutoff: dataset.cutoff,
    sourceInventory: admission.sourceInventory,
    policies: admission.policies,
  });
  if (admission.organization !== current.selected.scope.organization || !publication?.selected || !publication.controls)
    invalid();
  const authority = (read: PublicRead) =>
    stableJSON([
      read.controls.version,
      [...read.controls.suppressedActorIds].sort(),
      [...read.controls.suppressedArtifactIds].sort(),
      [...read.controls.revokedSnapshotIds].sort(),
      readSuppressedContributionIds(read.controls).sort(),
    ]);
  if (authority(paired.current) !== authority(publication))
    throw new PublicReadError(503, "participation_history_authority_changed");
  if (
    publicScopeKey(canonicalPublicScope(publication.selected.scope)) !== publicScopeKey(basis.scope) ||
    publication.selected.scope.schemaVersion !== undefined ||
    (publication.actorFilter !== undefined && publication.actorFilter !== "all")
  )
    invalid();
  if (
    publication.selected.rows.length ||
    publication.selected.evidence.length ||
    (publication.selected.pendingEvidence?.length ?? 0) ||
    (publication.selected.diagnostics?.length ?? 0) ||
    !Array.isArray(publication.selected.portfolioEvidence) ||
    publication.selected.snapshot.coverage.length > 500
  )
    invalid();

  // Check every known actor binding across both reads before requested-actor or
  // privacy shortcuts. Current login/display-name changes are not identity changes.
  const aliases = new Map<string, string>();
  const ids = new Map<string, { node: string | undefined; database: number | undefined }>();
  for (const entry of [...paired.current.selected.actors, ...publication.selected.actors]) {
    const actor = actorSchema.parse(entry.actor),
      previous = ids.get(entry.actorId);
    if (
      previous &&
      ((previous.node && actor.githubNodeId && previous.node !== actor.githubNodeId) ||
        (previous.database !== undefined &&
          actor.githubDatabaseId !== undefined &&
          previous.database !== actor.githubDatabaseId))
    )
      invalid();
    ids.set(entry.actorId, {
      node: previous?.node ?? actor.githubNodeId,
      database: previous?.database ?? actor.githubDatabaseId,
    });
    for (const key of [
      actor.githubNodeId ? "node:" + actor.githubNodeId : null,
      actor.githubDatabaseId === undefined ? null : "database:" + actor.githubDatabaseId,
    ]) {
      if (key === null) continue;
      if (aliases.has(key) && aliases.get(key) !== entry.actorId) invalid();
      aliases.set(key, entry.actorId);
    }
  }

  let projected: PublicRead;
  try {
    projected = projectRead(publication, basis.scope, publication.selected.snapshot.snapshotId, definitions);
  } catch (error) {
    if (error instanceof PublicReadError && error.code === "snapshot_revoked_refetch")
      return unknownParticipationHistory("history_evidence_unavailable");
    throw error;
  }
  if (compareSourceInstants(projected.selected.snapshot.generatedAt, basis.cutoff) < 0) invalid();
  const known = new Set(definitions.map((entry) => entry.id));
  if (
    basis.policies.some((policy) => !known.has(policy.metricId)) ||
    projected.selected.portfolioEvidence!.some((entry) =>
      entry.contribution.metricIds.some((metric) => !known.has(metric)),
    )
  )
    invalid();

  const raw = publication.selected.portfolioEvidence!;
  const sourceById = new Map(history.proofSources.map((entry) => [entry.contributionId, entry]));
  if (sourceById.size !== raw.length || raw.some((entry) => !sourceById.has(entry.contribution.contributionId)))
    invalid();
  const artifactBindings = new Map<string, string>();
  const canonical = new Map<string, string | null>();
  for (const entry of raw) {
    const artifact = artifactSchema.parse(entry.artifact),
      contribution = contributionSchema.parse(entry.contribution);
    const receipt = sourceById.get(contribution.contributionId)!;
    if (contribution.metricIds.some((metric) => !known.has(metric))) invalid();
    if (
      artifact.repositoryId !== receipt.repositoryId ||
      (artifact.stableId && contribution.artifactId && artifact.stableId !== contribution.artifactId)
    )
      invalid();
    if (
      entry.observedAt !== null &&
      (compareSourceInstants(entry.observedAt, basis.cutoff) > 0 ||
        (entry.occurredAt !== null && compareSourceInstants(entry.occurredAt, entry.observedAt) > 0))
    )
      invalid();
    if (
      entry.occurredAt !== null &&
      (compareSourceInstants(entry.occurredAt, basis.origin) < 0 ||
        compareSourceInstants(entry.occurredAt, basis.cutoff) > 0)
    )
      invalid();
    if (
      entry.evidenceMetadata &&
      (entry.evidenceMetadata.sourceOccurredAt !== entry.occurredAt ||
        entry.evidenceMetadata.observedAt !== entry.observedAt)
    )
      invalid();
    const artifactIdentity = stableJSON([artifact.kind, artifact.repositoryId, artifact.publicUrl ?? null]);
    if (artifact.stableId) {
      if (artifactBindings.has(artifact.stableId) && artifactBindings.get(artifact.stableId) !== artifactIdentity)
        invalid();
      artifactBindings.set(artifact.stableId, artifactIdentity);
    }
    const key = stableJSON([contribution.canonicalEventId, contribution.actorId, contribution.artifactId]);
    const prior = canonical.get(key);
    // Distinct credited policy/role projections can share one source event;
    // their original occurrence must agree without merging their proof IDs.
    if (
      prior !== undefined &&
      prior !== null &&
      entry.occurredAt !== null &&
      compareSourceInstants(prior, entry.occurredAt) !== 0
    )
      invalid();
    canonical.set(key, prior ?? entry.occurredAt);
  }

  // The full admitted inventory is authoritative input from the provider, not
  // reconstructed from whichever coverage entries happened to be supplied.
  const coverage = projected.selected.snapshot.coverage;
  if (
    coverage.some(
      (entry) =>
        !basis.sourceInventory.some((pair) => pair.repositoryId === entry.scopeId && pair.source === entry.source),
    )
  )
    invalid();
  const complete = (entry: (typeof coverage)[number]) =>
    entry.state === "complete" &&
    entry.knownStart !== null &&
    compareSourceInstants(entry.knownStart, basis.origin) <= 0 &&
    entry.windowStart !== null &&
    compareSourceInstants(entry.windowStart, basis.origin) <= 0 &&
    entry.windowEnd !== null &&
    compareSourceInstants(entry.windowEnd, basis.cutoff) >= 0 &&
    entry.sourceWatermark !== null &&
    compareSourceInstants(entry.sourceWatermark, basis.cutoff) >= 0 &&
    entry.lastSuccessfulSync !== null &&
    compareSourceInstants(entry.lastSuccessfulSync, basis.cutoff) >= 0 &&
    entry.missingPages === 0 &&
    entry.permissionsMissing.length === 0 &&
    entry.sourceErrors.length === 0;
  if (
    !basis.sourceInventory.every((pair) => {
      const entries = coverage.filter((entry) => entry.scopeId === pair.repositoryId && entry.source === pair.source);
      return entries.length > 0 && entries.every(complete);
    })
  )
    return unknownParticipationHistory("history_incomplete");

  const unavailablePolicy = basis.policies.some((policy) => {
    const saved = projected.selected.methodology?.find((entry) => entry.metricId === policy.metricId);
    const currentPolicy = current.selected.methodology?.find((entry) => entry.metricId === policy.metricId);
    return (
      !saved ||
      saved.policyVersion !== policy.version ||
      saved.policySignature !== policy.signature ||
      (currentPolicy !== undefined &&
        (currentPolicy.policyVersion !== policy.version || currentPolicy.policySignature !== policy.signature)) ||
      [...(current.selected.disabledMetrics ?? []), ...(projected.selected.disabledMetrics ?? [])].some(
        (entry) => entry.id === policy.metricId,
      )
    );
  });
  if (
    unavailablePolicy ||
    projected.selected.snapshot.metricDefinitionVersion !== current.selected.snapshot.metricDefinitionVersion ||
    projected.selected.snapshot.computationVersion !== current.selected.snapshot.computationVersion
  )
    return unknownParticipationHistory("qualifying_policy_unavailable");
  const actor = current.selected.actors.find((entry) => entry.actorId === actorId)?.actor;
  const previousActor = projected.selected.actors.find((entry) => entry.actorId === actorId)?.actor;
  if (
    !actor ||
    !previousActor ||
    actor.kind !== "user" ||
    actor.executionMode === "automated" ||
    actor.kind !== previousActor.kind ||
    actor.executionMode !== previousActor.executionMode
  )
    return unknownParticipationHistory("qualifying_actor_unavailable");
  if (history.unresolved.some((entry) => entry.actorId === null || entry.actorId === actorId))
    return unknownParticipationHistory("history_evidence_unavailable");

  const visible = new Map(
    projected.selected.portfolioEvidence!.map((entry) => [entry.contribution.contributionId, entry]),
  );
  const candidates: PortfolioEvidence[] = [];
  for (const entry of raw) {
    const contribution = contributionSchema.parse(entry.contribution);
    if (contribution.actorId !== null && contribution.actorId !== actorId) continue;
    const receipt = sourceById.get(contribution.contributionId)!;
    const relevant = basis.policies.some(
      (policy) =>
        contribution.metricIds.includes(policy.metricId) &&
        policy.sources.includes(receipt.source) &&
        policy.roles.some((role) => contribution.roles.includes(role)),
    );
    if (!relevant || contribution.qualification === "ineligible") continue;
    if (
      contribution.actorId === null ||
      !["eligible", "ineligible"].includes(contribution.qualification) ||
      entry.activityState === "unknown" ||
      entry.activityState === "pending"
    )
      return unknownParticipationHistory("history_evidence_unavailable");
    if (entry.activityState !== "accepted") continue;
    const retained = visible.get(contribution.contributionId);
    if (!retained || entry.occurredAt === null || entry.observedAt === null)
      return unknownParticipationHistory("history_evidence_unavailable");
    candidates.push(retained);
  }
  candidates.sort(
    (left, right) =>
      compareSourceInstants(left.occurredAt!, right.occurredAt!) ||
      (left.contribution.contributionId < right.contribution.contributionId
        ? -1
        : left.contribution.contributionId > right.contribution.contributionId
          ? 1
          : 0),
  );
  const first = candidates[0];
  if (!first) return unknownParticipationHistory("no_qualifying_evidence");
  const proof = achievementProofSchema.parse({
    contributionId: first.contribution.contributionId,
    canonicalEventId: first.contribution.canonicalEventId,
    actorId,
    artifactId: first.artifact.stableId,
    artifactKind: first.artifact.kind,
    repositoryId: first.artifact.repositoryId ?? null,
    sourceUrl: first.artifact.publicUrl,
    roles: [...new Set(first.contribution.roles)].sort(),
    metricIds: [...new Set(first.contribution.metricIds)].sort(),
    occurredAt: first.occurredAt,
    activityState: "accepted",
    qualification: "eligible",
  });
  const firstProof = { proof, observedAt: first.observedAt!, source: sourceById.get(proof.contributionId)!.source };
  // Identity only: every route still performs a fresh authorized provider read.
  // Bind the entire bounded private history, not only the chosen first record.
  const historyKey = createHash("sha256")
    .update(
      stableJSON({
        history,
        selectedInput: binding,
        actorId,
        category,
        scope: current.selected.scope,
        actorFilter: current.actorFilter ?? "all",
        controls: current.controls,
      }),
    )
    .digest("hex");
  return publicParticipationHistorySchema.parse({
    schemaVersion: "leaderboard-participation-history/v1",
    ruleVersion: participationHistoryVersion,
    dateBasis: "accepted_source_occurrence",
    ranked: false,
    state: "known",
    reason: null,
    historyKey,
    basis,
    firstProof,
    ...participationHistoryPeriod(
      current.selected.scope.start,
      current.selected.scope.end,
      basis.cutoff,
      proof.occurredAt,
    ),
  });
}
