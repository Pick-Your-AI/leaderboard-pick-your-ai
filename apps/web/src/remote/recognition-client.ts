import { metadata, parameters, publicLink, ReadFailure, type Selection } from "./client.ts";
const id = /^[A-Za-z0-9_.:-]{1,200}$/;
const fail = (): never => {
  throw new ReadFailure(502, "invalid_recognition_response");
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : fail();
const text = (value: unknown, max = 2000): string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : fail();
const identity = (value: unknown) => {
  const result = text(value, 200);
  return id.test(result) ? result : fail();
};
const date = (value: unknown) => {
  const result = text(value, 40);
  return Number.isFinite(Date.parse(result)) && new Date(result).toISOString() === result ? result : fail();
};
const list = (value: unknown, maximum: number): unknown[] =>
  Array.isArray(value) && value.length <= maximum ? value : fail();

export function recognitionParameters(selected: Selection, snapshotId: string) {
  identity(snapshotId);
  if (selected.snapshot && selected.snapshot !== snapshotId) throw new ReadFailure(502, "api_snapshot_mismatch");
  return parameters(selected, { snapshot: snapshotId, cursor: null });
}
export function cardHref(base: string, selected: Selection, snapshotId: string, actorId: string, metricId: string) {
  const params = recognitionParameters(selected, snapshotId);
  params.set("metric", identity(metricId));
  return `${base}/cards/${encodeURIComponent(identity(actorId))}?${params}`;
}
export function achievements(value: unknown, selected: Selection, actorId: string) {
  const data = record(value);
  const meta = metadata(data, selected);
  if (data.actorId !== actorId || data.ruleVersion !== "accepted-evidence/v1") fail();
  const seen = new Set<string>();
  return {
    ...meta,
    achievements: list(data.achievements, 2).map((value) => {
      const item = record(value);
      const rule = identity(item.id);
      if (
        !["first-accepted-in-scope", "first-review-in-scope"].includes(rule) ||
        seen.has(rule) ||
        item.ruleVersion !== data.ruleVersion ||
        item.dateBasis !== "proven_source_occurrence_in_selected_scope" ||
        typeof item.sharedCredit !== "boolean"
      )
        fail();
      seen.add(rule);
      const occurredAt = date(item.occurredAt);
      if ((selected.start && occurredAt < selected.start) || (selected.end && occurredAt >= selected.end)) fail();
      const evidenceIds = list(item.evidenceIds, 1).map(identity);
      const artifactIds = list(item.artifactIds, 1).map(identity);
      const sourceUrls = list(item.sourceUrls, 1).map((value) => publicLink(text(value)) ?? fail());
      if (!evidenceIds.length || !artifactIds.length || !sourceUrls.length) fail();
      return {
        id: rule,
        label: text(item.label),
        ruleVersion: "accepted-evidence/v1",
        occurredAt,
        evidenceIds,
        artifactIds,
        sourceUrls,
        sharedCredit: item.sharedCredit,
        scopeMeaning: text(item.scopeMeaning),
      };
    }),
  };
}
export function spotlights(value: unknown) {
  const data = record(value);
  if (data.ruleVersion !== "reviewed-opt-in/v1" || data.ordering !== "round-robin-category-oldest-selection-first")
    fail();
  const seen = new Set<string>();
  return list(data.spotlights, 10_000).map((value) => {
    const item = record(value);
    const spotlightId = identity(item.id);
    if (seen.has(spotlightId) || item.ruleVersion !== data.ruleVersion) fail();
    seen.add(spotlightId);
    return {
      id: spotlightId,
      actorId: identity(item.actorId),
      claimId: identity(item.claimId),
      sourceUrl: publicLink(text(item.sourceUrl)) ?? fail(),
      category: text(item.category),
      selectionExplanation: text(item.selectionExplanation, 1000),
      selectedAt: date(item.selectedAt),
      bio: item.bio === null || item.bio === "" ? null : text(item.bio, 500),
    };
  });
}
