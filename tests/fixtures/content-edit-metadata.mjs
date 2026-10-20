// Synthetic metadata only. These native-looking identities never enter a live source.
export const repository = { id: 2, slug: "Synthetic/ContentEdits" };

export function parent(kind = "issue", number = 11, overrides = {}) {
  return {
    __typename: kind === "issue" ? "Issue" : "PullRequest",
    id: `${kind === "issue" ? "I" : "PR"}_SYNTHETIC_${number}`,
    number,
    url: `https://github.com/${repository.slug}/${kind === "issue" ? "issues" : "pull"}/${number}`,
    ...overrides,
  };
}

export function edit(id = "UCE_SYNTHETIC_1", overrides = {}) {
  return {
    __typename: "UserContentEdit",
    id,
    createdAt: "2026-01-02T03:04:05Z",
    editedAt: "2026-01-02T03:04:06.1Z",
    updatedAt: "2026-01-02T03:04:07.123Z",
    editor: { __typename: "User", id: "U_SYNTHETIC_7", databaseId: 7 },
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

export function model() {
  const issue = parent();
  const pullRequest = parent("pull_request", 12);
  return {
    issues: [issue],
    pullRequests: [pullRequest],
    histories: new Map([
      [issue.id, { includesCreatedEdit: true, records: [edit()] }],
      [pullRequest.id, { includesCreatedEdit: false, records: [] }],
    ]),
  };
}

function page(records, first, after, key) {
  const prefix = `${key}:`;
  if (after !== null && (typeof after !== "string" || !after.startsWith(prefix)))
    throw new Error("synthetic cursor belongs to another connection");
  const offset = after === null ? 0 : Number(after.slice(prefix.length));
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > records.length)
    throw new Error("invalid synthetic cursor");
  const nodes = records.slice(offset, offset + first);
  const next = offset + nodes.length;
  return {
    totalCount: records.length,
    nodes: structuredClone(nodes),
    pageInfo: { hasNextPage: next < records.length, endCursor: nodes.length ? `${prefix}${next}` : null },
  };
}

export function responseFor(state, request) {
  const { query, variables } = request;
  if (variables.owner !== "Synthetic" || variables.name !== "ContentEdits")
    throw new Error("synthetic request escaped its repository");
  const repo = { databaseId: repository.id, isPrivate: false };
  if (query.includes("query GithubContentEditParents")) {
    const field = query.includes("pullRequests(first:") ? "pullRequests" : "issues";
    repo[field] = page(state[field], variables.first, variables.after, `parents:${field}`);
  } else if (query.includes("query GithubContentEditMetadata")) {
    const field = query.includes("pullRequest(number:") ? "pullRequest" : "issue";
    const item = state[field === "issue" ? "issues" : "pullRequests"].find(
      (value) => value.number === variables.number,
    );
    if (!item) repo[field] = null;
    else {
      const history = state.histories.get(item.id);
      if (!history) throw new Error("synthetic history is missing");
      repo[field] = {
        ...structuredClone(item),
        includesCreatedEdit: history.includesCreatedEdit,
        userContentEdits:
          history.records === null ? null : page(history.records, variables.first, variables.after, `edits:${item.id}`),
      };
    }
  } else throw new Error("unexpected synthetic GraphQL operation");
  return { data: { repository: repo } };
}
