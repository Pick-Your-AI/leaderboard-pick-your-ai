import registryJson from "./registry.json" with { type: "json" };
import { metricRegistrySchema, type MetricRegistry, type SourceEvent } from "@pick-your-ai/contracts";

export const metricRegistryV1: MetricRegistry = metricRegistrySchema.parse(registryJson);
export const metricDefinitionsV1 = metricRegistryV1.metrics;

export function getMetricDefinition(metricId: string) {
  return metricDefinitionsV1.find((metric) => metric.id === metricId);
}

export type CanonicalizationResult =
  | {
      state: "canonical";
      dedupeKey: string;
      observationIds: string[];
      observations: SourceEvent[];
    }
  | {
      state: "ambiguous" | "unknown";
      dedupeKey: string | null;
      observationIds: string[];
      observations: SourceEvent[];
    };

function stableActorId(event: SourceEvent): string | null {
  if (event.actor.identityState !== "resolved") return null;
  return (
    event.actor.githubNodeId ??
    (event.actor.githubDatabaseId === undefined ? null : String(event.actor.githubDatabaseId))
  );
}

function semanticSignature(event: SourceEvent): string | null {
  const actorId = stableActorId(event);
  const subjectId = event.subject.stableId;
  if (!actorId || !subjectId || event.occurredAt === null) return null;
  return JSON.stringify([event.action, actorId, event.role, subjectId, event.occurredAt]);
}

/**
 * Join only events with an explicit source dedupe key and matching semantic
 * identity. Missing keys remain unknown; conflicting matches remain ambiguous.
 */
export function canonicalizeObservations(events: readonly SourceEvent[]): CanonicalizationResult[] {
  const keyed = new Map<string, SourceEvent[]>();
  const unkeyed: SourceEvent[] = [];
  for (const event of events) {
    if (!event.dedupeKey) {
      unkeyed.push(event);
      continue;
    }
    const group = keyed.get(event.dedupeKey) ?? [];
    group.push(event);
    keyed.set(event.dedupeKey, group);
  }

  const results: CanonicalizationResult[] = [];
  for (const [dedupeKey, group] of keyed) {
    const ordered = [...group].sort((a, b) => a.eventId.localeCompare(b.eventId));
    const signatures = ordered.map(semanticSignature);
    const sameKnownSemantics = signatures.every((signature) => signature !== null) && new Set(signatures).size === 1;
    results.push({
      state: sameKnownSemantics ? "canonical" : "ambiguous",
      dedupeKey,
      observationIds: [...new Set(ordered.flatMap((event) => event.observationIds))].sort(),
      observations: ordered,
    });
  }

  for (const event of unkeyed) {
    results.push({
      state: "unknown",
      dedupeKey: null,
      observationIds: [...event.observationIds],
      observations: [event],
    });
  }

  return results.sort((a, b) =>
    (a.dedupeKey ?? a.observationIds[0] ?? "").localeCompare(b.dedupeKey ?? b.observationIds[0] ?? ""),
  );
}
