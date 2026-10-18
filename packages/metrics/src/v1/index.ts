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

type ProviderIdentity = ["node", string] | ["database", number];

function actorIdentities(event: SourceEvent): ProviderIdentity[] {
  if (event.actor.identityState !== "resolved") return [];
  const identities: ProviderIdentity[] = [];
  if (event.actor.githubNodeId !== undefined) identities.push(["node", event.actor.githubNodeId]);
  if (event.actor.githubDatabaseId !== undefined) identities.push(["database", event.actor.githubDatabaseId]);
  return identities;
}

/** Validate only explicit resolved bindings in this batch; never join event keys or create aliases. */
function conflictingActorIdentities(events: readonly SourceEvent[]): Set<string> {
  const bindings = new Map<
    string,
    { namespace: ProviderIdentity[0]; neighbors: Set<string>; kinds: Set<SourceEvent["actor"]["kind"]> }
  >();
  for (const event of events) {
    const identities = actorIdentities(event);
    for (const identity of identities) {
      const key = JSON.stringify(identity);
      const binding = bindings.get(key) ?? { namespace: identity[0], neighbors: new Set(), kinds: new Set() };
      for (const peer of identities) {
        const peerKey = JSON.stringify(peer);
        if (peerKey !== key) binding.neighbors.add(peerKey);
      }
      if (event.actor.kind !== "unknown") binding.kinds.add(event.actor.kind);
      bindings.set(key, binding);
    }
  }

  const visited = new Set<string>();
  const conflicting = new Set<string>();
  for (const start of bindings.keys()) {
    if (visited.has(start)) continue;
    const pending = [start];
    const component: string[] = [];
    const kinds = new Set<SourceEvent["actor"]["kind"]>();
    let nodeCount = 0;
    let databaseCount = 0;
    while (pending.length > 0) {
      const key = pending.pop()!;
      if (visited.has(key)) continue;
      visited.add(key);
      component.push(key);
      const binding = bindings.get(key)!;
      if (binding.namespace === "node") nodeCount += 1;
      else databaseCount += 1;
      for (const kind of binding.kinds) kinds.add(kind);
      for (const neighbor of binding.neighbors) if (!visited.has(neighbor)) pending.push(neighbor);
    }
    if (nodeCount > 1 || databaseCount > 1 || kinds.size > 1) {
      for (const key of component) conflicting.add(key);
    }
  }
  return conflicting;
}

function semanticSignature(event: SourceEvent): string | null {
  const actorId = actorIdentities(event)[0];
  const subjectId = event.subject.stableId;
  if (!actorId || !subjectId || event.occurredAt === null) return null;
  return JSON.stringify([event.action, actorId, event.role, subjectId, event.occurredAt]);
}

/**
 * Join only events with an explicit source dedupe key and matching semantic
 * identity. Missing keys remain unknown; conflicting matches remain ambiguous.
 */
export function canonicalizeObservations(events: readonly SourceEvent[]): CanonicalizationResult[] {
  const conflictingIdentities = conflictingActorIdentities(events);
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
    const sameKnownSemantics =
      signatures.every((signature) => signature !== null) &&
      new Set(signatures).size === 1 &&
      ordered.every((event) =>
        actorIdentities(event).every((identity) => !conflictingIdentities.has(JSON.stringify(identity))),
      );
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
