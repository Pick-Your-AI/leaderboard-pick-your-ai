import { createHash } from "node:crypto";
import { newest, type ActivityGroup, type ActivityIndex } from "./activity.js";

/** Additive presentation wrappers; the original activity groups and proof IDs are unchanged. */
export const activityCompactionVersion = "actor-state-utc-hour-v1";
export const activityGroupPreviewLimit = 5;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface ActivityBurst {
  burstId: string;
  actorId: string;
  activityState: ActivityGroup["activityState"];
  latestOccurredAt: string | null;
  earliestOccurredAt: string | null;
  firstCollectedAt: string | null;
  lastCollectedAt: string | null;
  unknownCollectionCount: number;
  groupCount: number;
  categoryIds: string[];
  previewGroups: ActivityGroup[];
}

/** Compact only the already authorized, bounded publication; never scan or fetch source history. */
export function activityBurstIndex(index: ActivityIndex) {
  const members = new Map<string, ActivityGroup[]>();
  for (const group of index.groups) {
    const key =
      group.latestOccurredAt === null
        ? [activityCompactionVersion, "unknown", group.groupId]
        : [
            activityCompactionVersion,
            group.actorId,
            group.activityState,
            Math.floor(Date.parse(group.latestOccurredAt) / 3_600_000),
          ];
    const burstId = createHash("sha256").update(JSON.stringify(key)).digest("hex");
    const groups = members.get(burstId) ?? [];
    groups.push(group);
    members.set(burstId, groups);
  }
  const bursts = [...members].map(([burstId, groups]): ActivityBurst => {
    groups.sort((a, b) => newest(a.latestOccurredAt, b.latestOccurredAt) || compare(a.groupId, b.groupId));
    const first = groups[0]!;
    const actionStarts = groups.map((group) => group.earliestOccurredAt).sort(newest);
    const collectionStarts = groups
      .map((group) => group.firstCollectedAt)
      .filter((value): value is string => value !== null)
      .sort(newest);
    const collectionEnds = groups
      .map((group) => group.lastCollectedAt)
      .filter((value): value is string => value !== null)
      .sort(newest);
    return {
      burstId,
      actorId: first.actorId,
      activityState: first.activityState,
      latestOccurredAt: first.latestOccurredAt,
      earliestOccurredAt: actionStarts.at(-1)!,
      firstCollectedAt: collectionStarts.at(-1) ?? null,
      lastCollectedAt: collectionEnds[0] ?? null,
      unknownCollectionCount: groups.reduce((count, group) => count + group.unknownCollectionCount, 0),
      groupCount: groups.length,
      categoryIds: [...new Set(groups.flatMap((group) => group.categoryIds))].sort(),
      previewGroups: groups.slice(0, activityGroupPreviewLimit),
    };
  });
  bursts.sort((a, b) => newest(a.latestOccurredAt, b.latestOccurredAt) || compare(a.burstId, b.burstId));
  return { bursts, members };
}
