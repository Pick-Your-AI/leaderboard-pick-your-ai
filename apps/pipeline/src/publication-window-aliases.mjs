import {
  canonicalPublicScope,
  publicScopeFilterKey,
  publicScopeKey,
  publicWindowPeriods,
} from "@pick-your-ai/contracts";
import {
  publicScopeFromTemplate,
  resolvePublicationWindow,
  validatePublicationPeriods,
} from "./publication-windows.mjs";

const named = new Set(["7d", "30d", "90d", "month", "quarter", "year"]);
const calendar = new Set(["month", "quarter", "year"]);
const representativeOrder = ["year", "quarter", "month", "90d", "30d", "7d", "all"];
const fail = (code = "ambiguous_public_period_bounds") => {
  throw new Error(code);
};
const periodsFor = (template) => (publicWindowPeriods.includes(template.period) ? [template.period] : []);

function validate(templates, resolveMetricWindow) {
  if (!Array.isArray(templates) || templates.length > 100 || typeof resolveMetricWindow !== "function")
    fail("invalid_publication_window_templates");
  validatePublicationPeriods(templates);
}

/** Coalesce only distinct, explicitly approved named labels with one exact
 * complete public scope. The representative is an already approved engine
 * period, chosen independently of template order. Retained history is untouched. */
function coalesce(publications) {
  const groups = new Map();
  for (const publication of publications) {
    const key = publicScopeKey(publication.scope);
    const prior = groups.get(key);
    if (!prior) {
      groups.set(key, publication);
      continue;
    }
    if (
      prior.publicPeriods.length === 0 ||
      publication.publicPeriods.length !== 1 ||
      !named.has(publication.publicPeriods[0]) ||
      prior.publicPeriods.some((period) => !named.has(period)) ||
      prior.publicPeriods.includes(publication.publicPeriods[0]) ||
      prior.window.timezone !== publication.window.timezone ||
      prior.window.from !== publication.window.from ||
      prior.window.to !== publication.window.to
    )
      fail();
    prior.publicPeriods.push(publication.publicPeriods[0]);
    if (representativeOrder.indexOf(publication.window.period) < representativeOrder.indexOf(prior.window.period))
      prior.window = publication.window;
  }
  return [...groups.values()].map((publication) => ({
    ...publication,
    publicPeriods: publication.publicPeriods.sort(
      (left, right) => publicWindowPeriods.indexOf(left) - publicWindowPeriods.indexOf(right),
    ),
  }));
}

/** Calendar-to-date at its exact UTC opening instant has no interval to
 * publish. Only that valid empty case is omitted; every other resolver or
 * configuration error remains an error, including sub-second cutoffs. */
function resolveNonempty(template, cutoff, resolveMetricWindow) {
  try {
    return resolvePublicationWindow(template, cutoff, resolveMetricWindow);
  } catch (error) {
    if (!calendar.has(template.period) || error?.message !== "empty_named_period_window") throw error;
    const window = resolveMetricWindow(template.period, cutoff);
    if (window.from !== window.to || window.to !== cutoff) throw error;
    return null;
  }
}

/** One materialization and dispatch identity per concrete scope, with every
 * approved public alias carried explicitly into private confirmation. Legacy
 * and custom scopes never acquire a named label from matching dates. */
export function resolveDiscoverablePublicationWindows(templates, cutoff, resolveMetricWindow) {
  validate(templates, resolveMetricWindow);
  const publications = [];
  for (const template of templates) {
    const resolved = resolveNonempty(template, cutoff, resolveMetricWindow);
    if (resolved) publications.push({ ...resolved, publicPeriods: periodsFor(template) });
  }
  return coalesce(publications);
}

/** Check a supplied retained scope against the approved templates. Its own
 * end supplies the named-window cutoff; this neither discovers a publication
 * nor authorizes one using the current wall clock. */
export function approvedDiscoverablePublicationScope(templates, scope, resolveMetricWindow) {
  const selected = canonicalPublicScope(scope);
  try {
    validate(templates, resolveMetricWindow);
    const matches = [];
    for (const template of templates) {
      const approved = publicScopeFromTemplate(template);
      if (publicScopeFilterKey(approved) !== publicScopeFilterKey(selected)) continue;
      if (!named.has(template.period)) {
        if (publicScopeKey(approved) === publicScopeKey(selected))
          matches.push({ scope: approved, window: null, publicPeriods: periodsFor(template) });
        continue;
      }
      if (selected.start === null || selected.end === null) continue;
      const resolved = resolveNonempty(template, selected.end, resolveMetricWindow);
      if (resolved && publicScopeKey(resolved.scope) === publicScopeKey(selected))
        matches.push({ ...resolved, publicPeriods: periodsFor(template) });
    }
    return matches.length > 0 && coalesce(matches).length === 1;
  } catch {
    return false;
  }
}
