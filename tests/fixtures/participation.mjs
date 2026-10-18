// Synthetic public evidence only; no real history, approval or contributor data.
import { readFixture } from "./pending-metric.mjs";
export const participationStart = "2026-10-04T00:00:00.000Z";
export const participationEnd = "2026-10-19T00:00:00.000Z";
export function participationFixture() {
  const read = readFixture();
  Object.assign(read.selected.scope, { start: participationStart, end: participationEnd });
  read.selected.snapshot.generatedAt = participationEnd;
  read.head.publishedAt = participationEnd;
  Object.assign(read.selected.snapshot.coverage[0], {
    state: "complete",
    knownStart: participationStart,
    windowStart: participationStart,
    windowEnd: participationEnd,
    sourceWatermark: participationEnd,
    lastSuccessfulSync: participationEnd,
  });
  for (const row of read.selected.rows) row.result.state = "measured";
  const entries = read.selected.evidence.filter((entry) => entry.contribution.actorId === "101");
  entries[0].occurredAt = "2026-10-04T23:59:59.999999999Z";
  entries[1].occurredAt = "2026-10-05T00:00:00Z";
  entries[2].occurredAt = "2026-10-12T00:00:00Z";
  entries[0].evidenceMetadata = {
    schemaVersion: "leaderboard-evidence/v1",
    artifactTitle: null,
    sourceAction: "pull_request_merged",
    sourceOccurredAt: entries[0].occurredAt,
    observedAt: "2026-10-17T11:59:59.123456789Z",
    activityState: "observed",
    acceptedAt: null,
    history: { coverage: "not_supplied", records: [] },
  };
  return read;
}
