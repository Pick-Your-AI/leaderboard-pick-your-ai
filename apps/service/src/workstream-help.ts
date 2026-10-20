import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import {
  achievementProofSchema,
  compareSourceInstants,
  encodeWorkstreamHelpStatement,
  publicWorkstreamHelpSchema,
  workstreamHelpEvidenceKey,
  workstreamHelpLimits,
  workstreamHelpMetricIds,
  workstreamHelpRecognitionSchema,
  workstreamHelpUnit,
  type MetricDefinition,
  type PublicWorkstreamHelp,
  type WorkstreamHelpRecognition,
} from "@pick-your-ai/contracts";
import { PublicReadError, type PortfolioEvidence, type PublishedSnapshot, type PublicRead, type PublicScope } from "./public-source.js";

const conflict = (): never => { throw new PublicReadError(503, "workstream_help_evidence_conflict"); };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** The optional collection is bounded as data before Zod, hashing or projection. */
function boundedPublicHelp(value: unknown): void {
  let bytes = 0, nodes = 0;
  const ancestors = new Set<object>();
  const check = (ok: unknown): void => { if (!ok) conflict(); };
  const take = (count: number): void => {
    check(count <= 8_000_000 - bytes);
    bytes += count;
  };
  // Count the well-formed JSON representation without allocating an escaped string.
  const addString = (text: string): void => {
    take(2);
    check(text.length <= 8_000_000 - bytes);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 0x22 || code === 0x5c) take(2);
      else if (code <= 0x1f) take(code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6);
      else if (code < 0x80) take(1);
      else if (code < 0x800) take(2);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { take(4); index++; }
        else take(6);
      } else if (code >= 0xdc00 && code <= 0xdfff) take(6);
      else take(3);
    }
  };
  const visit = (item: unknown, depth: number): void => {
    check(++nodes <= 250_000 && depth <= 24);
    if (typeof item === "string") addString(item);
    else if (item === null || typeof item === "boolean") take(5);
    else if (typeof item === "number" && Number.isFinite(item)) take(32);
    else if (item && typeof item === "object") {
      check(!isProxy(item) && !ancestors.has(item));
      const array = Array.isArray(item);
      check(array ? Object.getPrototypeOf(item) === Array.prototype :
        [Object.prototype, null].includes(Object.getPrototypeOf(item)));
      if (array) check(item.length <= workstreamHelpLimits.records && item.length <= 250_000 - nodes);
      // Inventory keys once, then bound their count before obtaining any descriptors.
      const keys = Reflect.ownKeys(item);
      check(array ? keys.length === item.length + 1 : keys.length <= 250_000 - nodes);
      check(keys.every((key) => typeof key === "string"));
      ancestors.add(item);
      take(2);
      if (array) {
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) conflict();
          take(1);
          visit(descriptor.value, depth + 1);
        }
      } else {
        for (const key of keys) {
          if (typeof key !== "string") conflict();
          addString(key);
          take(2);
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) conflict();
          visit(descriptor.value, depth + 1);
        }
      }
      ancestors.delete(item);
    } else conflict();
  };
  visit(value, 0);
}

function sameSource(entry: PortfolioEvidence, help: PublicWorkstreamHelp): boolean {
  const source = help.statement;
  return entry.contribution.actorId === source.actorId &&
    entry.contribution.artifactId === source.artifactId &&
    entry.artifact.stableId === source.artifactId &&
    entry.artifact.repositoryId === source.repositoryId &&
    entry.artifact.kind === "pull_request" && entry.artifact.source === "github" && entry.artifact.visibility === "public" &&
    entry.artifact.publicUrl === source.sourceUrl &&
    entry.sourceRevision === source.sourceRevision &&
    entry.occurredAt === source.occurredAt &&
    entry.contribution.roles.length === 1 && entry.contribution.roles[0] === "author";
}

/** Called inside projectRead after validating every evidence collection and current control.
 * Only the caller's already projected portfolio may supply a surviving dependency.
 */
export function projectWorkstreamHelp(
  selected: PublishedSnapshot,
  portfolio: PortfolioEvidence[],
  scope: PublicScope,
): PublicWorkstreamHelp[] | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(selected, "reviewedWorkstreamHelp");
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return conflict();
  const supplied: unknown = descriptor.value;
  boundedPublicHelp(supplied);
  if (!Array.isArray(supplied) || supplied.length > workstreamHelpLimits.records) return conflict();
  const original = new Map((selected.portfolioEvidence ?? []).map((entry) => [entry.contribution.contributionId, entry]));
  const visible = new Map(portfolio.map((entry) => [entry.contribution.contributionId, entry]));
  const copiesById = new Map<string, PublishedSnapshot["evidence"]>();
  for (const entry of [...selected.evidence, ...(selected.portfolioEvidence ?? []), ...(selected.pendingEvidence ?? [])]) {
    const key = entry.contribution.contributionId;
    const copies = copiesById.get(key) ?? [];
    copies.push(entry);
    copiesById.set(key, copies);
  }
  const seen = new Set<string>(), units = new Map<string, string>(), catalogs = new Map<string, string>();
  const statementHashes = new Map<string, string>();
  const retained: PublicWorkstreamHelp[] = [];
  for (const input of supplied) {
    const parsed = publicWorkstreamHelpSchema.safeParse(input);
    if (!parsed.success) return conflict();
    const help = parsed.data;
    if (createHash("sha256").update(encodeWorkstreamHelpStatement(help.statement), "utf8").digest("hex") !==
      help.statementHash) return conflict();
    if (seen.has(help.contributionId) || help.statement.organization !== scope.organization ||
      compareSourceInstants(help.reviewedAt, selected.snapshot.generatedAt) > 0) return conflict();
    seen.add(help.contributionId);
    if (statementHashes.has(help.statementUrl) && statementHashes.get(help.statementUrl) !== help.statementHash) return conflict();
    statementHashes.set(help.statementUrl, help.statementHash);
    const key = workstreamHelpUnit(help), signature = JSON.stringify([
      workstreamHelpEvidenceKey(help), help.acceptedAt, help.reviewedAt,
    ]);
    if (units.has(key) && units.get(key) !== signature) return conflict();
    units.set(key, signature);
    for (const workstream of [help.statement.from, help.statement.to]) {
      const identity = JSON.stringify([help.statement.organization, help.statement.definitionVersion, workstream.id]);
      if (catalogs.has(identity) && catalogs.get(identity) !== workstream.label) return conflict();
      catalogs.set(identity, workstream.label);
    }
    const prior = original.get(help.contributionId);
    if (!prior) return conflict();
    // Every copy of a proof must retain one source identity, including a copy
    // that a different evidence route would select first.
    const copies = copiesById.get(help.contributionId) ?? [];
    const copyKey = (entry: typeof copies[number]) => JSON.stringify([
      entry.artifact.stableId, entry.artifact.kind, entry.artifact.source, entry.artifact.visibility,
      entry.artifact.repositoryId, entry.artifact.publicUrl,
      entry.contribution.actorId, entry.contribution.artifactId, entry.sourceRevision, entry.sourceRevisionUrl,
      entry.occurredAt, entry.contribution.roles,
    ]);
    if (copies.some((entry) => copyKey(entry) !== copyKey(prior))) return conflict();
    // Corrected identity, source or clock does not silently transfer the factual attestation.
    const entry = visible.get(help.contributionId);
    if (!entry || !sameSource(entry, help) || entry.activityState !== "accepted" ||
      entry.contribution.qualification !== "eligible" ||
      entry.contribution.metricIds.length !== 1 ||
      !workstreamHelpMetricIds.some((id) => id === entry.contribution.metricIds[0])) continue;
    if ((selected.pendingEvidence ?? []).some((entry) => entry.contribution.contributionId === help.contributionId))
      return conflict();
    if (!entry.evidenceMetadata ||
      (entry.evidenceMetadata.activityState !== "accepted" || entry.evidenceMetadata.acceptedAt !== help.acceptedAt ||
        entry.evidenceMetadata.sourceOccurredAt !== help.statement.occurredAt)) return conflict();
    retained.push(help);
  }
  return retained;
}

/** Positive accepted events require no claim of complete historical coverage. */
export function acceptedWorkstreamHelp(
  read: PublicRead,
  actorId: string,
  category: string | null,
  definitions: readonly MetricDefinition[],
): WorkstreamHelpRecognition[] {
  if (read.selected.reviewedWorkstreamHelp === undefined)
    throw new PublicReadError(503, "workstream_help_unavailable");
  const actors = new Map(read.selected.actors
    .filter((entry) => entry.actor.kind === "user" && entry.actor.executionMode !== "automated")
    .map((entry) => [entry.actorId, entry.actor]));
  const aliases = new Map<string, string>();
  for (const [id, actor] of actors) {
    for (const key of [
      ...(actor.githubNodeId ? ["node:" + actor.githubNodeId] : []),
      ...(actor.githubDatabaseId !== undefined ? ["database:" + actor.githubDatabaseId] : []),
    ]) {
      if (aliases.has(key) && aliases.get(key) !== id) conflict();
      aliases.set(key, id);
    }
  }
  const known = new Set(definitions.map((entry) => entry.id));
  const evidence = new Map((read.selected.portfolioEvidence ?? [])
    .map((entry) => [entry.contribution.contributionId, entry]));
  const candidates: WorkstreamHelpRecognition[] = [];
  for (const help of read.selected.reviewedWorkstreamHelp) {
    const entry = evidence.get(help.contributionId);
    if (!entry || !actors.has(help.statement.actorId)) continue;
    const proof = achievementProofSchema.parse({
      contributionId: entry.contribution.contributionId,
      canonicalEventId: entry.contribution.canonicalEventId,
      actorId: entry.contribution.actorId,
      artifactId: entry.artifact.stableId,
      artifactKind: entry.artifact.kind,
      repositoryId: entry.artifact.repositoryId ?? null,
      sourceUrl: entry.artifact.publicUrl,
      roles: [...entry.contribution.roles],
      metricIds: [...entry.contribution.metricIds],
      occurredAt: entry.occurredAt,
      activityState: "accepted",
      qualification: "eligible",
    });
    if (proof.metricIds.some((id) => !known.has(id)) ||
      compareSourceInstants(proof.occurredAt, read.selected.snapshot.generatedAt) > 0) conflict();
    const parsed = workstreamHelpRecognitionSchema.safeParse({ label: "Reviewed cross-workstream help", help, proof });
    if (!parsed.success) conflict();
    if (proof.actorId === actorId && (category === null || proof.metricIds.includes(category)))
      candidates.push(parsed.data);
  }
  candidates.sort((a, b) =>
    compareSourceInstants(a.proof.occurredAt, b.proof.occurredAt) ||
    compareSourceInstants(a.help.reviewedAt, b.help.reviewedAt) ||
    compare(a.proof.contributionId, b.proof.contributionId));
  const units = new Map<string, WorkstreamHelpRecognition>();
  for (const entry of candidates) {
    const key = workstreamHelpUnit(entry.help);
    if (!units.has(key)) units.set(key, entry);
  }
  return [...units.values()];
}
