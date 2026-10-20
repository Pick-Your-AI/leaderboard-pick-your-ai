import { createHash } from "node:crypto";
import { types } from "node:util";

export interface PublicStewardshipTarget {
  readonly kind: "issue_comment";
  readonly repositoryId: string;
  readonly repositorySlug: string;
  readonly issueId: string;
  readonly issueNumber: string;
  readonly commentId: string;
  readonly commentDatabaseId: string;
  readonly url: string;
}
export interface PublicStewardshipEvidence {
  readonly locator: string;
  readonly revision: string;
  readonly sha256: string;
}
export interface PublicStewardshipSnapshot {
  readonly pinned: boolean;
  readonly evidence: PublicStewardshipEvidence;
}
export interface PublicStewardshipReview {
  readonly version: "public-stewardship-review/v1";
  readonly requestId: string;
  readonly claimRevision: number;
  readonly claimDigest: string;
  readonly reviewedInputDigest: string;
  readonly actorId: string;
  readonly contributorRole: "triager";
  readonly target: PublicStewardshipTarget;
  readonly action: "pinned" | "unpinned";
  readonly before: PublicStewardshipSnapshot;
  readonly after: PublicStewardshipSnapshot;
  readonly occurredAt: null;
}
export interface BoundPublicStewardshipReview {
  readonly review: PublicStewardshipReview;
  readonly descriptorDigest: string;
  readonly requestVersion: number;
  readonly reviewerId: string;
  readonly reviewerRoleVersion: string;
  readonly policyVersion: string;
  readonly acceptedAt: string;
}

const invalid = (): never => {
  throw new TypeError("invalid_public_stewardship_review");
};
function requireValue(value: unknown): asserts value {
  if (!value) invalid();
}

/** Do not invoke accessors, proxies, inherited fields or serialization callbacks. */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !types.isProxy(value));
  requireValue(!Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const names = Reflect.ownKeys(value);
  requireValue(names.length === keys.length && names.every((key) => typeof key === "string" && keys.includes(key)));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    requireValue(descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable);
    result[key] = descriptor.value;
  }
  return result;
}
function array(value: unknown, minimum: number, maximum: number): unknown[] {
  requireValue(value !== null && typeof value === "object" && !types.isProxy(value));
  requireValue(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  requireValue(Number.isSafeInteger(length) && length >= minimum && length <= maximum);
  requireValue(Reflect.ownKeys(value).length === length + 1);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    requireValue(descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable);
    result.push(descriptor.value);
  }
  return result;
}
function text(value: unknown, maximum = 200): string {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim());
  requireValue(!/[\u0000-\u001f\u007f-\u009f]/.test(value));
  // UTF-8 hashing must not replace a lone surrogate with U+FFFD.
  for (const point of value) {
    const code = point.codePointAt(0)!;
    requireValue(code < 0xd800 || code > 0xdfff);
  }
  return value;
}
function identity(value: unknown): string {
  const result = text(value);
  requireValue(/^[A-Za-z0-9_:+/=-]+$/.test(result));
  return result;
}
function decimalId(value: unknown): string {
  const result = text(value, 20);
  requireValue(/^[1-9][0-9]{0,19}$/.test(result));
  return result;
}
function positiveInteger(value: unknown): number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  return value;
}
function hash(value: unknown): string {
  const result = text(value, 64);
  requireValue(/^[a-f0-9]{64}$/.test(result));
  return result;
}
function slug(value: unknown): string {
  const result = text(value, 200);
  requireValue(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(result));
  return result;
}
function githubUrl(value: unknown): URL {
  const raw = text(value, 2048);
  let result: URL;
  try {
    result = new URL(raw);
  } catch {
    return invalid();
  }
  requireValue(
    result.protocol === "https:" &&
      result.hostname === "github.com" &&
      !result.username &&
      !result.password &&
      !result.port &&
      !raw.includes("?") &&
      result.href === raw &&
      !/[%\\]/.test(result.pathname),
  );
  requireValue(
    result.pathname
      .split("/")
      .slice(1)
      .every((part) => part && part !== "." && part !== ".."),
  );
  return result;
}
function reference(value: unknown): { locator: string; revision: string } {
  const input = record(value, ["locator", "revision"]);
  const revision = text(input.revision, 64);
  requireValue(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision));
  const url = githubUrl(input.locator);
  const parts = url.pathname.split("/");
  requireValue(parts.length >= 6 && parts[3] === "blob" && parts[4] === revision && !url.href.includes("#"));
  slug(parts[1] + "/" + parts[2]);
  return { locator: url.href, revision };
}
function snapshot(value: unknown): PublicStewardshipSnapshot {
  const input = record(value, ["pinned", "evidence"]);
  requireValue(typeof input.pinned === "boolean");
  const evidence = record(input.evidence, ["locator", "revision", "sha256"]);
  const pinnedReference = reference({ locator: evidence.locator, revision: evidence.revision });
  return Object.freeze({
    pinned: input.pinned,
    evidence: Object.freeze({ ...pinnedReference, sha256: hash(evidence.sha256) }),
  });
}
function target(value: unknown): PublicStewardshipTarget {
  const input = record(value, [
    "kind",
    "repositoryId",
    "repositorySlug",
    "issueId",
    "issueNumber",
    "commentId",
    "commentDatabaseId",
    "url",
  ]);
  requireValue(input.kind === "issue_comment");
  const repositoryId = decimalId(input.repositoryId),
    repositorySlug = slug(input.repositorySlug);
  const issueId = identity(input.issueId),
    issueNumber = decimalId(input.issueNumber);
  const commentId = identity(input.commentId),
    commentDatabaseId = decimalId(input.commentDatabaseId);
  const url = githubUrl(input.url).href;
  requireValue(issueId !== commentId);
  requireValue(
    url === "https://github.com/" + repositorySlug + "/issues/" + issueNumber + "#issuecomment-" + commentDatabaseId,
  );
  return Object.freeze({
    kind: "issue_comment",
    repositoryId,
    repositorySlug,
    issueId,
    issueNumber,
    commentId,
    commentDatabaseId,
    url,
  });
}

/**
 * Closed private input, initially limited to a reviewed issue-comment pin/unpin.
 * Parsing proves shape and internal consistency, never visibility or attribution.
 */
export function parsePublicStewardshipReview(value: unknown): PublicStewardshipReview {
  const input = record(value, [
    "version",
    "requestId",
    "claimRevision",
    "claimDigest",
    "reviewedInputDigest",
    "actorId",
    "contributorRole",
    "target",
    "action",
    "before",
    "after",
    "occurredAt",
  ]);
  requireValue(
    input.version === "public-stewardship-review/v1" &&
      input.contributorRole === "triager" &&
      (input.action === "pinned" || input.action === "unpinned") &&
      input.occurredAt === null,
  );
  const before = snapshot(input.before),
    after = snapshot(input.after);
  requireValue(before.pinned === (input.action === "unpinned") && after.pinned === (input.action === "pinned"));
  // A single immutable artifact can contain both snapshots. It cannot have two hashes.
  requireValue(before.evidence.locator !== after.evidence.locator || before.evidence.sha256 === after.evidence.sha256);
  const result: PublicStewardshipReview = Object.freeze({
    version: "public-stewardship-review/v1",
    requestId: text(input.requestId),
    claimRevision: positiveInteger(input.claimRevision),
    claimDigest: hash(input.claimDigest),
    reviewedInputDigest: hash(input.reviewedInputDigest),
    actorId: decimalId(input.actorId),
    contributorRole: "triager",
    target: target(input.target),
    action: input.action,
    before,
    after,
    occurredAt: null,
  });
  requireValue(Buffer.byteLength(JSON.stringify(result), "utf8") <= 16_384);
  return result;
}
function digest(review: PublicStewardshipReview): string {
  return createHash("sha256").update(JSON.stringify(review), "utf8").digest("hex");
}

/** Fixed-field canonical descriptor hash, not an original artifact hash or approval. */
export function publicStewardshipReviewDigest(value: unknown): string {
  return digest(parsePublicStewardshipReview(value));
}
function acceptedTime(value: unknown): string {
  const raw = text(value, 24);
  requireValue(
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(raw) && !raw.startsWith("0000"),
  );
  const parsed = new Date(raw);
  requireValue(Number.isFinite(parsed.getTime()) && parsed.toISOString() === raw);
  return raw;
}

/**
 * Structural recheck of an already authenticated host snapshot. The host retains
 * consent, policy, source-use, current public visibility and audit-twin authority.
 * No HTTP body or caller Boolean is promoted to such authority by this function.
 */
export function bindPublicStewardshipReview(value: unknown, current: unknown): BoundPublicStewardshipReview {
  const review = parsePublicStewardshipReview(value);
  const input = record(current, ["request", "decision", "currentReviewerRoleVersion"]);
  const request = record(input.request, [
    "id",
    "version",
    "category",
    "owner",
    "collaborators",
    "claimRevision",
    "claimDigest",
    "reviewedInputDigest",
    "submitterRole",
  ]);
  const decision = record(input.decision, [
    "requestId",
    "requestVersion",
    "descriptorDigest",
    "reviewerId",
    "reviewerRoleVersion",
    "policyVersion",
    "acceptedAt",
    "references",
  ]);
  // Admit every supplied record before comparing bindings or taking any shortcut.
  const requestId = text(request.id),
    requestVersion = positiveInteger(request.version);
  const owner = decimalId(request.owner),
    collaboratorIds = array(request.collaborators, 0, 20).map(decimalId);
  const claimRevision = positiveInteger(request.claimRevision),
    claimDigest = hash(request.claimDigest);
  const reviewedInputDigest = hash(request.reviewedInputDigest),
    submitterRole = text(request.submitterRole);
  const decisionRequestId = text(decision.requestId),
    decisionVersion = positiveInteger(decision.requestVersion);
  const descriptorDigest = hash(decision.descriptorDigest),
    reviewerId = decimalId(decision.reviewerId);
  const reviewerRoleVersion = text(decision.reviewerRoleVersion),
    policyVersion = text(decision.policyVersion, 100);
  const currentReviewerRoleVersion = text(input.currentReviewerRoleVersion),
    acceptedAt = acceptedTime(decision.acceptedAt);
  const references = array(decision.references, 1, 5).map(reference);
  const referenceKeys = references.map((entry) => JSON.stringify([entry.locator, entry.revision]));
  requireValue(new Set(referenceKeys).size === referenceKeys.length);
  requireValue(new Set(collaboratorIds).size === collaboratorIds.length && !collaboratorIds.includes(owner));
  requireValue(
    request.category === "public_moderation" &&
      requestId === review.requestId &&
      decisionRequestId === requestId &&
      requestVersion === decisionVersion &&
      owner === review.actorId &&
      claimRevision === review.claimRevision &&
      claimDigest === review.claimDigest &&
      reviewedInputDigest === review.reviewedInputDigest &&
      submitterRole === review.contributorRole &&
      descriptorDigest === digest(review) &&
      reviewerRoleVersion === currentReviewerRoleVersion &&
      reviewerId !== owner &&
      !collaboratorIds.includes(reviewerId),
  );
  for (const proof of [review.before.evidence, review.after.evidence])
    requireValue(references.some((entry) => entry.locator === proof.locator && entry.revision === proof.revision));
  return Object.freeze({
    review,
    descriptorDigest,
    requestVersion,
    reviewerId,
    reviewerRoleVersion,
    policyVersion,
    acceptedAt,
  });
}
