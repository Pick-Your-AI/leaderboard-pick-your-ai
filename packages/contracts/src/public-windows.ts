import { canonicalPublicScope, publicScopeFilterKey, publicScopeKey, type PublicScope } from "./public-scope.js";

export const publicWindowsSchemaVersion = "public-windows/v1" as const;
export const publicWindowPeriods = ["7d", "30d", "90d", "month", "quarter", "year", "all"] as const;
export type PublicWindowPeriod = (typeof publicWindowPeriods)[number];
export interface PublicWindow {
  period: PublicWindowPeriod;
  scope: PublicScope;
  snapshotId: string;
  revision: number;
}
export interface PublicWindows {
  schemaVersion: typeof publicWindowsSchemaVersion;
  /** The complete requested filter identity, with both date bounds null. */
  scope: PublicScope;
  windows: PublicWindow[];
}
export type PublicWindowResolver = (period: PublicWindowPeriod, cutoff: string) => { from: string | null; to: string };

function invalid(): never {
  throw new Error("invalid_public_windows");
}
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) return invalid();
  return value;
}
/** JSON object order is irrelevant. Scope aliases, extra fields and noncanonical
 * dimension arrays are not wire identities and cannot be silently normalized. */
function exactScope(input: unknown): PublicScope {
  let scope: PublicScope;
  try {
    scope = canonicalPublicScope(input);
  } catch {
    return invalid();
  }
  const value = record(input, Object.keys(scope));
  for (const [key, expected] of Object.entries(scope)) {
    const actual = value[key];
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || actual.length !== expected.length || expected.some((item, i) => item !== actual[i]))
        return invalid();
    } else if (actual !== expected) return invalid();
  }
  return scope;
}
const wholeSecond = (value: string | null): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

/** Parse an independent discovery envelope. The trusted caller supplies the
 * existing metric resolver, avoiding a contracts-to-metrics dependency. This
 * validates published choices; it neither authorizes nor materializes a scope. */
export function parsePublicWindows(
  input: unknown,
  requestedScope: PublicScope,
  resolveWindow: PublicWindowResolver,
): PublicWindows {
  const requested = canonicalPublicScope(requestedScope);
  if (requested.start !== null || requested.end !== null || typeof resolveWindow !== "function") return invalid();
  const value = record(input, ["schemaVersion", "scope", "windows"]);
  const scope = exactScope(value.scope);
  if (
    value.schemaVersion !== publicWindowsSchemaVersion ||
    scope.start !== null ||
    scope.end !== null ||
    publicScopeKey(scope) !== publicScopeKey(requested) ||
    !Array.isArray(value.windows) ||
    value.windows.length > publicWindowPeriods.length
  )
    return invalid();
  const scopes = new Map<string, string>();
  const snapshots = new Map<string, string>();
  let previousPeriod = -1;
  const windows = Array.from(value.windows, (input): PublicWindow => {
    const entry = record(input, ["period", "scope", "snapshotId", "revision"]);
    const index = publicWindowPeriods.indexOf(entry.period as PublicWindowPeriod);
    if (
      index <= previousPeriod ||
      typeof entry.snapshotId !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,200}$/.test(entry.snapshotId) ||
      !Number.isSafeInteger(entry.revision) ||
      (entry.revision as number) < 1
    )
      return invalid();
    previousPeriod = index;
    const selected = exactScope(entry.scope);
    const period = publicWindowPeriods[index]!;
    if (publicScopeFilterKey(selected) !== publicScopeKey(scope)) return invalid();
    if (period === "all") {
      if (selected.start !== null || selected.end !== null) return invalid();
    } else {
      if (!wholeSecond(selected.start) || !wholeSecond(selected.end)) return invalid();
      let bounds: ReturnType<PublicWindowResolver>;
      try {
        bounds = resolveWindow(period, selected.end);
      } catch {
        return invalid();
      }
      if (bounds.from !== selected.start || bounds.to !== selected.end || selected.start >= selected.end)
        return invalid();
    }
    const key = publicScopeKey(selected);
    const identity = JSON.stringify([entry.snapshotId, entry.revision]);
    // Explicitly approved labels may name one identical materialization (for
    // example quarter and year in February). They cannot fork its identity.
    if (
      (scopes.has(key) && scopes.get(key) !== identity) ||
      (snapshots.has(entry.snapshotId) && snapshots.get(entry.snapshotId) !== key)
    )
      return invalid();
    scopes.set(key, identity);
    snapshots.set(entry.snapshotId, key);
    return { period, scope: selected, snapshotId: entry.snapshotId, revision: entry.revision as number };
  });
  return { schemaVersion: publicWindowsSchemaVersion, scope, windows };
}
