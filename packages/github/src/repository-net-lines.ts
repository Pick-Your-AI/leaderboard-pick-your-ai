import { createHash } from "node:crypto";
import { normalizeGithubObservation, type GithubEvidenceEnvelope } from "./normalizers.js";
import { pinnedSha } from "./physical-diff.js";

export interface RepositoryNetLinesScope {
  repositoryIds: readonly number[];
  from: string | null;
  to: string;
  cutoff: string;
}

interface Change {
  repositoryId: number;
  canonicalId: string;
  after: string;
  at: string;
  fingerprint: string;
  additions: number;
  deletions: number;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1000 && value.trim() === value;
const dense = (value: unknown, maximum: number): value is unknown[] =>
  Array.isArray(value) &&
  value.length <= maximum &&
  Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean);
function instant(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19)
    ? parsed.toISOString()
    : null;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Repository-only descriptive projection of protected integration observations.
 * The host supplies authorized envelopes after verifying the default-branch DAG,
 * exact diff and first integration clock. Payload text is never that authority.
 * This function neither collects source nor makes a public coverage/approval claim.
 */
export function summarizeRepositoryNetLines(
  observations: readonly GithubEvidenceEnvelope[],
  scope: RepositoryNetLinesScope,
) {
  if (
    !object(scope) ||
    !dense(scope.repositoryIds, 1000) ||
    !scope.repositoryIds.length ||
    !scope.repositoryIds.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0) ||
    new Set(scope.repositoryIds).size !== scope.repositoryIds.length ||
    !dense(observations, 10_000)
  )
    throw new Error("Invalid bounded repository net-lines input");
  const from = scope.from === null ? null : instant(scope.from);
  const to = instant(scope.to),
    cutoff = instant(scope.cutoff);
  if ((scope.from !== null && from === null) || !to || !cutoff || (from !== null && from >= to) || to > cutoff)
    throw new Error("Invalid repository net-lines window");
  const repositoryIds = [...scope.repositoryIds].sort((a, b) => a - b);
  const repositories = new Map(repositoryIds.map((id) => [id, { unknown: 0, reasons: new Set<string>() }]));
  const changes = new Map<string, Change>();
  const conflicting = new Set<string>();
  const afterUnits = new Map<string, string>();
  const hiddenRepositories = new Set<number>();
  let outsideScope = 0;
  const unknown = (repositoryId: number, reason: string) => {
    const row = repositories.get(repositoryId)!;
    row.unknown++;
    row.reasons.add(reason);
  };
  for (const envelope of observations) {
    const repositoryId = object(envelope?.repository) ? envelope.repository.id : null;
    if (typeof repositoryId !== "number" || !repositories.has(repositoryId)) {
      outsideScope++;
      continue;
    }
    const observedAt = instant(envelope.observedAt);
    // A later observation cannot change this earlier frozen projection.
    if (observedAt && observedAt > cutoff) continue;
    const payload = object(envelope.payload) ? envelope.payload : null;
    if (
      envelope.repository.visibility !== "public" ||
      (payload && object(payload.repository) && payload.repository.private !== false)
    ) {
      hiddenRepositories.add(repositoryId);
      unknown(repositoryId, "public_repository_visibility_unverified");
      continue;
    }
    if (!observedAt || !object(envelope.proof) || envelope.proof.verified !== true) {
      unknown(repositoryId, "integration_source_unverified");
      continue;
    }
    // A PR diff or commit-author sum is not a repository integration diff.
    if (envelope.family !== "commit") {
      unknown(repositoryId, "integration_commit_required");
      continue;
    }
    const integration = envelope.integration;
    if (!object(integration) || !text(envelope.repository.defaultBranch)) {
      unknown(repositoryId, "default_branch_integration_unverified");
      continue;
    }
    if (
      integration.defaultBranch !== envelope.repository.defaultBranch ||
      integration.targetBranch !== integration.defaultBranch
    ) {
      unknown(repositoryId, "default_branch_integration_unverified");
      continue;
    }
    const at = instant(envelope.occurredAt);
    if (!at || at > observedAt) {
      unknown(repositoryId, "integration_time_unverified");
      continue;
    }
    if (
      !pinnedSha(integration.before) ||
      !pinnedSha(integration.after) ||
      integration.before.length !== integration.after.length ||
      integration.before.toLowerCase() === integration.after.toLowerCase() ||
      !text(integration.canonicalChangeId) ||
      !dense(integration.commitShas, 10_000) ||
      !integration.commitShas.every((sha) => typeof sha === "string" && pinnedSha(sha)) ||
      !integration.commitShas.some((sha) => sha.toLowerCase() === integration.after.toLowerCase())
    ) {
      unknown(repositoryId, "integration_pins_or_identity_unverified");
      continue;
    }
    const commit = payload;
    if (
      !commit ||
      typeof commit.sha !== "string" ||
      commit.sha !== integration.after ||
      !integration.commitShas.includes(commit.sha) ||
      ["pull_request", "issue", "review", "release", "label", "milestone"].some((key) => object(commit[key])) ||
      typeof commit.html_url !== "string" ||
      commit.html_url.toLowerCase() !==
        `https://github.com/${envelope.repository.slug}/commit/${integration.after}`.toLowerCase()
    ) {
      unknown(repositoryId, "integration_commit_identity_unverified");
      continue;
    }
    if (!object(integration.diff) || !dense(integration.diff.files, 10_000)) {
      unknown(repositoryId, "integration_diff_unavailable");
      continue;
    }
    let normalized;
    try {
      normalized = normalizeGithubObservation(envelope);
    } catch {
      unknown(repositoryId, "integration_diff_or_source_invalid");
      continue;
    }
    if (normalized.reasons.includes("default_branch_integration_unverified")) {
      unknown(repositoryId, "default_branch_integration_unverified");
      continue;
    }
    const diff = normalized.physicalDiff;
    if (!diff?.complete || diff.additions === null || diff.deletions === null) {
      unknown(repositoryId, "integration_diff_unavailable");
      continue;
    }
    // Conflict checks run before the event-window filter: a changed clock must
    // not hide a competing interpretation of the same integration outside it.
    const canonicalId = integration.canonicalChangeId;
    const key = JSON.stringify([repositoryId, canonicalId]);
    const after = integration.after.toLowerCase();
    const fingerprint = hash([
      integration.before.toLowerCase(),
      after,
      at,
      diff.files
        .map((file) => [
          file.path,
          file.previousPath ?? null,
          file.additions,
          file.deletions,
          file.classification,
          file.eligible,
          file.reason,
        ])
        .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0)),
    ]);
    const old = changes.get(key);
    if (old && old.fingerprint !== fingerprint) conflicting.add(key);
    else if (!old)
      changes.set(key, {
        repositoryId,
        canonicalId,
        after,
        at,
        fingerprint,
        additions: diff.additions,
        deletions: diff.deletions,
      });
    const afterKey = JSON.stringify([repositoryId, after]);
    const existingUnit = afterUnits.get(afterKey);
    if (existingUnit && existingUnit !== key) {
      conflicting.add(existingUnit);
      conflicting.add(key);
    } else afterUnits.set(afterKey, key);
  }
  const rows = repositoryIds.map((repositoryId) => {
    const state = repositories.get(repositoryId)!;
    const selected: Change[] = [];
    let conflictingChangeIdentities = 0;
    for (const [key, change] of changes) {
      if (change.repositoryId !== repositoryId) continue;
      if (hiddenRepositories.has(repositoryId)) continue;
      if (conflicting.has(key)) {
        conflictingChangeIdentities++;
        state.reasons.add("conflicting_integration_unit");
      } else if ((from === null || change.at >= from) && change.at < to) selected.push(change);
    }
    let additions = 0n,
      deletions = 0n;
    for (const change of selected) {
      additions += BigInt(change.additions);
      deletions += BigInt(change.deletions);
    }
    const bound = BigInt(Number.MAX_SAFE_INTEGER);
    if (additions > bound || deletions > bound)
      throw new Error("Repository net-lines aggregate exceeds safe integer bound");
    return {
      repositoryId: String(repositoryId),
      state: selected.length ? ("partial" as const) : ("unknown" as const),
      knownAdditions: selected.length ? Number(additions) : null,
      knownDeletions: selected.length ? Number(deletions) : null,
      knownNetLines: selected.length ? Number(additions - deletions) : null,
      knownIntegrations: selected.length,
      unavailableObservations: state.unknown,
      conflictingChangeIdentities,
      changeIds: selected.map((change) => hash([repositoryId, change.canonicalId, change.after])).sort(),
      reasons: [...state.reasons].sort(),
    };
  });
  return {
    schemaVersion: "repository-net-lines/v1" as const,
    metricId: "net_lines" as const,
    unit: "signed net text lines" as const,
    aggregation: "sum_additions_minus_sum_deletions" as const,
    scope: { repositoryIds, from, to, cutoff },
    coverage: "incomplete" as const,
    publicEnabled: false as const,
    ranked: false as const,
    outsideScopeObservations: outsideScope,
    rows,
  };
}
