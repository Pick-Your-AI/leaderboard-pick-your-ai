import { compareSourceInstants, sourceEventSchema } from "@pick-your-ai/contracts";
import { GithubClientError, type GithubReadClient } from "./client.js";

/**
 * Minimized, private output of bounded authorized REST reads. This is a protected
 * collector product, not a cryptographic attestation or proof of ongoing access.
 * Current prerelease state does not establish the release's historical state.
 */
export interface GithubReleaseInclusionRecord {
  schemaVersion: "github-release-inclusion/v1";
  source: "github_rest";
  observedAt: string;
  request: {
    repositoryId: number;
    repositorySlug: string;
    releaseId: number;
    pullRequestNumber: number;
  };
  repository: { id: number; nodeId: string; slug: string; visibility: "public" };
  release: {
    id: number;
    nodeId: string;
    tagName: string;
    publishedAt: string;
    immutable: true;
    draft: false;
    currentPrerelease: boolean;
  };
  pullRequest: {
    id: number;
    nodeId: string;
    number: number;
    repositoryId: number;
    repositoryNodeId: string;
    repositorySlug: string;
    mergedAt: string;
    mergeCommitSha: string;
    /** Native account identity only; User does not prove a human-operated change. */
    author: { id: number; nodeId: string; type: "User" | "Bot" };
  };
  tag: {
    ref: string;
    nodeId: string;
    object: { type: "commit" | "tag"; sha: string };
    annotatedTags: {
      requestedSha: string;
      sha: string;
      nodeId: string;
      target: { type: "commit" | "tag"; sha: string };
    }[];
    commitSha: string;
  };
  comparison: {
    requestedBaseSha: string;
    requestedHeadSha: string;
    baseCommitSha: string;
    mergeBaseCommitSha: string;
    status: "ahead" | "identical";
    aheadBy: number;
    behindBy: 0;
  };
}

export type GithubReleaseInclusionFailure =
  | "invalid_request"
  | "repository_unverified"
  | "immutable_release_required"
  | "release_unverified"
  | "pull_request_unverified"
  | "clock_inconsistent"
  | "tag_unverified"
  | "tag_chain_limit"
  | "ancestry_unverified"
  | "record_unverified";

/** Fixed reasons never include release notes, response bodies, tokens or actor payloads. */
export class GithubReleaseInclusionError extends Error {
  constructor(public readonly reason: GithubReleaseInclusionFailure) {
    super(`GitHub release inclusion failed: ${reason}`);
    this.name = "GithubReleaseInclusionError";
  }
}

const MAX_ANNOTATED_TAGS = 16;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]): boolean =>
  Reflect.ownKeys(value).length === expected.length &&
  expected.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable === true && Object.hasOwn(descriptor, "value");
  });
const id = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const nodeId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_+=/\-]{1,256}$/.test(value);
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const slug = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value) &&
  ![".", ".."].includes(value.split("/")[1]!);
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 128 && sourceEventSchema.shape.observedAt.safeParse(value).success;

function requireEvidence(condition: unknown, reason: GithubReleaseInclusionFailure): asserts condition {
  if (!condition) throw new GithubReleaseInclusionError(reason);
}

function tagName(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1024 ||
    value === "@" ||
    /[\x00-\x20\x7f~^:?*\[\\]/.test(value) ||
    value.includes("..") ||
    value.includes("@{") ||
    value.endsWith(".") ||
    value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  )
    return false;
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

function gitObject(value: unknown): value is { type: "commit" | "tag"; sha: string } {
  return (
    object(value) && keys(value, ["type", "sha"]) && ["commit", "tag"].includes(value.type as string) && sha(value.sha)
  );
}

/**
 * Structurally revalidate a protected collector product and return detached,
 * minimized fields. This cannot authenticate arbitrary caller-created JSON;
 * admission must separately bind the authorized target and trusted collection.
 */
export function validateGithubReleaseInclusion(value: unknown): GithubReleaseInclusionRecord {
  const reason = "record_unverified";
  requireEvidence(
    object(value) &&
      keys(value, [
        "schemaVersion",
        "source",
        "observedAt",
        "request",
        "repository",
        "release",
        "pullRequest",
        "tag",
        "comparison",
      ]) &&
      value.schemaVersion === "github-release-inclusion/v1" &&
      value.source === "github_rest" &&
      timestamp(value.observedAt),
    reason,
  );
  const { request, repository, release, pullRequest, tag, comparison } = value;
  requireEvidence(
    object(request) &&
      keys(request, ["repositoryId", "repositorySlug", "releaseId", "pullRequestNumber"]) &&
      id(request.repositoryId) &&
      slug(request.repositorySlug) &&
      id(request.releaseId) &&
      id(request.pullRequestNumber) &&
      object(repository) &&
      keys(repository, ["id", "nodeId", "slug", "visibility"]) &&
      repository.id === request.repositoryId &&
      repository.slug === request.repositorySlug &&
      nodeId(repository.nodeId) &&
      repository.visibility === "public",
    reason,
  );
  requireEvidence(
    object(release) &&
      keys(release, ["id", "nodeId", "tagName", "publishedAt", "immutable", "draft", "currentPrerelease"]) &&
      release.id === request.releaseId &&
      nodeId(release.nodeId) &&
      tagName(release.tagName) &&
      timestamp(release.publishedAt) &&
      release.immutable === true &&
      release.draft === false &&
      typeof release.currentPrerelease === "boolean",
    reason,
  );
  requireEvidence(
    object(pullRequest) &&
      keys(pullRequest, [
        "id",
        "nodeId",
        "number",
        "repositoryId",
        "repositoryNodeId",
        "repositorySlug",
        "mergedAt",
        "mergeCommitSha",
        "author",
      ]) &&
      id(pullRequest.id) &&
      nodeId(pullRequest.nodeId) &&
      pullRequest.number === request.pullRequestNumber &&
      pullRequest.repositoryId === repository.id &&
      pullRequest.repositoryNodeId === repository.nodeId &&
      pullRequest.repositorySlug === repository.slug &&
      timestamp(pullRequest.mergedAt) &&
      sha(pullRequest.mergeCommitSha) &&
      object(pullRequest.author) &&
      keys(pullRequest.author, ["id", "nodeId", "type"]) &&
      id(pullRequest.author.id) &&
      nodeId(pullRequest.author.nodeId) &&
      ["User", "Bot"].includes(pullRequest.author.type as string),
    reason,
  );
  requireEvidence(
    compareSourceInstants(pullRequest.mergedAt, release.publishedAt) <= 0 &&
      compareSourceInstants(release.publishedAt, value.observedAt) <= 0,
    reason,
  );
  requireEvidence(
    object(tag) &&
      keys(tag, ["ref", "nodeId", "object", "annotatedTags", "commitSha"]) &&
      tag.ref === `refs/tags/${release.tagName}` &&
      nodeId(tag.nodeId) &&
      gitObject(tag.object) &&
      Array.isArray(tag.annotatedTags) &&
      tag.annotatedTags.length <= MAX_ANNOTATED_TAGS &&
      sha(tag.commitSha),
    reason,
  );
  let target = tag.object;
  const visited = new Set<string>();
  const annotatedTags: GithubReleaseInclusionRecord["tag"]["annotatedTags"] = [];
  for (const entry of tag.annotatedTags) {
    requireEvidence(
      target.type === "tag" &&
        !visited.has(target.sha) &&
        object(entry) &&
        keys(entry, ["requestedSha", "sha", "nodeId", "target"]) &&
        entry.requestedSha === target.sha &&
        entry.sha === target.sha &&
        nodeId(entry.nodeId) &&
        gitObject(entry.target) &&
        entry.target.sha.length === target.sha.length,
      reason,
    );
    visited.add(target.sha);
    annotatedTags.push({
      requestedSha: entry.requestedSha,
      sha: entry.sha,
      nodeId: entry.nodeId,
      target: { ...entry.target },
    });
    target = entry.target;
  }
  requireEvidence(
    target.type === "commit" &&
      target.sha === tag.commitSha &&
      tag.commitSha.length === pullRequest.mergeCommitSha.length &&
      !visited.has(target.sha),
    reason,
  );
  requireEvidence(
    object(comparison) &&
      keys(comparison, [
        "requestedBaseSha",
        "requestedHeadSha",
        "baseCommitSha",
        "mergeBaseCommitSha",
        "status",
        "aheadBy",
        "behindBy",
      ]) &&
      comparison.requestedBaseSha === pullRequest.mergeCommitSha &&
      comparison.requestedHeadSha === tag.commitSha &&
      comparison.baseCommitSha === pullRequest.mergeCommitSha &&
      comparison.mergeBaseCommitSha === pullRequest.mergeCommitSha &&
      comparison.behindBy === 0 &&
      Number.isSafeInteger(comparison.aheadBy) &&
      ((comparison.status === "identical" &&
        comparison.aheadBy === 0 &&
        tag.commitSha === pullRequest.mergeCommitSha) ||
        (comparison.status === "ahead" &&
          (comparison.aheadBy as number) > 0 &&
          tag.commitSha !== pullRequest.mergeCommitSha)),
    reason,
  );
  // Every retained value is checked above. Reconstruct nested containers so a
  // caller cannot mutate retained proof through aliases or extra array fields.
  return {
    schemaVersion: "github-release-inclusion/v1",
    source: "github_rest",
    observedAt: value.observedAt,
    request: { ...request },
    repository: { ...repository },
    release: { ...release },
    pullRequest: { ...pullRequest, author: { ...pullRequest.author } },
    tag: { ...tag, object: { ...tag.object }, annotatedTags },
    comparison: { ...comparison },
  } as GithubReleaseInclusionRecord;
}

function apiIdentity(value: unknown, path: string, reason: GithubReleaseInclusionFailure, origin?: string): string {
  requireEvidence(typeof value === "string" && value.length <= 8192, reason);
  let parsed: URL;
  try {
    parsed = new URL(value);
    requireEvidence(decodeURIComponent(parsed.pathname) === path, reason);
  } catch {
    throw new GithubReleaseInclusionError(reason);
  }
  requireEvidence(
    parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      (origin === undefined || parsed.origin === origin),
    reason,
  );
  return parsed.origin;
}

function nativeGitObject(
  value: unknown,
  repositoryPath: string,
  origin: string,
): { type: "commit" | "tag"; sha: string } {
  requireEvidence(
    object(value) && ["commit", "tag"].includes(value.type as string) && sha(value.sha),
    "tag_unverified",
  );
  apiIdentity(
    value.url,
    `${repositoryPath}/git/${value.type === "commit" ? "commits" : "tags"}/${value.sha}`,
    "tag_unverified",
    origin,
  );
  return { type: value.type as "commit" | "tag", sha: value.sha };
}

/**
 * Read an immutable published release, its accepted PR integration and actual
 * tag ancestry. Mutable releases have no supported historical proof here.
 * Requests always use the client's configured authority, never response URLs.
 * Authorization is repeated by GithubReadClient on every attempt and delivery.
 */
export async function collectGithubReleaseInclusion(options: {
  client: GithubReadClient;
  source: string;
  repository: { id: number; slug: string };
  releaseId: number;
  pullRequestNumber: number;
  observedAt: string;
  assertAuthorized: () => void;
  /** Default eight, hard ceiling sixteen; zero supports lightweight tags only. */
  maxAnnotatedTags?: number;
}): Promise<GithubReleaseInclusionRecord> {
  requireEvidence(object(options) && object(options.repository), "invalid_request");
  // Snapshot host selection before the first await; mutable options cannot
  // redirect later reads or change the protected target/observation identity.
  const { client, source, releaseId, pullRequestNumber, observedAt, assertAuthorized } = options;
  const repositoryId = options.repository.id;
  const repositorySlug = options.repository.slug;
  const maxAnnotatedTags = options.maxAnnotatedTags ?? 8;
  requireEvidence(
    id(repositoryId) &&
      slug(repositorySlug) &&
      id(releaseId) &&
      id(pullRequestNumber) &&
      timestamp(observedAt) &&
      typeof source === "string" &&
      source.length > 0 &&
      source.length <= 256 &&
      !/[\x00-\x1f\x7f]/.test(source) &&
      typeof assertAuthorized === "function" &&
      Number.isSafeInteger(maxAnnotatedTags) &&
      maxAnnotatedTags >= 0 &&
      maxAnnotatedTags <= MAX_ANNOTATED_TAGS,
    "invalid_request",
  );
  const authorize = () => {
    try {
      assertAuthorized();
    } catch {
      throw new GithubClientError({ kind: "unsafe_request" }, source);
    }
  };
  authorize();
  const scoped = client.forRepository(repositoryId);
  const read = (path: string) => scoped.rest(source, path, authorize);
  const repositoryPath = `/repos/${repositorySlug}`;
  const repository = await read(repositoryPath);
  requireEvidence(
    object(repository) &&
      repository.id === repositoryId &&
      repository.full_name === repositorySlug &&
      nodeId(repository.node_id) &&
      repository.private === false &&
      repository.visibility === "public",
    "repository_unverified",
  );
  const origin = apiIdentity(repository.url, repositoryPath, "repository_unverified");
  const release = await read(`${repositoryPath}/releases/${releaseId}`);
  requireEvidence(object(release), "release_unverified");
  requireEvidence(release.immutable === true, "immutable_release_required");
  requireEvidence(
    release.id === releaseId &&
      nodeId(release.node_id) &&
      tagName(release.tag_name) &&
      release.draft === false &&
      timestamp(release.published_at) &&
      typeof release.prerelease === "boolean",
    "release_unverified",
  );
  apiIdentity(release.url, `${repositoryPath}/releases/${releaseId}`, "release_unverified", origin);
  requireEvidence(compareSourceInstants(release.published_at, observedAt) <= 0, "clock_inconsistent");
  const pullRequest = await read(`${repositoryPath}/pulls/${pullRequestNumber}`);
  requireEvidence(
    object(pullRequest) &&
      id(pullRequest.id) &&
      nodeId(pullRequest.node_id) &&
      pullRequest.number === pullRequestNumber &&
      pullRequest.merged === true &&
      pullRequest.state === "closed" &&
      pullRequest.draft === false &&
      timestamp(pullRequest.merged_at) &&
      sha(pullRequest.merge_commit_sha) &&
      object(pullRequest.base) &&
      object(pullRequest.base.repo) &&
      pullRequest.base.repo.id === repositoryId &&
      pullRequest.base.repo.node_id === repository.node_id &&
      pullRequest.base.repo.full_name === repositorySlug &&
      pullRequest.base.repo.private === false &&
      object(pullRequest.user) &&
      id(pullRequest.user.id) &&
      nodeId(pullRequest.user.node_id) &&
      ["User", "Bot"].includes(pullRequest.user.type as string),
    "pull_request_unverified",
  );
  apiIdentity(pullRequest.url, `${repositoryPath}/pulls/${pullRequestNumber}`, "pull_request_unverified", origin);
  apiIdentity(pullRequest.base.repo.url, repositoryPath, "pull_request_unverified", origin);
  requireEvidence(compareSourceInstants(pullRequest.merged_at, release.published_at) <= 0, "clock_inconsistent");
  const ref = `refs/tags/${release.tag_name}`;
  const encodedTag = release.tag_name.split("/").map(encodeURIComponent).join("/");
  const reference = await read(`${repositoryPath}/git/ref/tags/${encodedTag}`);
  requireEvidence(object(reference) && reference.ref === ref && nodeId(reference.node_id), "tag_unverified");
  // GitHub's singular GET /git/ref returns a canonical /git/refs URL.
  apiIdentity(reference.url, `${repositoryPath}/git/${ref}`, "tag_unverified", origin);
  const initialTarget = nativeGitObject(reference.object, repositoryPath, origin);
  let target = initialTarget;
  const annotatedTags: GithubReleaseInclusionRecord["tag"]["annotatedTags"] = [];
  const visited = new Set<string>();
  while (target.type === "tag") {
    requireEvidence(!visited.has(target.sha), "tag_unverified");
    requireEvidence(annotatedTags.length < maxAnnotatedTags, "tag_chain_limit");
    visited.add(target.sha);
    const requestedSha = target.sha;
    const annotated = await read(`${repositoryPath}/git/tags/${requestedSha}`);
    requireEvidence(object(annotated) && annotated.sha === requestedSha && nodeId(annotated.node_id), "tag_unverified");
    apiIdentity(annotated.url, `${repositoryPath}/git/tags/${requestedSha}`, "tag_unverified", origin);
    target = nativeGitObject(annotated.object, repositoryPath, origin);
    requireEvidence(target.sha.length === requestedSha.length && !visited.has(target.sha), "tag_unverified");
    annotatedTags.push({ requestedSha, sha: annotated.sha, nodeId: annotated.node_id, target });
  }
  requireEvidence(target.sha.length === pullRequest.merge_commit_sha.length, "tag_unverified");
  const comparisonPath = `${repositoryPath}/compare/${pullRequest.merge_commit_sha}...${target.sha}`;
  // Membership uses native status/base/merge-base, not a possibly truncated list
  // of commits or files. Request attribution supplies the immutable head SHA.
  const comparison = await read(`${comparisonPath}?per_page=1&page=1`);
  requireEvidence(
    object(comparison) && object(comparison.base_commit) && object(comparison.merge_base_commit),
    "ancestry_unverified",
  );
  apiIdentity(comparison.url, comparisonPath, "ancestry_unverified", origin);
  requireEvidence(
    comparison.base_commit.sha === pullRequest.merge_commit_sha &&
      comparison.merge_base_commit.sha === pullRequest.merge_commit_sha &&
      comparison.behind_by === 0 &&
      Number.isSafeInteger(comparison.ahead_by) &&
      ((comparison.status === "identical" &&
        comparison.ahead_by === 0 &&
        target.sha === pullRequest.merge_commit_sha) ||
        (comparison.status === "ahead" &&
          (comparison.ahead_by as number) > 0 &&
          target.sha !== pullRequest.merge_commit_sha)),
    "ancestry_unverified",
  );
  const record = validateGithubReleaseInclusion({
    schemaVersion: "github-release-inclusion/v1",
    source: "github_rest",
    observedAt,
    request: { repositoryId, repositorySlug, releaseId, pullRequestNumber },
    repository: { id: repositoryId, nodeId: repository.node_id, slug: repositorySlug, visibility: "public" },
    release: {
      id: release.id,
      nodeId: release.node_id,
      tagName: release.tag_name,
      publishedAt: release.published_at,
      immutable: true,
      draft: false,
      currentPrerelease: release.prerelease,
    },
    pullRequest: {
      id: pullRequest.id,
      nodeId: pullRequest.node_id,
      number: pullRequest.number,
      repositoryId,
      repositoryNodeId: repository.node_id,
      repositorySlug,
      mergedAt: pullRequest.merged_at,
      mergeCommitSha: pullRequest.merge_commit_sha,
      author: { id: pullRequest.user.id, nodeId: pullRequest.user.node_id, type: pullRequest.user.type },
    },
    tag: { ref, nodeId: reference.node_id, object: initialTarget, annotatedTags, commitSha: target.sha },
    comparison: {
      requestedBaseSha: pullRequest.merge_commit_sha,
      requestedHeadSha: target.sha,
      baseCommitSha: comparison.base_commit.sha,
      mergeBaseCommitSha: comparison.merge_base_commit.sha,
      status: comparison.status,
      aheadBy: comparison.ahead_by,
      behindBy: comparison.behind_by,
    },
  });
  authorize();
  return record;
}
