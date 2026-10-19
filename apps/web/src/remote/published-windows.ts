import {
  parsePublicWindows,
  publicScopeParameters,
  publicWindowPeriods,
  type PublicScope,
  type PublicWindowPeriod,
  type PublicWindows,
} from "@pick-your-ai/contracts";
import { resolveMetricWindow } from "@pick-your-ai/metrics";
import { ReadFailure, request, selection, uiHref, type Selection } from "./client.ts";
import { selectionScope } from "./public-scope.ts";

const entryPath = "/start";
const retainedSelectors = ["start", "end", "snapshot", "cursor", "proof", "compare", "compareStart", "compareEnd"];

function period(value: unknown): PublicWindowPeriod {
  if (typeof value !== "string" || !publicWindowPeriods.includes(value as PublicWindowPeriod))
    throw new ReadFailure(400, "invalid_window_period");
  return value as PublicWindowPeriod;
}

function entryBudget(value: string): void {
  if (value.length > 48 * 1024) throw new ReadFailure(414, "query_too_large");
}

/** Discovery is for this exact source filter, independent of dates and UI selectors. */
export function windowFilterScope(value: PublicScope): PublicScope {
  return selectionScope({ ...value, start: null, end: null });
}

export function windowParameters(value: PublicScope): URLSearchParams {
  return new URLSearchParams(publicScopeParameters(windowFilterScope(value)));
}

/** Existing request bounds, cancellation and credential omission also apply to discovery. */
export async function readPublishedWindows(
  base: string,
  selected: PublicScope,
  signal: AbortSignal,
): Promise<PublicWindows> {
  // Capture the complete original expectation before crossing the transport boundary.
  const requested = windowFilterScope(selected);
  const value = await request(base, "windows", new URLSearchParams(publicScopeParameters(requested)), signal);
  signal.throwIfAborted();
  try {
    return parsePublicWindows(value, requested, resolveMetricWindow);
  } catch {
    throw new ReadFailure(502, "api_windows_mismatch");
  }
}

/** A preset chooses a confirmed immutable publication; unavailable choices never substitute another period. */
export function choosePublishedWindow(
  selected: Selection,
  value: PublicWindows,
  requestedPeriod: PublicWindowPeriod,
): Selection {
  const requested = period(requestedPeriod);
  let available: PublicWindows;
  try {
    available = parsePublicWindows(value, windowFilterScope(selected), resolveMetricWindow);
  } catch {
    throw new ReadFailure(502, "api_windows_mismatch");
  }
  const chosen = available.windows.find((item) => item.period === requested);
  if (!chosen) throw new ReadFailure(503, "public_window_unavailable");
  return {
    ...structuredClone(selected),
    ...chosen.scope,
    snapshot: chosen.snapshotId,
    cursor: null,
    proof: null,
  };
}

export interface WindowStartIntent {
  period: PublicWindowPeriod;
  selected: Selection;
}

/** Only the new entry route has a default preset. Existing undated and pinned routes retain their meaning. */
export function windowStartIntent(pathname: string, search: string): WindowStartIntent | null {
  if (pathname !== entryPath) return null;
  const raw = search.startsWith("?") ? search.slice(1) : search;
  entryBudget(`${entryPath}${raw ? `?${raw}` : ""}`);
  const params = new URLSearchParams(raw);
  if (
    params.getAll("period").length > 1 ||
    retainedSelectors.some((key) => params.has(key)) ||
    (params.has("ui") && params.get("ui") !== "api")
  )
    throw new ReadFailure(400, "invalid_window_entry");
  const requested = period(params.get("period") ?? "30d");
  params.delete("period");
  // The existing parser still owns every actor, metric, filter and display-zone rule.
  const selected = selection(params.toString());
  return { period: requested, selected };
}

/** Explicit new-entry links deliberately carry no old dates, pin, cursor, proof or baseline. */
export function windowStartHref(selected: Selection, requestedPeriod: PublicWindowPeriod = "30d"): string {
  const requested = period(requestedPeriod);
  const value = {
    ...structuredClone(selected),
    ...windowFilterScope(selected),
    snapshot: null,
    cursor: null,
    proof: null,
  };
  const href = uiHref(entryPath, value);
  const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
  params.set("period", requested);
  const result = `${entryPath}?${params}`;
  entryBudget(result);
  return result;
}
