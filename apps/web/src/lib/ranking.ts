/**
 * Dense shared ranks: 1, =2, =2, 3. Display order inside a tie uses a stable
 * key and carries no rank or credit effect.
 */
export interface Ranked<T> {
  rank: number;
  tied: boolean;
  item: T;
}

export function denseRank<T>(
  items: readonly T[],
  value: (item: T) => number,
  tieKey: (item: T) => string,
): Ranked<T>[] {
  const ordered = [...items].sort((a, b) => value(b) - value(a) || tieKey(a).localeCompare(tieKey(b), "en"));
  const counts = new Map<number, number>();
  for (const item of ordered) counts.set(value(item), (counts.get(value(item)) ?? 0) + 1);

  const ranked: Ranked<T>[] = [];
  let rank = 0;
  let previous: number | undefined;
  for (const item of ordered) {
    const current = value(item);
    if (current !== previous) {
      rank += 1;
      previous = current;
    }
    ranked.push({ rank, tied: (counts.get(current) ?? 0) > 1, item });
  }
  return ranked;
}

/**
 * Cut a ranked list after `limit` rows, extending the cut so that a tie at the
 * boundary is never split. Returns the rows shown and how many remain.
 */
export function cutWithTies<T extends { rank: number }>(
  ranked: readonly T[],
  limit: number,
): {
  shown: T[];
  remaining: number;
} {
  if (ranked.length <= limit) return { shown: [...ranked], remaining: 0 };
  const boundary = ranked[limit - 1]!.rank;
  let end = limit;
  while (end < ranked.length && ranked[end]!.rank === boundary) end += 1;
  return { shown: ranked.slice(0, end), remaining: ranked.length - end };
}

export function formatRank(entry: { rank: number; tied: boolean }): string {
  return entry.tied ? `=${entry.rank}` : String(entry.rank);
}
