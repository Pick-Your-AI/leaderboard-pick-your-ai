export type Visibility = "public" | "private" | "unknown" | "unavailable";

export * from "./client.js";
export * from "./checkpoints.js";
export type { QuotaResource, QuotaObservation, QuotaDiagnostics } from "./quota.js";
export * from "./normalizers.js";
export { reviewSourceNormalizationVersion } from "./review-cohort.js";
export * from "./rest-snapshot.js";
export * from "./project-snapshots.js";
export * from "./project-context.js";
export * from "./timeline-history.js";
export * from "./issue-field-history.js";
export * from "./content-edit-history.js";
export * from "./comment-edit-history.js";
export * from "./comment-edit-inventory.js";
export * from "./physical-diff.js";
export * from "./repository-net-lines.js";
export * from "./documentation.js";
export * from "./localization-review.js";
export * from "./research.js";
export * from "./maintenance.js";
export * from "./release-stewardship-source.js";
export * from "./release-inclusion.js";
export * from "./pull-request-merge-target.js";
export * from "./release-recognition.js";
export * from "./ordering.js";

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
  // HTTP delay-seconds is a decimal integer, not JavaScript's numeric syntax.
  // In particular, a signed number must not fall through to Date's loose parser.
  if (/^[0-9]+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) return undefined;
    const date = new Date(now.getTime() + seconds * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  // RFC 9110 requires all three HTTP-date forms. Parse their fields explicitly
  // so partial dates, implicit local time and normalized invalid dates cannot
  // shorten or invent a pause. The obsolete asctime form is also UTC.
  let parts: string[] | null = /^(\w{3}), (\d{2}) (\w{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  let shortYear = false;
  if (!parts) {
    parts = /^(\w+), (\d{2})-(\w{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
    shortYear = parts !== null;
  }
  if (!parts) {
    const ascii = /^(\w{3}) (\w{3}) (\d{2}| \d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value);
    if (!ascii) return undefined;
    parts = [ascii[0], ascii[1]!, ascii[3]!, ascii[2]!, ascii[7]!, ascii[4]!, ascii[5]!, ascii[6]!];
  }
  const weekdays = shortYear
    ? ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekday = weekdays.indexOf(parts[1]!);
  const day = Number(parts[2]);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(parts[3]!);
  let year = Number(parts[4]);
  const hour = Number(parts[5]),
    minute = Number(parts[6]),
    second = Number(parts[7]);
  if (weekday < 0 || month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return undefined;
  if (second === 60 && (hour !== 23 || minute !== 59)) return undefined;
  const date = new Date(0);
  date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  if (shortYear) {
    const latest = new Date(now);
    latest.setUTCFullYear(latest.getUTCFullYear() + 50);
    year += Math.floor(latest.getUTCFullYear() / 100) * 100;
    date.setUTCFullYear(year, month, day);
    // Compare the same rounded leap-second instant returned below.
    if (date.getTime() + (second === 60 ? 1000 : 0) > latest.getTime()) year -= 100;
  }
  // HTTP-date imports RFC 5322's year semantics: 1900 or later, including
  // obsolete two-digit years after applying the HTTP fifty-year rule.
  if (year < 1900) return undefined;
  date.setUTCFullYear(year, month, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCDay() !== weekday
  )
    return undefined;
  // JavaScript has no leap-second instant. Rounding it forward avoids retrying
  // before the supplied second has elapsed.
  if (second === 60) date.setTime(date.getTime() + 1000);
  return date;
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
    // Both applicable limits must elapse; a shorter Retry-After cannot discard
    // the independently exhausted primary budget's reset.
    const exhaustedReset = remaining === "0" ? reset : undefined;
    const retryAt =
      retryAfter && exhaustedReset
        ? new Date(Math.max(retryAfter.getTime(), exhaustedReset.getTime()))
        : (retryAfter ?? exhaustedReset ?? fallback);
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

export {
  readGithubCommentSource,
  readGithubCommentIdentity,
  type GithubCommentKind,
  type GithubCommentSource,
} from "./comment-identity.js";

export {
  validateDocumentationPurposeSource,
  type VerifiedDocumentationPurposeSource,
} from "./documentation-purpose.js";

export {
  parseMaintenanceClassification,
  validateMaintenanceClassification,
  type MaintenanceClassificationRecord,
  type MaintenanceClassificationReference,
} from "./maintenance-classification.js";
export {
  minimizeDiscussionFeedback,
  discussionFeedbackFingerprint,
  discussionFeedbackRevision,
  verifyDiscussionFeedbackObservation,
  discussionFeedbackPublicRevision,
  validateHelpfulFeedbackSource,
} from "./discussion-feedback.js";

export {
  capturePullRequestDecisionHistory,
  validatePullRequestDecisionHistory,
  selectPullRequestDecisionAsOf,
  type PullRequestDecisionHistoryOptions,
  type PullRequestDecisionSelection,
} from "./decision-history.js";
