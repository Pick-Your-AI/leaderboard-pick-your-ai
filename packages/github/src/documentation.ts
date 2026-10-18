import { classifyFile, classifyPhysicalDiff, type PinnedPhysicalDiff } from "./physical-diff.js";

/** Explicit repository policy; no inference from PR titles, labels, line count or file extension. */
export interface DocumentationPathPolicy {
  repositoryId: number;
  version: string;
  documentationPaths: readonly string[];
  researchPaths: readonly string[];
  generatedPaths: readonly string[];
  importedPaths: readonly string[];
}
export function validateDocumentationPolicy(policy: DocumentationPathPolicy): void {
  if (
    !policy ||
    !Number.isSafeInteger(policy.repositoryId) ||
    policy.repositoryId < 1 ||
    !/^[A-Za-z0-9_.:-]{1,200}$/.test(policy.version)
  )
    throw new Error("Invalid documentation policy identity");
  for (const key of ["documentationPaths", "researchPaths", "generatedPaths", "importedPaths"] as const) {
    const paths = policy[key];
    if (
      !Array.isArray(paths) ||
      paths.length > 100 ||
      (key === "documentationPaths" && !paths.length) ||
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
}
const matches = (path: string, rules: readonly string[]) =>
  rules.some((rule) => (rule.endsWith("/") ? path.startsWith(rule) : path === rule));
export function classifyDocumentation(diff: PinnedPhysicalDiff, policy: DocumentationPathPolicy) {
  validateDocumentationPolicy(policy);
  const physical = classifyPhysicalDiff(diff);
  if (!physical.complete) return { eligible: false, reasons: ["documentation_diff_incomplete"] };
  const reasons = new Set<string>();
  let eligible = false;
  for (const file of physical.files) {
    if (!matches(file.path, policy.documentationPaths)) continue;
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
    if (exclusion) reasons.add(`documentation_excluded_${exclusion}`);
    else if (file.additions > 0 || file.deletions > 0) eligible = true; // Substantive deletion is participation too; zero-change moves are not new content.
  }
  if (!eligible) reasons.add("no_eligible_documentation_change");
  return { eligible, reasons: [...reasons].sort() };
}
