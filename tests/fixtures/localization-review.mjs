const day = 86_400_000;
export const localizationReviewSlug = "synthetic-org/synthetic-repo";
export const localizationReviewUrl = "https://github.com/" + localizationReviewSlug + "/pull/10";
export const localizationReviewApi = "https://api.github.com/repos/" + localizationReviewSlug + "/pulls/10";
export const localizationReviewActor = (id) => ({
  id,
  node_id: "U_SYNTHETIC_LOCALE_" + id,
  login: "synthetic-locale-" + id,
  type: "User",
});

// Data only. Both suites feed these native-like objects through the real
// collector/normalizer; the accepting Controls actor is deliberately separate.
export function localizationReviewFixture(now = Date.now()) {
  const at = (days) => new Date(Math.floor(now / 1000) * 1000 - days * day).toISOString();
  const before = "b".repeat(40);
  const head = "a".repeat(40);
  const after = "c".repeat(40);
  const parent = {
    id: 10,
    node_id: "PR_SYNTHETIC_LOCALE_REVIEW",
    number: 10,
    html_url: localizationReviewUrl,
    user: localizationReviewActor(101),
    merged_by: localizationReviewActor(404),
    created_at: at(4),
    updated_at: at(1),
    merged_at: at(1),
    closed_at: at(1),
    state: "closed",
    merged: true,
    draft: false,
    head: { sha: head },
    base: { ref: "main" },
    merge_commit_sha: after,
  };
  const makeReview = (id, actorId, submittedAt) => ({
    id,
    node_id: "PRR_SYNTHETIC_LOCALE_" + id,
    html_url: localizationReviewUrl + "#pullrequestreview-" + id,
    pull_request_url: localizationReviewApi,
    _links: {
      html: { href: localizationReviewUrl + "#pullrequestreview-" + id },
      pull_request: { href: localizationReviewApi },
    },
    user: localizationReviewActor(actorId),
    state: "COMMENTED",
    submitted_at: submittedAt,
    commit_id: head,
    body: "Synthetic translation feedback; not public evidence text",
  });
  const first = makeReview(51, 202, at(2));
  const later = makeReview(52, 202, at(1.5));
  const policy = {
    repositoryId: 2,
    version: "synthetic-locale-review-v1",
    documentationPaths: ["docs/"],
    researchPaths: [],
    generatedPaths: ["docs/fr/generated/"],
    importedPaths: [],
    localizationPaths: [
      { locale: "fr", category: "documentation", paths: ["docs/fr/"] },
      { locale: "de", category: "documentation", paths: ["docs/de/"] },
    ],
  };
  const integration = {
    before,
    after,
    targetBranch: "main",
    defaultBranch: "main",
    canonicalChangeId: "synthetic-locale-review-merge",
    commitShas: [after],
    diff: {
      before,
      after,
      complete: true,
      files: [
        { path: "docs/fr/first.md", additions: 1, deletions: 0 },
        { path: "docs/fr/second.md", additions: 1000, deletions: 0 },
        { path: "docs/de/first.md", additions: 0, deletions: 2 },
        { path: "docs/fr/generated/api.md", additions: 10000, deletions: 0 },
      ],
    },
  };
  return { at, before, head, after, parent, first, later, policy, integration, makeReview };
}
