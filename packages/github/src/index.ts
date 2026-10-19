export type Visibility = "public" | "private" | "unknown" | "unavailable";

export * from "./client.js";
export * from "./checkpoints.js";
export type { QuotaResource, QuotaObservation, QuotaDiagnostics } from "./quota.js";
export * from "./normalizers.js";
export * from "./project-snapshots.js";
export * from "./project-context.js";
export * from "./timeline-history.js";
export * from "./physical-diff.js";
export * from "./documentation.js";
export * from "./research.js";
export * from "./maintenance.js";

export type EndpointOutcome =
  | { kind: "readable"; visibility: Visibility }
  | { kind: "authentication_required"; visibility: "unknown"; status: 401 }
  | { kind: "permission_denied"; visibility: "unknown"; status: 403 }
  | { kind: "not_found_or_hidden"; visibility: "unknown"; status: 404 }
  | { kind: "rate_limited"; visibility: "unknown"; retryAt: string; scope: "source" }
  | { kind: "transient_failure"; visibility: "unknown"; status?: number }
  | { kind: "unknown_failure"; visibility: "unknown"; status?: number };

export type HeaderReader = { get(name: string): string | null };

export interface GithubFailureInput {
  status?: number;
  headers?: HeaderReader;
  message?: string;
  now?: Date;
}

function parseRetryAfter(value: string | null, now: Date): Date | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const date = new Date(now.getTime() + seconds * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function primaryReset(headers: HeaderReader | undefined): Date | undefined {
  const reset = headers?.get("x-ratelimit-reset");
  if (!reset || !/^\d+$/.test(reset)) return undefined;
  const date = new Date(Number(reset) * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function classifyGithubFailure(input: GithubFailureInput): EndpointOutcome {
  const now = input.now ?? new Date();
  const remaining = input.headers?.get("x-ratelimit-remaining");
  const retryAfter = parseRetryAfter(input.headers?.get("retry-after") ?? null, now);
  const reset = primaryReset(input.headers);
  const mentionsRateLimit = /rate limit|secondary rate/i.test(input.message ?? "");
  const rateLimited =
    input.status === 429 ||
    (input.status === 403 && (remaining === "0" || retryAfter !== undefined || mentionsRateLimit));

  if (rateLimited) {
    // GitHub's guidance is to wait at least 60 seconds when a secondary-limit
    // response gives neither Retry-After nor a primary reset time.
    const fallback = new Date(now.getTime() + 60_000);
    const retryAt = retryAfter ?? (remaining === "0" ? reset : undefined) ?? fallback;
    return { kind: "rate_limited", visibility: "unknown", retryAt: retryAt.toISOString(), scope: "source" };
  }
  if (input.status === 401) return { kind: "authentication_required", visibility: "unknown", status: 401 };
  if (input.status === 404) return { kind: "not_found_or_hidden", visibility: "unknown", status: 404 };
  if (input.status === 403) return { kind: "permission_denied", visibility: "unknown", status: 403 };
  if (input.status === undefined || input.status === 408 || input.status === 425 || input.status >= 500) {
    return {
      kind: "transient_failure",
      visibility: "unknown",
      ...(input.status === undefined ? {} : { status: input.status }),
    };
  }
  return {
    kind: "unknown_failure",
    visibility: "unknown",
    ...(input.status === undefined ? {} : { status: input.status }),
  };
}

export function readableOutcome(visibility: Visibility | null | undefined): EndpointOutcome {
  return { kind: "readable", visibility: visibility ?? "unknown" };
}

/** Parse the `next` relation without trusting the URL it supplies. */
export function nextRestLink(linkHeader: string | null | undefined): string | undefined {
  if (!linkHeader) return undefined;
  const entries = linkHeader.match(/(?:<[^>]*>|[^,])+/g) ?? [];
  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    const match = entry.match(/^<([^>]*)>\s*;(.*)$/);
    if (!match) continue;
    const target = match[1];
    if (target === undefined) continue;
    const rel = (match[2] ?? "").match(/(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]+))/i);
    const relations = (rel?.[1] ?? rel?.[2] ?? "").split(/\s+/);
    if (relations.includes("next")) return target;
  }
  return undefined;
}

export interface RestPage<T> {
  items: readonly T[];
  link?: string | null;
}

export interface RestReadRequest {
  method: "GET";
}

export interface RestPaginationOptions {
  /** Hard stop for malformed or unexpectedly unbounded result sets. */
  maxPages: number;
  /** The configured GitHub API origin; pagination links must stay on it. */
  apiOrigin: string;
}

function assertTrustedApiUrl(raw: string, apiOrigin: string): string {
  const base = new URL(apiOrigin);
  const candidate = new URL(raw, base);
  if (
    base.protocol !== "https:" ||
    candidate.protocol !== "https:" ||
    candidate.origin !== base.origin ||
    candidate.username ||
    candidate.password
  ) {
    throw new Error("Refusing pagination URL outside the configured HTTPS GitHub API origin");
  }
  return candidate.toString();
}

export async function paginateRest<T>(
  initialUrl: string,
  fetchPage: (url: string, request: RestReadRequest) => Promise<RestPage<T>>,
  options: RestPaginationOptions,
): Promise<T[]> {
  if (!Number.isSafeInteger(options.maxPages) || options.maxPages < 1) {
    throw new RangeError("maxPages must be a positive safe integer");
  }
  const items: T[] = [];
  const visited = new Set<string>();
  let url: string | undefined = assertTrustedApiUrl(initialUrl, options.apiOrigin);
  let pageCount = 0;
  while (url) {
    if (visited.has(url)) throw new Error("REST pagination repeated a page URL");
    if (pageCount >= options.maxPages) throw new Error("REST pagination exceeded maxPages");
    visited.add(url);
    pageCount += 1;
    const page = await fetchPage(url, { method: "GET" });
    items.push(...page.items);
    const next = nextRestLink(page.link);
    url = next ? assertTrustedApiUrl(next, options.apiOrigin) : undefined;
  }
  return items;
}

export interface GraphqlPage<T> {
  nodes: readonly T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  errors?: readonly { message: string }[];
}

export interface GraphqlPaginationOptions {
  first: number;
  maxPages: number;
}

export async function paginateGraphql<T>(
  fetchPage: (variables: { first: number; after: string | null }) => Promise<GraphqlPage<T>>,
  options: GraphqlPaginationOptions,
): Promise<T[]> {
  if (!Number.isInteger(options.first) || options.first < 1 || options.first > 100) {
    throw new RangeError("GraphQL first must be an integer from 1 through 100");
  }
  if (!Number.isSafeInteger(options.maxPages) || options.maxPages < 1) {
    throw new RangeError("maxPages must be a positive safe integer");
  }
  const nodes: T[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  for (let pageCount = 0; pageCount < options.maxPages; pageCount += 1) {
    const page = await fetchPage({ first: options.first, after });
    if (page.errors?.length)
      throw new Error(`GraphQL response included errors: ${page.errors.map((error) => error.message).join("; ")}`);
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return nodes;
    const nextCursor = page.pageInfo.endCursor;
    if (!nextCursor) throw new Error("GraphQL page reports hasNextPage without an endCursor");
    if (cursors.has(nextCursor)) throw new Error("GraphQL pagination repeated an endCursor");
    cursors.add(nextCursor);
    after = nextCursor;
  }
  throw new Error("GraphQL pagination exceeded maxPages");
}
