import { createHash } from "node:crypto";
import { compareSourceInstants, sourceEventSchema } from "@pick-your-ai/contracts";
import type { NormalizedGithubResult } from "./normalizers.js";

export interface OrderingScope {
  kind: "subissues" | "project_items";
  repositoryId: string;
  repositorySlug: string;
  id: string;
  url: string;
}
interface OrderingSnapshot {
  locator: string;
  revision: string;
  items: string[];
}
export interface OrderingReview {
  version: "ordering-review/v1";
  requestId: string;
  claimDigest: string;
  actorId: string;
  contributorRole: "ordering_contributor";
  method: "manual";
  scope: OrderingScope;
  source: { factId: string; artifactId: string; locator: string; revision: string };
  aliases: string[];
  before: OrderingSnapshot;
  after: OrderingSnapshot;
}
export interface OrderingSourceAuthority {
  version: "ordering-source-authority/v1";
  scopes: OrderingScope[];
}
const fail = (): never => {
  throw new Error("ordering_evidence_unverified");
};
function requireValue(value: unknown): asserts value {
  if (!value) fail();
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  requireValue([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  requireValue(Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
  for (const key of keys) requireValue(Object.getOwnPropertyDescriptor(value, key)?.get === undefined);
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 2048): string {
  requireValue(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximum &&
      value === value.trim() &&
      !/[\u0000-\u001f\u007f]/.test(value),
  );
  return value;
}
function array(value: unknown, maximum: number): unknown[] {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= maximum);
  requireValue(Object.getPrototypeOf(value) === Array.prototype);
  requireValue(Reflect.ownKeys(value).length === value.length + 1);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    requireValue(entry && Object.hasOwn(entry, "value"));
    result.push(entry.value);
  }
  return result;
}
function list(value: unknown, maximum: number): string[] {
  const result = array(value, maximum).map((entry) => text(entry));
  requireValue(new Set(result).size === result.length);
  return result;
}
function githubUrl(value: unknown): string {
  const raw = text(value);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return fail();
  }
  requireValue(
    parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      !parsed.port &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      parsed.href === raw,
  );
  requireValue(
    !/%|\\/.test(parsed.pathname) &&
      !parsed.pathname
        .split("/")
        .slice(1)
        .some((part) => !part || part === "." || part === ".."),
  );
  return raw;
}
export function parseOrderingScope(value: unknown): OrderingScope {
  const scope = record(value, ["kind", "repositoryId", "repositorySlug", "id", "url"]);
  requireValue(scope.kind === "subissues" || scope.kind === "project_items");
  const repositoryId = text(scope.repositoryId, 200),
    repositorySlug = text(scope.repositorySlug, 200),
    id = text(scope.id);
  requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositorySlug));
  const url = githubUrl(scope.url);
  requireValue(!new URL(url).hash);
  requireValue(
    scope.kind === "subissues"
      ? new RegExp(
          `^https://github\\.com/${repositorySlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/issues/[1-9][0-9]*$`,
        ).test(url)
      : /^https:\/\/github\.com\/(?:orgs|users)\/[A-Za-z0-9_.-]+\/projects\/[1-9][0-9]*$/.test(url),
  );
  return { kind: scope.kind, repositoryId, repositorySlug, id, url };
}
function snapshot(value: unknown, slug: string): OrderingSnapshot {
  const input = record(value, ["locator", "revision", "items"]);
  const revision = text(input.revision, 64),
    locator = githubUrl(input.locator);
  requireValue(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision));
  requireValue(!new URL(locator).hash && locator.startsWith(`https://github.com/${slug}/blob/${revision}/`));
  const items = list(input.items, 100);
  requireValue(items.length >= 2);
  return { locator, revision, items };
}
/** Closed, detached protected-review input. A parsed string is not a source grant. */
export function parseOrderingReview(value: unknown): OrderingReview {
  const input = record(value, [
    "version",
    "requestId",
    "claimDigest",
    "actorId",
    "contributorRole",
    "method",
    "scope",
    "source",
    "aliases",
    "before",
    "after",
  ]);
  requireValue(
    input.version === "ordering-review/v1" &&
      input.method === "manual" &&
      input.contributorRole === "ordering_contributor",
  );
  const requestId = text(input.requestId, 200),
    claimDigest = text(input.claimDigest, 64),
    actorId = text(input.actorId, 200);
  requireValue(/^[a-f0-9]{64}$/.test(claimDigest));
  const scope = parseOrderingScope(input.scope),
    source = record(input.source, ["factId", "artifactId", "locator", "revision"]);
  const target = {
    factId: text(source.factId, 200),
    artifactId: text(source.artifactId),
    locator: githubUrl(source.locator),
    revision: text(source.revision, 512),
  };
  requireValue(target.locator.startsWith(`https://github.com/${scope.repositorySlug}/`));
  const aliases = list(input.aliases, 32).sort();
  requireValue(aliases.includes(target.artifactId));
  const before = snapshot(input.before, scope.repositorySlug),
    after = snapshot(input.after, scope.repositorySlug);
  requireValue(before.locator !== after.locator && before.items.length === after.items.length);
  requireValue(
    before.items.every((id) => after.items.includes(id)) && before.items.some((id, index) => after.items[index] !== id),
  );
  const result: OrderingReview = {
    version: "ordering-review/v1",
    requestId,
    claimDigest,
    actorId,
    contributorRole: "ordering_contributor",
    method: "manual",
    scope,
    source: target,
    aliases,
    before,
    after,
  };
  requireValue(Buffer.byteLength(JSON.stringify(result), "utf8") <= 48_000);
  return result;
}
export function parseOrderingSourceAuthority(value: unknown): OrderingSourceAuthority {
  const input = record(value, ["version", "scopes"]);
  requireValue(input.version === "ordering-source-authority/v1");
  const scopes = array(input.scopes, 100).map(parseOrderingScope);
  requireValue(
    new Set(scopes.map((scope) => JSON.stringify([scope.repositoryId, scope.kind, scope.id]))).size === scopes.length,
  );
  return { version: "ordering-source-authority/v1", scopes };
}
/** The caller also checks current intake, participant consent and its complete source-use audit. */
export function bindOrderingReview(
  value: unknown,
  request: {
    id: string;
    owner: string;
    category: string;
    locator: string;
    intake?: { claimDigest?: string; roles?: { submitter?: string | null } };
  },
  references: readonly { locator: string; revision: string }[],
): OrderingReview {
  const review = parseOrderingReview(value);
  requireValue(
    request.category === "ordering" &&
      review.requestId === request.id &&
      review.actorId === request.owner &&
      review.claimDigest === request.intake?.claimDigest &&
      review.contributorRole === request.intake?.roles?.submitter &&
      review.source.locator === request.locator,
  );
  for (const proof of [review.before, review.after])
    requireValue(
      references.filter((reference) => reference.locator === proof.locator && reference.revision === proof.revision)
        .length === 1,
    );
  return review;
}
export function orderingPlanIdentity(review: OrderingReview) {
  // Source artifact identifies the reviewed plan, independent of receipt IDs,
  // revision aliases or review time. Ordered values remain ordered in its proof.
  const scope = [review.actorId, review.scope.repositoryId, review.scope.kind, review.scope.id];
  const unit = JSON.stringify(["ordering-plan/v1", ...scope, review.source.artifactId]);
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        scope,
        review.scope,
        review.source.artifactId,
        review.contributorRole,
        review.method,
        review.before.items,
        review.after.items,
      ]),
    )
    .digest("hex");
  return { unit, identity, aliases: review.aliases.map((alias) => JSON.stringify([...scope, alias])) };
}
/** Every alias must be validated before any ordering receipt callback runs. */
export function registerOrderingPlan(
  registry: Map<string, { unit: string; identity: string }>,
  review: OrderingReview,
): boolean {
  const current = orderingPlanIdentity(review);
  const keys = [current.unit, ...current.aliases];
  for (const key of keys) {
    const previous = registry.get(key);
    requireValue(!previous || (previous.unit === current.unit && previous.identity === current.identity));
  }
  const duplicate = registry.has(current.unit);
  for (const key of keys) registry.set(key, { unit: current.unit, identity: current.identity });
  return duplicate;
}
/** Explicit host-enrolled scope plus one current attributable public plan source. */
export function validateOrderingSource(
  input: NormalizedGithubResult,
  targetFactId: string,
  acceptedAt: string,
  value: unknown,
  grant: unknown,
) {
  const review = parseOrderingReview(value),
    authority = parseOrderingSourceAuthority(grant);
  requireValue(authority.scopes.some((scope) => JSON.stringify(scope) === JSON.stringify(review.scope)));
  const targets = input.facts.filter((fact) => fact.id === targetFactId),
    target = targets[0];
  const proofs = input.evidence.filter((proof) => proof.contribution.contributionId === targetFactId),
    proof = proofs[0];
  const actors = input.actors.filter((actor) => actor.id === review.actorId),
    actor = actors[0];
  requireValue(
    !input.isSynthetic &&
      !input.syntheticFactIds?.includes(targetFactId) &&
      targets.length === 1 &&
      proofs.length === 1 &&
      actors.length === 1 &&
      target &&
      proof &&
      actor,
  );
  requireValue(
    target.id === review.source.factId &&
      target.actorId === review.actorId &&
      target.repoId === review.scope.repositoryId &&
      target.artifactId === review.source.artifactId &&
      target.state === "observed" &&
      target.acceptedAt == null &&
      target.acceptedBy == null &&
      target.acceptanceReceipt == null &&
      !!target.canonicalKey,
  );
  requireValue(
    ["author", "reporter", "commenter"].includes(target.role) &&
      actor.kind === "user" &&
      actor.executionMode !== "automated" &&
      actor.publicState === "visible",
  );
  requireValue(
    typeof target.occurredAt === "string" &&
      sourceEventSchema.shape.observedAt.safeParse(target.occurredAt).success &&
      sourceEventSchema.shape.observedAt.safeParse(acceptedAt).success &&
      compareSourceInstants(target.occurredAt, acceptedAt) <= 0,
  );
  requireValue(
    proof.artifact.visibility === "public" &&
      proof.artifact.source === "github" &&
      proof.artifact.repositoryId === target.repoId &&
      proof.artifact.stableId === target.artifactId &&
      proof.artifact.publicUrl === review.source.locator &&
      proof.sourceRevision === review.source.revision &&
      proof.contribution.artifactId === target.artifactId &&
      proof.contribution.actorId === target.actorId &&
      proof.contribution.canonicalEventId === target.canonicalKey &&
      proof.contribution.qualification === "eligible" &&
      proof.contribution.roles.length === 1 &&
      proof.contribution.roles[0] === target.role &&
      proof.contribution.metricIds.length === 1 &&
      proof.contribution.metricIds[0] === target.metricId &&
      proof.occurredAt === target.occurredAt,
  );
  return { review, authority, target, proof, ...orderingPlanIdentity(review) };
}
