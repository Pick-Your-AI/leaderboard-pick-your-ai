import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeGithubObservation } from "../dist/index.js";

const fixture = JSON.parse(await readFile(new URL("fixtures/engineering.json", import.meta.url), "utf8"));
const before = "b".repeat(40);
const after = "c".repeat(40);
const at = "2026-10-07T10:00:00Z";
const observedAt = "2026-10-08T10:00:00Z";
const physicalMetrics = new Set(["pr_lines_added", "pr_lines_removed", "pr_lines_changed", "files_changed"]);
const commitMetrics = new Set(["commits_integrated", "direct_changes"]);

function observation(family, repositoryBranch = "main", integrationBranch = "main") {
  const repository = {
    id: 2,
    slug: "synthetic-owner/repository",
    visibility: "public",
    defaultBranch: repositoryBranch,
  };
  const integration = {
    before,
    after,
    canonicalChangeId: "synthetic-default-integration",
    defaultBranch: integrationBranch,
    targetBranch: integrationBranch,
    commitShas: [after],
  };
  const payload =
    family === "commit"
      ? {
          sha: after,
          html_url: `https://github.com/synthetic-owner/repository/commit/${after}`,
          author: fixture.author,
          committer: fixture.merger,
          parents: [{ sha: before }],
          commit: { message: "Synthetic source; no identity inferred from this text." },
        }
      : {
          repository: { ...fixture.repository, default_branch: repositoryBranch },
          pull_request: {
            ...structuredClone(fixture.pull_request),
            user: fixture.author,
            merged_by: fixture.merger,
            base: { ref: repositoryBranch },
          },
          sender: fixture.merger,
        };
  if (family === "pull_request") {
    integration.diff = {
      before,
      after,
      complete: true,
      files: [{ path: "src/change.ts", additions: 7, deletions: 2 }],
    };
  }
  return {
    repository,
    proof: {
      verified: true,
      source: "github_webhook",
      revision: after,
      eventId: "synthetic-default-integration-event",
      isSynthetic: true,
    },
    family,
    action: family === "commit" ? "direct_default_branch_integration" : "closed",
    occurredAt: at,
    observedAt,
    payload,
    integration,
  };
}

function delivery(out, family) {
  const metrics = family === "commit" ? commitMetrics : physicalMetrics;
  return out.facts.filter((fact) => metrics.has(fact.metricId));
}

function assertParticipation(out, family) {
  assert.equal(out.isSynthetic, true);
  assert.equal(out.observations.length, 1);
  if (family === "commit") {
    assert.ok(out.participation.some((entry) => entry.actorId === "101" && entry.role === "author"));
    assert.ok(out.participation.some((entry) => entry.actorId === "202" && entry.role === "committer"));
  } else {
    assert.equal(out.facts.find((fact) => fact.metricId === "pr_merged")?.actorId, "101");
    assert.equal(out.facts.find((fact) => fact.metricId === "maintainer_merges")?.actorId, "202");
  }
}

for (const family of ["commit", "pull_request"]) {
  for (const branch of ["main", "trunk"]) {
    test(`${family}: delivery uses the actual ${branch} default and stable replay identity`, () => {
      const input = observation(family, branch, branch);
      const first = normalizeGithubObservation(input);
      const replay = normalizeGithubObservation(structuredClone(input));
      assertParticipation(first, family);
      assert.deepEqual(delivery(first, family), delivery(replay, family));
      assert.ok(delivery(first, family).every((fact) => fact.actorId === "101"));
      if (family === "commit") {
        assert.deepEqual(
          delivery(first, family)
            .map((fact) => fact.metricId)
            .sort(),
          [...commitMetrics].sort(),
        );
      } else {
        assert.deepEqual(
          delivery(first, family)
            .map((fact) => fact.metricId)
            .sort(),
          [...physicalMetrics].sort(),
        );
        assert.equal(first.facts.find((fact) => fact.metricId === "pr_lines_added").quantity, 7);
        assert.equal(first.facts.find((fact) => fact.metricId === "pr_lines_removed").quantity, 2);
        assert.equal(first.facts.find((fact) => fact.metricId === "pr_lines_changed").quantity, 9);
      }
    });
  }

  for (const [label, repositoryBranch, integrationBranch] of [
    ["another branch", "main", "release"],
    ["a previous default", "trunk", "main"],
    ["different branch casing", "Main", "main"],
    ["an empty default", "", "main"],
    ["a blank default", " ", "main"],
  ]) {
    test(`${family}: ${label} cannot supply default-branch delivery`, () => {
      const out = normalizeGithubObservation(observation(family, repositoryBranch, integrationBranch));
      assertParticipation(out, family);
      assert.deepEqual(delivery(out, family), []);
      assert.ok(
        out.reasons.includes(
          family === "commit"
            ? "default_branch_integration_unverified"
            : "physical_change_is_not_verified_default_branch_integration",
        ),
      );
    });
  }

  test(`${family}: an absent repository default cannot borrow the witness's default`, () => {
    const input = observation(family);
    delete input.repository.defaultBranch;
    const out = normalizeGithubObservation(input);
    assertParticipation(out, family);
    assert.deepEqual(delivery(out, family), []);
  });
}

test("a feature-branch PR keeps participation and receives physical credit only at verified default integration", () => {
  const input = observation("pull_request");
  input.payload.pull_request.base.ref = "feature";
  input.integration.targetBranch = "feature";
  const intermediate = normalizeGithubObservation(input);
  assertParticipation(intermediate, "pull_request");
  assert.deepEqual(delivery(intermediate, "pull_request"), []);

  input.integration.targetBranch = "main";
  const integrated = normalizeGithubObservation(input);
  assertParticipation(integrated, "pull_request");
  assert.equal(delivery(integrated, "pull_request").length, 4);
  assert.equal(integrated.facts.find((fact) => fact.metricId === "pr_lines_changed").quantity, 9);
});
