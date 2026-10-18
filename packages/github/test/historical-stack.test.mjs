import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeGithubObservation } from "../dist/index.js";

const fixture = JSON.parse(await readFile(new URL("fixtures/historical-stack.json", import.meta.url), "utf8"));
const entries = fixture.pullRequests.flatMap((pr) => pr.commits);
const unique = new Set(entries.map((commit) => commit.sha));
const ancestry = new Set(fixture.historicalMainCommitAliases);
const envelope = (family, payload) => ({
  repository: { id: 9001, slug: "synthetic-owner/historical-stack", visibility: "public", defaultBranch: "main" },
  proof: { verified: true, source: "github_graphql", revision: fixture.provenance.cutoff, isSynthetic: true },
  family,
  observedAt: fixture.provenance.cutoff,
  occurredAt: null,
  payload,
});

test("historical stack preserves verified entry, identity and ancestry counts without equating them", () => {
  assert.equal(fixture.isSynthetic, true);
  assert.equal(fixture.pullRequests.length, 34);
  assert.equal(entries.length, 107);
  assert.equal(unique.size, 92);
  assert.equal(fixture.pullRequests.filter((pr) => pr.baseRefName !== "main").length, 11);
  assert.equal([...unique].filter((sha) => ancestry.has(sha)).length, 86);
  assert.equal([...unique].filter((sha) => !ancestry.has(sha)).length, 6);
});

test("stack PR authors and merger operations retain separate attribution, including intermediate targets", () => {
  for (const pr of fixture.pullRequests) {
    const result = normalizeGithubObservation(
      envelope("pull_request", {
        html_url: `https://github.com/synthetic-owner/historical-stack/pull/${pr.number}`,
        number: pr.number,
        node_id: `fixture-pr-${pr.number}`,
        merged: true,
        merged_at: pr.mergedAt,
        user: pr.author,
        merged_by: pr.mergedBy,
        base: { ref: pr.baseRefName },
      }),
    );
    assert.equal(result.isSynthetic, true);
    assert.equal(result.facts.find((fact) => fact.metricId === "pr_merged")?.actorId, String(pr.author.databaseId));
    assert.equal(
      result.facts.find((fact) => fact.metricId === "maintainer_merges")?.actorId,
      String(pr.mergedBy.databaseId),
    );
    assert.ok(result.facts.every((fact) => !["qualified", "reviewed"].includes(fact.state)));
  }
});

test("repeated stack commit observations conserve identities and ancestry alone does not fabricate integration events", () => {
  const artifacts = new Set();
  for (const commit of entries) {
    const result = normalizeGithubObservation(
      envelope("commit", {
        ...commit,
        html_url: `https://github.com/synthetic-owner/historical-stack/commit/${commit.sha}`,
      }),
    );
    assert.equal(result.isSynthetic, true);
    assert.equal(result.facts.filter((fact) => fact.metricId === "commits_integrated").length, 0);
    assert.ok(result.reasons.includes("default_branch_integration_unverified"));
    for (const role of ["author", "committer"]) {
      const participant = result.participation.find((entry) => entry.role === role);
      assert.equal(participant?.actorId ?? null, commit[role] ? String(commit[role].databaseId) : null);
      if (participant) artifacts.add(participant.artifactId);
    }
    assert.ok(result.observations.every((observation) => observation.occurredAt === null));
  }
  assert.equal(artifacts.size, 92);
});

test("synthetic diff overlays cannot turn the eleven intermediate targets into delivered LOC", () => {
  const before = "a".repeat(40),
    after = "b".repeat(40);
  // This one-line overlay is invented test input, never historical LOC evidence.
  for (const pr of fixture.pullRequests.filter((entry) => entry.baseRefName !== "main")) {
    const input = envelope("pull_request", {
      node_id: `fixture-pr-${pr.number}`,
      number: pr.number,
      merged: true,
      merged_at: pr.mergedAt,
      user: pr.author,
      merged_by: pr.mergedBy,
      html_url: `https://github.com/synthetic-owner/historical-stack/pull/${pr.number}`,
      base: { ref: pr.baseRefName },
    });
    const integration = {
      before,
      after,
      canonicalChangeId: `synthetic-overlay-${pr.number}`,
      defaultBranch: "main",
      targetBranch: pr.baseRefName,
      commitShas: [after],
      diff: { before, after, complete: true, files: [{ path: "src/synthetic.ts", additions: 1, deletions: 0 }] },
    };
    const intermediate = normalizeGithubObservation({ ...input, integration });
    assert.equal(intermediate.facts.filter((fact) => fact.metricId === "pr_lines_changed").length, 0);
    const integrated = normalizeGithubObservation({ ...input, integration: { ...integration, targetBranch: "main" } });
    assert.equal(integrated.facts.find((fact) => fact.metricId === "pr_lines_changed")?.quantity, 1);
  }
});
