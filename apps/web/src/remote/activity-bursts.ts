import { compareSourceInstants, sourceEventSchema } from "@pick-your-ai/contracts";
import { activity, activityGroup, ReadFailure, type ActivityGroup, type Metadata, type Selection } from "./client.ts";

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
export interface ActivityBursts extends Metadata {
  bursts: ActivityBurst[];
  totalBursts: number;
  nextCursor: string | null;
}
export interface ActivityBurstDetail extends Metadata {
  burst: ActivityBurst;
  groups: ActivityGroup[];
  nextCursor: string | null;
}
const invalid = (): never => {
  throw new ReadFailure(502, "invalid_activity_burst_response");
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
};
const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 20000) return invalid();
  return value;
};
const clock = (value: unknown): string | null => {
  const parsed = sourceEventSchema.shape.occurredAt.safeParse(value);
  if (!parsed.success) return invalid();
  return parsed.data;
};
const nextCursor = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== "string" || !value) return invalid();
  return value;
};
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const newest = (a: string | null, b: string | null) => {
  if (a === null) return b === null ? 0 : 1;
  return b === null ? -1 : compareSourceInstants(b, a);
};
const sameInstant = (a: string | null, b: string | null) => newest(a, b) === 0;
function list(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) return invalid();
  return value;
}
function envelope(value: unknown, selected: Selection) {
  const data = record(value);
  if (data.compactionVersion !== "actor-state-utc-hour-v1" || data.groupPreviewLimit !== 5) return invalid();
  // Reuse the unchanged v1 envelope and publication/scope admission.
  const {
    groups: _groups,
    totalGroups: _total,
    nextCursor: _cursor,
    ...meta
  } = activity({ ...data, groups: [], totalGroups: 0, nextCursor: null }, selected);
  return { data, meta };
}
function member(group: ActivityGroup, burst: ActivityBurst) {
  const preview = burst.previewGroups.find(
    (item) => item.groupId === group.groupId || item.repositoryId === group.repositoryId,
  );
  if (
    group.actorId !== burst.actorId ||
    JSON.stringify(group.actor) !== JSON.stringify(burst.previewGroups[0]!.actor) ||
    group.activityState !== burst.activityState ||
    (preview !== undefined && JSON.stringify(preview) !== JSON.stringify(group)) ||
    (group.latestOccurredAt === null) !== (burst.latestOccurredAt === null) ||
    (group.latestOccurredAt !== null &&
      burst.latestOccurredAt !== null &&
      group.earliestOccurredAt !== null &&
      burst.earliestOccurredAt !== null &&
      (compareSourceInstants(group.latestOccurredAt, burst.latestOccurredAt) > 0 ||
        compareSourceInstants(group.earliestOccurredAt, burst.earliestOccurredAt) < 0)) ||
    group.categoryIds.some((id) => !burst.categoryIds.includes(id)) ||
    (group.firstCollectedAt !== null &&
      (burst.firstCollectedAt === null || compareSourceInstants(group.firstCollectedAt, burst.firstCollectedAt) < 0)) ||
    (group.lastCollectedAt !== null &&
      (burst.lastCollectedAt === null || compareSourceInstants(group.lastCollectedAt, burst.lastCollectedAt) > 0)) ||
    (burst.latestOccurredAt === null && group.groupId !== burst.previewGroups[0]!.groupId)
  )
    return invalid();
}
function members(groups: ActivityGroup[], burst: ActivityBurst) {
  if (
    groups.length > burst.groupCount ||
    new Set(groups.map((group) => group.groupId)).size !== groups.length ||
    new Set(groups.map((group) => group.repositoryId)).size !== groups.length ||
    groups.reduce((total, group) => total + group.unknownCollectionCount, 0) > burst.unknownCollectionCount
  )
    return invalid();
  groups.forEach((group, index) => {
    member(group, burst);
    if (index > 0) {
      const previous = groups[index - 1]!;
      if ((newest(previous.latestOccurredAt, group.latestOccurredAt) || compare(previous.groupId, group.groupId)) > 0)
        invalid();
    }
  });
  if (groups.length === burst.groupCount) {
    const starts = groups.map((group) => group.earliestOccurredAt).sort(newest);
    const collectedStarts = groups
      .map((group) => group.firstCollectedAt)
      .filter((value): value is string => value !== null)
      .sort(newest);
    const collectedEnds = groups
      .map((group) => group.lastCollectedAt)
      .filter((value): value is string => value !== null)
      .sort(newest);
    if (
      !sameInstant(burst.latestOccurredAt, groups[0]!.latestOccurredAt) ||
      !sameInstant(burst.earliestOccurredAt, starts.at(-1)!) ||
      !sameInstant(burst.firstCollectedAt, collectedStarts.at(-1) ?? null) ||
      !sameInstant(burst.lastCollectedAt, collectedEnds[0] ?? null) ||
      burst.unknownCollectionCount !== groups.reduce((total, group) => total + group.unknownCollectionCount, 0) ||
      JSON.stringify([...burst.categoryIds].sort()) !==
        JSON.stringify([...new Set(groups.flatMap((group) => group.categoryIds))].sort())
    )
      invalid();
  }
}
function decodeBurst(value: unknown, selected: Selection): ActivityBurst {
  const data = record(value);
  const previewGroups = list(data.previewGroups, 5).map((item) => activityGroup(item, selected));
  if (
    typeof data.burstId !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.burstId) ||
    !previewGroups.length ||
    data.actorId !== previewGroups[0]!.actorId ||
    data.activityState !== previewGroups[0]!.activityState
  )
    return invalid();
  const categoryIds = list(data.categoryIds, 98);
  if (
    !categoryIds.length ||
    categoryIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(id)) ||
    new Set(categoryIds).size !== categoryIds.length
  )
    return invalid();
  const burst: ActivityBurst = {
    burstId: data.burstId,
    actorId: previewGroups[0]!.actorId,
    activityState: previewGroups[0]!.activityState,
    latestOccurredAt: clock(data.latestOccurredAt),
    earliestOccurredAt: clock(data.earliestOccurredAt),
    firstCollectedAt: clock(data.firstCollectedAt),
    lastCollectedAt: clock(data.lastCollectedAt),
    unknownCollectionCount: count(data.unknownCollectionCount),
    groupCount: count(data.groupCount),
    categoryIds: categoryIds as string[],
    previewGroups,
  };
  if (
    burst.groupCount < 1 ||
    (selected.repository !== null && burst.groupCount !== 1) ||
    previewGroups.length !== Math.min(5, burst.groupCount) ||
    (burst.latestOccurredAt === null) !== (burst.earliestOccurredAt === null) ||
    (burst.firstCollectedAt === null) !== (burst.lastCollectedAt === null) ||
    (burst.groupCount > 1 && burst.latestOccurredAt === null) ||
    (burst.latestOccurredAt !== null &&
      burst.earliestOccurredAt !== null &&
      (compareSourceInstants(burst.earliestOccurredAt, burst.latestOccurredAt) > 0 ||
        Math.floor(Date.parse(burst.earliestOccurredAt) / 3600000) !==
          Math.floor(Date.parse(burst.latestOccurredAt) / 3600000))) ||
    (burst.firstCollectedAt !== null &&
      burst.lastCollectedAt !== null &&
      compareSourceInstants(burst.firstCollectedAt, burst.lastCollectedAt) > 0) ||
    (selected.start !== null &&
      (burst.earliestOccurredAt === null || compareSourceInstants(burst.earliestOccurredAt, selected.start) < 0)) ||
    (selected.end !== null &&
      (burst.latestOccurredAt === null || compareSourceInstants(burst.latestOccurredAt, selected.end) >= 0)) ||
    !sameInstant(burst.latestOccurredAt, previewGroups[0]!.latestOccurredAt)
  )
    return invalid();
  members(previewGroups, burst);
  return burst;
}
export function activityBursts(value: unknown, selected: Selection): ActivityBursts {
  const { data, meta } = envelope(value, selected);
  const bursts = list(data.bursts, Number(selected.limit)).map((item) => decodeBurst(item, selected));
  const totalBursts = count(data.totalBursts);
  const cursor = nextCursor(data.nextCursor);
  const groupIds = bursts.flatMap((burst) => burst.previewGroups.map((group) => group.groupId));
  const keys = bursts.map((burst) =>
    JSON.stringify(
      burst.latestOccurredAt === null
        ? ["unknown", burst.previewGroups[0]!.groupId]
        : [burst.actorId, burst.activityState, Math.floor(Date.parse(burst.latestOccurredAt) / 3600000)],
    ),
  );
  if (
    totalBursts < bursts.length ||
    (bursts.length === totalBursts && cursor !== null) ||
    (selected.cursor === null &&
      ((bursts.length === 0) !== (totalBursts === 0) || (cursor === null && bursts.length !== totalBursts))) ||
    bursts.reduce((total, burst) => total + burst.groupCount, 0) > 20000 ||
    new Set(bursts.map((burst) => burst.burstId)).size !== bursts.length ||
    new Set(groupIds).size !== groupIds.length ||
    new Set(keys).size !== keys.length
  )
    return invalid();
  const actors = new Map<string, string>();
  bursts.forEach((burst, index) => {
    const identity = JSON.stringify(burst.previewGroups[0]!.actor);
    if (actors.has(burst.actorId) && actors.get(burst.actorId) !== identity) invalid();
    actors.set(burst.actorId, identity);
    if (index > 0) {
      const previous = bursts[index - 1]!;
      if ((newest(previous.latestOccurredAt, burst.latestOccurredAt) || compare(previous.burstId, burst.burstId)) > 0)
        invalid();
    }
  });
  return { ...meta, bursts, totalBursts, nextCursor: cursor };
}
export function activityBurstDetail(value: unknown, selected: Selection): ActivityBurstDetail {
  const { data, meta } = envelope(value, selected);
  const burst = decodeBurst(data.burst, selected);
  const groups = list(data.groups, Number(selected.limit)).map((item) => activityGroup(item, selected));
  const cursor = nextCursor(data.nextCursor);
  if (
    !groups.length ||
    (groups.length === burst.groupCount && cursor !== null) ||
    (selected.cursor === null &&
      ((cursor === null && groups.length !== burst.groupCount) ||
        JSON.stringify(groups.slice(0, 5)) !==
          JSON.stringify(burst.previewGroups.slice(0, Math.min(5, groups.length)))))
  )
    return invalid();
  members(groups, burst);
  return { ...meta, burst, groups, nextCursor: cursor };
}
