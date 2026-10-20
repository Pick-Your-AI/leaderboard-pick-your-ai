// Synthetic public metadata and one deliberately unpublished review-comment identity.
import { model, responseFor, repository, edit } from "./content-edit-metadata.mjs";
import { commentEntry, commentTarget, commentResponse } from "./comment-edit-metadata.mjs";

export { repository, edit };
const nativeRepository = () => ({ databaseId: repository.id, nameWithOwner: repository.slug, isPrivate: false });
export function commentInventoryModel() {
  const state = {
    parents: model(),
    entries: new Map(),
    comments: new Map(),
    reviews: new Map(),
    threads: new Map(),
    threadComments: new Map(),
  };
  const add = (kind, fragment) => {
    const entry = commentEntry(commentTarget(kind, String(fragment)));
    entry.native.body = "synthetic-never-retain-comment-body";
    entry.records = [1, 2].map((index) =>
      edit(`UCE_${entry.target.id}_${index}`, {
        body: "synthetic-never-retain-edit-body",
        diff: "synthetic-never-retain-edit-diff",
      }),
    );
    state.entries.set(entry.target.id, entry);
    return entry.target.id;
  };
  const issue = state.parents.issues[0],
    pr = state.parents.pullRequests[0];
  state.comments.set(issue.id, [add("issue_comment", 101), add("issue_comment", 102)]);
  state.comments.set(pr.id, [
    add("pull_request_conversation_comment", 201),
    add("pull_request_conversation_comment", 202),
  ]);
  state.reviews.set(pr.id, [add("pull_request_review", 301), add("pull_request_review", 302)]);
  state.entries.get(state.reviews.get(pr.id)[1]).native.state = "APPROVED";
  const inline = [401, 402, 403, 404].map((fragment) => add("pull_request_review_comment", fragment));
  const pending = state.entries.get(inline[3]);
  pending.native.state = "PENDING";
  pending.native.publishedAt = null;
  for (const [index, ids] of [[inline[0], inline[1], inline[3]], [inline[2]]].entries()) {
    const thread = {
      __typename: "PullRequestReviewThread",
      id: `THREAD_SYNTHETIC_${index + 1}`,
      repository: nativeRepository(),
      pullRequest: { ...structuredClone(pr), repository: nativeRepository() },
    };
    state.threads.set(thread.id, thread);
    state.threadComments.set(thread.id, ids);
  }
  return state;
}

function page(values, request, key) {
  const { first, after } = request.variables;
  const prefix = `${key}:`;
  if (after !== null && (typeof after !== "string" || !after.startsWith(prefix)))
    throw new Error("synthetic inventory cursor crossed a connection");
  const offset = after === null ? 0 : Number(after.slice(prefix.length));
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > values.length)
    throw new Error("synthetic inventory cursor invalid");
  const nodes = values.slice(offset, offset + first),
    end = offset + nodes.length;
  return {
    totalCount: values.length,
    nodes: structuredClone(nodes),
    pageInfo: { hasNextPage: end < values.length, endCursor: nodes.length ? `${prefix}${end}` : null },
  };
}

export function commentInventoryResponse(state, request) {
  if (
    request.query.includes("query GithubContentEditParents") ||
    request.query.includes("query GithubContentEditMetadata")
  )
    return responseFor(state.parents, request);
  if (request.query.includes("query GithubCommentEditMetadata")) {
    if (state.entries.get(request.variables.id)?.native.state === "PENDING")
      throw new Error("unpublished comment history must never be read");
    return commentResponse(state, request);
  }
  if (!request.query.includes("query GithubCommentEditInventory"))
    throw new Error("unexpected synthetic inventory operation");
  const { id } = request.variables;
  const parent = [...state.parents.issues, ...state.parents.pullRequests].find((value) => value.id === id);
  const original = parent ? { ...structuredClone(parent), repository: nativeRepository() } : state.threads.get(id);
  if (!original) return { data: { node: null } };
  const node = structuredClone(original);
  const field = request.query.includes("reviewThreads(first:")
    ? "reviewThreads"
    : request.query.includes("reviews(first:")
      ? "reviews"
      : "comments";
  let values;
  if (field === "reviewThreads") values = [...state.threads.values()].filter((value) => value.pullRequest.id === id);
  else {
    const ids = (field === "reviews" ? state.reviews : parent ? state.comments : state.threadComments).get(id) ?? [];
    values = ids.map((id) => state.entries.get(id).native);
  }
  node[field] = page(values, request, `${id}:${field}`);
  return { data: { node } };
}
