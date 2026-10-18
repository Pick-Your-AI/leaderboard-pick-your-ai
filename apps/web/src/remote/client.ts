import { stableJSON } from "@pick-your-ai/metrics";
import { parseCSVExport } from "./csv-export.ts";
import { onlyExportKeys, parseExportJSON } from "./export-json.ts";
import {
  compareSourceInstants,
  actorFilterSchema,
  actorKindSchema,
  executionModeSchema,
  matchesActorFilter,
  type ActorFilter,
  publicEvidenceMetadataSchema,
  type PublicEvidenceMetadata,
  actorSchema,
  artifactSchema,
  contributionSchema,
  coverageSchema,
  metricDefinitionSchema,
  metricRegistrySchema,
  metricResultSchema,
  sourceEventSchema,
  pendingCountSchema,
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
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const identifier = /^[A-Za-z0-9_.:-]{1,200}$/;
const scopeKeys = ["organization", "repository", "workstream", "start", "end"] as const;
const supported = new Set([
  "actors",
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
]);
export interface Selection {
  actors?: ActorFilter;
  organization: string;
  repository: string | null;
  workstream: string | null;
  start: string | null;
  end: string | null;
  snapshot: string | null;
  limit: string;
  cursor: string | null;
  metric: string;
  search: string | null;
  category: string | null;
  proof?: string | null;
  /** Local catalog discovery only; never sent as a source-data filter. */
  catalogQuery?: string | null;
  department?: string | null;
}
export function selection(query: string): Selection {
  const params = new URLSearchParams(query);
  for (const key of params.keys())
    if (!supported.has(key) || params.getAll(key).length !== 1)
      throw new ReadFailure(400, "unsupported_or_duplicate_filter");
  const actorFilter = actorFilterSchema.safeParse(params.get("actors") ?? "all");
  if (!actorFilter.success) throw new ReadFailure(400, "invalid_actor_filter");
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
  const limit = params.get("limit") ?? "50";
  if (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100) throw new ReadFailure(400, "invalid_page_limit");
  const cursor = params.get("cursor");
  if (cursor !== null && (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 2048))
    throw new ReadFailure(400, "invalid_cursor");
  const catalogQuery = params.get("q");
  if (catalogQuery !== null && (catalogQuery.length > 120 || /[\u0000-\u001f\u007f]/.test(catalogQuery)))
    throw new ReadFailure(400, "invalid_catalog_query");
  const search = params.get("search");
  if (search !== null && !/^[A-Za-z0-9-]{1,39}$/.test(search)) throw new ReadFailure(400, "invalid_search");
  return {
    actors: actorFilter.data,
    catalogQuery: catalogQuery?.trim() || null,
    department: id("department"),
    search: search?.toLowerCase() ?? null,
    category: id("category"),
    proof: id("proof"),
    organization: id("organization") ?? "Pick-Your-AI",
    repository: id("repository"),
    workstream: id("workstream"),
    start,
    end,
    snapshot: id("snapshot"),
    metric: id("metric") ?? "pr_opened",
    limit,
    cursor,
  };
}
export function parameters(
  value: Selection,
  extra: { metric?: string; snapshot?: string | null; cursor?: string | null; board?: boolean } = {},
): URLSearchParams {
  const params = new URLSearchParams();
  if (value.actors && value.actors !== "all") params.set("actors", value.actors);
  for (const key of scopeKeys) if (value[key] !== null) params.set(key, value[key]);
  const pin = extra.snapshot === undefined ? value.snapshot : extra.snapshot;
  if (pin) params.set("snapshot", pin);
  if (extra.board) {
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
  if ((path.startsWith("/contributors") || path === "/activity" || path.startsWith("/activity/")) && value.category)
    params.set("category", value.category);
  if (path === "/contributors" && value.search) params.set("search", value.search);
  if (path === "/leaderboards" || path === "/methodology" || path === "/methodology/changes") {
    if (value.catalogQuery) params.set("q", value.catalogQuery);
    if (value.department) params.set("department", value.department);
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
async function readBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > maxResponseBytes)) {
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
      if (bytes > maxResponseBytes) throw new ReadFailure(502, "api_response_too_large");
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
export async function request(
  base: string,
  path: string,
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<unknown> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  requestSignal.throwIfAborted();
  const response = await fetch(`${base}/${path}${params.size ? `?${params}` : ""}`, {
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
  const response = await fetch(`${base}/exports?${params}`, {
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
  const bytes = await readBytes(response, requestSignal);
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
    metric.definition.release_eligibility === "descriptive-only" ||
    ["ratio", "median_and_p75_of_elapsed_hours"].includes(metric.definition.aggregation)
  );
}
/** Validate the minimized export contract, which intentionally has no actor profile or live head. */
export function validateExport(value: unknown, selected: Selection, expectedMetric: MetricDefinition): void {
  const data = object(value),
    scope = object(data.scope);
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
    "coverage",
    "methodology",
    "totalRows",
    "pageRows",
    "nextCursor",
    "diagnostics",
    "rows",
    "evidence",
    "pendingEvidence",
  ]);
  onlyExportKeys(scope, scopeKeys);
  if (data.exportSchemaVersion !== "public-export/v1" || data.schemaVersion !== "leaderboard/v1")
    throw new ReadFailure(502, "invalid_export_response");
  const filter = actorSelection(data, selected);
  for (const key of scopeKeys) if (scope[key] !== selected[key]) throw new ReadFailure(502, "api_scope_mismatch");
  if (!selected.snapshot || identity(data.snapshotId) !== selected.snapshot)
    throw new ReadFailure(502, "api_snapshot_mismatch");
  integer(data.revision);
  string(data.generatedAt);
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
  const evidenceBindings = new Map<string, string>();
  const bindEvidence = (id: string, entry: Record<string, unknown>) => {
    const binding = stableJSON(entry),
      previous = evidenceBindings.get(id);
    if (previous !== undefined && previous !== binding) throw new ReadFailure(502, "invalid_export_response");
    evidenceBindings.set(id, binding);
  };
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
    if (entry.repositoryId !== null) identity(entry.repositoryId);
    if (entry.occurredAt !== null) string(entry.occurredAt);
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
    if (entry.occurredAt !== null) string(entry.occurredAt);
    if (entry.sourceRevision !== null) string(entry.sourceRevision);
    if (entry.sourceRevisionUrl !== null && publicLink(string(entry.sourceRevisionUrl)) === null)
      throw new ReadFailure(502, "invalid_export_response");
  }
  const referencedPending = new Set<string>();
  const pageActors = new Set<string>(),
    referencedEvidence = new Set<string>();
  const rowPending = new Map<string, PendingCount | undefined>();
  for (const value of rows) {
    const row = object(value),
      result = metricResultSchema.parse(row.result);
    onlyExportKeys(row, ["actorId", "login", "actorKind", "executionMode", "rank", "result", "evidenceIds", "pending"]);
    const actorId = identity(row.actorId);
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
export interface Metadata {
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
  disabledMetrics: { id: string; reason: string }[];
}
export function metadata(value: unknown, selected: Selection): Metadata {
  const data = object(value),
    scope = object(data.scope),
    head = object(data.head);
  for (const key of scopeKeys) if (scope[key] !== selected[key]) throw new ReadFailure(502, "api_scope_mismatch");
  const snapshotId = identity(data.snapshotId);
  if (selected.snapshot && selected.snapshot !== snapshotId) throw new ReadFailure(502, "api_snapshot_mismatch");
  return {
    actorFilter: actorSelection(data, selected),
    snapshotId,
    revision: integer(data.revision),
    generatedAt: string(data.generatedAt),
    metricDefinitionVersion: identity(data.metricDefinitionVersion),
    computationVersion: identity(data.computationVersion),
    policyVersion: identity(data.policyVersion),
    head: {
      snapshotId: identity(head.snapshotId),
      revision: integer(head.revision),
      publishedAt: string(head.publishedAt),
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
    disabledMetrics: array(data.disabledMetrics ?? [], 98).map((value) => {
      const item = object(value);
      return { id: identity(item.id), reason: string(item.reason) };
    }),
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
  metric: MetricDefinition;
  ranking: { direction: string; rank: boolean } | null;
  rows: {
    rank: number | null;
    actorId: string;
    actor: Actor;
    result: MetricResult;
    evidenceIds: string[];
    pending?: PendingCount;
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
      (!["ascending", "descending"].includes(String(method.direction)) ||
        typeof method.rank !== "boolean" ||
        (descriptiveMetric(metric) && method.rank !== false)))
  )
    throw new ReadFailure(502, "api_metric_mismatch");
  return {
    ...metadata(value, selected),
    metric,
    ranking: method ? { direction: String(method.direction), rank: method.rank as boolean } : null,
    rows: array(data.rows, 100).map((value) => {
      const row = object(value),
        result = metricResultSchema.parse(row.result);
      if (
        result.metricId !== metric.id ||
        (row.rank !== null && (integer(row.rank) < 1 || method?.rank === false || descriptiveMetric(metric)))
      )
        throw new ReadFailure(502, "invalid_api_response");
      return {
        rank: row.rank === null ? null : integer(row.rank),
        actorId: identity(row.actorId),
        actor: selectedActor(row.actor, selected),
        result,
        evidenceIds: array(row.evidenceIds).map(identity),
        ...(row.pending === undefined ? {} : { pending: pendingCountSchema.parse(row.pending) }),
      };
    }),
    diagnostics: diagnostics(data.diagnostics),
    totalRows: integer(data.totalRows),
    nextCursor: data.nextCursor === null ? null : string(data.nextCursor),
  };
}
export interface Evidence {
  evidenceMetadata?: PublicEvidenceMetadata;
  artifact: Artifact;
  contribution: Contribution;
  occurredAt: string | null;
  sourceRevision: string | null;
  sourceRevisionUrl: string | null;
  activityState: "observed" | "pending" | "accepted" | "unknown";
  observedAt: string | null;
}
export function evidence(value: unknown): Evidence {
  const data = object(value);
  const metadata =
    data.evidenceMetadata === undefined ? undefined : publicEvidenceMetadataSchema.parse(data.evidenceMetadata);
  const contribution = contributionSchema.parse(data.contribution);
  if (metadata?.acceptedAt && contribution.qualification !== "eligible")
    throw new ReadFailure(502, "invalid_api_response");
  const activityState = data.activityState ?? metadata?.activityState ?? "unknown";
  if (
    metadata &&
    ((data.activityState !== undefined && data.activityState !== metadata.activityState) ||
      (data.observedAt !== undefined && data.observedAt !== metadata.observedAt))
  )
    throw new ReadFailure(502, "invalid_api_response");
  if (!["observed", "pending", "accepted", "unknown"].includes(String(activityState)))
    throw new ReadFailure(502, "invalid_api_response");
  return {
    ...(metadata === undefined ? {} : { evidenceMetadata: metadata }),
    activityState: activityState as Evidence["activityState"],
    observedAt: activityTime(data.observedAt === undefined ? (metadata?.observedAt ?? null) : data.observedAt),
    artifact: artifactSchema.parse(data.artifact),
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
  actorId: string;
  actor: Actor;
  results: MetricResult[];
  diagnostics: Diagnostic[];
  roleBreakdown: { role: string; contributions: number }[];
  timeline: Evidence[];
  timelineTruncated: boolean;
  nextCursor: string | null;
  categories: CategoryTotal[];
  evidenceCount: number;
}
export function profile(value: unknown, selected: Selection): Profile {
  const data = object(value);
  if ((data.category ?? null) !== selected.category) throw new ReadFailure(502, "api_filter_mismatch");
  return {
    ...metadata(value, selected),
    actorId: identity(data.actorId),
    actor: selectedActor(data.actor, selected),
    results: array(data.results, 98).map((item) => metricResultSchema.parse(item)),
    diagnostics: diagnostics(data.diagnostics),
    roleBreakdown: array(data.roleBreakdown, 30).map((value) => {
      const item = object(value);
      return { role: string(item.role), contributions: integer(item.contributions) };
    }),
    timeline: array(data.timeline, 100).map(evidence),
    timelineTruncated: data.timelineTruncated === true,
    nextCursor: data.nextCursor == null ? null : string(data.nextCursor),
    categories: categoryTotals(data.categories ?? []),
    evidenceCount: integer(data.evidenceCount),
  };
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
  if (!["recently_reconciled", "stale_or_degraded"].includes(String(data.status)))
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
    !["not_supplied", "per_proof"].includes(String(data.correctionHistory))
  )
    throw new ReadFailure(502, "invalid_activity_response");
  return data;
}
function activityGroup(value: unknown, selected: Selection): ActivityGroup {
  const data = object(value);
  const state = data.activityState;
  if (!["observed", "pending", "accepted", "unknown"].includes(String(state)))
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
        artifactId = identity(item.artifactId);
      const artifact = artifactSchema.parse({
        schemaVersion: "leaderboard/v1",
        source: "github",
        visibility: "public",
        kind: item.kind,
        stableId: artifactId,
        publicUrl: item.publicUrl,
      });
      const publicUrl = publicLink(artifact.publicUrl);
      if (!publicUrl) throw new ReadFailure(502, "invalid_activity_response");
      return { artifactId, kind: artifact.kind, publicUrl };
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
      result = evidence(value);
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
