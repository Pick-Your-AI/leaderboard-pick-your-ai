import { createHash } from "node:crypto";
import { PublicReadError, type PortfolioEvidence, type PublicRead } from "./public-source.js";

/** Versioned, reversible display policy. These buckets are not metric aggregates. */
export const activityGroupingVersion = "actor-repository-state-utc-hour-v1";
export const activityPreviewLimit = 5;
export const activityPageByteLimit = 1_000_000;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stamp = (value: string | null) => (value === null ? -Infinity : Date.parse(value));
export const newest = (a: string | null, b: string | null) => {
  const left = stamp(a),
    right = stamp(b);
  return left === right ? 0 : left > right ? -1 : 1;
};
export function publicPortfolio(read: PublicRead, category: string | null): PortfolioEvidence[] {
  // Legacy eligibility never implies acceptance or a retained collection clock.
  const entries =
    read.selected.portfolioEvidence ??
    read.selected.evidence.map((entry) => ({
      ...entry,
      activityState: "unknown" as const,
      observedAt: null,
    }));
  return entries.filter(
    (entry) =>
      !entry.contribution.roles.includes("unknown") &&
      (category === null || entry.contribution.metricIds.includes(category)),
  );
}
interface Fact {
  id: string;
  representative: PortfolioEvidence;
  proofs: PortfolioEvidence[];
}
export interface ActivityProof extends PortfolioEvidence {
  canonicalFactId: string;
}
export interface ActivityGroup {
  groupId: string;
  actorId: string;
  actor: PublicRead["selected"]["actors"][number]["actor"];
  repositoryId: string | null;
  activityState: PortfolioEvidence["activityState"];
  latestOccurredAt: string | null;
  earliestOccurredAt: string | null;
  firstCollectedAt: string | null;
  lastCollectedAt: string | null;
  unknownCollectionCount: number;
  artifactCount: number;
  factCount: number;
  proofCount: number;
  categoryIds: string[];
  artifactPreview: { artifactId: string; kind: PortfolioEvidence["artifact"]["kind"]; publicUrl: string }[];
}
export interface ActivityIndex {
  groups: ActivityGroup[];
  proofs: Map<string, ActivityProof[]>;
}

/** Only call after projectRead: no inbox events, identity guesses or ranking rows enter this index. */
export function activityIndex(read: PublicRead, category: string | null): ActivityIndex {
  const facts = new Map<string, Fact>();
  const metricStates = new Map<string, PortfolioEvidence["activityState"]>();
  // Merge identical canonical facts across metric representations. All original proof IDs remain
  // available in bounded detail pages; proof multiplicity is never presented as additional work.
  for (const entry of publicPortfolio(read, category)) {
    const id = digest([entry.contribution.canonicalEventId, entry.contribution.artifactId, entry.contribution.actorId]);
    // Acceptance belongs to the metric policy, not the source event globally. One source fact
    // can legitimately be observed under one policy and accepted under another. Preserve both
    // explicit states without double-counting representations inside either group.
    for (const metricId of category === null ? entry.contribution.metricIds : [category]) {
      const key = JSON.stringify([id, metricId]);
      const priorState = metricStates.get(key);
      if (priorState !== undefined && priorState !== entry.activityState)
        throw new PublicReadError(503, "activity_fact_conflict");
      metricStates.set(key, entry.activityState);
    }
    const stateKey = JSON.stringify([id, entry.activityState]);
    const prior = facts.get(stateKey);
    if (prior) {
      const previous = prior.representative;
      if (
        stamp(previous.occurredAt) !== stamp(entry.occurredAt) ||
        JSON.stringify(previous.artifact) !== JSON.stringify(entry.artifact)
      )
        throw new PublicReadError(503, "activity_fact_conflict");
      prior.proofs.push(entry);
    } else facts.set(stateKey, { id, representative: entry, proofs: [entry] });
  }
  const actors = new Map(read.selected.actors.map((entry) => [entry.actorId, entry.actor]));
  const buckets = new Map<string, Fact[]>();
  for (const fact of facts.values()) {
    fact.proofs.sort((a, b) => compare(a.contribution.contributionId, b.contribution.contributionId));
    fact.representative = fact.proofs[0]!;
    const entry = fact.representative;
    const bucket =
      entry.occurredAt === null
        ? ["unknown", entry.contribution.artifactId]
        : ["utc-hour", Math.floor(Date.parse(entry.occurredAt) / 3_600_000)];
    const groupId = digest([
      activityGroupingVersion,
      entry.contribution.actorId,
      entry.artifact.repositoryId ?? null,
      entry.activityState,
      bucket,
    ]);
    const grouped = buckets.get(groupId) ?? [];
    grouped.push(fact);
    buckets.set(groupId, grouped);
  }
  const proofs = new Map<string, ActivityProof[]>();
  const groups = [...buckets]
    .map(([groupId, grouped]): ActivityGroup => {
      grouped.sort((a, b) => newest(a.representative.occurredAt, b.representative.occurredAt) || compare(a.id, b.id));
      const first = grouped[0]!.representative;
      const entries = grouped.flatMap((fact) =>
        fact.proofs.map((entry) => ({
          ...entry,
          contribution: {
            ...entry.contribution,
            metricIds: [...new Set(entry.contribution.metricIds)].sort(),
            roles: [...new Set(entry.contribution.roles)].sort(),
            // Legacy provider reason strings are not a public correction narrative.
            reasonCodes: [`public_${entry.activityState}_work`],
          },
          canonicalFactId: fact.id,
        })),
      );
      proofs.set(groupId, entries);
      const artifacts = new Map<string, PortfolioEvidence["artifact"]>();
      for (const fact of grouped)
        artifacts.set(fact.representative.contribution.artifactId!, fact.representative.artifact);
      const collected = entries
        .map((entry) => entry.observedAt)
        .filter((value): value is string => value !== null)
        .sort((a, b) => newest(a, b));
      return {
        groupId,
        actorId: first.contribution.actorId!,
        actor: actors.get(first.contribution.actorId!)!,
        repositoryId: first.artifact.repositoryId ?? null,
        activityState: first.activityState,
        latestOccurredAt: first.occurredAt,
        earliestOccurredAt: grouped.at(-1)!.representative.occurredAt,
        firstCollectedAt: collected.at(-1) ?? null,
        lastCollectedAt: collected[0] ?? null,
        unknownCollectionCount: entries.filter((entry) => entry.observedAt === null).length,
        artifactCount: artifacts.size,
        factCount: grouped.length,
        proofCount: entries.length,
        categoryIds: [...new Set(entries.flatMap((entry) => entry.contribution.metricIds))].sort(),
        artifactPreview: [...artifacts].slice(0, activityPreviewLimit).map(([artifactId, artifact]) => ({
          artifactId,
          kind: artifact.kind,
          publicUrl: artifact.publicUrl!,
        })),
      };
    })
    .sort((a, b) => newest(a.latestOccurredAt, b.latestOccurredAt) || compare(a.groupId, b.groupId));
  return { groups, proofs };
}
