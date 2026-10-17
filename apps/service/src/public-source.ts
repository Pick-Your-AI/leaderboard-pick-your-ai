import {
  actorSchema, artifactSchema, contributionSchema, metricResultSchema, snapshotSchema, sourceEventSchema,
  type Actor, type Artifact, type Contribution, type MetricResult, type Snapshot,
} from "@pick-your-ai/contracts";

/** An exact materialized scope, never a request to sum overlapping aggregates. */
export interface PublicScope {
  organization: string;
  repository: string | null;
  workstream: string | null;
  start: string | null;
  end: string | null;
}
export interface PublicEvidence {
  artifact: Artifact;
  contribution: Contribution;
  occurredAt: string | null;
  sourceRevision: string | null;
  sourceRevisionUrl: string | null;
}
export interface PublicActor {
  actorId: string;
  actor: Actor;
  state: "public" | "hidden" | "deleted" | "unlinked";
}
export interface PublicRow {
  actorId: string;
  result: MetricResult;
  evidenceIds: string[];
}
export interface PublicDiagnostic {
  metricId: string;
  actorId: string;
  numerator: number | null;
  denominator: number | null;
  sampleCount: number;
  censored: number;
  missingReadiness: number;
  p75: number | null;
}
export interface PublishedSnapshot {
  approvedPublic: true;
  scope: PublicScope;
  snapshot: Snapshot;
  actors: PublicActor[];
  rows: PublicRow[];
  evidence: PublicEvidence[];
  /** Approved per-metric direction; the API does not infer comparability or scoring. */
  ranking: { metricId: string; direction: "ascending" | "descending"; rank?: boolean }[];
  disabledMetrics?: { id: string; reason: string; policyVersion: string; policyLink: string | null }[];
  methodology?: { metricId: string; policyVersion: string; policySignature: string; policyLink: string | null }[];
  diagnostics?: PublicDiagnostic[];
}
/** Current controls must be read atomically even for a historical snapshot. */
export interface PublicRead {
  head: { snapshotId: string; revision: number; publishedAt: string };
  selected: PublishedSnapshot;
  controls: {
    version: string;
    suppressedActorIds: string[];
    suppressedArtifactIds: string[];
    revokedSnapshotIds: string[];
  };
}
export interface PublicSnapshotSource {
  /** null means absent/unapproved/expired. Do not return raw ingestion replay documents.
   * Implementations must honor signal cancellation and enforce current controls.
   */
  read(scope: PublicScope, snapshotId: string | null, signal: AbortSignal): Promise<PublicRead | null>;
}
export const unavailableSource: PublicSnapshotSource = { async read() { return null; } };

export class PublicReadError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export function safePublicUrl(value: string | null | undefined): string | null {
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.origin === "https://github.com" && !url.username && !url.password && !url.search &&
      (!url.hash || /^#(?:issuecomment-\d+|pullrequestreview-\d+|discussion_r\d+|r\d+|discussioncomment-\d+)$/.test(url.hash)) &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./~-]+)?$/.test(url.pathname)
      ? url.href : null;
  } catch { return null; }
}
const date = (value: string | null) => sourceEventSchema.shape.occurredAt.safeParse(value).success;
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);

/** Validate and construct a fresh allowlisted public object. Never serialize provider objects. */
export function projectRead(input: PublicRead, scope: PublicScope, pin: string | null): PublicRead {
  const reject = () => { throw new PublicReadError(503, "public_projection_unavailable"); };
  if (!input || !input.selected || !input.controls || !input.head) return reject();
  const selected = input.selected;
  if (selected.approvedPublic !== true || !selected.scope || !Object.keys(scope).every(key =>
      selected.scope[key as keyof PublicScope] === scope[key as keyof PublicScope]) ||
      !Array.isArray(selected.rows) || selected.rows.length > 10000 ||
      !Array.isArray(selected.actors) || selected.actors.length > 10000 ||
      !Array.isArray(selected.evidence) || selected.evidence.length > 20000 ||
      !Array.isArray(selected.ranking) || selected.ranking.length > 98) return reject();
  const ranking = selected.ranking.map(entry => {
    if (!id(entry.metricId) || !["ascending", "descending"].includes(entry.direction) ||
        (entry.rank !== undefined && typeof entry.rank !== "boolean")) return reject();
    return { metricId: entry.metricId, direction: entry.direction, rank: entry.rank !== false };
  });
  if ((selected.disabledMetrics !== undefined && (!Array.isArray(selected.disabledMetrics) || selected.disabledMetrics.length > 98)) ||
      (selected.methodology !== undefined && (!Array.isArray(selected.methodology) || selected.methodology.length > 98))) return reject();
  const disabledMetrics = (selected.disabledMetrics ?? []).map(entry => {
    if (!id(entry.id) || !id(entry.policyVersion) || typeof entry.reason !== "string" || !/^[a-z0-9_:-]{1,100}$/.test(entry.reason)) return reject();
    return { id: entry.id, reason: entry.reason, policyVersion: entry.policyVersion, policyLink: safePublicUrl(entry.policyLink) };
  });
  const methodology = (selected.methodology ?? []).map(entry => {
    if (!id(entry.metricId) || !id(entry.policyVersion) || typeof entry.policySignature !== "string" || !/^[a-f0-9]{64}$/.test(entry.policySignature)) return reject();
    return { metricId: entry.metricId, policyVersion: entry.policyVersion, policySignature: entry.policySignature, policyLink: safePublicUrl(entry.policyLink) };
  });
  if (new Set(disabledMetrics.map(entry => entry.id)).size !== disabledMetrics.length ||
      new Set(methodology.map(entry => entry.metricId)).size !== methodology.length) return reject();
  const disabled = new Set(disabledMetrics.map(entry => entry.id));
  if (new Set(ranking.map(entry => entry.metricId)).size !== ranking.length) return reject();
  const snapshot = snapshotSchema.parse(selected.snapshot);
  const controls = input.controls;
  if (!id(controls.version) || !id(snapshot.snapshotId) || !id(input.head.snapshotId) || !Number.isSafeInteger(input.head.revision) ||
      input.head.revision < snapshot.revision || !date(input.head.publishedAt) || input.head.publishedAt === null ||
      ![controls.suppressedActorIds, controls.suppressedArtifactIds, controls.revokedSnapshotIds].every(
        list => Array.isArray(list) && list.length <= 20000 && list.every(id))) return reject();
  if (pin !== null && snapshot.snapshotId !== pin) return reject();
  if (pin === null && (snapshot.snapshotId !== input.head.snapshotId || snapshot.revision !== input.head.revision)) return reject();
  if (controls.revokedSnapshotIds.includes(snapshot.snapshotId)) throw new PublicReadError(410, "snapshot_revoked_refetch");
  const suppressedActors = new Set(controls.suppressedActorIds);
  const suppressedArtifacts = new Set(controls.suppressedArtifactIds);
  const actors = selected.actors.map(entry => {
    if (!id(entry.actorId) || !["public", "hidden", "deleted", "unlinked"].includes(entry.state)) return reject();
    const actor = actorSchema.parse(entry.actor);
    return { actorId: entry.actorId, actor, state: entry.state };
  }).filter(entry => entry.state === "public" && entry.actor.identityState === "resolved" && !suppressedActors.has(entry.actorId));
  if (new Set(actors.map(actor => actor.actorId)).size !== actors.length) return reject();
  const actorIds = new Set(actors.map(actor => actor.actorId));
  const evidence = selected.evidence.map(entry => {
    const artifact = artifactSchema.parse(entry.artifact);
    const parsed = contributionSchema.parse(entry.contribution);
    const contribution = { ...parsed, metricIds: parsed.metricIds.filter(metricId => !disabled.has(metricId)) };
    if (!date(entry.occurredAt) || (entry.sourceRevision !== null && !id(entry.sourceRevision))) return reject();
    return { artifact, contribution, occurredAt: entry.occurredAt, sourceRevision: entry.sourceRevision,
      sourceRevisionUrl: safePublicUrl(entry.sourceRevisionUrl) };
  }).filter(entry => entry.artifact.visibility === "public" && safePublicUrl(entry.artifact.publicUrl) !== null &&
    !suppressedArtifacts.has(entry.artifact.stableId!) && entry.contribution.metricIds.length > 0 && entry.contribution.qualification === "eligible" &&
    entry.contribution.artifactId === entry.artifact.stableId && actorIds.has(entry.contribution.actorId ?? "") &&
    (scope.repository === null || entry.artifact.repositoryId === scope.repository) &&
    (scope.start === null || (entry.occurredAt !== null && Date.parse(entry.occurredAt) >= Date.parse(scope.start))) &&
    (scope.end === null || (entry.occurredAt !== null && Date.parse(entry.occurredAt) < Date.parse(scope.end))));
  const evidenceMap = new Map(evidence.map(entry => [entry.contribution.contributionId, entry]));
  if (evidenceMap.size !== evidence.length) return reject();
  let evidenceReferenceCount = 0;
  const rows = selected.rows.map(entry => {
    if (!id(entry.actorId) || !Array.isArray(entry.evidenceIds) || entry.evidenceIds.length > 10000 ||
        !entry.evidenceIds.every(id) || new Set(entry.evidenceIds).size !== entry.evidenceIds.length) return reject();
    evidenceReferenceCount += entry.evidenceIds.length;
    const result = metricResultSchema.parse(entry.result);
    if (evidenceReferenceCount > 40000 || !ranking.some(entry => entry.metricId === result.metricId)) return reject();
    return { actorId: entry.actorId, result, evidenceIds: [...entry.evidenceIds] };
  }).filter(entry => !disabled.has(entry.result.metricId) && actorIds.has(entry.actorId) &&
    // Remove affected aggregates entirely; subtracting evidence counts would corrupt ratios/weights.
    entry.evidenceIds.every(evidenceId => {
      const evidence = evidenceMap.get(evidenceId);
      return evidence?.contribution.actorId === entry.actorId && evidence.contribution.metricIds.includes(entry.result.metricId);
    }) && (entry.result.value === undefined || entry.result.value === 0 || entry.evidenceIds.length > 0));
  if (new Set(rows.map(row => JSON.stringify([row.actorId, row.result.metricId]))).size !== rows.length) return reject();
  if (selected.diagnostics !== undefined && (!Array.isArray(selected.diagnostics) || selected.diagnostics.length > 10000)) return reject();
  const visibleRows = new Set(rows.map(row => JSON.stringify([row.actorId, row.result.metricId])));
  const diagnostics = (selected.diagnostics ?? []).map(entry => {
    if (!id(entry.metricId) || !id(entry.actorId) ||
        ![entry.sampleCount, entry.censored, entry.missingReadiness].every(value => Number.isSafeInteger(value) && value >= 0) ||
        ![entry.numerator, entry.denominator, entry.p75].every(value => value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0))) return reject();
    return { metricId: entry.metricId, actorId: entry.actorId, numerator: entry.numerator, denominator: entry.denominator,
      sampleCount: entry.sampleCount, censored: entry.censored, missingReadiness: entry.missingReadiness, p75: entry.p75 };
  }).filter(entry => visibleRows.has(JSON.stringify([entry.actorId, entry.metricId])));
  if (new Set(diagnostics.map(entry => JSON.stringify([entry.actorId, entry.metricId]))).size !== diagnostics.length) return reject();
  // Raw exception strings and permission details never enter the public projection.
  const coverage = (value: MetricResult["coverage"]) => ({ ...value,
    permissionsMissing: value.permissionsMissing.length ? ["source_capability_unavailable"] : [],
    sourceErrors: value.sourceErrors.length ? ["source_collection_failed"] : [] });
  return {
    head: { snapshotId: input.head.snapshotId, revision: input.head.revision, publishedAt: input.head.publishedAt },
    controls: { version: controls.version, suppressedActorIds: [], suppressedArtifactIds: [], revokedSnapshotIds: [] },
    selected: { approvedPublic: true, scope: { ...scope },
      snapshot: { ...snapshot, coverage: snapshot.coverage.map(coverage), results: [] },
      actors, rows: rows.map(row => ({ ...row, result: { ...row.result, coverage: coverage(row.result.coverage) } })), evidence,
      ranking: ranking.filter(entry => !disabled.has(entry.metricId)), disabledMetrics, methodology, diagnostics },
  };
}
