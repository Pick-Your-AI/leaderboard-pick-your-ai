import { createHash } from "node:crypto";
import type { Envelope } from "./webhook.js";

/** Internal candidate format, separate from research and proposed public contracts. */
export interface Transition {
  version: "transition/v1";
  eventId: string;
  objectId: string;
  facet: string;
  value: string | null;
  occurredAt: string | null;
  observedAt: string;
  effectiveAt: string | null;
  evidenceIds: string[];
  afterEventIds: string[];
  supersedesEventIds: string[];
}

export interface FacetState {
  objectId: string;
  facet: string;
  state: "known" | "ambiguous" | "incomplete" | "conflicted";
  value: string | null;
  candidateEventIds: string[];
  reasonCodes: string[];
}

export interface ReplayResult {
  version: "transition-replay/v1";
  scope: "supplied_events_only";
  events: Transition[];
  facets: FacetState[];
  digest: string;
}

const fields = new Set([
  "version",
  "eventId",
  "objectId",
  "facet",
  "value",
  "occurredAt",
  "observedAt",
  "effectiveAt",
  "evidenceIds",
  "afterEventIds",
  "supersedesEventIds",
]);
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
function invalid(): never {
  throw new Error("invalid_transition");
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_:./=+-]{1,256}$/.test(value)) invalid();
  return value;
}
function time(value: unknown, nullable = true): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) invalid();
  const canonical = date.toISOString();
  if (canonical !== value && canonical.replace(".000Z", "Z") !== value) invalid();
  return canonical;
}
function ids(value: unknown, required = false): string[] {
  if (!Array.isArray(value) || value.length > 32 || (required && value.length === 0)) invalid();
  return [...new Set(Array.from(value, id))].sort(compare);
}

function parse(raw: unknown): Transition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const data = raw as Record<string, unknown>;
  if (Object.keys(data).some((key) => !fields.has(key)) || data.version !== "transition/v1") invalid();
  const eventId = id(data.eventId);
  const afterEventIds = ids(data.afterEventIds);
  const supersedesEventIds = ids(data.supersedesEventIds);
  if (afterEventIds.includes(eventId) || supersedesEventIds.includes(eventId)) invalid();
  return {
    version: "transition/v1",
    eventId,
    objectId: id(data.objectId),
    facet: id(data.facet),
    value: data.value === null ? null : id(data.value),
    occurredAt: time(data.occurredAt),
    observedAt: time(data.observedAt, false)!,
    effectiveAt: time(data.effectiveAt),
    evidenceIds: ids(data.evidenceIds, true),
    afterEventIds,
    supersedesEventIds,
  };
}

/** Receipt normalization does not assert event uniqueness, ordering, or qualification. */
export function transitionFromDelivery(envelope: Envelope, observedAt: string): Transition | null {
  if (!envelope || envelope.version !== "github-delivery/v1") throw new Error("unsupported_delivery_version");
  if (
    (envelope.event !== "issues" && envelope.event !== "pull_request") ||
    !Number.isSafeInteger(envelope.repositoryId) ||
    envelope.repositoryId < 1 ||
    typeof envelope.subjectId !== "string" ||
    !/^[A-Za-z0-9_=-]{1,200}$/.test(envelope.subjectId)
  )
    invalid();
  if (envelope.action !== "opened" && envelope.action !== "closed" && envelope.action !== "reopened") return null;
  return parse({
    version: "transition/v1",
    eventId: `github:delivery:${envelope.deliveryId}`,
    objectId: `github:repository:${envelope.repositoryId}:subject:${envelope.subjectId}`,
    facet: "lifecycle",
    value: envelope.action === "closed" ? "closed" : "open",
    occurredAt: envelope.occurredAt,
    observedAt,
    // Lifecycle transitions take effect at their action time when that time is known.
    effectiveAt: envelope.occurredAt,
    evidenceIds: [`github:delivery:${envelope.deliveryId}`],
    afterEventIds: [],
    supersedesEventIds: [],
  });
}

function key(event: Transition): string {
  return JSON.stringify([event.objectId, event.facet]);
}

function reconcile(events: Transition[], all: Map<string, Transition>): FacetState {
  const first = events[0]!;
  const reasons = new Set<string>();
  const members = new Map(events.map((event) => [event.eventId, event]));
  const corrections = new Map(events.map((event) => [event.eventId, new Set<string>()]));
  const checkReference = (reference: string): boolean => {
    const target = all.get(reference);
    if (!target) {
      reasons.add("missing_reference");
      return false;
    }
    if (key(target) !== key(first)) {
      reasons.add("cross_facet_reference");
      return false;
    }
    return true;
  };
  for (const event of events) {
    for (const reference of event.supersedesEventIds) {
      if (checkReference(reference)) corrections.get(reference)!.add(event.eventId);
    }
    for (const reference of event.afterEventIds) checkReference(reference);
  }
  // A correction replaces an assertion in its logical history slot. Redirect
  // explicit predecessor references through correction chains, not arrival time.
  const terminals = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const resolve = (eventId: string): Set<string> => {
    const cached = terminals.get(eventId);
    if (cached) return cached;
    if (visiting.has(eventId)) {
      reasons.add("correction_cycle");
      return new Set();
    }
    visiting.add(eventId);
    const next = corrections.get(eventId)!;
    const result = new Set<string>();
    if (next.size === 0) result.add(eventId);
    else for (const successor of next) for (const terminal of resolve(successor)) result.add(terminal);
    visiting.delete(eventId);
    if (result.size > 1) reasons.add("competing_corrections");
    terminals.set(eventId, result);
    return result;
  };
  for (const event of events) resolve(event.eventId);
  const active = events.filter((event) => corrections.get(event.eventId)!.size === 0);
  const outgoing = new Map(active.map((event) => [event.eventId, new Set<string>()]));
  const addEdge = (before: string, after: string) => {
    if (before === after) {
      reasons.add("ordering_cycle");
      return;
    }
    outgoing.get(before)!.add(after);
  };
  for (const event of events) {
    for (const predecessor of event.afterEventIds) {
      if (!members.has(predecessor)) continue;
      for (const before of resolve(predecessor)) for (const after of resolve(event.eventId)) addEdge(before, after);
    }
  }
  for (const before of active)
    for (const after of active) {
      if (before.effectiveAt !== null && after.effectiveAt !== null && before.effectiveAt < after.effectiveAt) {
        addEdge(before.eventId, after.eventId);
      }
    }
  const indegree = new Map(active.map((event) => [event.eventId, 0]));
  for (const edges of outgoing.values()) for (const target of edges) indegree.set(target, indegree.get(target)! + 1);
  const queue = active.filter((event) => indegree.get(event.eventId) === 0).map((event) => event.eventId);
  let visited = 0;
  while (queue.length) {
    const current = queue.pop()!;
    visited++;
    for (const target of outgoing.get(current)!) {
      indegree.set(target, indegree.get(target)! - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }
  if (visited !== active.length) reasons.add("ordering_cycle");
  const candidates = active.filter((event) => outgoing.get(event.eventId)!.size === 0);
  const values = new Set(candidates.map((event) => event.value));
  const conflicted = ["ordering_cycle", "correction_cycle", "competing_corrections", "cross_facet_reference"].some(
    (reason) => reasons.has(reason),
  );
  const incomplete = reasons.has("missing_reference");
  const state = conflicted ? "conflicted" : incomplete ? "incomplete" : values.size === 1 ? "known" : "ambiguous";
  if (state === "ambiguous") reasons.add("unordered_alternatives");
  if (active.some((event) => event.effectiveAt === null)) reasons.add("unknown_effective_time");
  return {
    objectId: first.objectId,
    facet: first.facet,
    state,
    value: state === "known" ? candidates[0]!.value : null,
    candidateEventIds: candidates.map((event) => event.eventId).sort(compare),
    reasonCodes: [...reasons].sort(compare),
  };
}

/** Bounded, deterministic replay. No I/O, clock reads, mutation, or arrival-order tie breaking. */
export function replayTransitions(input: readonly unknown[]): ReplayResult {
  if (!Array.isArray(input) || input.length > 256) throw new Error("replay_limit_exceeded");
  const byId = new Map<string, Transition>();
  for (const raw of input) {
    const event = parse(raw);
    const prior = byId.get(event.eventId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(event)) throw new Error("conflicting_event_id");
    byId.set(event.eventId, event);
  }
  const events = [...byId.values()].sort((left, right) => compare(left.eventId, right.eventId));
  const groups = new Map<string, Transition[]>();
  for (const event of events) {
    const group = groups.get(key(event)) ?? [];
    group.push(event);
    groups.set(key(event), group);
  }
  const facets = [...groups].sort(([left], [right]) => compare(left, right)).map(([, group]) => reconcile(group, byId));
  const result = { version: "transition-replay/v1" as const, scope: "supplied_events_only" as const, events, facets };
  return { ...result, digest: createHash("sha256").update(JSON.stringify(result)).digest("hex") };
}
