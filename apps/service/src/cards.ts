import {
  actorFilterLabels,
  publicScopeParameters,
  publicScopeSchemaVersion,
  type MetricRegistry,
} from "@pick-your-ai/contracts";
import { PublicReadError, safePublicUrl, type PublicRead } from "./public-source.js";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

/** Definition text is registry context; diagnostics are supplied observations, never inferred counts. */
function measurementContext(
  read: PublicRead,
  row: PublicRead["selected"]["rows"][number],
  metric: MetricRegistry["metrics"][number],
): [string, string][] {
  const diagnostic = read.selected.diagnostics?.find(
    (entry) => entry.actorId === row.actorId && entry.metricId === metric.id,
  );
  const supplied = (value: number | null | undefined) => (value == null ? "unknown" : String(value));
  return [
    ["Unit", metric.definition.unit],
    ["Aggregation", metric.definition.aggregation],
    ["Definition event clock", metric.definition.event_clock],
    ["Numerator", supplied(diagnostic?.numerator)],
    ["Denominator", supplied(diagnostic?.denominator)],
    ["Samples", supplied(diagnostic?.sampleCount)],
    ["Censored", supplied(diagnostic?.censored)],
    ["Missing readiness", supplied(diagnostic?.missingReadiness)],
    ["p75", supplied(diagnostic?.p75)],
    ["Pending", `${supplied(row.pending?.count)} (${row.pending?.state ?? "unknown"})`],
    ["Value class", row.pending?.valueClass ?? "unknown"],
    ...(read.selected.scope.schemaVersion === publicScopeSchemaVersion
      ? ([
          [
            "Membership basis",
            read.selected.scope.context === "current" ? "Current at the frozen snapshot" : "Event context",
          ],
          ["Projects", read.selected.scope.projects!.join(", ") || "All approved Projects and unboarded work"],
        ] as [string, string][])
      : []),
  ];
}

/** Input must already pass projectRead, including CURRENT suppression for pinned reads. */
export function renderContributorCard(
  read: PublicRead,
  actorId: string,
  metric: MetricRegistry["metrics"][number],
  archived: boolean,
): string {
  const actor = read.selected.actors.find((entry) => entry.actorId === actorId);
  const row = read.selected.rows.find((entry) => entry.actorId === actorId && entry.result.metricId === metric.id);
  if (!actor || !row) throw new PublicReadError(404, "card_unavailable");
  const context = measurementContext(read, row, metric);
  const snapshot = read.selected.snapshot;
  const scope = read.selected.scope;
  const params = new URLSearchParams({
    organization: scope.organization,
    snapshot: snapshot.snapshotId,
    metric: metric.id,
  });
  for (const [key, value] of Object.entries(publicScopeParameters(scope)))
    if (key !== "organization") params.set(key, value);
  if (read.actorFilter && read.actorFilter !== "all") params.set("actors", read.actorFilter);
  params.set("ui", "api");
  const href = `/contributors/${encodeURIComponent(actorId)}?${params}`;
  const evidence = read.selected.evidence.filter((entry) =>
    row.evidenceIds.includes(entry.contribution.contributionId),
  );
  const sources = [
    ...new Set(
      evidence.map((entry) => safePublicUrl(entry.artifact.publicUrl)).filter((url): url is string => url !== null),
    ),
  ];
  const methodology = read.selected.methodology?.find((entry) => entry.metricId === metric.id);
  const policy = methodology
    ? `${methodology.policyVersion} (${methodology.policySignature})`
    : "No separate approved metric policy supplied";
  const period = `${scope.start ?? "available history"} to ${scope.end ?? "snapshot date"}`;
  const mode = archived ? "Archived snapshot card" : "Current snapshot card — refresh to check for changes";
  const value = row.result.value === undefined ? row.result.state : `${row.result.value} (${row.result.state})`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(metric.name)} contribution card</title></head><body><main><article aria-labelledby="card-title"><h1 id="card-title">${escape(metric.name)}</h1><p>${escape(actor.actor.login ?? actorId)}</p><p>${escape(value)}</p><dl>${context.map(([label, value]) => `<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`).join("")}<dt>Mode</dt><dd>${escape(mode)}</dd><dt>Snapshot date</dt><dd><time datetime="${escape(snapshot.generatedAt)}">${escape(snapshot.generatedAt)}</time></dd><dt>Period</dt><dd>${escape(period)}</dd><dt>Scope</dt><dd>${escape([scope.organization, scope.repository, scope.workstream].filter(Boolean).join(" / "))}</dd><dt>Activity selection</dt><dd>${escape(actorFilterLabels[read.actorFilter ?? "all"])}</dd><dt>Metric registry</dt><dd>${escape(snapshot.metricDefinitionVersion)}</dd><dt>Metric policy</dt><dd>${escape(policy)}</dd><dt>Coverage</dt><dd>${escape(row.result.coverage.state)}</dd></dl><p>This card describes the dated snapshot. Account type does not certify manual work; this is not a live-activity or productivity claim.</p><a href="${escape(href)}">Scoped contribution portfolio</a><h2>Public sources</h2>${sources.length ? `<ul>${sources.map((url) => `<li><a rel="noreferrer" href="${escape(url)}">${escape(url)}</a></li>`).join("")}</ul>` : "<p>No public source link is available.</p>"}</article></main></body></html>`;
}

/** A bounded passive SVG suitable for image embeds; no scripts, links or external assets. */
export function renderContributorCardImage(
  read: PublicRead,
  actorId: string,
  metric: MetricRegistry["metrics"][number],
  archived: boolean,
): string {
  const actor = read.selected.actors.find((entry) => entry.actorId === actorId);
  const row = read.selected.rows.find((entry) => entry.actorId === actorId && entry.result.metricId === metric.id);
  if (!actor || !row) throw new PublicReadError(404, "card_unavailable");
  const { snapshot, scope } = read.selected;
  const context = measurementContext(read, row, metric);
  const contextLines = context.slice(0, 3).map(([label, value]) => `${label}: ${value}`);
  for (let index = 3; index < context.length; index += 2)
    contextLines.push(
      context
        .slice(index, index + 2)
        .map(([label, value]) => `${label}: ${value}`)
        .join("; "),
    );
  const method = read.selected.methodology?.find((entry) => entry.metricId === metric.id);
  const sources = read.selected.evidence
    .filter((entry) => row.evidenceIds.includes(entry.contribution.contributionId))
    .map((entry) => safePublicUrl(entry.artifact.publicUrl))
    .filter((url): url is string => url !== null);
  const lines = [
    `${metric.name}: ${row.result.value ?? row.result.state} (${row.result.state})`,
    actor.actor.login ?? actorId,
    ...contextLines,
    `${archived ? "Archived" : "Current dated"} snapshot: ${snapshot.generatedAt}`,
    `Period: ${scope.start ?? "available history"} to ${scope.end ?? "snapshot date"}`,
    `Scope: ${[scope.organization, scope.repository, scope.workstream].filter(Boolean).join(" / ")} / ${actorFilterLabels[read.actorFilter ?? "all"]}`,
    `Registry: ${snapshot.metricDefinitionVersion}`,
    `Policy: ${method?.policyVersion ?? "not supplied"}`,
    `Coverage: ${row.result.coverage.state}`,
    `Source: ${sources[0] ?? "public link unavailable"}${sources.length > 1 ? ` (+${sources.length - 1} more in portfolio)` : ""}`,
    "Dated evidence, not a live activity or productivity claim.",
  ];
  const bounded = (line: string) => escape(line.length > 115 ? line.slice(0, 112) + "…" : line);
  const height = 76 + (lines.length - 1) * 36;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="${height}" viewBox="0 0 960 ${height}" role="img" aria-labelledby="title description"><title id="title">${bounded(`${metric.name} — dated contribution card`)}</title><desc id="description">${lines.map(bounded).join("; ")}</desc><rect width="960" height="${height}" rx="12" fill="#ffffff" stroke="#334155"/><g fill="#172033" font-family="sans-serif" font-size="14">${lines.map((line, index) => `<text x="24" y="${38 + index * 36}">${bounded(line)}</text>`).join("")}</g></svg>`;
}
