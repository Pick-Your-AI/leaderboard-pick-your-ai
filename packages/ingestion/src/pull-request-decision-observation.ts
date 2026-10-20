import { types } from "node:util";
import {
  compareSourceInstants,
  pullRequestDecisionBindingSchema,
  pullRequestDecisionGenerationSchema,
  pullRequestDecisionInstantSchema,
  pullRequestDecisionHistorySchema,
  pullRequestDecisionClocksValid,
  pullRequestDecisionUnavailableReasons,
  type PullRequestDecisionBinding,
  type PullRequestDecisionGeneration,
  type PullRequestDecisionHistory,
  type PullRequestDecisionUnavailableReason,
} from "@pick-your-ai/contracts";

export const pullRequestDecisionObservationVersion = "pipeline-pr-decision-observation/v1" as const;
export const pullRequestDecisionObservationBytes = 2_100_000;
export const pullRequestDecisionProducerVersion = "github-pr-decision-collection/v1";
export function pullRequestDecisionProducerBinding(source: string, dataMode: "public" | "synthetic"): string {
  if (
    typeof source !== "string" ||
    !/^[A-Za-z0-9_=.:\-]{1,128}$/.test(source) ||
    !["public", "synthetic"].includes(dataMode)
  )
    throw new TypeError("invalid_pull_request_decision_producer");
  return JSON.stringify({ schemaVersion: pullRequestDecisionProducerVersion, source, dataMode });
}
export interface PullRequestDecisionObservation {
  schemaVersion: typeof pullRequestDecisionObservationVersion;
  sourceRevision: string;
  binding: PullRequestDecisionBinding;
  generation: PullRequestDecisionGeneration;
  result:
    | { status: "captured"; receipt: PullRequestDecisionHistory }
    | { status: "unavailable"; reason: PullRequestDecisionUnavailableReason };
}

function invalid(): never {
  throw new TypeError("invalid_pull_request_decision_observation");
}

/** Admit bounded JSON data before schema traversal or serialization. No hooks run. */
function copyObservation(value: unknown): unknown {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 150_000 || depth > 20) return invalid();
    let result: unknown;
    if (item === null || typeof item === "boolean") {
      bytes += 5;
      result = item;
    } else if (typeof item === "number" && Number.isFinite(item)) {
      bytes += 32;
      result = item;
    } else if (typeof item === "string") {
      if (item.length > pullRequestDecisionObservationBytes - bytes) return invalid();
      bytes += Buffer.byteLength(JSON.stringify(item));
      result = item;
    } else if (item && typeof item === "object") {
      if (types.isProxy(item) || ancestors.has(item)) return invalid();
      ancestors.add(item);
      const keys = Reflect.ownKeys(item);
      if (keys.length > 150_000 - nodes || keys.some((key) => typeof key !== "string")) return invalid();
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 10_000 || keys.length !== item.length + 1)
          return invalid();
        const entries: unknown[] = [];
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return invalid();
          entries.push(visit(descriptor.value, depth + 1));
          bytes++;
        }
        result = entries;
      } else {
        if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) return invalid();
        const entries: Record<string, unknown> = Object.create(null);
        for (const key of keys as string[]) {
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return invalid();
          if (key.length > pullRequestDecisionObservationBytes - bytes) return invalid();
          bytes += Buffer.byteLength(JSON.stringify(key)) + 2;
          entries[key] = visit(descriptor.value, depth + 1);
        }
        result = entries;
      }
      ancestors.delete(item);
      bytes += 2;
    } else return invalid();
    if (bytes > pullRequestDecisionObservationBytes) return invalid();
    return result;
  };
  return visit(value, 0);
}

function fields(value: unknown, names: string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== names.length ||
    names.some((name) => !Object.hasOwn(value, name))
  )
    return invalid();
  return value as Record<string, unknown>;
}

/** Structural collection admission; actual native authority belongs to the producer. */
export function parsePullRequestDecisionObservation(value: unknown): PullRequestDecisionObservation {
  const row = fields(copyObservation(value), ["schemaVersion", "sourceRevision", "binding", "generation", "result"]);
  if (
    row.schemaVersion !== pullRequestDecisionObservationVersion ||
    typeof row.sourceRevision !== "string" ||
    !/^[A-Za-z0-9_=.:\-]{1,128}$/.test(row.sourceRevision)
  )
    return invalid();
  const binding = pullRequestDecisionBindingSchema.parse(row.binding);
  const generation = pullRequestDecisionGenerationSchema.parse(row.generation);
  const result = row.result as Record<string, unknown> | null;
  if (result?.status === "captured") {
    fields(result, ["status", "receipt"]);
    const receipt = pullRequestDecisionHistorySchema.parse(result.receipt);
    if (
      JSON.stringify(receipt.binding) !== JSON.stringify(binding) ||
      JSON.stringify(receipt.generation) !== JSON.stringify(generation) ||
      !pullRequestDecisionClocksValid(receipt)
    )
      return invalid();
    return {
      schemaVersion: pullRequestDecisionObservationVersion,
      sourceRevision: row.sourceRevision,
      binding,
      generation,
      result: { status: "captured", receipt },
    };
  }
  fields(result, ["status", "reason"]);
  if (
    result?.status !== "unavailable" ||
    !pullRequestDecisionUnavailableReasons.includes(result.reason as PullRequestDecisionUnavailableReason)
  )
    return invalid();
  return {
    schemaVersion: pullRequestDecisionObservationVersion,
    sourceRevision: row.sourceRevision,
    binding,
    generation,
    result: { status: "unavailable", reason: result.reason as PullRequestDecisionUnavailableReason },
  };
}

export function collectionPullRequestDecisionObservation(
  value: unknown,
  family: string,
  repositoryId: number,
): PullRequestDecisionObservation | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (types.isProxy(value)) return invalid();
  if (!("pullRequestDecisionHistory" in value)) return undefined;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const names = [
    "subjectId",
    "sourceRevision",
    "sourceUrl",
    "evidence",
    "actorId",
    "occurredAt",
    "state",
    "pullRequestDecisionHistory",
  ];
  if (Reflect.ownKeys(value).length !== names.length) return invalid();
  const fact: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return invalid();
    fact[name] = descriptor.value;
  }
  const observation = parsePullRequestDecisionObservation(fact.pullRequestDecisionHistory);
  if (
    family !== "pull_requests" ||
    observation.binding.repository.id !== repositoryId ||
    observation.binding.subject.id !== fact.subjectId ||
    observation.binding.subject.url !== fact.sourceUrl ||
    observation.sourceRevision !== fact.sourceRevision ||
    fact.evidence !== "current_state" ||
    fact.actorId !== null ||
    fact.occurredAt !== null ||
    !["open", "closed", "merged"].includes(fact.state as string)
  )
    return invalid();
  return observation;
}

/** Compare with the database's actual insertion clock; never assign O from C. */
export function assertPullRequestDecisionPersistence(
  value: PullRequestDecisionObservation,
  request: { runId: string; repositoryId: number; family: string; until: string },
  observedAt: string,
  firstRunId: string,
): void {
  if (
    !pullRequestDecisionInstantSchema.safeParse(observedAt).success ||
    request.family !== "pull_requests" ||
    value.binding.repository.id !== request.repositoryId ||
    value.generation.scanId !== request.runId ||
    value.generation.asOf !== request.until ||
    value.generation.cutoffMode !== "exclusive" ||
    firstRunId !== request.runId ||
    compareSourceInstants(request.until, observedAt) > 0 ||
    (value.result.status === "captured" &&
      compareSourceInstants(value.result.receipt.capture.completedAt, observedAt) > 0)
  )
    throw new Error("pull_request_decision_persistence_binding_changed");
}
