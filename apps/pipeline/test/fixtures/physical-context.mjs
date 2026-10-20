import { normalizeGithubObservation } from "../../../../packages/github/dist/index.js";

export const before = "b".repeat(40);
export const after = "c".repeat(40);
export const integratedAt = "2026-10-07T10:00:00.000Z";
export const collectedAt = "2026-10-08T10:00:00.000Z";
export const physicalFiles = [
  { path: "src/main.ts", additions: 10, deletions: 2 },
  { path: "docs/guide.md", additions: 3, deletions: 1 },
  { path: "test/behavior.mjs", additions: 4, deletions: 5 },
  { path: "src/format.ts", additions: 4, deletions: 4, formattingOnly: true },
  { path: "generated/output.ts", additions: 20, deletions: 0 },
  { path: "vendor/dependency.ts", additions: 7, deletions: 3 },
  { path: "package-lock.json", additions: 10, deletions: 11 },
  { path: "assets/image.png", additions: 0, deletions: 0, binary: true },
  { path: "src/import.ts", additions: 30, deletions: 30, imported: true },
];

/** Entirely fictional source passed through the actual stock normalizer. */
export function physicalSource({ files = physicalFiles, observedAt = collectedAt } = {}) {
  const repository = { id: 2, slug: "synthetic-org/synthetic-repo", visibility: "public", defaultBranch: "main" };
  const author = { id: 101, node_id: "U_SYNTHETIC_PHYSICAL", login: "synthetic-author", type: "User" };
  const pull = {
    id: 1001,
    node_id: "PR_SYNTHETIC_PHYSICAL",
    number: 1,
    html_url: `https://github.com/${repository.slug}/pull/1`,
    created_at: "2026-10-06T10:00:00.000Z",
    updated_at: integratedAt,
    merged_at: integratedAt,
    closed_at: integratedAt,
    state: "closed",
    merged: true,
    merge_commit_sha: after,
    base: { ref: "main" },
    user: author,
    merged_by: { id: 202, node_id: "U_SYNTHETIC_MERGER", login: "synthetic-merger", type: "User" },
  };
  const envelope = {
    repository,
    proof: { verified: true, source: "github_rest", revision: integratedAt, isSynthetic: true },
    family: "pull_request",
    action: "closed",
    occurredAt: integratedAt,
    observedAt,
    payload: { pull_request: pull },
    integration: {
      before,
      after,
      defaultBranch: "main",
      targetBranch: "main",
      canonicalChangeId: "synthetic-physical-integration",
      commitShas: [after],
      diff: { before, after, complete: true, files: structuredClone(files) },
    },
  };
  return {
    repository,
    pull,
    envelope,
    output: normalizeGithubObservation(envelope),
    source: {
      family: "pull_requests",
      repository_id: 2,
      subject_id: pull.node_id,
      observed_at: observedAt,
      document: { sourceUrl: pull.html_url },
    },
  };
}
