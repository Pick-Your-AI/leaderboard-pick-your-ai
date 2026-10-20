import {
  compareSourceInstants,
  relationshipPairKey,
  relationshipPairSchema,
  type RelationshipPair,
} from "@pick-your-ai/contracts";
import type { AuditEntry, MetricFact } from "./engine.js";

export const relationshipPairMetricIds = new Set(["reference_links", "closing_links"]);

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

export function relationshipPairMembership(context: MetricFact["eventContext"]): MetricFact["eventContext"] {
  if (context == null) return context;
  return {
    ...context,
    projects: [...context.projects].sort(),
    workstreams: [...context.workstreams].sort(),
    ...(context.projectScope === undefined ? {} : { projectScope: [...context.projectScope].sort() }),
    ...(context.workstreamScope === undefined ? {} : { workstreamScope: [...context.workstreamScope].sort() }),
  };
}

/**
 * Conserve the first supported pair in the frozen authorized known history.
 * Completeness is a separate coverage claim; no global-origin proof is required.
 * Call after event revision/canonical checks, before actor/context/date filtering.
 */
export function conserveRelationshipPairs(
  facts: readonly MetricFact[],
  rejectedEvents: readonly MetricFact[],
  repositoryIds: readonly string[],
  admittedRevisions: readonly MetricFact[],
): { facts: MetricFact[]; audit: AuditEntry[] } {
  const audit: AuditEntry[] = [];
  const reject = (items: readonly MetricFact[], reason: string) => {
    if (items.length)
      audit.push({
        factIds: [...new Set(items.map((fact) => fact.id))].sort(),
        actorId: items.every((fact) => fact.actorId === items[0]!.actorId) ? items[0]!.actorId : null,
        reason,
      });
  };
  const bindings = new Map<MetricFact, { pair: RelationshipPair; key: string }>();
  const events = new Map<string, MetricFact[]>();
  const remember = (fact: MetricFact, binding: { pair: RelationshipPair; key: string }) => {
    bindings.set(fact, binding);
    const event = events.get(binding.pair.eventId) ?? [];
    event.push(fact);
    events.set(binding.pair.eventId, event);
  };
  const read = (fact: MetricFact) => {
    const parsed = relationshipPairSchema.safeParse(fact.relationshipPair);
    if (!parsed.success) return null;
    const pair = parsed.data;
    if (
      fact.metricId !== (pair.kind === "reference" ? "reference_links" : "closing_links") ||
      ![pair.from, pair.to].some(
        (endpoint) => endpoint.artifactId === fact.artifactId && endpoint.repositoryId === fact.repoId,
      )
    )
      return null;
    return { pair, key: relationshipPairKey(pair) };
  };
  const groups = new Map<string, MetricFact[]>();
  const unboundCurrent: MetricFact[] = [];
  for (const fact of facts) {
    const binding = read(fact);
    if (!binding) {
      reject([fact], "relationship_pair_unverified");
      unboundCurrent.push(fact);
      continue;
    }
    // This is source authorization, not the caller's narrower display filter.
    if (![binding.pair.from, binding.pair.to].every((endpoint) => repositoryIds.includes(endpoint.repositoryId))) {
      reject([fact], "relationship_pair_repository_unavailable");
      unboundCurrent.push(fact);
      continue;
    }
    remember(fact, binding);
    if (binding.pair.action === "disconnect") {
      reject([fact], "relationship_disconnect");
      continue;
    }
    const group = groups.get(binding.key) ?? [];
    group.push(fact);
    groups.set(binding.key, group);
  }
  const blocked = new Map<string, MetricFact[]>();
  const unresolvedRevisions = new Map<string, MetricFact[]>();
  const resolvedRevision = new Map<string, number>();
  const admittedById = new Map<string, MetricFact[]>();
  for (const fact of bindings.keys()) {
    resolvedRevision.set(fact.id, Math.max(resolvedRevision.get(fact.id) ?? -1, fact.revision));
    const admitted = admittedById.get(fact.id) ?? [];
    admitted.push(fact);
    admittedById.set(fact.id, admitted);
  }
  for (const fact of rejectedEvents) {
    // An admitted later reviewed revision resolves this same fact's older
    // rejected value. It does not resolve another ID or a newer ambiguity.
    if ((resolvedRevision.get(fact.id) ?? -1) > fact.revision) continue;
    // An unresolved same/newer revision can remove or change its own pair
    // descriptor or clock. Withhold the already bound unit through that fact
    // identity; do not invent a new endpoint/event binding for the rejection.
    for (const admitted of admittedById.get(fact.id) ?? []) {
      const key = bindings.get(admitted)!.key;
      const failures = unresolvedRevisions.get(key) ?? [];
      failures.push(fact);
      unresolvedRevisions.set(key, failures);
    }
    const binding = read(fact);
    if (
      !binding ||
      ![binding.pair.from, binding.pair.to].every((endpoint) => repositoryIds.includes(endpoint.repositoryId))
    )
      continue;
    remember(fact, binding);
    if (binding.pair.action === "disconnect") continue;
    const group = blocked.get(binding.key) ?? [];
    group.push(fact);
    blocked.set(binding.key, group);
  }
  // Revision selection may replace a once-bound fact with a reviewed but
  // unbound current value. Retain prior admitted bindings only as uncertainty:
  // never restore their credit or promote a later event past their known clock.
  // A properly bound, authorized admitted correction does not enter this path.
  const historyById = new Map<string, MetricFact[]>();
  for (const prior of admittedRevisions) {
    const history = historyById.get(prior.id) ?? [];
    history.push(prior);
    historyById.set(prior.id, history);
  }
  const unresolvedById = new Map<string, Map<string, number>>();
  for (const unresolved of [...unboundCurrent, ...rejectedEvents]) {
    if ((resolvedRevision.get(unresolved.id) ?? -1) > unresolved.revision) continue;
    const revisions = unresolvedById.get(unresolved.id) ?? new Map<string, number>();
    revisions.set(unresolved.metricId, Math.max(revisions.get(unresolved.metricId) ?? -1, unresolved.revision));
    unresolvedById.set(unresolved.id, revisions);
  }
  for (const [id, revisions] of unresolvedById) {
    for (const prior of historyById.get(id) ?? []) {
      const revision = revisions.get(prior.metricId);
      if (revision === undefined || prior.revision >= revision) continue;
      const binding = read(prior);
      if (
        !binding ||
        binding.pair.action === "disconnect" ||
        ![binding.pair.from, binding.pair.to].every((endpoint) => repositoryIds.includes(endpoint.repositoryId))
      )
        continue;
      const failures = blocked.get(binding.key) ?? [];
      failures.push(prior);
      blocked.set(binding.key, failures);
    }
  }
  for (const views of events.values()) {
    const first = views[0]!;
    const expected = bindings.get(first)!;
    if (
      views.every((fact) => {
        const actual = bindings.get(fact)!;
        return (
          actual.key === expected.key &&
          actual.pair.action === expected.pair.action &&
          fact.actorId === first.actorId &&
          (fact.occurredAt === null || first.occurredAt === null
            ? fact.occurredAt === first.occurredAt
            : compareSourceInstants(fact.occurredAt, first.occurredAt) === 0)
        );
      })
    )
      continue;
    reject(views, "ambiguous_relationship_event");
    for (const fact of views) {
      const key = bindings.get(fact)!.key;
      const failures = blocked.get(key) ?? [];
      failures.push(fact);
      blocked.set(key, failures);
    }
  }
  const retained: MetricFact[] = [];
  for (const [key, group] of groups) {
    // A known event without a clock may precede every timestamped observation.
    // It cannot be replaced by a convenient later actor or period.
    if (group.some((fact) => fact.occurredAt === null)) {
      reject(group, "ambiguous_relationship_pair");
      continue;
    }
    const ordered = [...group].sort(
      (a, b) => compareSourceInstants(a.occurredAt!, b.occurredAt!) || a.id.localeCompare(b.id),
    );
    const first = ordered[0]!;
    const earlierFailures = [
      ...(unresolvedRevisions.get(key) ?? []),
      ...(blocked.get(key) ?? []).filter(
        (fact) => fact.occurredAt === null || compareSourceInstants(fact.occurredAt, first.occurredAt!) <= 0,
      ),
    ];
    if (earlierFailures.length) {
      reject([...group, ...earlierFailures], "ambiguous_relationship_pair");
      continue;
    }
    const earliest = ordered.filter((fact) => compareSourceInstants(fact.occurredAt!, first.occurredAt!) === 0);
    const meaning = (fact: MetricFact) =>
      stable([
        fact.actorId,
        fact.repoId,
        fact.role,
        fact.state,
        relationshipPairMembership(fact.eventContext),
        relationshipPairMembership(fact.currentContext),
        fact.acceptedAt,
        fact.acceptedBy,
        fact.acceptanceReceipt,
      ]);
    // A mirror may use either verified endpoint as its evidence view. It may
    // not silently choose a different repository, participant or membership.
    if (first.actorId === null || new Set(earliest.map(meaning)).size !== 1) {
      reject(group, "ambiguous_relationship_pair");
      continue;
    }
    retained.push(first);
    reject(ordered.slice(1), "repeated_relationship_pair");
  }
  return { facts: retained, audit };
}
