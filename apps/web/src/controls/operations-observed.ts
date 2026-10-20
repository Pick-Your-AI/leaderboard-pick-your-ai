/** Private operator response shapes. Keep server packages out of the browser bundle. */
export interface OperatorReadAuthority {
  repositoryId: number;
  sourceGeneration: string;
  policyVersion: string;
  authorityRevision: string;
}
export interface OperatorPublication {
  scopeKey: string;
  snapshotId: string;
  revision: number;
}
// Fits 100 full-length canonical Project IDs, all roles and maximum base dimensions.
export const operatorPublicationScopeKeyLimit = 16_384;
const sourceFamilies = [
  "issues",
  "pull_requests",
  "commits",
  "reviews",
  "comments",
  "releases",
  "discussions",
  "timelines",
  "content_edits",
  "project_history",
  "project_curation_history",
  "issue_field_history",
  "relationships",
  "project_current",
] as const;
const collectorStates = ["unknown", "quiet", "progress", "collecting", "disconnected", "degraded", "overdue"] as const;
const collectorReasons = [
  "no_current_attempt",
  "source_read_failed",
  "source_schema_drift",
  "source_commit_failed",
  "collection_failed",
  "attempt_overdue",
  "partial_collection",
  "completion_time_unknown",
  "reconciliation_gap",
  "reconciliation_overdue",
  "completed_empty_window",
  "source_count_unknown",
  "completed_observed_window",
] as const;
const quotaResources = ["core", "search", "code_search", "graphql", "unknown"] as const;
type CollectorState = (typeof collectorStates)[number];
export interface OperatorHealthResponse extends OperatorReadAuthority {
  asOf: string;
  freshnessBudgetSeconds: number;
  collector: {
    state: CollectorState;
    families: Array<{
      family: (typeof sourceFamilies)[number];
      state: CollectorState;
      reason: (typeof collectorReasons)[number];
      lastAttemptAt: string | null;
      lastSuccessAt: string | null;
      reconciledThrough: string | null;
      items: number | null;
      expectedItems: number | null;
    }>;
  };
  intake: {
    retained: number | null;
    pending: number | null;
    leased: number | null;
    quarantined: number | null;
    oldestPendingAt: string | null;
    queueAgeSeconds: number | null;
    latestReceivedAt: string | null;
    latestSourceAt: string | null;
    lagSeconds: number | null;
  };
  publication: {
    pending: number | null;
    leased: number | null;
    quarantined: number | null;
    oldestPendingAt: string | null;
    queueAgeSeconds: number | null;
    state: "unknown" | "unavailable" | "verified";
    completedAt: string | null;
    delaySeconds: number | null;
    policyVersion: string | null;
    publications: OperatorPublication[];
  };
  quota: {
    state: "available" | "unavailable";
    scopeKey: string | null;
    resources: Array<{
      resource: (typeof quotaResources)[number];
      state: "observed" | "unknown" | "unavailable";
      observation: {
        observedAt: string;
        responseStatus: number;
        limit: number | null;
        remaining: number | null;
        used: number | null;
        resetAt: string | null;
        retryAfterSeconds: number | null;
      } | null;
    }>;
  };
}
const replayStates = [
  "unknown",
  "queued",
  "processing",
  "failed",
  "superseded",
  "processed",
  "published",
  "unavailable",
] as const;
const replayReasons = [
  "legacy_unbound",
  "awaiting_intake",
  "intake_in_progress",
  "intake_failed",
  "later_replay_queued",
  "no_new_publication_notice",
  "awaiting_publication",
  "publication_in_progress",
  "publication_failed",
  "source_generation_changed",
  "result_binding_unavailable",
  "publication_verification_unavailable",
  "verified_publication",
] as const;
export interface OperatorReplayResultResponse extends OperatorReadAuthority {
  receiptId: string;
  deliveryId: string;
  status: (typeof replayStates)[number];
  reason: (typeof replayReasons)[number];
  queuedAt: string | null;
  processedAt: string | null;
  publicationCompletedAt: string | null;
  processingDelaySeconds: number | null;
  publicationDelaySeconds: number | null;
  replayPolicyVersion: string | null;
  publicationPolicyVersion: string | null;
  publications: OperatorPublication[];
}

const authorityKeys = ["repositoryId", "sourceGeneration", "policyVersion", "authorityRevision"];
const invalid = (): never => {
  throw Error("Observed operations response changed or is invalid.");
};
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(fields, key) || !Object.hasOwn(fields[key]!, "value") || !fields[key]!.enumerable)
  )
    return invalid();
  return Object.fromEntries(keys.map((key) => [key, fields[key]!.value]));
}
function array(value: unknown, minimum: number, maximum: number): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return invalid();
  return Array.from({ length: value.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable) return invalid();
    return field.value;
  });
}
function choice<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) return invalid();
  return value as T[number];
}
function count(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid();
  return value;
}
const optionalCount = (value: unknown) => (value === null ? null : count(value));
function seconds(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
    return invalid();
  return value;
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) return invalid();
  return value;
}
const optionalIdentity = (value: unknown) => (value === null ? null : identity(value));
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return invalid();
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) return invalid();
  return value;
}
function receiptIdentity(value: unknown): string {
  // Host-authored and historical replay receipts use the protected route's opaque ID grammar.
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) return invalid();
  return value;
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return invalid();
  return value;
}
function observed(value: unknown, asOf?: string): string | null {
  if (value === null) return null;
  const time = instant(value);
  if (asOf !== undefined && time > asOf) return invalid();
  return time;
}
const elapsed = (start: string | null, end: string | null): number | null =>
  start !== null && end !== null && end >= start ? (Date.parse(end) - Date.parse(start)) / 1000 : null;
function delay(value: unknown, start: string | null, end: string | null): number | null {
  const result = seconds(value);
  if (result !== elapsed(start, end)) return invalid();
  return result;
}
function authority(value: Record<string, unknown>, expected: OperatorReadAuthority): OperatorReadAuthority {
  if (!expected || typeof expected !== "object") return invalid();
  const result = {
    repositoryId: count(value.repositoryId, 1),
    sourceGeneration: value.sourceGeneration,
    policyVersion: identity(value.policyVersion),
    authorityRevision: identity(value.authorityRevision),
  };
  if (
    typeof result.sourceGeneration !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(result.sourceGeneration) ||
    result.repositoryId !== expected.repositoryId ||
    result.sourceGeneration !== expected.sourceGeneration ||
    result.policyVersion !== expected.policyVersion ||
    result.authorityRevision !== expected.authorityRevision
  )
    return invalid();
  return { ...result, sourceGeneration: result.sourceGeneration };
}
function publications(value: unknown, required: boolean): OperatorPublication[] {
  const scopes = new Set<string>();
  return array(value, required ? 1 : 0, required ? 100 : 0).map((entry) => {
    const row = object(entry, ["scopeKey", "snapshotId", "revision"]);
    if (
      typeof row.scopeKey !== "string" ||
      !row.scopeKey.length ||
      row.scopeKey.length > operatorPublicationScopeKeyLimit ||
      scopes.has(row.scopeKey)
    )
      return invalid();
    scopes.add(row.scopeKey);
    return { scopeKey: row.scopeKey, snapshotId: hash(row.snapshotId), revision: count(row.revision, 1) };
  });
}
function queue(row: Record<string, unknown>, asOf: string) {
  const pending = optionalCount(row.pending),
    leased = optionalCount(row.leased),
    quarantined = optionalCount(row.quarantined);
  const oldestPendingAt = observed(row.oldestPendingAt, asOf);
  if (pending === 0 && leased === 0 && quarantined === 0 && oldestPendingAt !== null) return invalid();
  return {
    pending,
    leased,
    quarantined,
    oldestPendingAt,
    queueAgeSeconds: delay(row.queueAgeSeconds, oldestPendingAt, asOf),
  };
}
function collector(value: unknown, asOf: string, budget: number): OperatorHealthResponse["collector"] {
  const row = object(value, ["state", "families"]),
    seen = new Set<string>();
  const fresh = (time: string | null) => time !== null && elapsed(time, asOf)! <= budget;
  const families = array(row.families, 1, sourceFamilies.length).map((entry) => {
    const item = object(entry, [
      "family",
      "state",
      "reason",
      "lastAttemptAt",
      "lastSuccessAt",
      "reconciledThrough",
      "items",
      "expectedItems",
    ]);
    const family = choice(item.family, sourceFamilies);
    if (seen.has(family)) return invalid();
    seen.add(family);
    const state = choice(item.state, collectorStates),
      reason = choice(item.reason, collectorReasons);
    const lastAttemptAt = observed(item.lastAttemptAt, asOf),
      lastSuccessAt = observed(item.lastSuccessAt, asOf);
    const reconciledThrough = observed(item.reconciledThrough, asOf);
    const items = optionalCount(item.items),
      expectedItems = optionalCount(item.expectedItems);
    const attempted = lastAttemptAt !== null,
      timely = fresh(lastAttemptAt);
    const completed = timely && fresh(lastSuccessAt) && fresh(reconciledThrough);
    let coherent = false;
    switch (reason) {
      case "source_read_failed":
        coherent = state === "disconnected" && attempted;
        break;
      case "source_schema_drift":
      case "source_commit_failed":
      case "collection_failed":
        coherent = state === "degraded" && attempted;
        break;
      case "attempt_overdue":
        coherent = state === "overdue" && attempted && !timely;
        break;
      case "partial_collection":
        coherent = state === "collecting" && timely;
        break;
      case "completion_time_unknown":
        coherent = state === "unknown" && timely && (lastSuccessAt === null || reconciledThrough === null);
        break;
      case "reconciliation_gap":
        coherent = state === "unknown" && timely && lastSuccessAt !== null && reconciledThrough !== null;
        break;
      case "reconciliation_overdue":
        coherent = state === "overdue" && timely && lastSuccessAt !== null && reconciledThrough !== null && !completed;
        break;
      case "completed_empty_window":
        coherent = state === "quiet" && completed && items === 0 && expectedItems === 0;
        break;
      case "source_count_unknown":
        coherent =
          state === "unknown" && completed && (items === null || expectedItems === null || items !== expectedItems);
        break;
      case "completed_observed_window":
        coherent = state === "progress" && completed && items !== null && items > 0 && items === expectedItems;
        break;
      case "no_current_attempt":
        coherent = state === "unknown" && (!attempted || timely);
        break;
    }
    if (!coherent) return invalid();
    return { family, state, reason, lastAttemptAt, lastSuccessAt, reconciledThrough, items, expectedItems };
  });
  const state =
    ["disconnected", "degraded", "overdue", "unknown", "collecting"].find((candidate) =>
      families.some((family) => family.state === candidate),
    ) ?? (families.every((family) => family.state === "quiet") ? "quiet" : "progress");
  if (row.state !== state) return invalid();
  return { state: state as CollectorState, families };
}
function quota(value: unknown, asOf: string): OperatorHealthResponse["quota"] {
  const row = object(value, ["state", "scopeKey", "resources"]);
  const state = choice(row.state, ["available", "unavailable"]);
  if (state === "unavailable") {
    if (row.scopeKey !== null || array(row.resources, 0, 0).length) return invalid();
    return { state, scopeKey: null, resources: [] };
  }
  const scopeKey = hash(row.scopeKey),
    seen = new Set<string>();
  const resources = array(row.resources, quotaResources.length, quotaResources.length).map((entry) => {
    const item = object(entry, ["resource", "state", "observation"]),
      resource = choice(item.resource, quotaResources);
    if (seen.has(resource)) return invalid();
    seen.add(resource);
    const state = choice(item.state, ["observed", "unknown", "unavailable"]);
    if (state !== "observed") {
      if (item.observation !== null) return invalid();
      return { resource, state, observation: null };
    }
    const sample = object(item.observation, [
      "observedAt",
      "responseStatus",
      "limit",
      "remaining",
      "used",
      "resetAt",
      "retryAfterSeconds",
    ]);
    const observedAt = observed(sample.observedAt, asOf);
    if (observedAt === null) return invalid();
    return {
      resource,
      state,
      observation: {
        observedAt,
        responseStatus: count(sample.responseStatus, 100, 599),
        limit: optionalCount(sample.limit),
        remaining: optionalCount(sample.remaining),
        used: optionalCount(sample.used),
        // A retained reset deadline can legitimately follow the observation and asOf.
        resetAt: observed(sample.resetAt),
        retryAfterSeconds: optionalCount(sample.retryAfterSeconds),
      },
    };
  });
  return { state, scopeKey, resources };
}

/** Validate the exact authorized read; no browser clock, network call or health inference is used. */
export function checkedOperatorHealth(value: unknown, expected: OperatorReadAuthority): OperatorHealthResponse {
  const row = object(value, [
    ...authorityKeys,
    "asOf",
    "freshnessBudgetSeconds",
    "collector",
    "intake",
    "publication",
    "quota",
  ]);
  const bound = authority(row, expected),
    asOf = instant(row.asOf),
    freshnessBudgetSeconds = count(row.freshnessBudgetSeconds, 1, 86400);
  const input = object(row.intake, [
    "retained",
    "pending",
    "leased",
    "quarantined",
    "oldestPendingAt",
    "queueAgeSeconds",
    "latestReceivedAt",
    "latestSourceAt",
    "lagSeconds",
  ]);
  const retained = optionalCount(input.retained),
    intakeQueue = queue(input, asOf);
  if (
    retained !== null &&
    [intakeQueue.pending, intakeQueue.leased, intakeQueue.quarantined].reduce<bigint>(
      (sum, value) => sum + BigInt(value ?? 0),
      0n,
    ) > BigInt(retained)
  )
    return invalid();
  const latestReceivedAt = observed(input.latestReceivedAt, asOf),
    latestSourceAt = observed(input.latestSourceAt, asOf);
  const intake = {
    retained,
    ...intakeQueue,
    latestReceivedAt,
    latestSourceAt,
    lagSeconds: delay(input.lagSeconds, latestSourceAt, latestReceivedAt),
  };
  const output = object(row.publication, [
    "pending",
    "leased",
    "quarantined",
    "oldestPendingAt",
    "queueAgeSeconds",
    "state",
    "completedAt",
    "delaySeconds",
    "policyVersion",
    "publications",
  ]);
  const publicationQueue = queue(output, asOf),
    state = choice(output.state, ["unknown", "unavailable", "verified"]);
  const completedAt = observed(output.completedAt, asOf),
    delaySeconds = seconds(output.delaySeconds),
    policyVersion = optionalIdentity(output.policyVersion);
  if (
    state === "verified"
      ? completedAt === null || delaySeconds === null || policyVersion === null
      : completedAt !== null || delaySeconds !== null || policyVersion !== null
  )
    return invalid();
  const publication = {
    ...publicationQueue,
    state,
    completedAt,
    delaySeconds,
    policyVersion,
    publications: publications(output.publications, state === "verified"),
  };
  return {
    ...bound,
    asOf,
    freshnessBudgetSeconds,
    collector: collector(row.collector, asOf, freshnessBudgetSeconds),
    intake,
    publication,
    quota: quota(row.quota, asOf),
  };
}

/** A queued/processed receipt cannot acquire publication meaning from a malformed or stale response. */
export function checkedReplayResult(
  value: unknown,
  expected: OperatorReadAuthority & { receiptId: string; deliveryId: string },
): OperatorReplayResultResponse {
  const row = object(value, [
    ...authorityKeys,
    "receiptId",
    "deliveryId",
    "status",
    "reason",
    "queuedAt",
    "processedAt",
    "publicationCompletedAt",
    "processingDelaySeconds",
    "publicationDelaySeconds",
    "replayPolicyVersion",
    "publicationPolicyVersion",
    "publications",
  ]);
  const bound = authority(row, expected),
    receiptId = receiptIdentity(row.receiptId),
    deliveryId = uuid(row.deliveryId);
  if (receiptId !== expected.receiptId || deliveryId !== expected.deliveryId) return invalid();
  const status = choice(row.status, replayStates),
    reason = choice(row.reason, replayReasons);
  const allowed: Record<OperatorReplayResultResponse["status"], readonly OperatorReplayResultResponse["reason"][]> = {
    unknown: ["legacy_unbound"],
    queued: ["awaiting_intake"],
    processing: ["intake_in_progress", "publication_in_progress"],
    failed: ["intake_failed", "publication_failed"],
    superseded: ["later_replay_queued"],
    processed: ["no_new_publication_notice", "awaiting_publication"],
    published: ["verified_publication"],
    unavailable: ["source_generation_changed", "result_binding_unavailable", "publication_verification_unavailable"],
  };
  if (!allowed[status].includes(reason)) return invalid();
  const queuedAt = observed(row.queuedAt),
    processedAt = observed(row.processedAt),
    publicationCompletedAt = observed(row.publicationCompletedAt);
  const processingDelaySeconds = seconds(row.processingDelaySeconds),
    publicationDelaySeconds = seconds(row.publicationDelaySeconds);
  const replayPolicyVersion = optionalIdentity(row.replayPolicyVersion),
    publicationPolicyVersion = optionalIdentity(row.publicationPolicyVersion);
  const late = [
    "no_new_publication_notice",
    "awaiting_publication",
    "publication_in_progress",
    "publication_failed",
    "publication_verification_unavailable",
    "verified_publication",
  ].includes(reason);
  const uncertain = reason === "result_binding_unavailable";
  if (status !== "unknown" && status !== "unavailable" && (queuedAt === null || replayPolicyVersion === null))
    return invalid();
  if (processedAt !== null && (queuedAt === null || replayPolicyVersion === null || processedAt < queuedAt))
    return invalid();
  if (late) {
    if (
      queuedAt === null ||
      processedAt === null ||
      replayPolicyVersion === null ||
      processingDelaySeconds !== elapsed(queuedAt, processedAt)
    )
      return invalid();
  } else if (uncertain) {
    // A failed binding can retain an observed processing timestamp without a proven delay.
    if (
      processingDelaySeconds !== null &&
      (processedAt === null || processingDelaySeconds !== elapsed(queuedAt, processedAt))
    )
      return invalid();
  } else if (processedAt !== null || processingDelaySeconds !== null) return invalid();
  if (status === "published") {
    if (
      publicationCompletedAt === null ||
      processedAt === null ||
      publicationCompletedAt < processedAt ||
      publicationPolicyVersion === null ||
      publicationDelaySeconds !== elapsed(queuedAt, publicationCompletedAt)
    )
      return invalid();
  } else if (publicationCompletedAt !== null || publicationDelaySeconds !== null || publicationPolicyVersion !== null)
    return invalid();
  return {
    ...bound,
    receiptId,
    deliveryId,
    status,
    reason,
    queuedAt,
    processedAt,
    publicationCompletedAt,
    processingDelaySeconds,
    publicationDelaySeconds,
    replayPolicyVersion,
    publicationPolicyVersion,
    publications: publications(row.publications, status === "published"),
  };
}
