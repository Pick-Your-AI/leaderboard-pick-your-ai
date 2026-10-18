import { classifyFile, classifyPhysicalDiff, pinnedSha, type PinnedPhysicalDiff } from "./physical-diff.js";

/** Reviewed repository paths, separate from research-owned artifact schemas. */
export interface ResearchPathPolicy {
  repositoryId: number;
  version: string;
  recordPaths: readonly string[];
  generatedPaths: readonly string[];
  importedPaths: readonly string[];
  syntheticPaths: readonly string[];
}

/**
 * Protected host provenance after reading the exact Git blob. Merely finding a
 * Markdown file, an approval word or a successful validator does not supply it.
 */
export interface VerifiedResearchRecord {
  verified: true;
  kind: "decision_record";
  repositoryId: number;
  path: string;
  sourceRevision: string;
  blobSha: string;
  presentAtRevision: true;
  provenance: "original" | "generated" | "imported" | "synthetic" | "unknown";
}

function validPath(value: unknown, prefix: boolean): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 500 &&
    /^[A-Za-z0-9_./-]+$/.test(value) &&
    !value.startsWith("/") &&
    (prefix || !value.endsWith("/")) &&
    !value.split("/").some((part, i, parts) => part === "." || part === ".." || (!part && i !== parts.length - 1))
  );
}

const matches = (path: string, rules: readonly string[]) =>
  rules.some((rule) => (rule.endsWith("/") ? path.startsWith(rule) : path === rule));

export function validateResearchPolicy(policy: ResearchPathPolicy): void {
  if (
    !policy ||
    !Number.isSafeInteger(policy.repositoryId) ||
    policy.repositoryId < 1 ||
    typeof policy.version !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,200}$/.test(policy.version)
  )
    throw new Error("Invalid research policy identity");
  for (const key of ["recordPaths", "generatedPaths", "importedPaths", "syntheticPaths"] as const) {
    const paths = policy[key];
    if (
      !Array.isArray(paths) ||
      paths.length > 100 ||
      (key === "recordPaths" && !paths.length) ||
      new Set(paths).size !== paths.length ||
      paths.some((path) => !validPath(path, true))
    )
      throw new Error("Explicit bounded research paths required");
  }
}

/** Identity is the canonical record path and Git blob, never a PR or line count. */
export function classifyResearchRecords(
  diff: PinnedPhysicalDiff,
  records: readonly VerifiedResearchRecord[],
  policy: ResearchPathPolicy,
) {
  validateResearchPolicy(policy);
  if (!Array.isArray(records) || records.length > 100) throw new Error("Bounded verified research records required");
  const physical = classifyPhysicalDiff(diff);
  if (!physical.complete) return { records: [] as VerifiedResearchRecord[], reasons: ["research_diff_incomplete"] };
  const reasons = new Set<string>();
  const selected = new Map<string, VerifiedResearchRecord>();
  const bindings = new Map<string, string>();
  for (const record of records) {
    if (
      !record ||
      record.verified !== true ||
      record.kind !== "decision_record" ||
      record.repositoryId !== policy.repositoryId ||
      record.presentAtRevision !== true ||
      !validPath(record.path, false) ||
      !pinnedSha(record.sourceRevision) ||
      record.sourceRevision.toLowerCase() !== diff.after.toLowerCase() ||
      !pinnedSha(record.blobSha)
    )
      throw new Error("Verified research record revision and identity required");
    const binding = JSON.stringify([
      record.sourceRevision.toLowerCase(),
      record.blobSha.toLowerCase(),
      record.provenance,
    ]);
    const priorBinding = bindings.get(record.path);
    if (priorBinding !== undefined && priorBinding !== binding)
      throw new Error("Conflicting research record blob identity or provenance");
    bindings.set(record.path, binding);
    if (record.provenance !== "original") {
      reasons.add("research_original_provenance_unverified");
      continue;
    }
    const file = physical.files.find((entry) => entry.path === record.path);
    if (!file || !matches(record.path, policy.recordPaths)) {
      reasons.add("research_record_change_unverified");
      continue;
    }
    const paths = [file.path, ...(file.previousPath ? [file.previousPath] : [])];
    const previousClass = file.previousPath ? classifyFile({ ...file, path: file.previousPath }) : null;
    const excluded =
      paths.some((path) => matches(path, policy.syntheticPaths)) ||
      paths.some((path) => matches(path, policy.generatedPaths)) ||
      paths.some((path) => matches(path, policy.importedPaths)) ||
      (previousClass && !["source", "tests", "docs"].includes(previousClass)) ||
      !file.eligible;
    if (excluded) {
      reasons.add("research_record_excluded_content");
      continue;
    }
    if (file.additions === 0 && file.deletions === 0) {
      reasons.add("research_record_has_no_substantive_change");
      continue;
    }
    const canonical = {
      ...record,
      blobSha: record.blobSha.toLowerCase(),
      sourceRevision: record.sourceRevision.toLowerCase(),
    };
    selected.set(record.path, canonical);
  }
  return { records: [...selected.values()].sort((a, b) => a.path.localeCompare(b.path)), reasons: [...reasons].sort() };
}
