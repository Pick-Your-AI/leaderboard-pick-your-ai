import { compareSourceInstants, sourceEventSchema } from "@pick-your-ai/contracts";
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
  return sourceEventSchema.shape.occurredAt.safeParse(result).success && Number.isFinite(Date.parse(result))
    ? result
    : fail();
};
const list = (value: unknown, maximum: number): unknown[] =>
  Array.isArray(value) && value.length <= maximum ? value : fail();

/** Editorial controls have only an unfiltered organization-level protocol. */
export function supportsEditorialScope(selected: Selection, organization: string): boolean {
  return (
    (selected.actors ?? "all") === "all" &&
    selected.organization === organization &&
    !selected.repository &&
    !selected.workstream &&
    (selected.context ?? "event") === "event" &&
    !selected.projects?.length &&
    !selected.roles?.length &&
    !selected.start &&
    !selected.end &&
    !selected.snapshot &&
    !selected.category &&
    !selected.search
  );
}

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
export function cardImageHref(
  base: string,
  selected: Selection,
  snapshotId: string,
  actorId: string,
  metricId: string,
) {
  const href = cardHref(base, selected, snapshotId, actorId, metricId);
  const index = href.indexOf("?");
  return href.slice(0, index) + "/image" + href.slice(index);
}
export function achievements(value: unknown, selected: Selection, actorId: string) {
  const data = record(value);
  const meta = metadata(data, selected);
  if (data.actorId !== actorId || data.ruleVersion !== "accepted-evidence/v1") fail();
  const suppliedAwards = list(data.achievements, 2);
  const through = selected.end ?? meta.generatedAt;
  if (
    suppliedAwards.length > 0 &&
    (!meta.coverage.length ||
      meta.coverage.some(
        (coverage) =>
          coverage.state !== "complete" ||
          coverage.missingPages !== 0 ||
          coverage.permissionsMissing.length > 0 ||
          coverage.sourceErrors.length > 0 ||
          !coverage.windowStart ||
          !coverage.windowEnd ||
          !coverage.sourceWatermark ||
          !(compareSourceInstants(coverage.windowEnd, through) >= 0) ||
          !(compareSourceInstants(coverage.sourceWatermark, through) >= 0) ||
          (selected.start
            ? !(compareSourceInstants(coverage.windowStart, selected.start) <= 0)
            : !coverage.knownStart || !(compareSourceInstants(coverage.windowStart, coverage.knownStart) <= 0)),
      ))
  )
    fail();
  const seen = new Set<string>();
  return {
    ...meta,
    achievements: suppliedAwards.map((value) => {
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
      if (
        (selected.start && Date.parse(occurredAt) < Date.parse(selected.start)) ||
        (selected.end && Date.parse(occurredAt) >= Date.parse(selected.end))
      )
        fail();
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
