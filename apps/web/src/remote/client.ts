import {
  actorSchema,
  artifactSchema,
  contributionSchema,
  coverageSchema,
  metricDefinitionSchema,
  metricRegistrySchema,
  metricResultSchema,
  type Actor,
  type Artifact,
  type Contribution,
  type Coverage,
  type MetricDefinition,
  type MetricRegistry,
  type MetricResult,
} from "@pick-your-ai/contracts";

export class ReadFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
const identifier = /^[A-Za-z0-9_.:-]{1,200}$/;
const scopeKeys = ["organization", "repository", "workstream", "start", "end"] as const;
const supported = new Set([...scopeKeys, "snapshot", "limit", "cursor", "metric", "ui"]);
export interface Selection {
  organization: string;
  repository: string | null;
  workstream: string | null;
  start: string | null;
  end: string | null;
  snapshot: string | null;
  limit: string;
  cursor: string | null;
  metric: string;
}
export function selection(search: string): Selection {
  const params = new URLSearchParams(search);
  for (const key of params.keys())
    if (!supported.has(key) || params.getAll(key).length !== 1)
      throw new ReadFailure(400, "unsupported_or_duplicate_filter");
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
  return {
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
  if (extra.cursor) params.set("cursor", extra.cursor);
  return `${path}?${params}`;
}
export function apiBase(raw = "/api/v1"): string {
  const url = new URL(raw, window.location.origin);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && url.origin !== window.location.origin) ||
    !/^\/[A-Za-z0-9/_-]+$/.test(url.pathname)
  )
    throw new ReadFailure(500, "invalid_public_api_configuration");
  return url.href.replace(/\/$/, "");
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
async function readBytes(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new ReadFailure(502, "invalid_api_response");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.length;
    if (bytes > 2_000_000) {
      await reader.cancel();
      throw new ReadFailure(502, "api_response_too_large");
    }
    chunks.push(chunk.value);
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
  const response = await fetch(`${base}/${path}${params.size ? `?${params}` : ""}`, {
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    headers: { accept: "application/json" },
  });
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new ReadFailure(
      response.ok ? 502 : response.status,
      response.ok ? "invalid_api_response" : `http_${response.status}`,
    );
  const joined = await readBytes(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(joined));
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
): Promise<Blob> {
  const params = parameters(selected, { board: true, cursor: selected.cursor });
  params.set("format", format);
  if (!selected.snapshot) throw new ReadFailure(400, "export_requires_displayed_snapshot");
  const response = await fetch(`${base}/exports?${params}`, {
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
  });
  if (!response.ok) throw new ReadFailure(response.status, `export_http_${response.status}`);
  const type = format === "json" ? "application/json" : "text/csv";
  if (!response.headers.get("content-type")?.includes(type)) throw new ReadFailure(502, "invalid_export_response");
  const raw = new TextDecoder().decode(await readBytes(response));
  if (format === "json") {
    try {
      board(JSON.parse(raw), selected);
    } catch {
      throw new ReadFailure(502, "invalid_export_response");
    }
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
export interface Metadata {
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
    };
  });
}
export interface Board extends Metadata {
  metric: MetricDefinition;
  ranking: { direction: string; rank: boolean } | null;
  rows: { rank: number | null; actorId: string; actor: Actor; result: MetricResult; evidenceIds: string[] }[];
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
    (method && (!["ascending", "descending"].includes(String(method.direction)) || typeof method.rank !== "boolean"))
  )
    throw new ReadFailure(502, "api_metric_mismatch");
  return {
    ...metadata(value, selected),
    metric,
    ranking: method ? { direction: String(method.direction), rank: method.rank as boolean } : null,
    rows: array(data.rows, 100).map((value) => {
      const row = object(value),
        result = metricResultSchema.parse(row.result);
      if (result.metricId !== metric.id || (row.rank !== null && (integer(row.rank) < 1 || method?.rank === false)))
        throw new ReadFailure(502, "invalid_api_response");
      return {
        rank: row.rank === null ? null : integer(row.rank),
        actorId: identity(row.actorId),
        actor: actorSchema.parse(row.actor),
        result,
        evidenceIds: array(row.evidenceIds).map(identity),
      };
    }),
    diagnostics: diagnostics(data.diagnostics),
    totalRows: integer(data.totalRows),
    nextCursor: data.nextCursor === null ? null : string(data.nextCursor),
  };
}
export interface Evidence {
  artifact: Artifact;
  contribution: Contribution;
  occurredAt: string | null;
  sourceRevision: string | null;
  sourceRevisionUrl: string | null;
}
export function evidence(value: unknown): Evidence {
  const data = object(value);
  return {
    artifact: artifactSchema.parse(data.artifact),
    contribution: contributionSchema.parse(data.contribution),
    occurredAt: data.occurredAt === null ? null : string(data.occurredAt),
    sourceRevision: data.sourceRevision === null ? null : string(data.sourceRevision),
    sourceRevisionUrl: publicLink(data.sourceRevisionUrl as string | null),
  };
}
export interface Profile extends Metadata {
  actorId: string;
  actor: Actor;
  results: MetricResult[];
  diagnostics: Diagnostic[];
  roleBreakdown: { role: string; contributions: number }[];
  timeline: Evidence[];
  timelineTruncated: boolean;
  evidenceCount: number;
}
export function profile(value: unknown, selected: Selection): Profile {
  const data = object(value);
  return {
    ...metadata(value, selected),
    actorId: identity(data.actorId),
    actor: actorSchema.parse(data.actor),
    results: array(data.results, 98).map((item) => metricResultSchema.parse(item)),
    diagnostics: diagnostics(data.diagnostics),
    roleBreakdown: array(data.roleBreakdown, 30).map((value) => {
      const item = object(value);
      return { role: string(item.role), contributions: integer(item.contributions) };
    }),
    timeline: array(data.timeline, 100).map(evidence),
    timelineTruncated: data.timelineTruncated === true,
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
export const catalog = (value: unknown): MetricRegistry => metricRegistrySchema.parse(value);
