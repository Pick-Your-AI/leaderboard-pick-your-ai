import { createHash } from "node:crypto";

export type GithubRestSnapshotFamily = "issues" | "pull_requests" | "comments" | "releases";

const prefix = "gh-rest-v1:";
const inlinePrefix = "gh-rest-comment-v2:";
const revisionPattern = /^(gh-rest-v1:|gh-rest-comment-v2:)([a-f0-9]{64})\.([a-f0-9]{32})$/;
const invalid = (): never => {
  throw new TypeError("invalid_github_rest_snapshot");
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
type Projection = (value: unknown) => unknown;
const string: Projection = (value) => (typeof value === "string" ? value : invalid());
const integer: Projection = (value) => (typeof value === "number" && Number.isSafeInteger(value) ? value : invalid());
const boolean: Projection = (value) => (typeof value === "boolean" ? value : invalid());

// Missing, explicit null and a source value remain distinct. We never serialize
// arbitrary response objects, rendered text variants or unselected API extras.
function field(value: Record<string, unknown>, key: string, project: Projection = string): unknown {
  if (!Object.hasOwn(value, key)) return [0];
  return value[key] === null ? [1] : [2, project(value[key])];
}
function record(value: unknown, project: (value: Record<string, unknown>) => unknown): unknown {
  return object(value) ? project(value) : invalid();
}
const identity: Projection = (value) =>
  record(value, (item) => [
    field(item, "id", integer),
    field(item, "node_id"),
    field(item, "login"),
    field(item, "type"),
  ]);
const label: Projection = (value) =>
  typeof value === "string"
    ? ["name", value]
    : record(value, (item) => ["label", field(item, "id", integer), field(item, "node_id"), field(item, "name")]);
const milestone: Projection = (value) =>
  record(value, (item) => [
    field(item, "id", integer),
    field(item, "node_id"),
    field(item, "number", integer),
    field(item, "title"),
    field(item, "state"),
  ]);
const branch: Projection = (value) =>
  record(value, (item) => [
    field(item, "sha"),
    field(item, "ref"),
    field(item, "repo", (repo) => record(repo, (entry) => [field(entry, "id", integer), field(entry, "node_id")])),
  ]);
const asset: Projection = (value) =>
  record(value, (item) => [
    field(item, "id", integer),
    field(item, "node_id"),
    field(item, "name"),
    field(item, "label"),
    field(item, "state"),
    field(item, "content_type"),
    field(item, "size", integer),
    field(item, "digest"),
    field(item, "created_at"),
    field(item, "updated_at"),
  ]);
const set =
  (project: Projection): Projection =>
  (value) => {
    if (!Array.isArray(value) || value.length > 10_000) return invalid();
    // These API collections are sets. Reordering is not an artifact edit; retained
    // duplicates still affect the hash rather than being silently discarded.
    return value.map((item) => JSON.stringify(project(item))).sort();
  };

export function isGithubRestSnapshotFamily(value: string): value is GithubRestSnapshotFamily {
  return ["issues", "pull_requests", "comments", "releases"].includes(value);
}

/**
 * Versioned projection of explicit fields shared by the REST list/get shapes.
 * Text contributes to identity but is returned only as a digest. In particular,
 * a PR list does not supply get-only merged_by/mergeable/diff totals, and an asset
 * download counter is not source-content identity. Hydration verifies additional
 * qualification dependencies separately; this is not a full-resource checksum.
 */
export function githubRestSnapshotFingerprint(family: GithubRestSnapshotFamily, payload: unknown): string {
  if (!isGithubRestSnapshotFamily(family) || !object(payload)) return invalid();
  const shared = [
    field(payload, "id", integer),
    field(payload, "node_id"),
    field(payload, "html_url"),
    field(payload, "body"),
    field(payload, "created_at"),
    field(payload, "updated_at"),
  ];
  let specific: unknown[];
  if (family === "issues" || family === "pull_requests") {
    specific = [
      field(payload, "number", integer),
      field(payload, "title"),
      field(payload, "state"),
      field(payload, "locked", boolean),
      field(payload, "active_lock_reason"),
      field(payload, "closed_at"),
      field(payload, "user", identity),
      field(payload, "assignee", identity),
      field(payload, "assignees", set(identity)),
      field(payload, "labels", set(label)),
      field(payload, "milestone", milestone),
      ...(family === "issues"
        ? [field(payload, "state_reason")]
        : [
            field(payload, "merged_at"),
            field(payload, "merge_commit_sha"),
            field(payload, "draft", boolean),
            field(payload, "head", branch),
            field(payload, "base", branch),
          ]),
    ];
  } else if (family === "comments") {
    specific = [field(payload, "issue_url"), field(payload, "user", identity), field(payload, "author_association")];
  } else {
    specific = [
      field(payload, "name"),
      field(payload, "tag_name"),
      field(payload, "target_commitish"),
      field(payload, "draft", boolean),
      field(payload, "prerelease", boolean),
      field(payload, "immutable", boolean),
      field(payload, "published_at"),
      field(payload, "author", identity),
      field(payload, "assets", set(asset)),
    ];
  }
  return createHash("sha256")
    .update(JSON.stringify([prefix, family, shared, specific]))
    .digest("hex");
}

// The old v1 projection is intentionally unchanged, including custom inline
// observations already stored under it. Expanded native inline dependencies
// belong to a different marker and never reinterpret a retained v1 revision.
function inlineCommentFingerprint(payload: unknown): string {
  if (!object(payload) || typeof payload.pull_request_url !== "string" || payload.pull_request_url.length === 0)
    return invalid();
  return createHash("sha256")
    .update(
      JSON.stringify([
        inlinePrefix,
        githubRestSnapshotFingerprint("comments", payload),
        field(payload, "pull_request_url"),
        field(payload, "pull_request_review_id", integer),
        field(payload, "in_reply_to_id", integer),
        field(payload, "commit_id"),
        field(payload, "original_commit_id"),
        field(payload, "path"),
        field(payload, "diff_hunk"),
        field(payload, "line", integer),
        field(payload, "original_line", integer),
        field(payload, "side"),
        field(payload, "start_line", integer),
        field(payload, "start_side"),
        field(payload, "subject_type"),
      ]),
    )
    .digest("hex");
}

/** A fresh immutable observation preserves current-state A → B → A after a restart. */
export function githubRestSnapshotRevision(family: GithubRestSnapshotFamily, payload: unknown, scanId: string): string {
  if (typeof scanId !== "string" || !/^[A-Za-z0-9_=.:\-]{1,128}$/.test(scanId)) return invalid();
  const inline = family === "comments" && object(payload) && Object.hasOwn(payload, "pull_request_url");
  const version = inline ? inlinePrefix : prefix;
  const fingerprint = inline ? inlineCommentFingerprint(payload) : githubRestSnapshotFingerprint(family, payload);
  const observation = createHash("sha256")
    .update(JSON.stringify([version, scanId]))
    .digest("hex")
    .slice(0, 32);
  return `${version}${fingerprint}.${observation}`;
}

/** Reserved markers must never fall through to legacy timestamp verification. */
export function hasGithubRestSnapshotPrefix(revision: string): boolean {
  return typeof revision === "string" && revision.startsWith("gh-rest-");
}

/** Semantic identity excludes the observation suffix; legacy revisions are not rewritten. */
export function githubRestSnapshotSemanticRevision(revision: string): string | null {
  const match = typeof revision === "string" ? revisionPattern.exec(revision) : null;
  return match ? `${match[1]}${match[2]}` : null;
}

export function verifyGithubRestSnapshotRevision(family: string, payload: unknown, revision: string): boolean {
  if (!isGithubRestSnapshotFamily(family)) return false;
  const semantic = githubRestSnapshotSemanticRevision(revision);
  if (semantic === null) return false;
  try {
    if (semantic.startsWith(inlinePrefix))
      return family === "comments" && semantic === `${inlinePrefix}${inlineCommentFingerprint(payload)}`;
    return semantic === `${prefix}${githubRestSnapshotFingerprint(family, payload)}`;
  } catch {
    return false;
  }
}
