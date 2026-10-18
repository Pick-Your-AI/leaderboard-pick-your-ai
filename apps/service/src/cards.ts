import type { MetricRegistry } from "@pick-your-ai/contracts";
import { PublicReadError, safePublicUrl, type PublicRead } from "./public-source.js";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

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
  const snapshot = read.selected.snapshot;
  const scope = read.selected.scope;
  const params = new URLSearchParams({
    organization: scope.organization,
    snapshot: snapshot.snapshotId,
    metric: metric.id,
  });
  for (const key of ["repository", "workstream", "start", "end"] as const)
    if (scope[key] !== null) params.set(key, scope[key]);
  const href = `/api/v1/contributors/${encodeURIComponent(actorId)}?${params}`;
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(metric.name)} contribution card</title></head><body><main><article aria-labelledby="card-title"><h1 id="card-title">${escape(metric.name)}</h1><p>${escape(actor.actor.login ?? actorId)}</p><p>${escape(value)}</p><dl><dt>Mode</dt><dd>${escape(mode)}</dd><dt>Snapshot date</dt><dd><time datetime="${escape(snapshot.generatedAt)}">${escape(snapshot.generatedAt)}</time></dd><dt>Period</dt><dd>${escape(period)}</dd><dt>Scope</dt><dd>${escape([scope.organization, scope.repository, scope.workstream].filter(Boolean).join(" / "))}</dd><dt>Metric registry</dt><dd>${escape(snapshot.metricDefinitionVersion)}</dd><dt>Metric policy</dt><dd>${escape(policy)}</dd><dt>Coverage</dt><dd>${escape(row.result.coverage.state)}</dd></dl><p>This card describes the dated snapshot; it does not claim live activity or personal productivity.</p><a href="${escape(href)}">Scoped contribution portfolio</a><h2>Public sources</h2>${sources.length ? `<ul>${sources.map((url) => `<li><a rel="noreferrer" href="${escape(url)}">${escape(url)}</a></li>`).join("")}</ul>` : "<p>No public source link is available.</p>"}</article></main></body></html>`;
}
