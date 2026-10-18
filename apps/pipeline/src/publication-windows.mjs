import { canonicalPublicScope, publicScopeKey, publicScopeFilterKey } from "@pick-your-ai/contracts";

const named = new Set(["7d", "30d", "90d", "month", "quarter", "year"]);
const fail = (code) => {
  throw new Error(code);
};
const key = publicScopeKey;
const sameLens = (left, right) => publicScopeFilterKey(left) === publicScopeFilterKey(right);

/** Period is approved template metadata, never a field in a public scope. */
export function publicScopeFromTemplate(template) {
  if (template === null || typeof template !== "object" || Array.isArray(template)) fail("invalid_public_scope");
  const { period, ...scope } = template;
  return canonicalPublicScope(scope);
}

/** Opt-in templates remain part of the host's approved configuration. Existing
 * exact scopes never acquire a named period merely because their lengths match. */
export function validatePublicationPeriods(scopes) {
  const keys = new Set();
  for (const template of scopes) {
    const period = template?.period;
    if (period !== undefined && ![...named, "all", "custom"].includes(period)) fail("invalid_public_period");
    const scope = publicScopeFromTemplate(template);
    if ((named.has(period) || period === "all") && (scope.start !== null || scope.end !== null))
      fail("named_period_requires_unresolved_bounds");
    if (period === "custom" && scope.start === null) fail("custom_period_requires_bounds");
    const identity = named.has(period) ? JSON.stringify([publicScopeFilterKey(scope), period]) : key(scope);
    if (keys.has(identity)) fail("duplicate_public_scope");
    keys.add(identity);
  }
}

export function resolvePublicationWindow(template, cutoff, resolveMetricWindow) {
  const scope = publicScopeFromTemplate(template);
  const { period } = template;
  let window;
  if (named.has(period)) {
    // The existing public query requires .000Z. Reject, never round/truncate an
    // event cutoff or the separately retained source/observation timestamps.
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(cutoff)) fail("named_period_requires_whole_second_cutoff");
    window = resolveMetricWindow(period, cutoff);
    if (window.from >= window.to) fail("empty_named_period_window");
    scope.start = window.from;
    scope.end = window.to;
  } else {
    window =
      scope.start === null
        ? resolveMetricWindow("all", cutoff)
        : resolveMetricWindow("custom", cutoff, { from: scope.start, to: scope.end });
  }
  return { scope, window };
}

/** Bounds are the public identity; two period labels must never race to own it. */
export function resolvePublicationWindows(templates, cutoff, resolveMetricWindow) {
  const resolved = templates.map((template) => resolvePublicationWindow(template, cutoff, resolveMetricWindow));
  if (new Set(resolved.map(({ scope }) => key(scope))).size !== resolved.length) fail("ambiguous_public_period_bounds");
  return resolved;
}

/** A read can select a retained window, never compute or authorize a new one.
 * Ambiguous labels fail closed even if the current configuration was changed. */
export function approvedPublicationScope(templates, scope, resolveMetricWindow) {
  const selected = canonicalPublicScope(scope);
  const matches = templates.filter((template) => {
    const approved = publicScopeFromTemplate(template);
    if (!sameLens(approved, selected)) return false;
    if (!named.has(template.period)) return key(approved) === key(selected);
    if (selected.start === null || selected.end === null) return false;
    try {
      return key(resolvePublicationWindow(template, selected.end, resolveMetricWindow).scope) === key(selected);
    } catch {
      return false;
    }
  });
  return matches.length === 1;
}
