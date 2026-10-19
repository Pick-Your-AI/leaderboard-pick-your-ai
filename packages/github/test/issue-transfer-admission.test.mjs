import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGithubObservation } from "../dist/index.js";

// Synthetic, explicitly enriched source-side observations. No fixture asserts
// live transfer capability, historical destination discovery or policy approval.
const occurredAt = "2026-10-07T10:00:00Z";
const observedAt = "2026-10-08T10:00:00Z";
const sourceSlug = "synthetic-owner/source";
const targetSlug = "synthetic-owner/target";
const actor = { id: 202, node_id: "U_synthetic_triager", type: "User", login: "synthetic-triager" };

function observation() {
  return {
    repository: { id: 2, slug: sourceSlug, visibility: "public" },
    proof: {
      verified: true,
      source: "github_webhook",
      revision: "synthetic-transfer-revision",
      eventId: "synthetic-transfer-event",
      isSynthetic: true,
    },
    family: "relationship",
    action: "transferred",
    occurredAt,
    observedAt,
    payload: {
      issue: {
        id: 1001,
        node_id: "I_synthetic_original",
        number: 1,
        html_url: "https://github.com/" + sourceSlug + "/issues/1",
        user: { id: 101, type: "User", login: "synthetic-author" },
      },
      sender: actor,
      destination: {
        repositoryId: 3,
        stableId: "I_synthetic_original",
        slug: targetSlug,
        url: "https://github.com/" + targetSlug + "/issues/8",
        visibility: "public",
        allowed: true,
      },
    },
  };
}

function normalize(change = () => {}) {
  const input = observation();
  change(input);
  const before = structuredClone(input);
  const output = normalizeGithubObservation(input);
  assert.deepEqual(input, before, "normalization must not rewrite the supplied source evidence");
  return output;
}

test("public transfer preserves the original issue, actor, occurrence and raw-only lineage", () => {
  const out = normalize();
  assert.deepEqual(
    out.facts.map((fact) => [fact.metricId, fact.actorId, fact.artifactId, fact.state, fact.occurredAt]),
    [["issue_transfers", "202", "I_synthetic_original", "observed", "2026-10-07T10:00:00.000Z"]],
  );
  assert.equal(out.facts[0].acceptedAt, null);
  assert.equal(out.facts[0].subjectActorId, "101");
  assert.equal(out.evidence[0].artifact.kind, "issue");
  assert.equal(out.evidence[0].artifact.publicUrl, "https://github.com/" + sourceSlug + "/issues/1");
  assert.deepEqual(out.lineage, [
    {
      relation: "transferred_to",
      sourceIds: ["I_synthetic_original"],
      targetId: "I_synthetic_original",
      evidenceIds: [out.observations[0].id],
    },
  ]);
  assert.deepEqual(out.suppressArtifactIds, []);
});

test("a proven different target alias creates only a transfer and retains both explicit identities", () => {
  const out = normalize((input) => {
    input.payload.destination.stableId = "I_synthetic_explicit_alias";
  });
  assert.deepEqual(
    out.facts.map((fact) => fact.metricId),
    ["issue_transfers"],
  );
  assert.deepEqual(out.lineage[0].sourceIds, ["I_synthetic_original"]);
  assert.equal(out.lineage[0].targetId, "I_synthetic_explicit_alias");
  assert.equal(out.facts[0].state, "observed");
});

test("reobservation preserves the transfer unit without granting creation or resolution", () => {
  const original = normalize();
  const repeated = normalize((input) => {
    input.observedAt = "2026-10-09T10:00:00Z";
    input.proof.source = "github_rest";
    input.proof.revision = "synthetic-reobserved-transfer";
  });
  assert.equal(repeated.facts[0].id, original.facts[0].id);
  assert.equal(repeated.facts[0].canonicalKey, original.facts[0].canonicalKey);
  assert.notEqual(repeated.facts[0].observedAt, original.facts[0].observedAt);
  assert.deepEqual(
    repeated.facts.map((fact) => fact.metricId),
    ["issue_transfers"],
  );
});

const invalidTargets = [
  ["pull-request URL", (target) => (target.url = "https://github.com/" + targetSlug + "/pull/8")],
  ["repository root URL", (target) => (target.url = "https://github.com/" + targetSlug + "/")],
  ["issue file suffix", (target) => (target.url += "/files")],
  ["zero issue number", (target) => (target.url = "https://github.com/" + targetSlug + "/issues/0")],
  ["leading-zero issue number", (target) => (target.url = "https://github.com/" + targetSlug + "/issues/08")],
  [
    "unsafe integer issue number",
    (target) => (target.url = "https://github.com/" + targetSlug + "/issues/9007199254740992"),
  ],
  ["owner-only repository slug", (target) => (target.slug = "synthetic-owner")],
  [
    "nested repository slug",
    (target) => {
      target.slug = targetSlug + "/nested";
      target.url = "https://github.com/" + target.slug + "/issues/8";
    },
  ],
  ["same repository identity", (target) => (target.repositoryId = 2)],
  ["missing repository identity", (target) => delete target.repositoryId],
  ["missing target identity", (target) => delete target.stableId],
  ["different repository URL", (target) => (target.url = "https://github.com/synthetic-other/target/issues/8")],
];

for (const [name, change] of invalidTargets) {
  test("transfer rejects a " + name + " without alias or credit", () => {
    const out = normalize((input) => change(input.payload.destination));
    assert.deepEqual(out.facts, []);
    assert.deepEqual(out.evidence, []);
    assert.deepEqual(out.lineage, []);
    assert.ok(out.reasons.includes("transfer_lineage_incomplete"));
  });
}

const invalidSources = [
  [
    "pull-request wrapper",
    (input) => {
      input.payload.pull_request = { ...input.payload.issue, html_url: "https://github.com/" + sourceSlug + "/pull/1" };
      delete input.payload.issue;
    },
  ],
  [
    "REST pull-request discriminator",
    (input) => {
      input.payload.issue.pull_request = { url: "https://api.github.com/repos/" + sourceSlug + "/pulls/1" };
    },
  ],
  ["native PullRequest discriminator", (input) => (input.payload.issue.__typename = "PullRequest")],
  [
    "pull-request source URL",
    (input) => (input.payload.issue.html_url = "https://github.com/" + sourceSlug + "/pull/1"),
  ],
  [
    "zero source issue number",
    (input) => (input.payload.issue.html_url = "https://github.com/" + sourceSlug + "/issues/0"),
  ],
  ["source issue file suffix", (input) => (input.payload.issue.html_url += "/files")],
];

for (const [name, change] of invalidSources) {
  test("transfer rejects a " + name + " without manufacturing an issue", () => {
    const out = normalize(change);
    assert.deepEqual(out.facts, []);
    assert.deepEqual(out.evidence, []);
    assert.deepEqual(out.lineage, []);
    assert.ok(out.reasons.includes("transfer_lineage_incomplete"));
  });
}

const unavailableTargets = [
  ["private", (input) => (input.payload.destination.visibility = "private")],
  ["unknown", (input) => (input.payload.destination.visibility = "unknown")],
  ["unapproved", (input) => (input.payload.destination.allowed = false)],
  ["missing", (input) => delete input.payload.destination],
];

for (const [name, change] of unavailableTargets) {
  test(name + " transfer destination suppresses a known source even after its public URL is unavailable", () => {
    const out = normalize((input) => {
      change(input);
      delete input.payload.issue.html_url;
    });
    assert.deepEqual(out.facts, []);
    assert.deepEqual(out.evidence, []);
    assert.deepEqual(out.lineage, []);
    assert.deepEqual(out.suppressArtifactIds, ["I_synthetic_original"]);
    assert.ok(out.reasons.includes("transfer_destination_private_unknown_or_unapproved"));
  });
}

test("an unknown source identity cannot invent a suppression target", () => {
  const out = normalize((input) => {
    input.payload.destination.visibility = "private";
    delete input.payload.issue.id;
    delete input.payload.issue.node_id;
    delete input.payload.issue.html_url;
  });
  assert.deepEqual(out.facts, []);
  assert.deepEqual(out.lineage, []);
  assert.deepEqual(out.suppressArtifactIds, []);
});

test("unknown actor and exact transition time remain unknown without assignee or observation-time inference", () => {
  const out = normalize((input) => {
    input.payload.sender = null;
    input.payload.issue.assignee = actor;
    input.payload.issue.updated_at = occurredAt;
    input.occurredAt = null;
  });
  assert.equal(out.facts[0].state, "unknown");
  assert.equal(out.facts[0].actorId, null);
  assert.equal(out.facts[0].occurredAt, null);
  assert.equal(out.facts[0].acceptedAt, null);
  assert.ok(out.reasons.includes("unknown_actor"));
  assert.ok(out.reasons.includes("unknown_event_time"));
});

test("back-and-forth transfer observations stay separate raw transitions without accumulating qualified merit", () => {
  const forward = normalize();
  const reverse = normalize((input) => {
    input.repository = { id: 3, slug: targetSlug, visibility: "public" };
    input.payload.issue.html_url = "https://github.com/" + targetSlug + "/issues/8";
    input.payload.issue.number = 8;
    input.payload.destination.repositoryId = 2;
    input.payload.destination.slug = sourceSlug;
    input.payload.destination.url = "https://github.com/" + sourceSlug + "/issues/2";
    input.occurredAt = "2026-10-07T10:01:00Z";
    input.proof.eventId = "synthetic-reverse-transfer";
  });
  const facts = [...forward.facts, ...reverse.facts];
  assert.equal(facts.length, 2);
  assert.notEqual(facts[0].id, facts[1].id);
  assert.ok(facts.every((fact) => fact.metricId === "issue_transfers" && fact.state === "observed"));
  assert.ok(facts.every((fact) => fact.acceptedAt === null && fact.acceptanceReceipt === null));
});
