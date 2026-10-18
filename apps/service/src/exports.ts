import type { Actor, MetricRegistry, MetricResult, PendingCount } from "@pick-your-ai/contracts";
import { PublicReadError, safePublicUrl, type PublicRead, type PublicDiagnostic } from "./public-source.js";

/** Serialization limits, not policy eligibility or source-publication approval. */
export const PUBLIC_EXPORT_LIMITS = Object.freeze({
  bytes: 2 * 1024 * 1024,
  fieldBytes: 16 * 1024,
  csvCellBytes: 256 * 1024,
  evidenceRecords: 2000,
  nodes: 100_000,
  depth: 24,
});
const exportVersion = "public-export/v1";
interface ExportBoard {
  metric: MetricRegistry["metrics"][number];
  ranking: PublicRead["selected"]["ranking"][number] | null;
  rows: {
    rank: number | null;
    actorId: string;
    actor?: Actor | undefined;
    result: MetricResult;
    evidenceIds: string[];
    pending?: PendingCount;
  }[];
  totalRows: number;
  nextCursor: string | null;
  diagnostics?: PublicDiagnostic[];
}
function tooLarge(): never {
  throw new PublicReadError(413, "export_too_large");
}
function unsafe(): never {
  throw new PublicReadError(503, "export_content_unavailable");
}
function checkedText(value: string): string {
  if (value.length > PUBLIC_EXPORT_LIMITS.fieldBytes || Buffer.byteLength(value) > PUBLIC_EXPORT_LIMITS.fieldBytes)
    tooLarge();
  // Tabs/newlines are ordinary CSV text, but NUL/terminal controls are not public content.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) unsafe();
  return value;
}
/** Calculate a hard byte budget before allocating the full serialized document. */
function boundedJson(value: unknown): string {
  let bytes = 0;
  let nodes = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > PUBLIC_EXPORT_LIMITS.nodes || depth > PUBLIC_EXPORT_LIMITS.depth) tooLarge();
    if (item === null) bytes += 4;
    else if (typeof item === "string") bytes += Buffer.byteLength(JSON.stringify(checkedText(item)));
    else if (typeof item === "number") {
      if (!Number.isFinite(item)) unsafe();
      bytes += String(item).length;
    } else if (typeof item === "boolean") bytes += item ? 4 : 5;
    else if (Array.isArray(item)) {
      if (item.length > PUBLIC_EXPORT_LIMITS.nodes) tooLarge();
      bytes += 2 + Math.max(0, item.length - 1);
      for (const child of item) visit(child, depth + 1);
    } else if (typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype) {
      const entries = Object.entries(item).filter(([, child]) => child !== undefined);
      bytes += 2 + Math.max(0, entries.length - 1);
      for (const [key, child] of entries) {
        bytes += Buffer.byteLength(JSON.stringify(checkedText(key))) + 1;
        visit(child, depth + 1);
      }
    } else unsafe();
    if (bytes > PUBLIC_EXPORT_LIMITS.bytes) tooLarge();
  }
  visit(value, 0);
  return JSON.stringify(value);
}
function csvCell(value: string | number | boolean | null): string {
  const text = value === null ? "" : String(value);
  if (Buffer.byteLength(text) > PUBLIC_EXPORT_LIMITS.csvCellBytes) tooLarge();
  // Quote every cell and neutralize formula prefixes, including whitespace/BOM/format
  // characters that spreadsheet importers may ignore. Embedded quotes cannot end a cell.
  const formula = /^[\s\p{Cf}]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text);
  const serialized = `"${formula ? "'" : ""}${text.replaceAll('"', '""')}"`;
  if (Buffer.byteLength(serialized) > PUBLIC_EXPORT_LIMITS.csvCellBytes) tooLarge();
  return serialized;
}

/** Use only a current-authorized, projected page; never read a provider or raw records here. */
export function renderPublicExport(read: PublicRead, board: ExportBoard, format: "json" | "csv") {
  const ids = new Set(board.rows.flatMap((row) => row.evidenceIds));
  const pendingIds = new Set(board.rows.flatMap((row) => row.pending?.evidenceIds ?? []));
  if (ids.size + pendingIds.size > PUBLIC_EXPORT_LIMITS.evidenceRecords) tooLarge();
  const available = new Map(
    [...read.selected.evidence, ...(read.selected.pendingEvidence ?? [])].map((entry) => [
      entry.contribution.contributionId,
      entry,
    ]),
  );
  const serializeEvidence = (evidenceId: string) => {
    const entry = available.get(evidenceId);
    if (!entry) unsafe();
    const sourceUrl = safePublicUrl(entry.artifact.publicUrl);
    if (sourceUrl === null) unsafe();
    return {
      evidenceId,
      repositoryId: entry.artifact.repositoryId ?? null,
      sourceUrl,
      occurredAt: entry.occurredAt,
      sourceRevision: entry.sourceRevision,
      sourceRevisionUrl: entry.sourceRevisionUrl,
    };
  };
  const evidence = [...ids].sort().map(serializeEvidence);
  const pendingEvidence = [...pendingIds].sort().map(serializeEvidence);
  const snapshot = read.selected.snapshot;
  // Deliberately omit raw/provider fields, display names, internal event IDs and control lists.
  const document = {
    exportSchemaVersion: exportVersion,
    schemaVersion: snapshot.schemaVersion,
    snapshotId: snapshot.snapshotId,
    revision: snapshot.revision,
    generatedAt: snapshot.generatedAt,
    metricDefinitionVersion: snapshot.metricDefinitionVersion,
    computationVersion: snapshot.computationVersion,
    policyVersion: read.controls.version,
    scope: read.selected.scope,
    actorFilter: read.actorFilter ?? "all",
    metric: board.metric,
    ranking: board.ranking,
    coverage: snapshot.coverage,
    methodology: (read.selected.methodology ?? []).filter((entry) => entry.metricId === board.metric.id),
    totalRows: board.totalRows,
    pageRows: board.rows.length,
    nextCursor: board.nextCursor,
    diagnostics: board.diagnostics ?? [],
    rows: board.rows.map((row) => ({
      actorId: row.actorId,
      login: row.actor?.login ?? null,
      actorKind: row.actor?.kind ?? "unknown",
      executionMode: row.actor?.executionMode ?? "unknown",
      rank: row.rank,
      result: row.result,
      evidenceIds: [...row.evidenceIds],
      ...(row.pending === undefined ? {} : { pending: row.pending }),
    })),
    evidence,
    pendingEvidence,
  };
  const json = boundedJson(document);
  if (format === "json") return { body: json, contentType: "application/json; charset=utf-8" };

  // A metadata record preserves provenance even for a valid empty/suppressed page.
  // Data records never repeat source evidence as extra metric rows or change aggregate totals.
  const columns = [
    "record_type",
    "export_schema_version",
    "snapshot",
    "revision",
    "generated_at",
    "policy",
    "metric_definition_version",
    "computation_version",
    "organization",
    "repository",
    "workstream",
    "start",
    "end",
    "metric",
    "definition",
    "unit",
    "metric_definition",
    "ranking",
    "coverage",
    "methodology",
    "total_rows",
    "page_rows",
    "next_cursor",
    "actor_filter",
    "actor_id",
    "actor",
    "rank",
    "state",
    "value",
    "result_coverage",
    "evidence",
    "numerator",
    "denominator",
    "sample_count",
    "censored",
    "missing_readiness",
    "p75",
    "pending",
    "pending_evidence",
  ];
  const s = document.scope;
  const metadata = [
    exportVersion,
    snapshot.snapshotId,
    snapshot.revision,
    snapshot.generatedAt,
    document.policyVersion,
    snapshot.metricDefinitionVersion,
    snapshot.computationVersion,
    s.organization,
    s.repository,
    s.workstream,
    s.start,
    s.end,
    board.metric.id,
    board.metric.counting_rule,
    board.metric.definition.unit,
    boundedJson(board.metric),
    boundedJson(board.ranking),
    boundedJson(document.coverage),
    boundedJson(document.methodology),
    board.totalRows,
    document.pageRows,
    board.nextCursor,
    document.actorFilter,
  ];
  let bytes = 0;
  const lines: string[] = [];
  function line(cells: (string | number | boolean | null)[]): void {
    const serialized = cells.map(csvCell).join(",") + "\r\n";
    bytes += Buffer.byteLength(serialized);
    if (bytes > PUBLIC_EXPORT_LIMITS.bytes) tooLarge();
    lines.push(serialized);
  }
  line(columns);
  line([
    "metadata",
    ...metadata,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ]);
  const byId = new Map(evidence.map((entry) => [entry.evidenceId, entry]));
  for (const row of document.rows) {
    const diagnostic = document.diagnostics.find(
      (entry) => entry.actorId === row.actorId && entry.metricId === board.metric.id,
    );
    line([
      "row",
      ...metadata,
      row.actorId,
      row.login,
      row.rank,
      row.result.state,
      row.result.value ?? null,
      boundedJson(row.result.coverage),
      boundedJson(row.evidenceIds.map((id) => byId.get(id)!)),
      diagnostic?.numerator ?? null,
      diagnostic?.denominator ?? null,
      diagnostic?.sampleCount ?? null,
      diagnostic?.censored ?? null,
      diagnostic?.missingReadiness ?? null,
      diagnostic?.p75 ?? null,
      row.pending === undefined ? null : boundedJson(row.pending),
      boundedJson((row.pending?.evidenceIds ?? []).map(serializeEvidence)),
    ]);
  }
  return { body: lines.join(""), contentType: "text/csv; charset=utf-8" };
}
