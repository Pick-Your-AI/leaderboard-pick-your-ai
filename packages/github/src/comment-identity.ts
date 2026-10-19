/** Native public comment identity. A source URL never supplies author, editor or activity credit. */
export type GithubCommentKind = "issue_comment" | "pull_request_conversation_comment" | "pull_request_review_comment";
export interface GithubCommentSource {
  kind: GithubCommentKind;
  commentId: number;
  parentNumber: number;
  sourceUrl: string;
  apiPath: string;
  parentApiPath: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function readGithubCommentSource(slug: string, sourceUrl: unknown): GithubCommentSource | null {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(slug) || typeof sourceUrl !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (
    parsed.origin !== "https://github.com" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.href !== sourceUrl
  )
    return null;
  const suffix = parsed.pathname.startsWith("/" + slug + "/") ? parsed.pathname.slice(slug.length + 2) : "";
  const parent = /^(issues|pull)\/([1-9]\d*)$/.exec(suffix);
  const anchor = /^#(issuecomment-|discussion_r|r)([1-9]\d*)$/.exec(parsed.hash);
  if (!parent || !anchor) return null;
  const parentNumber = Number(parent[2]),
    commentId = Number(anchor[2]);
  if (!positive(parentNumber) || !positive(commentId)) return null;
  const inline = anchor[1] !== "issuecomment-";
  if (inline && parent[1] !== "pull") return null;
  return {
    kind: inline
      ? "pull_request_review_comment"
      : parent[1] === "pull"
        ? "pull_request_conversation_comment"
        : "issue_comment",
    commentId,
    parentNumber,
    sourceUrl,
    apiPath: "/repos/" + slug + (inline ? "/pulls/comments/" : "/issues/comments/") + commentId,
    parentApiPath: "/repos/" + slug + (inline ? "/pulls/" : "/issues/") + parentNumber,
  };
}

/** List and get identities must agree with every supplied native self/parent link. */
export function readGithubCommentIdentity(slug: string, value: unknown): GithubCommentSource | null {
  if (!record(value)) return null;
  const source = readGithubCommentSource(slug, value.html_url);
  if (
    !source ||
    value.id !== source.commentId ||
    typeof value.node_id !== "string" ||
    value.node_id.length === 0 ||
    value.node_id.length > 256 ||
    /\s/.test(value.node_id) ||
    value.url !== "https://api.github.com" + source.apiPath
  )
    return null;
  const inline = source.kind === "pull_request_review_comment";
  const parent = "https://api.github.com" + source.parentApiPath;
  if (
    value[inline ? "pull_request_url" : "issue_url"] !== parent ||
    Object.hasOwn(value, inline ? "issue_url" : "pull_request_url")
  )
    return null;
  if (Object.hasOwn(value, "_links")) {
    if (!record(value._links)) return null;
    for (const [key, expected] of [
      ["self", value.url],
      ["html", source.sourceUrl],
      ["pull_request", parent],
    ]) {
      if (Object.hasOwn(value._links, key as string)) {
        const link = value._links[key as string];
        if (!record(link) || link.href !== expected || (key === "pull_request" && !inline)) return null;
      }
    }
  }
  return source;
}
