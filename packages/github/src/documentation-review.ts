import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { compareSourceInstants, publicEvidenceMetadataSchema, sourceEventSchema } from "@pick-your-ai/contracts";
import { classifyDocumentation, validateDocumentationPolicy, type DocumentationPathPolicy } from "./documentation.js";
import type { PinnedPhysicalDiff } from "./physical-diff.js";
import type { NormalizedGithubResult } from "./normalizers.js";

export const documentationReviewVersion = "documentation-review/v1";

export interface DocumentationReviewRecord {
  requestId: string;
  requestVersion: number;
  decisionId: string;
  targetFactId: string;
  sourceRevision: string;
  head: string;
  diff: PinnedPhysicalDiff;
}
export interface DocumentationReviewConfiguration {
  version: typeof documentationReviewVersion;
  pathPolicy: DocumentationPathPolicy;
  checklist: { version: string; items: string[] };
  records: DocumentationReviewRecord[];
}
export interface DocumentationReview {
  schemaVersion: typeof documentationReviewVersion;
  targetFactId: string;
  sourceRevision: string;
  head: string;
  proofHash: string;
  checklistVersion: string;
  completedItems: string[];
}
export interface DocumentationReviewProof {
  pathPolicy: DocumentationPathPolicy;
  checklist: DocumentationReviewConfiguration["checklist"];
  record: DocumentationReviewRecord;
  review: DocumentationReview;
}

function invalid(): never {
  throw new TypeError("documentation_review_unverified");
}
function requireValue(value: unknown): asserts value {
  if (!value) invalid();
}

/** Reject executable or oversized protected data before hashing, copying or classifying it. */
export function boundDocumentationReviewData(value: unknown): void {
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const take = (count: number) => {
    requireValue(count <= 1_000_000 - bytes);
    bytes += count;
  };
  const visit = (item: unknown, depth: number): void => {
    requireValue(++nodes <= 30_000 && depth <= 16);
    if (typeof item === "string") take(2 + item.length * 6);
    else if (item === null || typeof item === "boolean") take(5);
    else if (typeof item === "number" && Number.isFinite(item)) take(32);
    else if (item && typeof item === "object") {
      requireValue(!isProxy(item) && !ancestors.has(item));
      const array = Array.isArray(item);
      requireValue(
        array
          ? Object.getPrototypeOf(item) === Array.prototype
          : [Object.prototype, null].includes(Object.getPrototypeOf(item)),
      );
      const keys = Reflect.ownKeys(item);
      requireValue(keys.length <= 30_000 - nodes);
      requireValue(array ? item.length <= 1000 && keys.length === item.length + 1 : true);
      requireValue(keys.every((key) => typeof key === "string"));
      ancestors.add(item);
      take(2);
      const selected = array ? Array.from({ length: item.length }, (_value, index) => String(index)) : keys;
      for (const key of selected) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        requireValue(descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable);
        take(3 + String(key).length * 6);
        visit(descriptor.value, depth + 1);
      }
      ancestors.delete(item);
    } else invalid();
  };
  visit(value, 0);
}

function fields(value: unknown, names: string[]): Record<string, unknown> {
  requireValue(value && typeof value === "object" && !Array.isArray(value));
  const keys = Object.keys(value);
  requireValue(keys.length === names.length && names.every((name) => Object.hasOwn(value, name)));
  return value as Record<string, unknown>;
}
function id(value: unknown): asserts value is string {
  requireValue(typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value));
}
function revision(value: unknown): asserts value is string {
  requireValue(typeof value === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value));
}
function items(value: unknown): asserts value is string[] {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= 64);
  value.forEach(id);
  requireValue(new Set(value).size === value.length);
}
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const digest = (value: unknown): string => createHash("sha256").update(stable(value)).digest("hex");

export function parseDocumentationReviewConfiguration(value: unknown): DocumentationReviewConfiguration {
  boundDocumentationReviewData(value);
  const config = fields(value, ["version", "pathPolicy", "checklist", "records"]);
  requireValue(config.version === documentationReviewVersion);
  fields(config.pathPolicy, [
    "repositoryId",
    "version",
    "documentationPaths",
    "researchPaths",
    "generatedPaths",
    "importedPaths",
  ]);
  const pathPolicy = config.pathPolicy as DocumentationPathPolicy;
  validateDocumentationPolicy(pathPolicy);
  const checklist = fields(config.checklist, ["version", "items"]);
  id(checklist.version);
  items(checklist.items);
  requireValue(Array.isArray(config.records) && config.records.length <= 100);
  const requests = new Set<string>();
  for (const value of config.records) {
    const record = fields(value, [
      "requestId",
      "requestVersion",
      "decisionId",
      "targetFactId",
      "sourceRevision",
      "head",
      "diff",
    ]);
    for (const key of ["requestId", "decisionId", "targetFactId"]) id(record[key]);
    requireValue(Number.isSafeInteger(record.requestVersion) && Number(record.requestVersion) > 0);
    requireValue(typeof record.sourceRevision === "string" && record.sourceRevision.length <= 256);
    requireValue(/^[A-Za-z0-9_.:-]+$/.test(record.sourceRevision));
    revision(record.head);
    const diff = fields(record.diff, ["before", "after", "complete", "files"]);
    revision(diff.before);
    requireValue(
      diff.after === record.head && diff.before !== diff.after && diff.complete === true && Array.isArray(diff.files),
    );
    for (const file of diff.files) {
      requireValue(file && typeof file === "object" && !Array.isArray(file));
      requireValue(
        Object.keys(file).every((key) =>
          [
            "path",
            "previousPath",
            "additions",
            "deletions",
            "binary",
            "formattingOnly",
            "imported",
            "generated",
          ].includes(key),
        ),
      );
      requireValue(!Object.hasOwn(file, "previousPath") || typeof file.previousPath === "string");
      for (const key of ["binary", "formattingOnly", "imported", "generated"])
        requireValue(!Object.hasOwn(file, key) || typeof file[key] === "boolean");
    }
    requireValue(classifyDocumentation(record.diff as PinnedPhysicalDiff, pathPolicy).eligible);
    const requestId = record.requestId as string;
    requireValue(!requests.has(requestId));
    requests.add(requestId);
  }
  return structuredClone(value) as DocumentationReviewConfiguration;
}

export function parseDocumentationReview(value: unknown): DocumentationReview {
  boundDocumentationReviewData(value);
  const review = fields(value, [
    "schemaVersion",
    "targetFactId",
    "sourceRevision",
    "head",
    "proofHash",
    "checklistVersion",
    "completedItems",
  ]);
  requireValue(review.schemaVersion === documentationReviewVersion);
  id(review.targetFactId);
  requireValue(typeof review.sourceRevision === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(review.sourceRevision));
  revision(review.head);
  requireValue(typeof review.proofHash === "string" && /^[a-f0-9]{64}$/.test(review.proofHash));
  id(review.checklistVersion);
  items(review.completedItems);
  return structuredClone(value) as DocumentationReview;
}

/** This digest binds private bytes. It grants no source permission or reviewer authority. */
export function documentationReviewProofHash(
  config: Pick<DocumentationReviewConfiguration, "pathPolicy" | "checklist">,
  record: DocumentationReviewRecord,
): string {
  boundDocumentationReviewData([config.pathPolicy, config.checklist, record]);
  return digest([
    documentationReviewVersion,
    config.pathPolicy,
    config.checklist,
    record.targetFactId,
    record.sourceRevision,
    record.head,
    record.diff,
  ]);
}

export function validateDocumentationReviewSource(
  input: NormalizedGithubResult,
  targetFactId: string,
  acceptedAt: string,
  value: unknown,
) {
  boundDocumentationReviewData(value);
  const proof = fields(value, ["pathPolicy", "checklist", "record", "review"]);
  const config = parseDocumentationReviewConfiguration({
    version: documentationReviewVersion,
    pathPolicy: proof.pathPolicy,
    checklist: proof.checklist,
    records: [proof.record],
  });
  const record = config.records[0]!;
  const review = parseDocumentationReview(proof.review);
  const targets = input.facts.filter((fact) => fact.id === targetFactId);
  const evidence = input.evidence.filter((entry) => entry.contribution.contributionId === targetFactId);
  const target = targets[0];
  const source = evidence[0];
  const actors = input.actors.filter((actor) => actor.id === target?.actorId);
  const instant = (at: unknown): at is string =>
    typeof at === "string" && sourceEventSchema.shape.observedAt.safeParse(at).success;
  requireValue(
    input.isSynthetic !== true &&
      !input.syntheticFactIds?.includes(targetFactId) &&
      targets.length === 1 &&
      target &&
      target.metricId === "review_rounds" &&
      target.role === "reviewer" &&
      target.state === "observed" &&
      target.acceptanceReceipt == null &&
      target.acceptedBy == null &&
      target.acceptedAt == null &&
      target.actorId &&
      target.subjectActorId &&
      target.actorId !== target.subjectActorId &&
      actors.length === 1 &&
      actors[0]!.kind === "user" &&
      actors[0]!.executionMode !== "automated" &&
      actors[0]!.publicState === "visible" &&
      target.artifactId &&
      target.canonicalKey &&
      target.repoId === String(config.pathPolicy.repositoryId) &&
      instant(target.occurredAt) &&
      instant(target.observedAt) &&
      instant(acceptedAt) &&
      compareSourceInstants(target.occurredAt, acceptedAt) <= 0 &&
      target.rawState === "submitted_head:" + record.head &&
      evidence.length === 1 &&
      source &&
      source.artifact.kind === "pull_request" &&
      source.artifact.source === "github" &&
      source.artifact.visibility === "public" &&
      source.artifact.stableId === target.artifactId &&
      source.artifact.repositoryId === target.repoId &&
      source.contribution.artifactId === target.artifactId &&
      source.contribution.actorId === target.actorId &&
      source.contribution.canonicalEventId === target.canonicalKey &&
      source.contribution.qualification === "eligible" &&
      stable(source.contribution.metricIds) === stable(["review_rounds"]) &&
      stable(source.contribution.roles) === stable(["reviewer"]) &&
      source.occurredAt === target.occurredAt &&
      (source.evidenceMetadata === undefined ||
        (publicEvidenceMetadataSchema.safeParse(source.evidenceMetadata).success &&
          source.evidenceMetadata.sourceAction === "review_submitted" &&
          source.evidenceMetadata.activityState === "observed" &&
          source.evidenceMetadata.acceptedAt === null &&
          source.evidenceMetadata.sourceOccurredAt === target.occurredAt &&
          source.evidenceMetadata.observedAt === target.observedAt)) &&
      source.sourceRevision === record.sourceRevision &&
      record.targetFactId === targetFactId &&
      review.targetFactId === targetFactId &&
      review.sourceRevision === record.sourceRevision &&
      review.head === record.head &&
      review.proofHash === documentationReviewProofHash(config, record) &&
      review.checklistVersion === config.checklist.version &&
      stable([...review.completedItems].sort()) === stable([...config.checklist.items].sort()),
  );
  const repository = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/[1-9][0-9]*$/.exec(
    source.artifact.publicUrl,
  )?.[1];
  requireValue(repository);
  return {
    target,
    source,
    record,
    review,
    proof: { pathPolicy: config.pathPolicy, checklist: config.checklist, record, review } as DocumentationReviewProof,
    unit: "documentation-review:" + digest([target.repoId, target.artifactId, target.actorId, record.head]),
    sourceMeaning: digest([target.canonicalKey, record.sourceRevision, record.head, record.diff]),
    revisionUrl: "https://github.com/" + repository + "/commit/" + record.head,
  };
}
