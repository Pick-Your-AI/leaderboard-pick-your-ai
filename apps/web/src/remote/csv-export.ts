import { stableJSON } from "@pick-your-ai/metrics";
import type { MetricDefinition } from "@pick-your-ai/contracts";
import { parseExportJSON } from "./export-json.ts";

// Every public-export renderer quotes every cell and terminates every record
// with CRLF. Read that bounded contract; do not guess a spreadsheet dialect.
const legacyColumns = [
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
  "actor_kind",
  "execution_mode",
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
] as const;
const membershipColumns = ["scope_schema_version", "context", "projects"] as const;
type Column = (typeof legacyColumns)[number] | (typeof membershipColumns)[number] | "roles";
const scopedColumns = (roles: boolean): Column[] => {
  const split = legacyColumns.indexOf("start");
  return [
    ...legacyColumns.slice(0, split),
    ...membershipColumns,
    ...(roles ? ["roles" as const] : []),
    ...legacyColumns.slice(split),
  ];
};
const variants: { version: string; columns: readonly Column[] }[] = [
  { version: "public-export/v1", columns: legacyColumns },
  { version: "public-export/v2", columns: scopedColumns(false) },
  { version: "public-export/v3", columns: scopedColumns(true) },
];
const formula = (value: string) => /^[\s\p{Cf}]*[=+@-]/u.test(value) || /^[\t\r\n]/u.test(value);
const protectedText = (value: string) => (formula(value) ? `'${value}` : value);
const originalText = (value: string) => (value.startsWith("'") && formula(value.slice(1)) ? value.slice(1) : value);
function invalid(): never {
  throw new Error("invalid_export_csv");
}

function records(raw: string, rowLimit: number): { rows: string[][]; columns: readonly Column[]; version: string } {
  if (!Number.isSafeInteger(rowLimit) || rowLimit < 1 || rowLimit > 100 || raw.length > 2_000_000) invalid();
  const result: string[][] = [];
  let index = 0;
  while (index < raw.length) {
    const row: string[] = [];
    for (;;) {
      if (raw[index++] !== '"') invalid();
      let cell = "",
        closed = false;
      while (index < raw.length) {
        const character = raw.charAt(index++);
        if (character === '"') {
          if (raw[index] !== '"') {
            closed = true;
            break;
          }
          index++;
        }
        cell += character;
        if (cell.length > 256 * 1024) invalid();
      }
      if (!closed || formula(cell) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(cell)) invalid();
      if (new TextEncoder().encode(cell).byteLength > 256 * 1024) invalid();
      row.push(cell);
      if (row.length > legacyColumns.length + 4) invalid();
      if (raw[index] === ",") {
        index++;
        continue;
      }
      if (raw.slice(index, index + 2) !== "\r\n") invalid();
      index += 2;
      break;
    }
    result.push(row);
    if (result.length > rowLimit + 2) invalid();
  }
  const header = result[0];
  const variant = variants.find(
    ({ columns }) =>
      header && header.length === columns.length && columns.every((column, index) => header[index] === column),
  );
  if (result.length < 2 || !variant || result.some((row) => row.length !== variant.columns.length)) invalid();
  return { rows: result.slice(1), ...variant };
}

function number(cell: string): number {
  const source = originalText(cell),
    value = Number(source);
  // In particular an empty cell is absent, never zero. The producer uses String
  // for finite numbers; reject alternate, ambiguous and nonnumeric spellings.
  if (!source || !Number.isFinite(value) || String(value) !== source) invalid();
  return value;
}
const nullableNumber = (cell: string) => (cell === "" ? null : number(cell));
const nullableText = (cell: string) => (cell === "" ? null : originalText(cell));
function entries(cell: string): Record<string, unknown>[] {
  const value: unknown = parseExportJSON(cell);
  if (!Array.isArray(value) || value.length > 2000) invalid();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid();
    return entry as Record<string, unknown>;
  });
}

/** Reconstruct the minimized JSON contract, then use its shared validator. The
 * returned download remains the original CSV bytes, including formula guards. */
export function parseCSVExport(raw: string, expectedMetric: MetricDefinition, rowLimit: number): unknown {
  const parsed = records(raw, rowLimit);
  const { columns, version } = parsed;
  const [metadata, ...data] = parsed.rows;
  const metadataEnd = columns.indexOf("actor_id");
  if (!metadata) invalid();
  const at = (row: string[], column: Column): string => {
    const value = row[columns.indexOf(column)];
    if (value === undefined) invalid();
    return value;
  };
  if (
    metadata[0] !== "metadata" ||
    metadata.slice(metadataEnd).some((cell) => cell !== "") ||
    at(metadata, "export_schema_version") !== version
  )
    invalid();
  if (
    !expectedMetric ||
    at(metadata, "metric") !== protectedText(expectedMetric.id) ||
    at(metadata, "definition") !== protectedText(expectedMetric.counting_rule) ||
    at(metadata, "unit") !== protectedText(expectedMetric.definition.unit)
  )
    invalid();
  const evidence = new Map<string, Record<string, unknown>>();
  const pendingEvidence = new Map<string, Record<string, unknown>>();
  const mergeEvidence = (cell: string, target: Map<string, Record<string, unknown>>) =>
    entries(cell).map((entry) => {
      const id = entry.evidenceId;
      if (typeof id !== "string") invalid();
      const previous = target.get(id);
      if (previous && stableJSON(previous) !== stableJSON(entry)) invalid();
      target.set(id, entry);
      if (target.size > 2000) invalid();
      return id;
    });
  const diagnostics: unknown[] = [];
  const rows = data.map((row) => {
    if (row[0] !== "row" || row.slice(1, metadataEnd).some((cell, index) => cell !== metadata[index + 1])) invalid();
    const actorId = originalText(at(row, "actor_id"));
    const diagnosticColumns = [
      "numerator",
      "denominator",
      "sample_count",
      "censored",
      "missing_readiness",
      "p75",
    ] as const;
    if (diagnosticColumns.some((column) => at(row, column) !== ""))
      diagnostics.push({
        metricId: expectedMetric.id,
        actorId,
        numerator: nullableNumber(at(row, "numerator")),
        denominator: nullableNumber(at(row, "denominator")),
        sampleCount: number(at(row, "sample_count")),
        censored: number(at(row, "censored")),
        missingReadiness: number(at(row, "missing_readiness")),
        p75: nullableNumber(at(row, "p75")),
      });
    const evidenceIds = mergeEvidence(at(row, "evidence"), evidence);
    const pendingIds = mergeEvidence(at(row, "pending_evidence"), pendingEvidence);
    const pending: unknown = at(row, "pending") === "" ? undefined : parseExportJSON(at(row, "pending"));
    if (pendingIds.length && pending === undefined) invalid();
    if (pending !== undefined) {
      if (!pending || typeof pending !== "object" || Array.isArray(pending)) invalid();
      const ids = (pending as Record<string, unknown>).evidenceIds;
      if (!Array.isArray(ids) || stableJSON(ids) !== stableJSON(pendingIds)) invalid();
    }
    return {
      actorId,
      login: nullableText(at(row, "actor")),
      actorKind: at(row, "actor_kind"),
      executionMode: at(row, "execution_mode"),
      rank: nullableNumber(at(row, "rank")),
      result: {
        schemaVersion: "leaderboard/v1",
        metricId: expectedMetric.id,
        state: at(row, "state"),
        ...(at(row, "value") === "" ? {} : { value: number(at(row, "value")) }),
        coverage: parseExportJSON(at(row, "result_coverage")),
      },
      evidenceIds,
      ...(pending === undefined ? {} : { pending }),
    };
  });
  return {
    exportSchemaVersion: at(metadata, "export_schema_version"),
    schemaVersion: "leaderboard/v1",
    snapshotId: originalText(at(metadata, "snapshot")),
    revision: number(at(metadata, "revision")),
    generatedAt: originalText(at(metadata, "generated_at")),
    metricDefinitionVersion: originalText(at(metadata, "metric_definition_version")),
    computationVersion: originalText(at(metadata, "computation_version")),
    policyVersion: originalText(at(metadata, "policy")),
    scope: {
      organization: originalText(at(metadata, "organization")),
      repository: nullableText(at(metadata, "repository")),
      workstream: nullableText(at(metadata, "workstream")),
      start: nullableText(at(metadata, "start")),
      end: nullableText(at(metadata, "end")),
      ...(version === "public-export/v1"
        ? {}
        : {
            schemaVersion: at(metadata, "scope_schema_version"),
            context: at(metadata, "context"),
            projects: parseExportJSON(at(metadata, "projects")),
          }),
      ...(version === "public-export/v3" ? { roles: parseExportJSON(at(metadata, "roles")) } : {}),
    },
    actorFilter: at(metadata, "actor_filter"),
    metric: parseExportJSON(at(metadata, "metric_definition")),
    ranking: parseExportJSON(at(metadata, "ranking")),
    coverage: parseExportJSON(at(metadata, "coverage")),
    methodology: parseExportJSON(at(metadata, "methodology")),
    totalRows: number(at(metadata, "total_rows")),
    pageRows: number(at(metadata, "page_rows")),
    nextCursor: nullableText(at(metadata, "next_cursor")),
    diagnostics,
    rows,
    evidence: [...evidence.values()],
    pendingEvidence: [...pendingEvidence.values()],
  };
}
