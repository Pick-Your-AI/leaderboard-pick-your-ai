import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyRecognitionReceipt, normalizeGithubObservation } from "../../dist/index.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/engineering.json", import.meta.url), "utf8"));
export function registerMergedChangeSourceTests(category) {
  if (!["maintenance", "automation"].includes(category)) throw new Error("Unknown merged-change category");
  const mergedAt = "2026-10-07T10:00:00.000Z";
  const acceptedAt = "2026-10-08T10:00:00.000Z";
  const expected = new RegExp(
    `${category === "maintenance" ? "Maintenance" : "Automation"} recognition requires an observed merged pull-request participant`,
  );

  function source(kind = "merged", number = 10) {
    const pr = {
      ...structuredClone(fixture.pull_request),
      id: number,
      node_id: `PR_synthetic_${number}`,
      html_url: `https://github.com/synthetic-owner/repository/pull/${number}`,
      user: fixture.author,
      merged_by: fixture.merger,
    };
    const envelope = {
      repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public", defaultBranch: "main" },
      proof: {
        verified: true,
        source: "github_webhook",
        revision: mergedAt,
        eventId: `synthetic-${category}`,
        isSynthetic: true,
      },
      family: "pull_request",
      action: "closed",
      occurredAt: mergedAt,
      observedAt: acceptedAt,
      payload: { repository: fixture.repository, pull_request: pr, sender: fixture.merger },
      verifiedCoauthors: [{ actor: fixture.reviewer, verificationReceipt: "synthetic-coauthor-proof" }],
    };
    if (kind === "open" || kind === "closed-unmerged") {
      pr.state = kind === "open" ? "open" : "closed";
      pr.merged = false;
      pr.merged_at = null;
      pr.closed_at = kind === "open" ? null : mergedAt;
    } else if (kind === "issue") {
      envelope.family = "issue";
      envelope.payload = { repository: fixture.repository, issue: { ...fixture.issue, user: fixture.author } };
    } else if (kind === "release") {
      envelope.family = "release";
      envelope.action = "published";
      envelope.payload = {
        repository: fixture.repository,
        release: {
          id: 60,
          node_id: "RE_synthetic",
          html_url: "https://github.com/synthetic-owner/repository/releases/tag/v1",
          author: fixture.author,
          draft: false,
          published_at: mergedAt,
        },
        sender: fixture.bot,
      };
    }
    return normalizeGithubObservation(envelope);
  }
  function receipt(input, metric = "pr_merged", overrides = {}) {
    const target = input.facts.find((fact) => fact.metricId === metric);
    assert.ok(target, `original source target ${metric} must exist`);
    return {
      verified: true,
      id: `synthetic-${category}-review`,
      metricId: category,
      actorId: target.actorId,
      reviewerId: target.actorId === "202" ? "303" : "202",
      acceptedAt,
      decision: "accepted",
      targetFactId: target.id,
      evidenceIds: [`synthetic-reviewed-${category}-category`],
      ...overrides,
    };
  }
  const apply = (input, selected) => applyRecognitionReceipt(input, selected, ["202", "303"]);
  const recognized = (input) => input.facts.find((fact) => fact.metricId === category);

  for (const [kind, metric] of [
    ["open", "pr_opened"],
    ["closed-unmerged", "pr_opened"],
    ["issue", "issues_opened"],
    ["release", "release_stewardship"],
    ["merged", "maintainer_merges"],
    ["open", "pr_coauthored"],
  ]) {
    test(`${category} admission rejects ${kind} ${metric} as merged-change evidence`, () => {
      const input = source(kind);
      const before = structuredClone(input);
      assert.throws(() => apply(input, receipt(input, metric)), expected);
      assert.deepEqual(input, before);
    });
  }

  const invalidProofs = [
    [
      "ineligible source proof",
      (input, target, proof) => {
        proof.contribution.qualification = "ineligible";
      },
    ],
    [
      "prior source acceptance time",
      (input, target) => {
        target.acceptedAt = acceptedAt;
      },
    ],
    [
      "prior source accepting reviewer",
      (input, target) => {
        target.acceptedBy = "303";
      },
    ],
    [
      "prior source acceptance receipt",
      (input, target) => {
        target.acceptanceReceipt = "synthetic-earlier-acceptance";
      },
    ],
    [
      "missing source proof",
      (input, target, proof) => {
        input.evidence = input.evidence.filter((item) => item !== proof);
      },
    ],
    [
      "duplicate source proof",
      (input, target, proof) => {
        input.evidence.push(structuredClone(proof));
      },
    ],
    [
      "conflicting target identity",
      (input, target) => {
        input.facts.push({ ...target, artifactId: "PR_other" });
      },
    ],
    [
      "non-PR artifact",
      (input, target, proof) => {
        proof.artifact.kind = "issue";
      },
    ],
    [
      "private artifact",
      (input, target, proof) => {
        proof.artifact.visibility = "private";
      },
    ],
    [
      "different artifact identity",
      (input, target, proof) => {
        proof.artifact.stableId = "PR_other";
      },
    ],
    [
      "different repository",
      (input, target, proof) => {
        proof.artifact.repositoryId = "99";
      },
    ],
    [
      "different contribution artifact",
      (input, target, proof) => {
        proof.contribution.artifactId = "PR_other";
      },
    ],
    [
      "different contributor",
      (input, target, proof) => {
        proof.contribution.actorId = "303";
      },
    ],
    [
      "different canonical source unit",
      (input, target, proof) => {
        proof.contribution.canonicalEventId = "unrelated-unit";
      },
    ],
    [
      "different source metric",
      (input, target, proof) => {
        proof.contribution.metricIds = ["pr_opened"];
      },
    ],
    [
      "different participant role",
      (input, target, proof) => {
        proof.contribution.roles = ["merger"];
      },
    ],
    [
      "different evidence clock",
      (input, target, proof) => {
        proof.occurredAt = acceptedAt;
      },
    ],
    [
      "different metadata clock",
      (input, target, proof) => {
        proof.evidenceMetadata.sourceOccurredAt = acceptedAt;
      },
    ],
    [
      "unknown source clock",
      (input, target) => {
        target.occurredAt = null;
      },
    ],
    [
      "already qualified target",
      (input, target) => {
        target.state = "qualified";
      },
    ],
  ];
  for (const [name, corrupt] of invalidProofs) {
    test(`${category} admission rejects ${name} before granting recognition`, () => {
      const input = source();
      const selected = receipt(input);
      const target = input.facts.find((fact) => fact.id === selected.targetFactId);
      const proof = input.evidence.find((item) => item.contribution.contributionId === target.id);
      corrupt(input, target, proof);
      const before = structuredClone(input);
      assert.throws(() => apply(input, selected), expected);
      assert.deepEqual(input, before);
    });
  }

  test(`${category} acceptance cannot precede the evidenced merge`, () => {
    const input = source();
    assert.throws(
      () => apply(input, receipt(input, "pr_merged", { acceptedAt: "2026-10-07T09:59:59.999Z" })),
      expected,
    );
  });

  for (const metric of ["pr_merged", "pr_coauthored"]) {
    test(`${category} preserves ${metric} participant and merge clock while recording later acceptance separately`, () => {
      const input = source();
      const before = structuredClone(input);
      const selected = receipt(input, metric);
      const output = apply(input, selected);
      const fact = recognized(output);
      const proof = output.evidence.find((item) => item.contribution.contributionId === fact.id);
      assert.equal(fact.state, "qualified");
      assert.equal(fact.role, metric === "pr_merged" ? "author" : "coauthor");
      assert.equal(fact.actorId, selected.actorId);
      assert.equal(fact.occurredAt, mergedAt);
      assert.equal(fact.acceptedAt, acceptedAt);
      assert.equal(proof.occurredAt, mergedAt);
      assert.equal(proof.evidenceMetadata.sourceOccurredAt, mergedAt);
      assert.equal(proof.evidenceMetadata.acceptedAt, acceptedAt);
      assert.deepEqual(input, before);
      const atMerge = apply(input, receipt(input, metric, { acceptedAt: mergedAt }));
      assert.equal(recognized(atMerge).state, "qualified");
    });
  }

  test(`${category} receipt and changeset aliases cannot manufacture another PR participation unit`, () => {
    const input = source();
    const first = recognized(
      apply(input, receipt(input, "pr_merged", { id: "receipt-a", changesetId: "operation-a" })),
    );
    const second = recognized(
      apply(input, receipt(input, "pr_merged", { id: "receipt-b", changesetId: "operation-b" })),
    );
    assert.equal(first.id, second.id);
    assert.equal(first.canonicalKey, second.canonicalKey);
  });

  test(
    category === "maintenance"
      ? "a shared receipt changeset cannot collapse distinct merged PRs or verified coauthors"
      : `${category}: a shared receipt changeset cannot collapse distinct merged PRs or verified coauthors`,
    () => {
      const input = source();
      const other = source("merged", 11);
      const a = recognized(apply(input, receipt(input, "pr_merged", { changesetId: "operation-shared" })));
      const b = recognized(apply(other, receipt(other, "pr_merged", { changesetId: "operation-shared" })));
      const c = recognized(apply(input, receipt(input, "pr_coauthored", { changesetId: "operation-shared" })));
      assert.equal(new Set([a.id, b.id, c.id]).size, 3);
    },
  );

  test(`a rejected ${category} category remains explicit and preserves the original merged source`, () => {
    const input = source();
    const before = structuredClone(input);
    const output = apply(input, receipt(input, "pr_merged", { decision: "rejected" }));
    assert.equal(recognized(output).state, "excluded");
    assert.deepEqual(input, before);
  });

  test(`${category} accepts source revisions without a commit SHA and optional display metadata`, () => {
    const input = source();
    const selected = receipt(input);
    const proof = input.evidence.find((entry) => entry.contribution.contributionId === selected.targetFactId);
    delete proof.evidenceMetadata;
    proof.sourceRevision = "collection-scan:42";
    const output = apply(input, selected);
    const accepted = output.evidence.find((entry) => entry.contribution.contributionId === recognized(output).id);
    assert.equal(accepted.sourceRevision, "collection-scan:42");
    assert.equal(accepted.evidenceMetadata, undefined);
    assert.equal(accepted.occurredAt, mergedAt);
  });

  test(`${category} cannot round a later fractional merge into an earlier acceptance`, () => {
    const input = source();
    const selected = receipt(input);
    const target = input.facts.find((entry) => entry.id === selected.targetFactId);
    const proof = input.evidence.find((entry) => entry.contribution.contributionId === target.id);
    const precise = "2026-10-07T10:00:00.0001Z";
    target.occurredAt = precise;
    proof.occurredAt = precise;
    proof.evidenceMetadata.sourceOccurredAt = precise;
    assert.throws(() => apply(input, { ...selected, acceptedAt: mergedAt }), expected);
    const output = apply(input, { ...selected, acceptedAt: "2026-10-07T10:00:00.001Z" });
    assert.equal(recognized(output).occurredAt, precise);
  });

  test(`${category} preserves bot authorship and does not credit its human reviewer as the change contributor`, () => {
    const input = source();
    const selected = receipt(input);
    const contributor = input.actors.find((entry) => entry.id === selected.actorId);
    contributor.kind = "bot";
    contributor.executionMode = "automated";
    const original = structuredClone(input);
    const output = apply(input, selected);
    assert.equal(recognized(output).actorId, selected.actorId);
    assert.equal(recognized(output).acceptedBy, selected.reviewerId);
    assert.equal(output.actors.find((entry) => entry.id === selected.actorId).kind, "bot");
    assert.equal(
      output.facts.filter((entry) => entry.metricId === category && entry.actorId === selected.reviewerId).length,
      0,
    );
    assert.deepEqual(input, original);
  });
}
