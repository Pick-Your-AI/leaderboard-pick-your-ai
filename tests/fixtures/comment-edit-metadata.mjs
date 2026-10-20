// Synthetic native metadata only; no live GitHub content or authorization.
import { edit, parent, repository } from "./content-edit-metadata.mjs";

export { edit, repository };
export const commentKinds = [
  "issue_comment",
  "pull_request_conversation_comment",
  "pull_request_review",
  "pull_request_review_comment",
];

export function commentTarget(kind = "issue_comment", fragment = "101") {
  const nativeParent = parent(kind === "issue_comment" ? "issue" : "pull_request", kind === "issue_comment" ? 11 : 12);
  const anchor =
    kind === "pull_request_review"
      ? "pullrequestreview-"
      : kind === "pull_request_review_comment"
        ? "discussion_r"
        : "issuecomment-";
  return {
    kind,
    id: `COMMENT_SYNTHETIC_${kind}_${fragment}`,
    url: `${nativeParent.url}#${anchor}${fragment}`,
    parent: {
      kind: kind === "issue_comment" ? "issue" : "pull_request",
      id: nativeParent.id,
      number: nativeParent.number,
      url: nativeParent.url,
    },
  };
}

export function commentEntry(target = commentTarget()) {
  const repo = { databaseId: repository.id, nameWithOwner: repository.slug, isPrivate: false };
  const nativeParent = {
    __typename: target.parent.kind === "issue" ? "Issue" : "PullRequest",
    ...target.parent,
    repository: structuredClone(repo),
  };
  delete nativeParent.kind;
  const native = {
    __typename:
      target.kind === "pull_request_review"
        ? "PullRequestReview"
        : target.kind === "pull_request_review_comment"
          ? "PullRequestReviewComment"
          : "IssueComment",
    id: target.id,
    url: target.url,
    repository: repo,
    publishedAt: "2026-01-02T03:04:05Z",
    includesCreatedEdit: true,
    ...(target.kind === "issue_comment" ? { issue: nativeParent, pullRequest: null } : { pullRequest: nativeParent }),
    ...(target.kind === "pull_request_review" ? { state: "COMMENTED", submittedAt: "2026-01-02T03:04:05.1Z" } : {}),
    ...(target.kind === "pull_request_review_comment" ? { state: "SUBMITTED" } : {}),
  };
  return { target: structuredClone(target), native, records: [edit(`UCE_${target.id}_1`)] };
}

export function commentModel(kind = "issue_comment") {
  const entry = commentEntry(commentTarget(kind));
  return { selected: entry.target, entries: new Map([[entry.target.id, entry]]) };
}

export function commentResponse(state, request) {
  if (
    !/query\s+GithubCommentEditMetadata\b/.test(request.query) ||
    !/node\s*\(\s*id\s*:\s*\$id\s*\)/.test(request.query)
  )
    throw new Error("unexpected synthetic comment-edit operation");
  const { id, first, after } = request.variables;
  const entry = state.entries.get(id);
  if (!entry) return { data: { node: null } };
  const node = structuredClone(entry.native);
  if (entry.records === null) node.userContentEdits = null;
  else {
    const prefix = `comment-edits:${id}:`;
    if (after !== null && (typeof after !== "string" || !after.startsWith(prefix)))
      throw new Error("synthetic cursor belongs to another comment");
    const offset = after === null ? 0 : Number(after.slice(prefix.length));
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > entry.records.length)
      throw new Error("invalid synthetic comment cursor");
    const nodes = entry.records.slice(offset, offset + first);
    const next = offset + nodes.length;
    node.userContentEdits = {
      totalCount: entry.records.length,
      nodes: structuredClone(nodes),
      pageInfo: { hasNextPage: next < entry.records.length, endCursor: nodes.length ? `${prefix}${next}` : null },
    };
  }
  return { data: { node } };
}
