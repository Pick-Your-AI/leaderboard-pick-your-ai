import { getLeadMetrics, getMetricUi, selectMetricView } from "@pick-your-ai/metrics";
import { buildBoard, SourceError } from "./source.ts";
import { fixtureMetrics } from "./synthetic.ts";
import type { Scope } from "../lib/scope.ts";

export type SelectionRequest = { state?: string; date_basis?: string };

/** The prototype supports the explicitly registered fixture pair only. */
export function validatePrototypeView(metricId: string, request: SelectionRequest = {}): void {
  const fixture = fixtureMetrics[metricId];
  if (!fixture && request.state === undefined && request.date_basis === undefined) return;
  try {
    const selected = selectMetricView(metricId, request);
    const expectedDate = fixture?.rankStates.some((state) => state === "qualified" || state === "reviewed")
      ? "acceptedAt"
      : "occurredAt";
    if (
      !fixture ||
      fixture.rankStates.length !== 1 ||
      fixture.rankStates[0] !== selected.state ||
      expectedDate !== selected.date_basis
    )
      throw new Error("This data adapter does not implement the requested view");
  } catch (error) {
    throw new SourceError(
      "Unsupported metric view",
      error instanceof Error ? error.message : "Unsupported state/date selection",
    );
  }
}

export function buildSelectedBoard(metricId: string, scope: Scope, latestId: string, request: SelectionRequest = {}) {
  validatePrototypeView(metricId, request);
  return buildBoard(metricId, scope, latestId); // Unimplemented adapters return not-measured, never zero.
}

export const wallMetricIds = () =>
  getLeadMetrics("wall")
    .filter((metric) => fixtureMetrics[metric.id])
    .map((metric) => metric.id);

export function resolveWallBoards(value: string | undefined): string[] {
  const choices = wallMetricIds();
  if (value === undefined) return choices.slice(0, 1);
  const requested = value.split(",");
  if (!requested.length || requested.some((id) => !id || !choices.includes(id)))
    throw new SourceError(
      "Unsupported wall selection",
      "Every requested board must be an available registry wall choice. No board was substituted.",
    );
  return [...new Set(requested)];
}

export function metricViewLabel(metricId: string) {
  const selection = getMetricUi(metricId)?.default_combination;
  return selection ? `${selection.state} · ${selection.date_basis}` : "No selectable view";
}
