import { classifyFile, classifyPhysicalDiff, type PinnedPhysicalDiff } from "./physical-diff.js";

/** Explicit repository policy; no inference from PR titles, labels, line count or file extension. */
export interface DocumentationPathPolicy {
  repositoryId: number;
  version: string;
  documentationPaths: readonly string[];
  researchPaths: readonly string[];
  generatedPaths: readonly string[];
  importedPaths: readonly string[];
  /** Explicit language/category mapping; a path or extension never implies a locale. */
  localizationPaths?: readonly LocalizationPathRule[];
}
export interface LocalizationPathRule {
  locale: string;
  category: string;
  paths: readonly string[];
}
function validatePaths(paths: readonly string[], nonempty: boolean): void {
  if (
    !Array.isArray(paths) ||
    paths.length > 100 ||
    (nonempty && !paths.length) ||
    new Set(paths).size !== paths.length
  )
    throw new Error("Explicit bounded documentation paths required");
  for (const path of paths)
    if (
      typeof path !== "string" ||
      path.length > 500 ||
      !/^[A-Za-z0-9_./-]+$/.test(path) ||
      path.startsWith("/") ||
      path.split("/").some((part, i, parts) => part === "." || part === ".." || (!part && i !== parts.length - 1))
    )
      throw new Error("Unsafe documentation policy path");
}
export function validateDocumentationPolicy(policy: DocumentationPathPolicy): void {
  if (
    !policy ||
    !Number.isSafeInteger(policy.repositoryId) ||
    policy.repositoryId < 1 ||
    typeof policy.version !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,200}$/.test(policy.version)
  )
    throw new Error("Invalid documentation policy identity");
  for (const key of ["documentationPaths", "researchPaths", "generatedPaths", "importedPaths"] as const) {
    validatePaths(policy[key], key === "documentationPaths");
  }
  const rules = policy.localizationPaths ?? [];
  if (!Array.isArray(rules) || rules.length > 32) throw new Error("Bounded localization rules required");
  const identities = new Set<string>();
  let pathCount = 0;
  for (const rule of rules) {
    if (
      !rule ||
      typeof rule.locale !== "string" ||
      rule.locale.length > 64 ||
      !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(rule.locale) ||
      typeof rule.category !== "string" ||
      !/^[a-z][a-z0-9_]{0,39}$/.test(rule.category)
    )
      throw new Error("Explicit canonical locale and category required");
    let canonical: string | undefined;
    try {
      canonical = Intl.getCanonicalLocales(rule.locale)[0];
      const locale = new Intl.Locale(rule.locale);
      if (locale.baseName !== rule.locale || ["und", "mul", "zxx"].includes(rule.locale.split("-")[0]!))
        throw new Error("A specific language without extensions is required");
    } catch {
      throw new Error("Explicit canonical locale and category required");
    }
    if (canonical !== rule.locale) throw new Error("Explicit canonical locale and category required");
    const identity = JSON.stringify([rule.locale, rule.category]);
    if (identities.has(identity)) throw new Error("Duplicate localization locale/category");
    identities.add(identity);
    validatePaths(rule.paths, true);
    pathCount += rule.paths.length;
    if (pathCount > 256) throw new Error("Localization policy exceeds path bound");
  }
  // A file cannot silently establish several language/category units. Reject
  // conflicting overlapping rules before any observation is normalized.
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      if (
        rules[i]!.paths.some((left: string) =>
          rules[j]!.paths.some((right: string) => matches(left, [right]) || matches(right, [left])),
        )
      )
        throw new Error("Ambiguous overlapping localization paths");
    }
  }
}
const matches = (path: string, rules: readonly string[]) =>
  rules.some((rule) => (rule.endsWith("/") ? path.startsWith(rule) : path === rule));
export function classifyDocumentation(diff: PinnedPhysicalDiff, policy: DocumentationPathPolicy) {
  validateDocumentationPolicy(policy);
  const physical = classifyPhysicalDiff(diff);
  const localizations: { locale: string; category: string }[] = [];
  if (!physical.complete) return { eligible: false, localizations, reasons: ["documentation_diff_incomplete"] };
  const reasons = new Set<string>();
  const locales = new Map<string, { locale: string; category: string }>();
  let eligible = false;
  for (const file of physical.files) {
    const documentation = matches(file.path, policy.documentationPaths);
    const localization = (policy.localizationPaths ?? []).find((rule) => matches(file.path, rule.paths));
    if (!documentation && !localization) continue;
    const paths = [file.path, ...(file.previousPath ? [file.previousPath] : [])];
    const previousClass = file.previousPath ? classifyFile({ ...file, path: file.previousPath }) : null;
    const previousExclusion =
      previousClass && !["source", "tests", "docs"].includes(previousClass) ? previousClass : null;
    const exclusion = paths.some((path) => matches(path, policy.researchPaths))
      ? "research_path"
      : paths.some((path) => matches(path, policy.generatedPaths))
        ? "generated"
        : paths.some((path) => matches(path, policy.importedPaths))
          ? "imported"
          : (file.reason ?? previousExclusion);
    if (exclusion) {
      if (documentation) reasons.add(`documentation_excluded_${exclusion}`);
      if (localization) reasons.add(`localization_excluded_${exclusion}`);
    } else if (file.additions > 0 || file.deletions > 0) {
      if (documentation) eligible = true; // Substantive deletion is participation too; zero-change moves are not new content.
      if (localization) {
        const { locale, category } = localization;
        locales.set(JSON.stringify([locale, category]), { locale, category });
      }
    }
  }
  if (!eligible) reasons.add("no_eligible_documentation_change");
  localizations.push(...[...locales].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, value]) => value));
  return { eligible, localizations, reasons: [...reasons].sort() };
}
