import { stableJSON } from "@pick-your-ai/metrics";
import { defaultDisplayTimeZone, isDisplayTimeZone } from "../lib/display-time-zone.ts";
import { parseCSVExport } from "./csv-export.ts";
import { maxExportResponseBytes } from "./export-limits.ts";
import { responseScope, scopeExportVersion, scopeReadVersion, selectionScope } from "./public-scope.ts";
import { onlyExportKeys, parseExportJSON } from "./export-json.ts";
import {
  canonicalPublicScope,
  publicProfilePresentationSchema,
  publicProfilePresentationMatches,
  type PublicProfilePresentation,
  publicScopeParameters,
  type PublicScope,
  compareSourceInstants,
  participationWeekDenominator,
  publicParticipationSchema,
  type PublicParticipation,
  actorFilterSchema,
  actorKindSchema,
  executionModeSchema,
  matchesActorFilter,
  type ActorFilter,
  publicEvidenceMetadataSchema,
  type PublicEvidenceMetadata,
  publicProjectContextSchema,
  publicProjectContextMatches,
  type PublicProjectContext,
  actorSchema,
  artifactSchema,
  contributionSchema,
  coverageSchema,
  metricDefinitionSchema,
  metricRegistrySchema,
  metricResultSchema,
  sourceEventSchema,
  snapshotSchema,
  pendingCountSchema,
  rankingPresentationSchema,
  bindPublicPhysicalContext,
  type PublicPhysicalContext,
  type RankingPresentation,
  type Actor,
  type Artifact,
  type Contribution,
  type Coverage,
  type MetricDefinition,
  type MetricRegistry,
  type MetricResult,
  type PendingCount,
} from "@pick-your-ai/contracts";

export class ReadFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly disabledMetric?: DisabledMetric;
  constructor(status: number, code: string, disabledMetric?: DisabledMetric) {
    super(code);
    this.status = status;
    this.code = code;
    if (disabledMetric !== undefined) this.disabledMetric = disabledMetric;
  }
}
const identifier = /^[A-Za-z0-9_.:-]{1,200}$/;
const maxPublicRequestTargetBytes = 48 * 1024;
function validDepartmentId(value: string): boolean {
  // URLSearchParams and FormData replace isolated UTF-16 surrogates with U+FFFD.
  return (
    value !== "" && value.trim() === value && new URLSearchParams({ department: value }).get("department") === value
  );
}
const scopeKeys = ["organization", "repository", "workstream", "start", "end"] as const;
const comparisonKeys = ["compare", "compareStart", "compareEnd"] as const;
const supported = new Set([
  ...comparisonKeys,
  "actors",
  "context",
  "project",
  "role",
  ...scopeKeys,
  "snapshot",
  "limit",
  "cursor",
  "metric",
  "ui",
  "search",
  "category",
  "proof",
  "q",
  "department",
  "tz",
]);
export interface Selection extends PublicScope {
  actors?: ActorFilter;
  snapshot: string | null;
  limit: string;
  cursor: string | null;
  metric: string;
  search: string | null;
  category: string | null;
  proof?: string | null;
  compare?: string | null;
  compareStart?: string | null;
  compareEnd?: string | null;
  /** Local catalog discovery only; never sent as a source-data filter. */
  catalogQuery?: string | null;
  department?: string | null;
  /** Local display only; never included in source requests or export identities. */
  timeZone?: string;
}
export function selection(query: string, options: { comparison?: boolean } = {}): Selection {
  if (query.length > maxPublicRequestTargetBytes) throw new ReadFailure(400, "selection_too_large");
  const params = new URLSearchParams(query);
  if (!options.comparison && comparisonKeys.some((key) => params.has(key)))
    throw new ReadFailure(400, "comparison_requires_board");
  for (const key of params.keys())
    if (!supported.has(key) || params.getAll(key).length !== 1)
      throw new ReadFailure(400, "unsupported_or_duplicate_filter");
  const actorFilter = actorFilterSchema.safeParse(params.get("actors") ?? "all");
  if (!actorFilter.success) throw new ReadFailure(400, "invalid_actor_filter");
  const timeZone = params.get("tz") ?? defaultDisplayTimeZone;
  if (!isDisplayTimeZone(timeZone)) throw new ReadFailure(400, "invalid_display_timezone");
  const id = (key: string) => {
    const value = params.get(key);
    if (value !== null && !identifier.test(value)) throw new ReadFailure(400, "invalid_identifier");
    return value;
  };
  const date = (key: string) => {
    const value = params.get(key);
    if (
      value !== null &&
      (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value)
    )
      throw new ReadFailure(400, "invalid_utc_window");
    return value;
  };
  const start = date("start"),
    end = date("end");
  if (
    (start === null) !== (end === null) ||
    (start !== null && end !== null && (start >= end || Date.parse(end) - Date.parse(start) > 366 * 86400000))
  )
    throw new ReadFailure(400, "invalid_utc_window");
  const compare = id("compare"),
    compareStart = date("compareStart"),
    compareEnd = date("compareEnd");
  if (
    (compareStart === null) !== (compareEnd === null) ||
    (compareStart !== null &&
      compareEnd !== null &&
      (compareStart >= compareEnd || Date.parse(compareEnd) - Date.parse(compareStart) > 366 * 86400000)) ||
    (compare === null && (compareStart !== null || compareEnd !== null))
  )
    throw new ReadFailure(400, "invalid_comparison_window");
  const limit = params.get("limit") ?? "50";
  if (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100) throw new ReadFailure(400, "invalid_page_limit");
  const cursor = params.get("cursor");
  if (cursor !== null && (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 2048))
    throw new ReadFailure(400, "invalid_cursor");
  const catalogQuery = params.get("q");
  if (catalogQuery !== null && (catalogQuery.length > 120 || /[\u0000-\u001f\u007f]/.test(catalogQuery)))
    throw new ReadFailure(400, "invalid_catalog_query");
  // Department IDs are exact, trimmed UI metadata selectors, not source identifiers.
  const department = params.get("department");
  if (department !== null) {
    if (!validDepartmentId(department)) throw new ReadFailure(400, "invalid_identifier");
    const raw =
      query
        .replace(/^\?/, "")
        .split("&")
        .find((part) => new URLSearchParams(part).has("department")) ?? "";
    const encoded = raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : "";
    let exact: string;
    try {
      // Preserve literal percent punctuation; decode actual byte escapes without replacement.
      exact = decodeURIComponent(encoded.replace(/\+/g, " ").replace(/%(?![0-9a-f]{2})/gi, "%25"));
    } catch {
      throw new ReadFailure(400, "invalid_identifier");
    }
    if (exact !== department) throw new ReadFailure(400, "invalid_identifier");
  }
  const search = params.get("search");
  if (search !== null && !/^[A-Za-z0-9-]{1,39}$/.test(search)) throw new ReadFailure(400, "invalid_search");
  let scope: PublicScope;
  try {
    scope = canonicalPublicScope({
      organization: id("organization") ?? "Pick-Your-AI",
      repository: id("repository"),
      workstream: id("workstream"),
      start,
      end,
      ...(params.has("context") ? { context: params.get("context") } : {}),
      ...(params.has("project") ? { projects: params.get("project")!.split(",") } : {}),
      ...(params.has("role") ? { roles: params.get("role")!.split(",") } : {}),
    });
  } catch {
    throw new ReadFailure(400, "invalid_public_scope");
  }
  return {
    ...scope,
    actors: actorFilter.data,
    timeZone,
    catalogQuery: catalogQuery?.trim() || null,
    department,
    search: search?.toLowerCase() ?? null,
    category: id("category"),
    proof: id("proof"),
    ...(compare === null ? {} : { compare, compareStart, compareEnd }),
    snapshot: id("snapshot"),
    metric: id("metric") ?? "pr_opened",
    limit,
    cursor,
  };
}
/** Historical movement is a board-page capability; the wall has separate scope controls. */
export function rankComparisonPath(path: string): boolean {
  return /^\/leaderboards\/[^/]+$/.test(path) || /^\/projects\/[^/]+$/.test(path);
}
function comparisonParameters(params: URLSearchParams, value: Selection): void {
  for (const key of comparisonKeys) if (value[key]) params.set(key, value[key]);
}
export function parameters(
  value: Selection,
  extra: { metric?: string; snapshot?: string | null; cursor?: string | null; board?: boolean } = {},
): URLSearchParams {
  const params = new URLSearchParams();
  if (value.actors && value.actors !== "all") params.set("actors", value.actors);
  for (const [key, entry] of Object.entries(publicScopeParameters(selectionScope(value)))) params.set(key, entry);
  const pin = extra.snapshot === undefined ? value.snapshot : extra.snapshot;
  if (pin) params.set("snapshot", pin);
  if (extra.board) {
    comparisonParameters(params, value);
    params.set("metric", extra.metric ?? value.metric);
    params.set("limit", value.limit);
  }
  if (extra.cursor) params.set("cursor", extra.cursor);
  return params;
}
export function uiHref(
  path: string,
  value: Selection,
  extra: { snapshot?: string | null; cursor?: string | null; metric?: string } = {},
): string {
  const params = parameters(value, { ...extra, board: false });
  params.set("metric", extra.metric ?? value.metric);
  params.set("limit", value.limit);
  params.set("ui", "api");
  if (rankComparisonPath(path)) comparisonParameters(params, value);
  if (value.timeZone && value.timeZone !== defaultDisplayTimeZone) params.set("tz", value.timeZone);
  if ((path.startsWith("/contributors") || path === "/activity" || path.startsWith("/activity/")) && value.category)
    params.set("category", value.category);
  if (path === "/contributors" && value.search) params.set("search", value.search);
  if (path === "/leaderboards" || path === "/methodology" || path === "/methodology/changes") {
    if (value.catalogQuery) params.set("q", value.catalogQuery);
    if (value.department) {
      if (!validDepartmentId(value.department)) throw new ReadFailure(400, "invalid_identifier");
      params.set("department", value.department);
    }
  }
  if (extra.cursor) params.set("cursor", extra.cursor);
  return `${path}?${params}`;
}
function configuredServiceBase(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw, window.location.origin);
  } catch {
    throw new ReadFailure(500, "invalid_public_api_configuration");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && url.origin !== window.location.origin) ||
    !/^\/(?!\/)[A-Za-z0-9/_-]+$/.test(url.pathname)
  )
    throw new ReadFailure(500, "invalid_public_api_configuration");
  return url;
}
export function apiBase(raw = "/api/v1"): string {
  const url = configuredServiceBase(raw);
  return url.href.replace(/\/$/, "");
}
/** An explicitly configured top-level account link, never a public request base. */
export function controlsNavigationBase(raw: string): string {
  return configuredServiceBase(raw).href.replace(/\/$/, "");
}
export function publicLink(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    return url.origin === "https://github.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      (!url.hash ||
        /^#(?:issuecomment-\d+|pullrequestreview-\d+|discussion_r\d+|r\d+|discussioncomment-\d+)$/.test(url.hash)) &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./~-]+)?$/.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
const maxResponseBytes = 2_000_000;
function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}
async function readBytes(response: Response, signal: AbortSignal, maxBytes = maxResponseBytes): Promise<Uint8Array> {
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > maxBytes)) {
    discardBody(response);
    throw new ReadFailure(502, "api_response_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ReadFailure(502, "invalid_api_response");
  // Abort the reader as well as fetch: a response may already have arrived, or
  // a supplied transport may not propagate cancellation to its body stream.
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    signal.throwIfAborted();
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new ReadFailure(502, "api_response_too_large");
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    // An underlying cancel hook must not keep a failed request pending forever.
    cancel();
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}
function publicRequestURL(base: string, path: string, params: URLSearchParams): string {
  const value = `${base}/${path}${params.size ? `?${params}` : ""}`;
  const url = new URL(value, "https://request.invalid");
  if (url.pathname.length + url.search.length > maxPublicRequestTargetBytes)
    throw new ReadFailure(414, "query_too_large");
  return value;
}
/** Budget both complete live request targets before a subscription can create any transport. */
export function liveParameters(base: string, value: Selection): URLSearchParams {
  const params = parameters(value, { snapshot: null });
  publicRequestURL(base, "health", params);
  publicRequestURL(base, "updates", params);
  return params;
}
export async function request(
  base: string,
  path: string,
  params: URLSearchParams,
  signal: AbortSignal,
  selectedForDisabledMetric?: Selection,
): Promise<unknown> {
  // Only the board caller can opt in to structured disable details. Bind them
  // to a copy of the exact request, not to a later navigation or arbitrary error.
  const disabledSelection = selectedForDisabledMetric
    ? {
        ...selectedForDisabledMetric,
        ...(selectedForDisabledMetric.projects === undefined
          ? {}
          : { projects: [...selectedForDisabledMetric.projects] }),
        ...(selectedForDisabledMetric.roles === undefined ? {} : { roles: [...selectedForDisabledMetric.roles] }),
      }
    : null;
  const expected = disabledSelection
    ? parameters(disabledSelection, { board: true, cursor: disabledSelection.cursor })
    : null;
  const supplied = new URLSearchParams(params);
  expected?.sort();
  supplied.sort();
  const acceptDisabled = path === "boards" && expected?.toString() === supplied.toString();
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  requestSignal.throwIfAborted();
  const response = await fetch(publicRequestURL(base, path, params), {
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal: requestSignal,
    headers: { accept: "application/json" },
  });
  if (requestSignal.aborted) {
    discardBody(response);
    requestSignal.throwIfAborted();
  }
  if (
    response.redirected ||
    response.type === "opaqueredirect" ||
    !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "")
  ) {
    discardBody(response);
    throw new ReadFailure(
      response.ok ? 502 : response.status,
      response.ok ? "invalid_api_response" : `http_${response.status}`,
    );
  }
  const joined = await readBytes(response, requestSignal);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
  } catch {
    throw new ReadFailure(502, "invalid_api_response");
  }
  // Bound error bodies too, and show only controlled machine codes.
  if (!response.ok) {
    const code = (parsed as { error?: unknown } | null)?.error;
    if (response.status === 503 && code === "metric_disabled" && acceptDisabled && disabledSelection) {
      const meta = metadata(parsed, disabledSelection);
      const detail = disabledMetric(object(parsed).metric);
      const member = meta.disabledMetrics.find((item) => item.id === detail.id);
      if (
        detail.id !== disabledSelection.metric ||
        !member ||
        member.reason !== detail.reason ||
        member.policyVersion !== detail.policyVersion ||
        member.policyLink !== detail.policyLink
      )
        throw new ReadFailure(502, "invalid_disabled_metric_response");
      throw new ReadFailure(response.status, code, detail);
    }
    throw new ReadFailure(
      response.status,
      typeof code === "string" && /^[a-z0-9_:-]{1,100}$/.test(code) ? code : `http_${response.status}`,
    );
  }
  return parsed;
}
export async function exportPage(
  base: string,
  selected: Selection,
  format: "json" | "csv",
  signal: AbortSignal,
  expectedMetric: MetricDefinition,
): Promise<Blob> {
  const params = parameters(selected, { board: true, cursor: selected.cursor });
  params.set("format", format);
  if (!selected.snapshot) throw new ReadFailure(400, "export_requires_displayed_snapshot");
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  requestSignal.throwIfAborted();
  const response = await fetch(publicRequestURL(base, "exports", params), {
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal: requestSignal,
  });
  if (requestSignal.aborted) {
    discardBody(response);
    requestSignal.throwIfAborted();
  }
  if (!response.ok) {
    discardBody(response);
    throw new ReadFailure(response.status, `export_http_${response.status}`);
  }
  const type = format === "json" ? "application/json" : "text/csv";
  if (
    response.redirected ||
    response.type === "opaqueredirect" ||
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== type
  ) {
    discardBody(response);
    throw new ReadFailure(502, "invalid_export_response");
  }
  if ((response.headers.get("x-leaderboard-actor-filter") ?? "all") !== (selected.actors ?? "all")) {
    discardBody(response);
    throw new ReadFailure(502, "api_actor_filter_mismatch");
  }
  const bytes = await readBytes(response, requestSignal, maxExportResponseBytes);
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ReadFailure(502, "invalid_export_response");
  }
  try {
    validateExport(
      format === "json" ? parseExportJSON(raw) : parseCSVExport(raw, expectedMetric, Number(selected.limit)),
      selected,
      expectedMetric,
    );
  } catch {
    throw new ReadFailure(502, "invalid_export_response");
  }
  return new Blob([raw], { type });
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReadFailure(502, "invalid_api_response");
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 4096) throw new ReadFailure(502, "invalid_api_response");
  return value;
};
const timestamp = (value: unknown): string => {
  const parsed = snapshotSchema.shape.generatedAt.safeParse(string(value));
  if (!parsed.success) throw new ReadFailure(502, "invalid_api_response");
  return parsed.data;
};
const identity = (value: unknown) => {
  const parsed = string(value);
  if (!identifier.test(parsed)) throw new ReadFailure(502, "invalid_api_response");
  return parsed;
};
const integer = (value: unknown) => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ReadFailure(502, "invalid_api_response");
  return Number(value);
};
const array = (value: unknown, maximum = 10000): unknown[] => {
  if (!Array.isArray(value) || value.length > maximum) throw new ReadFailure(502, "invalid_api_response");
  return value;
};
function actorSelection(data: Record<string, unknown>, selected: Selection): ActorFilter {
  // Missing labels on legacy responses mean only the existing all-activity view.
  const parsed = actorFilterSchema.safeParse(data.actorFilter ?? "all");
  if (!parsed.success || parsed.data !== (selected.actors ?? "all"))
    throw new ReadFailure(502, "api_actor_filter_mismatch");
  return parsed.data;
}
function selectedActor(value: unknown, selected: Selection): Actor {
  const actor = actorSchema.parse(value);
  if (!matchesActorFilter(actor, selected.actors ?? "all")) throw new ReadFailure(502, "api_actor_filter_mismatch");
  return actor;
}
function descriptiveMetric(metric: MetricDefinition): boolean {
  return (
    metric.definition.display_policy === "spotlight" ||
    metric.definition.release_eligibility === "descriptive-only" ||
    ["ratio", "median_and_p75_of_elapsed_hours"].includes(metric.definition.aggregation)
  );
}
export interface RankComparison {
  rankingPresentation?: RankingPresentation;
  snapshotId: string | null;
  scope: PublicScope | null;
  generatedAt: string | null;
}
export type RankMovement =
  | { actorId: string; state: "comparable"; delta: number; reason: null }
  | { actorId: string; state: "new_entrant"; delta: null; reason: null }
  | { actorId: string; state: "unavailable"; delta: null; reason: string };
function invalidComparison(): never {
  throw new ReadFailure(502, "invalid_rank_comparison");
}
function comparisonTime(value: unknown): string {
  const parsed = sourceEventSchema.shape.occurredAt.safeParse(value);
  if (!parsed.success || parsed.data === null) invalidComparison();
  return parsed.data;
}
function comparisonObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const data = object(value);
  if (Object.keys(data).some((key) => !keys.includes(key))) invalidComparison();
  return data;
}
function rankComparison(
  value: unknown,
  selected: Selection,
  generatedAt: unknown,
  currentPresentation: RankingPresentation | null,
): RankComparison | undefined {
  if (!selected.compare) {
    if (value !== undefined) invalidComparison();
    return undefined;
  }
  comparisonTime(generatedAt);
  const data = comparisonObject(value, ["snapshotId", "scope", "generatedAt", "rankingPresentation"]);
  if (data.snapshotId === null && data.scope === null && data.generatedAt === null) {
    if (data.rankingPresentation !== undefined) invalidComparison();
    return { snapshotId: null, scope: null, generatedAt: null };
  }
  if (data.snapshotId !== selected.compare || data.scope === null || data.generatedAt === null) invalidComparison();
  let scope: PublicScope;
  try {
    scope = responseScope(
      data.scope,
      selectionScope({
        ...selected,
        start: selected.compareStart ?? selected.start,
        end: selected.compareEnd ?? selected.end,
      }),
    );
  } catch {
    invalidComparison();
  }
  const previous = rankingPresentationSchema.safeParse(data.rankingPresentation);
  if (
    !currentPresentation ||
    !previous.success ||
    currentPresentation.state !== "ranked" ||
    previous.data.state !== "ranked" ||
    previous.data.snapshotId !== selected.compare ||
    previous.data.metricId !== selected.metric ||
    previous.data.version !== currentPresentation.version ||
    previous.data.minimumComparableContributors !== currentPresentation.minimumComparableContributors ||
    previous.data.cohort !== currentPresentation.cohort ||
    previous.data.purpose !== currentPresentation.purpose
  )
    invalidComparison();
  return {
    snapshotId: selected.compare,
    scope,
    generatedAt: comparisonTime(data.generatedAt),
    rankingPresentation: previous.data,
  };
}
function rankMovement(
  value: unknown,
  actorId: string,
  rank: number | null,
  rankedValue: boolean,
  comparison: RankComparison | undefined,
  selected: Selection,
): RankMovement | undefined {
  if (comparison === undefined) {
    if (value !== undefined) invalidComparison();
    return undefined;
  }
  const data = comparisonObject(value, ["actorId", "state", "delta", "reason"]);
  if (data.actorId !== actorId) invalidComparison();
  if (data.state === "unavailable") {
    if (data.delta !== null || typeof data.reason !== "string" || !/^[a-z][a-z0-9_]{0,119}$/.test(data.reason))
      invalidComparison();
    return { actorId, state: "unavailable", delta: null, reason: data.reason };
  }
  if (
    comparison.snapshotId === null ||
    comparison.generatedAt === null ||
    (selected.actors ?? "all") !== "all" ||
    rank === null ||
    !rankedValue ||
    data.reason !== null
  )
    invalidComparison();
  if (data.state === "new_entrant" && data.delta === null)
    return { actorId, state: "new_entrant", delta: null, reason: null };
  if (
    data.state !== "comparable" ||
    typeof data.delta !== "number" ||
    !Number.isSafeInteger(data.delta) ||
    !Number.isSafeInteger(rank + data.delta) ||
    rank + data.delta < 1 ||
    rank + data.delta > (comparison.rankingPresentation?.comparableContributors ?? 0)
  )
    invalidComparison();
  return { actorId, state: "comparable", delta: data.delta, reason: null };
}

/** Successful policy receipts bind the complete current cohort, never just this page. */
function presentedRanking(
  value: unknown,
  snapshotId: string,
  metricId: string,
  totalRows: number,
  ranking: Record<string, unknown> | null,
): RankingPresentation | null {
  if (value === undefined) return null;
  const parsed = rankingPresentationSchema.safeParse(value);
  if (!parsed.success) throw new ReadFailure(502, "invalid_ranking_presentation");
  const receipt = parsed.data;
  if (
    receipt.snapshotId !== snapshotId ||
    receipt.metricId !== metricId ||
    receipt.totalContributors !== totalRows ||
    (ranking?.rank === true) !== (receipt.state !== "not_ranked") ||
    (ranking !== null && ranking.metricId !== metricId)
  )
    throw new ReadFailure(502, "invalid_ranking_presentation");
  return receipt;
}
function presentedRow(receipt: RankingPresentation | null, result: MetricResult, rank: number | null): void {
  if (receipt === null) return;
  const ranked = receipt.state === "ranked" && result.value !== undefined;
  if ((rank !== null) !== ranked || (rank !== null && rank > receipt.comparableContributors))
    throw new ReadFailure(502, "invalid_ranking_presentation");
}

/** A page is a subset, never a replacement for complete cohort enumeration. */
function presentedPage(receipt: RankingPresentation | null, results: readonly MetricResult[]): void {
  if (receipt === null) return;
  const comparable = receipt.state === "not_ranked" ? 0 : results.filter((result) => result.value !== undefined).length;
  if (
    results.length > receipt.totalContributors ||
    comparable > receipt.comparableContributors ||
    results.length - comparable > receipt.unrankableContributors
  )
    throw new ReadFailure(502, "invalid_ranking_presentation");
}

function physicalPresentation(
  value: unknown,
  binding: Parameters<typeof bindPublicPhysicalContext>[1],
): PublicPhysicalContext {
  try {
    return bindPublicPhysicalContext(value, binding);
  } catch {
    throw new ReadFailure(502, "invalid_physical_context");
  }
}

/** Validate the minimized export contract, which intentionally has no actor profile or live head. */
export function validateExport(value: unknown, selected: Selection, expectedMetric: MetricDefinition): void {
  const data = object(value);
  const scope = validatedScope(data.scope, selected);
  onlyExportKeys(data, [
    "exportSchemaVersion",
    "schemaVersion",
    "snapshotId",
    "revision",
    "generatedAt",
    "metricDefinitionVersion",
    "computationVersion",
    "policyVersion",
    "scope",
    "actorFilter",
    "metric",
    "ranking",
    "rankingPresentation",
    "coverage",
    "methodology",
    "totalRows",
    "pageRows",
    "nextCursor",
    "diagnostics",
    "rows",
    "evidence",
    "pendingEvidence",
    "comparison",
  ]);
  const presented = data.exportSchemaVersion === "public-export/v4";
  if (
    (!presented && data.exportSchemaVersion !== scopeExportVersion(scope)) ||
    data.schemaVersion !== "leaderboard/v1" ||
    presented !== Object.hasOwn(data, "rankingPresentation")
  )
    throw new ReadFailure(502, "invalid_export_response");
  const filter = actorSelection(data, selected);
  if (!selected.snapshot || identity(data.snapshotId) !== selected.snapshot)
    throw new ReadFailure(502, "api_snapshot_mismatch");
  integer(data.revision);
  timestamp(data.generatedAt);
  identity(data.metricDefinitionVersion);
  identity(data.computationVersion);
  identity(data.policyVersion);
  const metric = metricDefinitionSchema.parse(data.metric);
  if (metric.id !== selected.metric) throw new ReadFailure(502, "api_metric_mismatch");
  if (!expectedMetric || stableJSON(metric) !== stableJSON(expectedMetric))
    throw new ReadFailure(502, "api_metric_definition_mismatch");
  const ranking = data.ranking === null ? null : object(data.ranking);
  if (ranking) onlyExportKeys(ranking, ["metricId", "direction", "rank"]);
  if (
    ranking &&
    (ranking.metricId !== metric.id ||
      typeof ranking.direction !== "string" ||
      !["ascending", "descending"].includes(ranking.direction) ||
      typeof ranking.rank !== "boolean" ||
      (descriptiveMetric(metric) && ranking.rank !== false))
  )
    throw new ReadFailure(502, "invalid_export_response");
  array(data.coverage, 500).forEach((item) => coverageSchema.parse(item));
  const rows = array(data.rows, Number(selected.limit));
  if (integer(data.pageRows) !== rows.length || integer(data.totalRows) < rows.length)
    throw new ReadFailure(502, "invalid_export_response");
  if (data.nextCursor !== null) string(data.nextCursor);
  const presentation = presentedRanking(
    data.rankingPresentation,
    selected.snapshot,
    metric.id,
    integer(data.totalRows),
    ranking,
  );
  const physicalMethodology = array(data.methodology, 98).map((value) => {
    const entry = object(value);
    return {
      metricId: identity(entry.metricId),
      policyVersion: identity(entry.policyVersion),
      policySignature: string(entry.policySignature),
    };
  });
  const exportEvidence = new Map<string, Record<string, unknown>>();
  const evidenceBindings = new Map<string, string>();
  const bindEvidence = (id: string, entry: Record<string, unknown>) => {
    const binding = stableJSON(entry),
      previous = evidenceBindings.get(id);
    if (previous !== undefined && previous !== binding) throw new ReadFailure(502, "invalid_export_response");
    evidenceBindings.set(id, binding);
  };
  const comparison = rankComparison(data.comparison, selected, data.generatedAt, presentation);
  const evidenceIds = new Set<string>();
  for (const value of array(data.evidence, 2000)) {
    const entry = object(value),
      id = identity(entry.evidenceId);
    onlyExportKeys(entry, [
      "evidenceId",
      "repositoryId",
      "sourceUrl",
      "occurredAt",
      "sourceRevision",
      "sourceRevisionUrl",
    ]);
    bindEvidence(id, entry);
    if (evidenceIds.has(id) || publicLink(string(entry.sourceUrl)) === null)
      throw new ReadFailure(502, "invalid_export_response");
    evidenceIds.add(id);
    exportEvidence.set(id, entry);
    if (entry.repositoryId !== null) identity(entry.repositoryId);
    if (entry.occurredAt !== null) timestamp(entry.occurredAt);
    if (entry.sourceRevision !== null) string(entry.sourceRevision);
    if (entry.sourceRevisionUrl !== null && publicLink(string(entry.sourceRevisionUrl)) === null)
      throw new ReadFailure(502, "invalid_export_response");
  }
  const pendingIds = new Set<string>();
  for (const value of array(data.pendingEvidence ?? [], 2000)) {
    const entry = object(value),
      id = identity(entry.evidenceId);
    onlyExportKeys(entry, [
      "evidenceId",
      "repositoryId",
      "sourceUrl",
      "occurredAt",
      "sourceRevision",
      "sourceRevisionUrl",
    ]);
    bindEvidence(id, entry);
    if (pendingIds.has(id) || publicLink(string(entry.sourceUrl)) === null)
      throw new ReadFailure(502, "invalid_export_response");
    pendingIds.add(id);
    if (entry.repositoryId !== null) identity(entry.repositoryId);
    if (entry.occurredAt !== null) timestamp(entry.occurredAt);
    if (entry.sourceRevision !== null) string(entry.sourceRevision);
    if (entry.sourceRevisionUrl !== null && publicLink(string(entry.sourceRevisionUrl)) === null)
      throw new ReadFailure(502, "invalid_export_response");
  }
  const referencedPending = new Set<string>();
  const pageActors = new Set<string>(),
    referencedEvidence = new Set<string>();
  const rowPending = new Map<string, PendingCount | undefined>();
  const observedResults: MetricResult[] = [];
  for (const value of rows) {
    const row = object(value),
      result = metricResultSchema.parse(row.result);
    observedResults.push(result);
    onlyExportKeys(row, [
      "actorId",
      "login",
      "actorKind",
      "executionMode",
      "rank",
      "result",
      "evidenceIds",
      "pending",
      "movement",
      ...(presented ? ["physicalContext"] : []),
    ]);
    if (presented !== Object.hasOwn(row, "physicalContext")) throw new ReadFailure(502, "invalid_export_response");
    const actorId = identity(row.actorId);
    if (presented && row.physicalContext !== null) {
      const context = physicalPresentation(row.physicalContext, {
        snapshotId: selected.snapshot,
        actorId,
        metricId: metric.id,
        evidenceIds: array(row.evidenceIds).map(identity),
        value: result.value,
        generatedAt: string(data.generatedAt),
        start: scope.start,
        end: scope.end,
        methodology: physicalMethodology,
      });
      if (context.state === "available")
        for (const sample of context.samples)
          for (const id of sample.evidenceIds) {
            const proof = exportEvidence.get(id);
            if (
              !proof ||
              proof.repositoryId !== sample.repositoryId ||
              proof.sourceUrl !== sample.sourceUrl ||
              proof.occurredAt === null ||
              compareSourceInstants(string(proof.occurredAt), sample.integratedAt) !== 0
            )
              throw new ReadFailure(502, "invalid_physical_context");
          }
    }
    if (pageActors.has(actorId)) throw new ReadFailure(502, "invalid_export_response");
    pageActors.add(actorId);
    if (row.login !== null) string(row.login);
    // Legacy v1 exports may omit these labels; present labels must never certify
    // unsupported kinds or manual execution. Absence remains unknown.
    const actorKind = Object.hasOwn(row, "actorKind") ? actorKindSchema.parse(row.actorKind) : null;
    const executionMode = Object.hasOwn(row, "executionMode") ? executionModeSchema.parse(row.executionMode) : null;
    if (
      filter !== "all" &&
      (actorKind === null || executionMode === null || !matchesActorFilter({ kind: actorKind, executionMode }, filter))
    )
      throw new ReadFailure(502, "api_actor_filter_mismatch");
    if (
      result.metricId !== metric.id ||
      (row.rank !== null && (integer(row.rank) < 1 || ranking?.rank === false || descriptiveMetric(metric)))
    )
      throw new ReadFailure(502, "invalid_export_response");
    presentedRow(presentation, result, row.rank === null ? null : integer(row.rank));
    rankMovement(
      row.movement,
      actorId,
      row.rank === null ? null : integer(row.rank),
      presentation?.state === "ranked" && ranking?.rank === true && result.value !== undefined,
      comparison,
      selected,
    );
    const pending = row.pending === undefined ? undefined : pendingCountSchema.parse(row.pending);
    rowPending.set(actorId, pending);
    if (pending !== undefined)
      for (const id of pending.evidenceIds) {
        if (!pendingIds.has(id)) throw new ReadFailure(502, "invalid_export_response");
        referencedPending.add(id);
      }
    for (const id of array(row.evidenceIds)) {
      const evidenceId = identity(id);
      if (!evidenceIds.has(evidenceId)) throw new ReadFailure(502, "invalid_export_response");
      referencedEvidence.add(evidenceId);
    }
  }
  presentedPage(presentation, observedResults);
  if (referencedPending.size !== pendingIds.size) throw new ReadFailure(502, "invalid_export_response");
  if (referencedEvidence.size !== evidenceIds.size) throw new ReadFailure(502, "invalid_export_response");
  for (const value of array(data.diagnostics ?? []))
    onlyExportKeys(object(value), [
      "metricId",
      "actorId",
      "numerator",
      "denominator",
      "sampleCount",
      "censored",
      "missingReadiness",
      "p75",
      "pending",
    ]);
  const diagnosticActors = new Set<string>();
  for (const entry of diagnostics(data.diagnostics)) {
    if (
      entry.metricId !== metric.id ||
      !pageActors.has(entry.actorId) ||
      diagnosticActors.has(entry.actorId) ||
      (entry.pending !== undefined && stableJSON(entry.pending) !== stableJSON(rowPending.get(entry.actorId))) ||
      [entry.numerator, entry.denominator, entry.p75].some((value) => value !== null && value < 0)
    )
      throw new ReadFailure(502, "invalid_export_response");
    diagnosticActors.add(entry.actorId);
  }
  for (const value of array(data.methodology, 98)) {
    const entry = object(value);
    onlyExportKeys(entry, ["metricId", "policyVersion", "policySignature", "policyLink"]);
    if (identity(entry.metricId) !== metric.id) throw new ReadFailure(502, "api_metric_mismatch");
    identity(entry.policyVersion);
    string(entry.policySignature);
    if (entry.policyLink !== null && publicLink(string(entry.policyLink)) === null)
      throw new ReadFailure(502, "invalid_export_response");
  }
}
export interface DisabledMetric {
  id: string;
  /** Bounded machine code; never interpreted as public governance prose. */
  reason: string;
  policyVersion: string | null;
  policyLink: string | null;
}
function disabledMetric(value: unknown): DisabledMetric {
  const item = object(value);
  if (typeof item.reason !== "string" || !/^[a-z0-9_:-]{1,100}$/.test(item.reason))
    throw new ReadFailure(502, "invalid_disabled_metric_response");
  if (item.policyLink != null && typeof item.policyLink !== "string")
    throw new ReadFailure(502, "invalid_disabled_metric_response");
  return {
    id: identity(item.id),
    reason: item.reason,
    policyVersion: item.policyVersion == null ? null : identity(item.policyVersion),
    policyLink: publicLink(item.policyLink as string | null | undefined),
  };
}
export interface Metadata {
  scope: PublicScope;
  actorFilter?: ActorFilter;
  snapshotId: string;
  revision: number;
  generatedAt: string;
  metricDefinitionVersion: string;
  computationVersion: string;
  policyVersion: string;
  head: { snapshotId: string; revision: number; publishedAt: string };
  coverage: Coverage[];
  methodology: { metricId: string; policyVersion: string; policySignature: string; policyLink: string | null }[];
  disabledMetrics: DisabledMetric[];
}
function validatedScope(value: unknown, selected: Selection): PublicScope {
  try {
    return responseScope(value, selected);
  } catch {
    throw new ReadFailure(502, "api_scope_mismatch");
  }
}
export function metadata(value: unknown, selected: Selection): Metadata {
  const data = object(value),
    scope = validatedScope(data.scope, selected),
    head = object(data.head);
  if (
    data.schemaVersion !== scopeReadVersion(scope) ||
    (scope.schemaVersion !== undefined
      ? data.snapshotSchemaVersion !== "leaderboard/v1"
      : Object.hasOwn(data, "snapshotSchemaVersion"))
  )
    throw new ReadFailure(502, "invalid_api_response");
  const snapshotId = identity(data.snapshotId);
  if (selected.snapshot && selected.snapshot !== snapshotId) throw new ReadFailure(502, "api_snapshot_mismatch");
  const disabledMetrics = array(data.disabledMetrics ?? [], 98).map(disabledMetric);
  if (new Set(disabledMetrics.map((item) => item.id)).size !== disabledMetrics.length)
    throw new ReadFailure(502, "invalid_disabled_metric_response");
  return {
    scope,
    actorFilter: actorSelection(data, selected),
    snapshotId,
    revision: integer(data.revision),
    generatedAt: timestamp(data.generatedAt),
    metricDefinitionVersion: identity(data.metricDefinitionVersion),
    computationVersion: identity(data.computationVersion),
    policyVersion: identity(data.policyVersion),
    head: {
      snapshotId: identity(head.snapshotId),
      revision: integer(head.revision),
      publishedAt: timestamp(head.publishedAt),
    },
    coverage: array(data.coverage, 500).map((item) => coverageSchema.parse(item)),
    methodology: array(data.methodology ?? [], 98).map((value) => {
      const item = object(value);
      return {
        metricId: identity(item.metricId),
        policyVersion: identity(item.policyVersion),
        policySignature: string(item.policySignature),
        policyLink: publicLink(typeof item.policyLink === "string" ? item.policyLink : null),
      };
    }),
    disabledMetrics,
  };
}
export interface Diagnostic {
  pending?: PendingCount;
  metricId: string;
  actorId: string;
  numerator: number | null;
  denominator: number | null;
  sampleCount: number;
  censored: number;
  missingReadiness: number;
  p75: number | null;
}
function diagnostics(value: unknown): Diagnostic[] {
  const number = (value: unknown) => {
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new ReadFailure(502, "invalid_api_response");
    return value;
  };
  return array(value ?? []).map((value) => {
    const item = object(value);
    return {
      metricId: identity(item.metricId),
      actorId: identity(item.actorId),
      numerator: number(item.numerator),
      denominator: number(item.denominator),
      sampleCount: integer(item.sampleCount),
      censored: integer(item.censored),
      missingReadiness: integer(item.missingReadiness),
      p75: number(item.p75),
      ...(item.pending === undefined ? {} : { pending: pendingCountSchema.parse(item.pending) }),
    };
  });
}
export interface Board extends Metadata {
  comparison?: RankComparison;
  metric: MetricDefinition;
  ranking: { direction: string; rank: boolean } | null;
  rankingPresentation?: RankingPresentation | null;
  rows: {
    rank: number | null;
    actorId: string;
    actor: Actor;
    result: MetricResult;
    evidenceIds: string[];
    pending?: PendingCount;
    movement?: RankMovement;
    physicalContext?: PublicPhysicalContext;
  }[];
  diagnostics: Diagnostic[];
  totalRows: number;
  nextCursor: string | null;
}
export function board(value: unknown, selected: Selection): Board {
  const data = object(value),
    method = data.ranking === null ? null : object(data.ranking);
  const metric = metricDefinitionSchema.parse(data.metric);
  if (
    metric.id !== selected.metric ||
    (method &&
      (typeof method.direction !== "string" ||
        !["ascending", "descending"].includes(method.direction) ||
        typeof method.rank !== "boolean" ||
        (descriptiveMetric(metric) && method.rank !== false)))
  )
    throw new ReadFailure(502, "api_metric_mismatch");
  const meta = metadata(value, selected);
  const presentation = presentedRanking(
    data.rankingPresentation,
    meta.snapshotId,
    metric.id,
    integer(data.totalRows),
    method,
  );
  const comparison = rankComparison(data.comparison, selected, meta.generatedAt, presentation);
  if (comparison && method && method.metricId !== metric.id) invalidComparison();
  if (comparison && meta.disabledMetrics.some((entry) => entry.id === metric.id)) invalidComparison();
  const seen = new Set<string>();
  const parsed: Board = {
    ...meta,
    ...(comparison === undefined ? {} : { comparison }),
    metric,
    ranking: method ? { direction: String(method.direction), rank: method.rank as boolean } : null,
    rankingPresentation: presentation,
    rows: array(data.rows, selected.compare ? Number(selected.limit) : 100).map((value) => {
      const row = object(value),
        result = metricResultSchema.parse(row.result);
      if (
        result.metricId !== metric.id ||
        (row.rank !== null && (integer(row.rank) < 1 || method?.rank === false || descriptiveMetric(metric)))
      )
        throw new ReadFailure(502, "invalid_api_response");
      const actorId = identity(row.actorId);
      const rank = row.rank === null ? null : integer(row.rank);
      presentedRow(presentation, result, rank);
      if (comparison && seen.has(actorId)) invalidComparison();
      if (presentation !== null && seen.has(actorId)) throw new ReadFailure(502, "invalid_ranking_presentation");
      seen.add(actorId);
      const movement = rankMovement(
        row.movement,
        actorId,
        rank,
        presentation?.state === "ranked" && method?.rank === true && result.value !== undefined,
        comparison,
        selected,
      );
      const evidenceIds = array(row.evidenceIds).map(identity);
      const physicalContext =
        row.physicalContext === undefined
          ? undefined
          : physicalPresentation(row.physicalContext, {
              snapshotId: meta.snapshotId,
              actorId,
              metricId: metric.id,
              evidenceIds,
              value: result.value,
              generatedAt: meta.generatedAt,
              start: meta.scope.start,
              end: meta.scope.end,
              methodology: meta.methodology,
            });
      if (physicalContext !== undefined && presentation === null)
        throw new ReadFailure(502, "invalid_physical_context");
      return {
        rank,
        actorId,
        ...(movement === undefined ? {} : { movement }),
        ...(physicalContext === undefined ? {} : { physicalContext }),
        actor: selectedActor(row.actor, selected),
        result,
        evidenceIds,
        ...(row.pending === undefined ? {} : { pending: pendingCountSchema.parse(row.pending) }),
      };
    }),
    diagnostics: diagnostics(data.diagnostics),
    totalRows: integer(data.totalRows),
    nextCursor: data.nextCursor === null ? null : string(data.nextCursor),
  };
  presentedPage(
    presentation,
    parsed.rows.map((row) => row.result),
  );
  return parsed;
}
export interface Evidence {
  evidenceMetadata?: PublicEvidenceMetadata;
  projectContext?: PublicProjectContext;
  artifact: Artifact;
  contribution: Contribution;
  occurredAt: string | null;
  sourceRevision: string | null;
  sourceRevisionUrl: string | null;
  activityState: "observed" | "pending" | "accepted" | "unknown";
  observedAt: string | null;
}
export function evidence(value: unknown, selected?: Selection): Evidence {
  const data = object(value);
  const metadata =
    data.evidenceMetadata === undefined ? undefined : publicEvidenceMetadataSchema.parse(data.evidenceMetadata);
  const contribution = contributionSchema.parse(data.contribution);
  const artifact = artifactSchema.parse(data.artifact);
  let projectContext: PublicProjectContext | undefined;
  if (data.projectContext !== undefined) {
    const parsed = publicProjectContextSchema.safeParse(data.projectContext);
    if (
      !parsed.success ||
      !publicProjectContextMatches(
        parsed.data,
        artifact,
        contribution,
        selected ? (selectionScope(selected).context ?? "event") : parsed.data.basis,
      )
    )
      throw new ReadFailure(502, "invalid_api_response");
    projectContext = parsed.data;
  }
  if (selected?.roles?.length && !selected.roles.some((role) => contribution.roles.includes(role)))
    throw new ReadFailure(502, "api_role_filter_mismatch");
  if (metadata?.acceptedAt && contribution.qualification !== "eligible")
    throw new ReadFailure(502, "invalid_api_response");
  const activityState = data.activityState ?? metadata?.activityState ?? "unknown";
  if (
    metadata &&
    ((data.activityState !== undefined && data.activityState !== metadata.activityState) ||
      (data.observedAt !== undefined && data.observedAt !== metadata.observedAt))
  )
    throw new ReadFailure(502, "invalid_api_response");
  if (typeof activityState !== "string" || !["observed", "pending", "accepted", "unknown"].includes(activityState))
    throw new ReadFailure(502, "invalid_api_response");
  return {
    ...(metadata === undefined ? {} : { evidenceMetadata: metadata }),
    ...(projectContext === undefined ? {} : { projectContext }),
    activityState: activityState as Evidence["activityState"],
    observedAt: activityTime(data.observedAt === undefined ? (metadata?.observedAt ?? null) : data.observedAt),
    artifact,
    contribution,
    occurredAt: activityTime(data.occurredAt),
    sourceRevision: data.sourceRevision === null ? null : string(data.sourceRevision),
    sourceRevisionUrl: publicLink(data.sourceRevisionUrl as string | null),
  };
}
export interface CategoryTotal {
  metricId: string;
  observed: number;
  pending: number;
  accepted: number;
  unknown: number;
}
function categoryTotals(value: unknown): CategoryTotal[] {
  return array(value, 98).map((value) => {
    const item = object(value);
    return {
      metricId: identity(item.metricId),
      observed: integer(item.observed),
      pending: integer(item.pending),
      accepted: integer(item.accepted),
      unknown: integer(item.unknown),
    };
  });
}
export interface Directory extends Metadata {
  contributors: {
    actorId: string;
    actor: Actor;
    roles: string[];
    categories: CategoryTotal[];
    evidenceCount: number;
  }[];
  totalContributors: number;
  nextCursor: string | null;
}
export function directory(value: unknown, selected: Selection): Directory {
  const data = object(value);
  if (data.search !== selected.search || data.category !== selected.category)
    throw new ReadFailure(502, "api_filter_mismatch");
  return {
    ...metadata(value, selected),
    contributors: array(data.contributors, 100).map((value) => {
      const item = object(value);
      return {
        actorId: identity(item.actorId),
        actor: selectedActor(item.actor, selected),
        roles: array(item.roles, 30).map(string),
        categories: categoryTotals(item.categories),
        evidenceCount: integer(item.evidenceCount),
      };
    }),
    totalContributors: integer(data.totalContributors),
    nextCursor: data.nextCursor === null ? null : string(data.nextCursor),
  };
}
export function portfolioParameters(value: Selection, directory = false): URLSearchParams {
  const params = parameters(value);
  params.set("limit", value.limit);
  if (value.cursor) params.set("cursor", value.cursor);
  if (value.category) params.set("category", value.category);
  if (directory && value.search) params.set("search", value.search);
  return params;
}
export interface Profile extends Metadata {
  presentation: PublicProfilePresentation | null;
  actorId: string;
  actor: Actor;
  results: MetricResult[];
  activitySummary: PublicParticipation | null;
  diagnostics: Diagnostic[];
  roleBreakdown: { role: string; contributions: number }[];
  timeline: Evidence[];
  timelineTruncated: boolean;
  nextCursor: string | null;
  categories: CategoryTotal[];
  evidenceCount: number;
}
function completeParticipationCoverage(result: MetricResult, scope: PublicScope, cutoff: string): boolean {
  const coverage = result.coverage;
  return (
    scope.start !== null &&
    scope.end !== null &&
    coverage.state === "complete" &&
    coverage.knownStart !== null &&
    compareSourceInstants(coverage.knownStart, scope.start) <= 0 &&
    coverage.windowStart !== null &&
    compareSourceInstants(coverage.windowStart, scope.start) <= 0 &&
    coverage.windowEnd !== null &&
    compareSourceInstants(coverage.windowEnd, scope.end) >= 0 &&
    coverage.sourceWatermark !== null &&
    compareSourceInstants(coverage.sourceWatermark, scope.end) >= 0 &&
    compareSourceInstants(cutoff, scope.end) >= 0 &&
    coverage.missingPages === 0 &&
    coverage.permissionsMissing.length === 0 &&
    coverage.sourceErrors.length === 0
  );
}
export function profile(value: unknown, selected: Selection): Profile {
  const data = object(value);
  if ((data.category ?? null) !== selected.category) throw new ReadFailure(502, "api_filter_mismatch");
  const results = array(data.results, 98).map((item) => metricResultSchema.parse(item));
  const meta = metadata(value, selected);
  const participation =
    data.activitySummary === undefined ? null : publicParticipationSchema.safeParse(data.activitySummary);
  if (
    participation !== null &&
    (!participation.success ||
      participation.data.denominatorWeeks !== participationWeekDenominator(selected.start, selected.end) ||
      participation.data.metrics.some((entry) => {
        const result = results.find((result) => result.metricId === entry.metricId);
        const earliest = entry.earliestDatedEvidence;
        return (
          result === undefined ||
          ["pr_accepted_rate", "review_wait"].includes(entry.metricId) ||
          (entry.state === "measured" && !completeParticipationCoverage(result, meta.scope, meta.generatedAt)) ||
          (entry.state === "measured" && entry.activeWeeks === 0 && result.value !== 0) ||
          (earliest !== null &&
            ((selected.start !== null && compareSourceInstants(earliest.effectiveAt, selected.start) < 0) ||
              (selected.end !== null && compareSourceInstants(earliest.effectiveAt, selected.end) >= 0)))
        );
      }))
  )
    throw new ReadFailure(502, "invalid_participation_response");
  const presentation = Object.hasOwn(data, "presentation")
    ? publicProfilePresentationSchema.nullable().safeParse(data.presentation)
    : { success: true as const, data: null };
  if (!presentation.success) throw new ReadFailure(502, "invalid_profile_presentation");
  const parsed = {
    ...meta,
    actorId: identity(data.actorId),
    actor: selectedActor(data.actor, selected),
    presentation: presentation.data,
    results,
    activitySummary: participation?.success ? participation.data : null,
    diagnostics: diagnostics(data.diagnostics),
    roleBreakdown: array(data.roleBreakdown, 30).map((value) => {
      const item = object(value);
      return { role: string(item.role), contributions: integer(item.contributions) };
    }),
    timeline: array(data.timeline, 100).map((value) => evidence(value, selected)),
    timelineTruncated: data.timelineTruncated === true,
    nextCursor: data.nextCursor == null ? null : string(data.nextCursor),
    categories: categoryTotals(data.categories ?? []),
    evidenceCount: integer(data.evidenceCount),
  };
  if (
    parsed.presentation !== null &&
    !publicProfilePresentationMatches(parsed.presentation, parsed.actorId, parsed.actor)
  )
    throw new ReadFailure(502, "api_actor_mismatch");
  if (parsed.timeline.some((entry) => entry.contribution.actorId !== parsed.actorId))
    throw new ReadFailure(502, "api_actor_mismatch");
  const category = selected.category;
  if (
    category !== null &&
    (parsed.results.some((result) => result.metricId !== category) ||
      parsed.timeline.some((entry) => !entry.contribution.metricIds.includes(category)))
  )
    throw new ReadFailure(502, "api_filter_mismatch");
  return parsed;
}
export interface Health extends Metadata {
  status: "recently_reconciled" | "stale_or_degraded";
  serviceVersion: string;
  sources: {
    source: string;
    state: string;
    lastSuccessfulSync: string | null;
    reconciledThrough: string | null;
    collectionState: string;
  }[];
}
export function health(value: unknown, selected: Selection): Health {
  const data = object(value);
  if (typeof data.status !== "string" || !["recently_reconciled", "stale_or_degraded"].includes(data.status))
    throw new ReadFailure(502, "invalid_api_response");
  return {
    ...metadata(value, selected),
    status: data.status as Health["status"],
    serviceVersion: string(data.serviceVersion),
    sources: array(data.sources, 500).map((value) => {
      const item = object(value);
      return {
        source: string(item.source),
        state: string(item.state),
        lastSuccessfulSync: item.lastSuccessfulSync === null ? null : string(item.lastSuccessfulSync),
        reconciledThrough: item.reconciledThrough === null ? null : string(item.reconciledThrough),
        collectionState: string(item.collectionState),
      };
    }),
  };
}
export function catalog(value: unknown): MetricRegistry {
  const parsed = metricRegistrySchema.safeParse(value);
  if (!parsed.success) throw new ReadFailure(502, "invalid_metric_registry");
  // Reject non-transportable identities before a form or link can select another department.
  if (
    parsed.data.ui_metadata.decision_state === "candidate" &&
    parsed.data.ui_metadata.departments.some((department) => !validDepartmentId(department.id))
  )
    throw new ReadFailure(502, "invalid_metric_registry");
  return parsed.data;
}

export interface ActivityGroup {
  groupId: string;
  actorId: string;
  actor: Actor;
  repositoryId: string | null;
  activityState: Evidence["activityState"];
  latestOccurredAt: string | null;
  earliestOccurredAt: string | null;
  firstCollectedAt: string | null;
  lastCollectedAt: string | null;
  unknownCollectionCount: number;
  artifactCount: number;
  factCount: number;
  proofCount: number;
  categoryIds: string[];
  artifactPreview: { artifactId: string; kind: Artifact["kind"]; publicUrl: string }[];
}
export interface Activity extends Metadata {
  groups: ActivityGroup[];
  totalGroups: number;
  nextCursor: string | null;
}
export interface ActivityDetail extends Metadata {
  group: ActivityGroup;
  proofs: (Evidence & { canonicalFactId: string })[];
  nextCursor: string | null;
}
const activityDigest = (value: unknown) => {
  const result = string(value);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new ReadFailure(502, "invalid_activity_response");
  return result;
};
const activityTime = (value: unknown): string | null => {
  const result = sourceEventSchema.shape.occurredAt.safeParse(value);
  if (!result.success) throw new ReadFailure(502, "invalid_activity_response");
  return result.data;
};
function activityContract(value: unknown, selected: Selection) {
  const data = object(value);
  if (data.category !== selected.category) throw new ReadFailure(502, "api_filter_mismatch");
  if (
    data.groupingVersion !== "actor-repository-state-utc-hour-v1" ||
    data.previewLimit !== 5 ||
    typeof data.correctionHistory !== "string" ||
    !["not_supplied", "per_proof"].includes(data.correctionHistory)
  )
    throw new ReadFailure(502, "invalid_activity_response");
  return data;
}
export function activityGroup(value: unknown, selected: Selection): ActivityGroup {
  const data = object(value);
  const state = data.activityState;
  if (typeof state !== "string" || !["observed", "pending", "accepted", "unknown"].includes(state))
    throw new ReadFailure(502, "invalid_activity_response");
  const result: ActivityGroup = {
    groupId: activityDigest(data.groupId),
    actorId: identity(data.actorId),
    actor: selectedActor(data.actor, selected),
    repositoryId: data.repositoryId === null ? null : identity(data.repositoryId),
    activityState: state as Evidence["activityState"],
    latestOccurredAt: activityTime(data.latestOccurredAt),
    earliestOccurredAt: activityTime(data.earliestOccurredAt),
    firstCollectedAt: activityTime(data.firstCollectedAt),
    lastCollectedAt: activityTime(data.lastCollectedAt),
    unknownCollectionCount: integer(data.unknownCollectionCount),
    artifactCount: integer(data.artifactCount),
    factCount: integer(data.factCount),
    proofCount: integer(data.proofCount),
    categoryIds: array(data.categoryIds, 98).map(identity),
    artifactPreview: array(data.artifactPreview, 5).map((value) => {
      const item = object(value),
        artifactId = item.artifactId;
      const artifact = artifactSchema.parse({
        schemaVersion: "leaderboard/v1",
        source: "github",
        visibility: "public",
        kind: item.kind,
        stableId: artifactId,
        publicUrl: item.publicUrl,
      });
      const publicUrl = publicLink(artifact.publicUrl);
      if (!publicUrl || !artifact.stableId || artifact.stableId !== artifactId)
        throw new ReadFailure(502, "invalid_activity_response");
      return { artifactId: artifact.stableId, kind: artifact.kind, publicUrl };
    }),
  };
  if (
    result.actor.identityState !== "resolved" ||
    result.artifactCount < 1 ||
    result.factCount < result.artifactCount ||
    result.proofCount < result.factCount ||
    result.proofCount > 20000 ||
    result.unknownCollectionCount > result.proofCount ||
    result.artifactPreview.length !== Math.min(5, result.artifactCount) ||
    new Set(result.artifactPreview.map((item) => item.artifactId)).size !== result.artifactPreview.length ||
    !result.categoryIds.length ||
    new Set(result.categoryIds).size !== result.categoryIds.length ||
    (selected.category !== null && !result.categoryIds.includes(selected.category)) ||
    (selected.repository !== null && result.repositoryId !== selected.repository) ||
    (result.latestOccurredAt === null) !== (result.earliestOccurredAt === null) ||
    (result.firstCollectedAt === null) !== (result.lastCollectedAt === null) ||
    (result.latestOccurredAt !== null &&
      result.earliestOccurredAt !== null &&
      (compareSourceInstants(result.earliestOccurredAt, result.latestOccurredAt) > 0 ||
        Math.floor(Date.parse(result.earliestOccurredAt) / 3600000) !==
          Math.floor(Date.parse(result.latestOccurredAt) / 3600000))) ||
    (result.firstCollectedAt !== null &&
      result.lastCollectedAt !== null &&
      compareSourceInstants(result.firstCollectedAt, result.lastCollectedAt) > 0) ||
    (selected.start !== null &&
      (result.earliestOccurredAt === null || compareSourceInstants(result.earliestOccurredAt, selected.start) < 0)) ||
    (selected.end !== null &&
      (result.latestOccurredAt === null || compareSourceInstants(result.latestOccurredAt, selected.end) >= 0))
  )
    throw new ReadFailure(502, "invalid_activity_response");
  return result;
}
export function activity(value: unknown, selected: Selection): Activity {
  const data = activityContract(value, selected);
  const groups = array(data.groups, Number(selected.limit)).map((value) => activityGroup(value, selected));
  const totalGroups = integer(data.totalGroups);
  if (
    new Set(groups.map((group) => group.groupId)).size !== groups.length ||
    totalGroups < groups.length ||
    totalGroups > 20000
  )
    throw new ReadFailure(502, "invalid_activity_response");
  return {
    ...metadata(value, selected),
    groups,
    totalGroups,
    nextCursor: data.nextCursor === null ? null : string(data.nextCursor),
  };
}
export function activityDetail(value: unknown, selected: Selection): ActivityDetail {
  const data = activityContract(value, selected),
    group = activityGroup(data.group, selected);
  const proofs = array(data.proofs, Number(selected.limit)).map((value) => {
    const item = object(value),
      result = evidence(value, selected);
    if (
      result.contribution.actorId !== group.actorId ||
      result.activityState !== group.activityState ||
      result.artifact.visibility !== "public" ||
      !publicLink(result.artifact.publicUrl) ||
      result.contribution.artifactId !== result.artifact.stableId ||
      (result.artifact.repositoryId ?? null) !== group.repositoryId ||
      result.contribution.qualification !== "eligible" ||
      result.contribution.roles.includes("unknown") ||
      !result.contribution.metricIds.length ||
      result.contribution.metricIds.some((id) => !group.categoryIds.includes(id)) ||
      (selected.category !== null && !result.contribution.metricIds.includes(selected.category)) ||
      (result.occurredAt === null) !== (group.latestOccurredAt === null) ||
      (result.occurredAt !== null &&
        group.latestOccurredAt !== null &&
        group.earliestOccurredAt !== null &&
        (compareSourceInstants(result.occurredAt, group.latestOccurredAt) > 0 ||
          compareSourceInstants(result.occurredAt, group.earliestOccurredAt) < 0))
    )
      throw new ReadFailure(502, "invalid_activity_response");
    return {
      ...result,
      occurredAt: activityTime(result.occurredAt),
      observedAt: activityTime(result.observedAt),
      canonicalFactId: activityDigest(item.canonicalFactId),
    };
  });
  if (
    proofs.length > group.proofCount ||
    new Set(proofs.map((proof) => proof.contribution.contributionId)).size !== proofs.length
  )
    throw new ReadFailure(502, "invalid_activity_response");
  return {
    ...metadata(value, selected),
    group,
    proofs,
    nextCursor: data.nextCursor === null ? null : string(data.nextCursor),
  };
}
