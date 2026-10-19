import {
  maintenanceClassificationVersion,
  maintenanceClassificationKinds,
  type MaintenanceClassificationKind,
} from "@pick-your-ai/contracts";
import type { NormalizedGithubResult } from "./normalizers.js";
import { validateMaintenanceSource } from "./maintenance.js";

export interface MaintenanceClassificationReference {
  locator: string;
  revision: string;
}
/** Private, independently reviewed claim. A reference string is not artifact verification. */
export interface MaintenanceClassificationRecord {
  schemaVersion: typeof maintenanceClassificationVersion;
  policyVersion: string;
  targetFactId: string;
  sourceRevision: string;
  classifications: { kind: MaintenanceClassificationKind; references: MaintenanceClassificationReference[] }[];
}
const invalid = (): never => {
  throw new Error("maintenance_classification_unverified");
};
const object = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const text = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit && value.trim() === value;
function reference(value: unknown): MaintenanceClassificationReference {
  if (!object(value, ["locator", "revision"]) || !text(value.locator, 2048) || !text(value.revision, 128))
    return invalid();
  try {
    const url = new URL(value.locator);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.username ||
      url.password ||
      url.port ||
      !/^\/[^/]+\/[^/]+\/.+/.test(url.pathname) ||
      url.href !== value.locator
    )
      return invalid();
  } catch {
    return invalid();
  }
  return { locator: value.locator, revision: value.revision };
}

/** Closed, bounded private shape. Does not authenticate the reviewer or fetch a reference. */
export function parseMaintenanceClassification(value: unknown): MaintenanceClassificationRecord {
  if (
    !object(value, ["schemaVersion", "policyVersion", "targetFactId", "sourceRevision", "classifications"]) ||
    value.schemaVersion !== maintenanceClassificationVersion ||
    !text(value.policyVersion, 100) ||
    !text(value.targetFactId, 200) ||
    !text(value.sourceRevision, 2000) ||
    !Array.isArray(value.classifications) ||
    value.classifications.length < 1 ||
    value.classifications.length > 3
  )
    return invalid();
  // Match the supported controls detail limit; never create an unbounded side channel.
  try {
    if (JSON.stringify(value).length > 2000) return invalid();
  } catch {
    return invalid();
  }
  const seen = new Set<string>();
  const allReferencePairs = new Set<string>();
  const sourceClassifications = value.classifications;
  const classificationCount = sourceClassifications.length;
  // Read the bounded own indices; caller-supplied iteration cannot omit validation.
  const classifications = Array.from({ length: classificationCount }, (_, index) => {
    if (!Object.hasOwn(sourceClassifications, index)) return invalid();
    const entry = sourceClassifications[index];
    if (
      !object(entry, ["kind", "references"]) ||
      typeof entry.kind !== "string" ||
      !maintenanceClassificationKinds.includes(entry.kind as MaintenanceClassificationKind) ||
      seen.has(entry.kind) ||
      !Array.isArray(entry.references) ||
      entry.references.length < 1 ||
      entry.references.length > 5
    )
      return invalid();
    seen.add(entry.kind);
    const sourceReferences = entry.references;
    const referenceCount = sourceReferences.length;
    const references = Array.from({ length: referenceCount }, (_, index) => {
      if (!Object.hasOwn(sourceReferences, index)) return invalid();
      const parsed = reference(sourceReferences[index]);
      allReferencePairs.add(JSON.stringify(parsed));
      return parsed;
    });
    if (
      allReferencePairs.size > 5 ||
      new Set(references.map((item) => JSON.stringify(item))).size !== references.length
    )
      return invalid();
    return { kind: entry.kind as MaintenanceClassificationKind, references };
  });
  return {
    schemaVersion: maintenanceClassificationVersion,
    policyVersion: value.policyVersion,
    targetFactId: value.targetFactId,
    sourceRevision: value.sourceRevision,
    classifications: classifications.sort((a, b) => a.kind.localeCompare(b.kind)),
  };
}

/** Bind the reviewed claim to the unchanged, opaque-revision merged participant proof.
 * The verified-receipt host separately authenticates policy, references, consent and audit.
 */
export function validateMaintenanceClassification(
  input: NormalizedGithubResult,
  targetFactId: string,
  acceptedAt: string,
  value: unknown,
): MaintenanceClassificationRecord {
  const record = parseMaintenanceClassification(value);
  const { target, evidence } = validateMaintenanceSource(input, targetFactId, acceptedAt);
  if (record.targetFactId !== target.id || record.sourceRevision !== evidence.sourceRevision) return invalid();
  return record;
}
