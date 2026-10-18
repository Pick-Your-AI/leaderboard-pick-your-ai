import { createHash } from "node:crypto";
import type { CheckpointStore } from "./checkpoints.js";

/** Resource identity is never inferred from a URL or from an omitted header. */
export const quotaResources = ["core", "search", "code_search", "graphql", "unknown"] as const;
export type QuotaResource = (typeof quotaResources)[number];

export interface QuotaObservation {
  observedAt: string;
  responseStatus: number;
  limit: number | null;
  remaining: number | null;
  used: number | null;
  resetAt: string | null;
  retryAfterSeconds: number | null;
}

export interface QuotaDiagnostics {
  /** Binds the configured API origin and installation/account pool, without exposing either. */
  scopeKey: string;
  resources: Array<{
    resource: QuotaResource;
    state: "observed" | "unknown" | "unavailable";
    observation: QuotaObservation | null;
  }>;
}

interface StoredQuota extends QuotaObservation {
  version: 1;
  scopeKey: string;
  resource: QuotaResource;
}

const fields = [
  "version",
  "scopeKey",
  "resource",
  "observedAt",
  "responseStatus",
  "limit",
  "remaining",
  "used",
  "resetAt",
  "retryAfterSeconds",
];
const headerNames = [
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-used",
  "x-ratelimit-reset",
  "x-ratelimit-resource",
  "retry-after",
];
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

function integer(value: string | null): number | null {
  if (value === null || !/^[0-9]{1,16}$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function resetInstant(value: string | null): string | null {
  const seconds = integer(value);
  if (seconds === null || seconds > 253402300799) return null;
  return new Date(seconds * 1000).toISOString();
}

function valid(value: unknown, scopeKey: string, resource: QuotaResource): value is StoredQuota {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === fields.length &&
    fields.every((field) => Object.hasOwn(record, field)) &&
    record.version === 1 &&
    record.scopeKey === scopeKey &&
    record.resource === resource &&
    instant(record.observedAt) &&
    Number.isInteger(record.responseStatus) &&
    (record.responseStatus as number) >= 200 &&
    (record.responseStatus as number) <= 599 &&
    [record.limit, record.remaining, record.used, record.retryAfterSeconds].every(
      (number) => number === null || (Number.isSafeInteger(number) && (number as number) >= 0),
    ) &&
    (record.resetAt === null || instant(record.resetAt))
  );
}

/**
 * The latest retained response per resource, not an exact global quota balance.
 * No token lookup or network request is available at this boundary. Hosts share
 * this observer across repository views of the same installation/account client.
 */
export class GithubQuotaObservations {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(
    private readonly checkpoints: CheckpointStore,
    private readonly apiOrigin: string,
    private readonly now: () => number,
  ) {}

  private scope(source: string): string {
    if (typeof source !== "string" || !source.trim() || source.length > 2000) throw new Error("invalid_quota_scope");
    return createHash("sha256")
      .update(JSON.stringify(["github-quota/v1", this.apiOrigin, source]))
      .digest("hex");
  }

  /** A telemetry retention failure never retries an otherwise completed request. */
  async observe(
    source: string,
    response: Pick<Response, "status" | "headers">,
    assertAuthorized?: () => void,
  ): Promise<boolean> {
    assertAuthorized?.();
    if (!headerNames.some((name) => response.headers.has(name))) return false;
    const scopeKey = this.scope(source);
    const suppliedResource = response.headers.get("x-ratelimit-resource");
    const resource = quotaResources.find((candidate) => candidate === suppliedResource) ?? "unknown";
    const timestamp = this.now();
    if (!Number.isFinite(timestamp)) return false;
    let observedAt: string;
    try {
      observedAt = new Date(timestamp).toISOString();
    } catch {
      return false;
    }
    const observation: StoredQuota = {
      version: 1,
      scopeKey,
      resource,
      observedAt,
      responseStatus: response.status,
      limit: integer(response.headers.get("x-ratelimit-limit")),
      remaining: integer(response.headers.get("x-ratelimit-remaining")),
      used: integer(response.headers.get("x-ratelimit-used")),
      resetAt: resetInstant(response.headers.get("x-ratelimit-reset")),
      retryAfterSeconds: integer(response.headers.get("retry-after")),
    };
    if (!valid(observation, scopeKey, resource)) return false;
    const key = `quota:${scopeKey}:${resource}`;
    const write = (this.writes.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        assertAuthorized?.();
        return this.checkpoints.save(key, observation);
      });
    this.writes.set(key, write);
    try {
      await write;
      return true;
    } catch {
      return false;
    } finally {
      if (this.writes.get(key) === write) this.writes.delete(key);
    }
  }

  async read(source: string, assertAuthorized?: () => void): Promise<QuotaDiagnostics> {
    assertAuthorized?.();
    const scopeKey = this.scope(source);
    const resources: QuotaDiagnostics["resources"] = [];
    for (const resource of quotaResources) {
      const key = `quota:${scopeKey}:${resource}`;
      try {
        await this.writes.get(key)?.catch(() => undefined);
        assertAuthorized?.();
        const record = await this.checkpoints.load(key);
        assertAuthorized?.();
        if (record === undefined) {
          resources.push({ resource, state: "unknown", observation: null });
        } else if (!valid(record, scopeKey, resource)) {
          resources.push({ resource, state: "unavailable", observation: null });
        } else {
          resources.push({
            resource,
            state: "observed",
            observation: {
              observedAt: record.observedAt,
              responseStatus: record.responseStatus,
              limit: record.limit,
              remaining: record.remaining,
              used: record.used,
              resetAt: record.resetAt,
              retryAfterSeconds: record.retryAfterSeconds,
            },
          });
        }
      } catch {
        // Grant loss takes precedence over a storage or record failure.
        assertAuthorized?.();
        resources.push({ resource, state: "unavailable", observation: null });
      }
    }
    return { scopeKey, resources };
  }
}
