import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createGithubEvidenceNormalizer, normalizeGithubObservation } from "../dist/index.js";

// Synthetic protected enrichment. These records do not claim native historical
// destination discovery, source enablement, or accepted contribution credit.
const occurredAt = "2026-10-07T10:00:00Z";
const observedAt = "2026-10-08T10:00:00Z";
const instant = (value) => new Date(value).toISOString();
const eventObservation = (id) =>
  `gh:${createHash("sha256")
    .update(JSON.stringify(["event", id]))
    .digest("hex")}`;

function transfer() {
  return {
    repository: { id: 2, slug: "synthetic-owner/source", visibility: "public" },
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
        html_url: "https://github.com/synthetic-owner/source/issues/1",
        user: { id: 101, type: "User", login: "synthetic-author" },
      },
      sender: { id: 202, type: "User", login: "synthetic-triager" },
      destination: {
        repositoryId: 3,
        stableId: "I_synthetic_alias",
        slug: "synthetic-owner/target",
        url: "https://github.com/synthetic-owner/target/issues/8",
        visibility: "public",
        allowed: true,
      },
    },
  };
}

function creation() {
  const value = transfer();
  value.family = "issue";
  value.action = "opened";
  value.proof.eventId = "synthetic-opened-event";
  value.payload.issue.created_at = occurredAt;
  delete value.payload.destination;
  return value;
}

function normalize(value) {
  const before = structuredClone(value);
  const output = normalizeGithubObservation(value);
  assert.deepEqual(value, before, "the protected source envelope remains unchanged");
  return output;
}

function assertRawTransfer(output) {
  assert.equal(output.facts.length, 1);
  assert.equal(output.facts[0].metricId, "issue_transfers");
  assert.equal(output.facts[0].acceptedAt, null);
  assert.equal(output.facts[0].acceptanceReceipt, null);
  assert.equal(output.lineage.length, 1);
  assert.equal(output.lineage[0].relation, "transferred_to");
  assert.deepEqual(output.issueCreationScopes, []);
}

test("typed transfer binds both approved endpoints to the exact retained observation", () => {
  const value = transfer();
  const output = normalize(value);
  assertRawTransfer(output);
  assert.deepEqual(output.issueTransfers, [
    {
      schemaVersion: "github-issue-transfer/v1",
      sourceArtifactId: "I_synthetic_original",
      targetArtifactId: "I_synthetic_alias",
      sourceRepositoryId: "2",
      targetRepositoryId: "3",
      sourceUrl: value.payload.issue.html_url,
      targetUrl: value.payload.destination.url,
      observationId: eventObservation(value.proof.eventId),
      sourceRevision: value.proof.revision,
      observedAt: instant(observedAt),
      occurredAt: instant(occurredAt),
      eventId: value.proof.eventId,
    },
  ]);
  const [record] = output.issueTransfers;
  assert.equal(record.observationId, output.observations[0].id);
  assert.equal(record.sourceUrl, output.observations[0].sourceUrl);
  assert.equal(record.sourceArtifactId, output.facts[0].artifactId);
  assert.deepEqual(output.lineage[0].evidenceIds, [record.observationId]);
  assert.equal(output.facts[0].actorId, "202");
});

test("numeric fallback and unchanged provider identity are retained without inventing an alias", () => {
  const value = transfer();
  delete value.payload.issue.node_id;
  value.payload.destination.stableId = "github:issue:1001";
  const output = normalize(value);
  assertRawTransfer(output);
  assert.equal(output.issueTransfers[0].sourceArtifactId, "github:issue:1001");
  assert.equal(output.issueTransfers[0].targetArtifactId, "github:issue:1001");
});

test("missing transfer event and transition time remain explicit unknowns", () => {
  const value = transfer();
  delete value.proof.eventId;
  delete value.occurredAt;
  delete value.payload.sender;
  value.payload.issue.updated_at = observedAt;
  const output = normalize(value);
  assertRawTransfer(output);
  assert.equal(output.issueTransfers[0].eventId, null);
  assert.equal(output.issueTransfers[0].occurredAt, null);
  assert.equal(output.issueTransfers[0].observationId, output.observations[0].id);
  assert.equal(output.facts[0].occurredAt, null);
  assert.equal(output.facts[0].actorId, null);
  assert.equal(output.facts[0].state, "unknown");
});

for (const source of ["github_rest", "github_graphql"]) {
  test(`verified enriched ${source} transfer keeps its observed source without guessing a destination`, () => {
    const value = transfer();
    value.proof.source = source;
    const output = normalize(value);
    assertRawTransfer(output);
    assert.equal(output.issueTransfers.length, 1);
    assert.equal(output.observations[0].source, source);
  });
}

test("replayed transfer keeps event identity and each actual revision and observation clock", () => {
  const value = transfer();
  const first = normalize(value);
  value.proof.revision = "synthetic-replayed-revision";
  value.observedAt = "2026-10-09T10:00:00Z";
  const replay = normalize(value);
  assert.equal(replay.facts[0].id, first.facts[0].id);
  assert.equal(replay.issueTransfers[0].observationId, first.issueTransfers[0].observationId);
  assert.equal(replay.issueTransfers[0].sourceRevision, value.proof.revision);
  assert.equal(replay.issueTransfers[0].observedAt, instant(value.observedAt));
  assert.deepEqual(
    {
      ...replay.issueTransfers[0],
      sourceRevision: first.issueTransfers[0].sourceRevision,
      observedAt: first.issueTransfers[0].observedAt,
    },
    first.issueTransfers[0],
  );
});

test("bounded identifiers and source text accept their complete maximum lengths", () => {
  const value = transfer();
  value.payload.issue.node_id = "I".repeat(200);
  value.payload.destination.stableId = "A".repeat(200);
  value.proof.eventId = "e".repeat(2000);
  value.proof.revision = "r".repeat(2000);
  const output = normalize(value);
  assert.equal(output.issueTransfers.length, 1);
  assert.equal(output.issueTransfers[0].eventId, value.proof.eventId);
  assert.equal(output.issueTransfers[0].observationId, eventObservation(value.proof.eventId));
});

const malformedTransfers = [
  [
    "source identifier with terminal LF",
    (v) => {
      v.payload.issue.node_id += "\n";
    },
  ],
  [
    "target identifier with terminal LF",
    (v) => {
      v.payload.destination.stableId += "\n";
    },
  ],
  [
    "source identifier outside the provider alphabet",
    (v) => {
      v.payload.issue.node_id = "I_é";
    },
  ],
  [
    "target identifier with embedded whitespace",
    (v) => {
      v.payload.destination.stableId = "I alias";
    },
  ],
  [
    "overlong source identifier",
    (v) => {
      v.payload.issue.node_id = "I".repeat(201);
    },
  ],
  [
    "overlong target identifier",
    (v) => {
      v.payload.destination.stableId = "I".repeat(201);
    },
  ],
  [
    "empty supplied event ID",
    (v) => {
      v.proof.eventId = "";
    },
  ],
  [
    "null supplied event ID",
    (v) => {
      v.proof.eventId = null;
    },
  ],
  [
    "event ID with terminal LF",
    (v) => {
      v.proof.eventId += "\n";
    },
  ],
  [
    "event ID with surrounding whitespace",
    (v) => {
      v.proof.eventId = " event ";
    },
  ],
  [
    "event ID with a format character",
    (v) => {
      v.proof.eventId = "event\u200b";
    },
  ],
  [
    "overlong event ID",
    (v) => {
      v.proof.eventId = "e".repeat(2001);
    },
  ],
  [
    "revision with surrounding whitespace",
    (v) => {
      v.proof.revision = " revision ";
    },
  ],
  [
    "revision with an embedded control",
    (v) => {
      v.proof.revision = "revision\u0000suffix";
    },
  ],
  [
    "overlong source revision",
    (v) => {
      v.proof.revision = "r".repeat(2001);
    },
  ],
  [
    "invalid supplied occurrence",
    (v) => {
      v.occurredAt = "not-a-clock";
    },
  ],
  [
    "occurrence later than its observation",
    (v) => {
      v.occurredAt = "2026-10-09T10:00:00Z";
    },
  ],
  [
    "target URL with discarded whitespace",
    (v) => {
      v.payload.destination.url += "\n";
    },
  ],
  [
    "target URL with a discarded comment fragment",
    (v) => {
      v.payload.destination.url += "#issuecomment-7";
    },
  ],
  [
    "overlong complete target URL",
    (v) => {
      v.payload.destination.slug = `synthetic-owner/${"r".repeat(2050)}`;
      v.payload.destination.url = `https://github.com/${v.payload.destination.slug}/issues/8`;
    },
  ],
  [
    "overlong complete source URL",
    (v) => {
      v.repository.slug = `synthetic-owner/${"r".repeat(2050)}`;
      v.payload.issue.html_url = `https://github.com/${v.repository.slug}/issues/1`;
    },
  ],
];
for (const [name, mutate] of malformedTransfers) {
  test(`malformed transfer provenance rejects ${name} while retaining raw evidence`, () => {
    const value = transfer();
    mutate(value);
    const output = normalize(value);
    assertRawTransfer(output);
    assert.deepEqual(output.issueTransfers, []);
    assert.ok(output.reasons.includes("issue_transfer_provenance_incomplete"));
  });
}

for (const [name, mutate] of [
  [
    "private source",
    (v) => {
      v.repository.visibility = "private";
    },
  ],
  [
    "private destination",
    (v) => {
      v.payload.destination.visibility = "private";
    },
  ],
  [
    "unknown destination",
    (v) => {
      v.payload.destination.visibility = "unknown";
    },
  ],
  [
    "unapproved destination",
    (v) => {
      v.payload.destination.allowed = false;
    },
  ],
  [
    "unavailable destination",
    (v) => {
      delete v.payload.destination;
    },
  ],
  [
    "different claimed destination coordinates",
    (v) => {
      v.payload.destination.slug = "synthetic-owner/other";
    },
  ],
  [
    "pull request source",
    (v) => {
      v.payload.issue.pull_request = {};
    },
  ],
]) {
  test(`inadmissible transfer ${name} supplies no typed equivalence`, () => {
    const value = transfer();
    mutate(value);
    const output = normalize(value);
    assert.deepEqual(output.issueTransfers, []);
    assert.deepEqual(output.issueCreationScopes, []);
    assert.equal(output.facts.filter((fact) => fact.metricId === "issue_transfers").length, 0);
  });
}

test("generic lineage cannot manufacture transfer or creation proof", () => {
  const value = creation();
  value.action = "snapshot";
  value.proof.source = "github_rest";
  value.lineage = [
    { relation: "transferred_to", sourceIds: ["I_synthetic_original"], targetId: "I_other", evidenceIds: ["event"] },
  ];
  value.payload.issueTransfers = [{ schemaVersion: "github-issue-transfer/v1" }];
  value.payload.issueCreationScopes = [{ schemaVersion: "github-issue-creation-scope/v1" }];
  const output = normalize(value);
  assert.deepEqual(output.lineage, value.lineage);
  assert.deepEqual(output.issueTransfers, []);
  assert.deepEqual(output.issueCreationScopes, []);
  assert.equal(output.facts[0].metricId, "issues_opened");
});

test("opened webhook scope links the original fact and exact normalized native creation clock", () => {
  const value = creation();
  value.occurredAt = "2026-10-07T10:00:00.12Z";
  value.payload.issue.created_at = "2026-10-07T10:00:00.120Z";
  value.payload.issue.createdAt = value.payload.issue.created_at;
  const output = normalize(value);
  assert.deepEqual(output.issueTransfers, []);
  assert.deepEqual(output.issueCreationScopes, [
    {
      schemaVersion: "github-issue-creation-scope/v1",
      factId: output.facts[0].id,
      artifactId: "I_synthetic_original",
      repositoryId: "2",
      observationId: eventObservation(value.proof.eventId),
      sourceRevision: value.proof.revision,
      observedAt: instant(value.observedAt),
      occurredAt: instant(value.occurredAt),
      eventId: value.proof.eventId,
    },
  ]);
  assert.equal(output.issueCreationScopes[0].occurredAt, output.facts[0].occurredAt);
  assert.equal(output.issueCreationScopes[0].observationId, output.observations[0].id);
  assert.equal(output.facts[0].acceptedAt, null);
});

test("GraphQL-shaped native creation field and missing author do not manufacture actor evidence", () => {
  const value = creation();
  value.payload.issue.createdAt = value.payload.issue.created_at;
  delete value.payload.issue.created_at;
  delete value.payload.issue.user;
  value.payload.issue.__typename = "Issue";
  const output = normalize(value);
  assert.equal(output.issueCreationScopes.length, 1);
  assert.equal(output.facts[0].actorId, null);
  assert.equal(output.facts[0].state, "unknown");
});

test("creation replay retains the event proof without replacing its actual observation", () => {
  const value = creation();
  const first = normalize(value);
  value.observedAt = "2026-10-09T10:00:00Z";
  value.proof.revision = "synthetic-opened-replay";
  const second = normalize(value);
  assert.equal(second.issueCreationScopes[0].factId, first.issueCreationScopes[0].factId);
  assert.equal(second.issueCreationScopes[0].observationId, first.issueCreationScopes[0].observationId);
  assert.equal(second.issueCreationScopes[0].observedAt, instant(value.observedAt));
  assert.equal(second.issueCreationScopes[0].sourceRevision, value.proof.revision);
});

for (const [name, mutate] of [
  [
    "missing event ID",
    (v) => {
      delete v.proof.eventId;
    },
  ],
  [
    "empty event ID",
    (v) => {
      v.proof.eventId = "";
    },
  ],
  [
    "event ID ending in LF",
    (v) => {
      v.proof.eventId += "\n";
    },
  ],
  [
    "overlong event ID",
    (v) => {
      v.proof.eventId = "e".repeat(2001);
    },
  ],
  [
    "missing explicit occurrence",
    (v) => {
      delete v.occurredAt;
    },
  ],
  [
    "null explicit occurrence",
    (v) => {
      v.occurredAt = null;
    },
  ],
  [
    "different explicit creation clock",
    (v) => {
      v.occurredAt = "2026-10-07T10:00:01Z";
    },
  ],
  [
    "no native creation clock",
    (v) => {
      delete v.payload.issue.created_at;
    },
  ],
  [
    "only updated-at evidence",
    (v) => {
      v.payload.issue.updated_at = v.payload.issue.created_at;
      delete v.payload.issue.created_at;
    },
  ],
  [
    "contradictory native creation clocks",
    (v) => {
      v.payload.issue.createdAt = "2026-10-07T10:00:01Z";
    },
  ],
  [
    "creation after observation",
    (v) => {
      v.observedAt = "2026-10-06T10:00:00Z";
    },
  ],
  [
    "REST opened action",
    (v) => {
      v.proof.source = "github_rest";
    },
  ],
  [
    "GraphQL opened action",
    (v) => {
      v.proof.source = "github_graphql";
    },
  ],
  [
    "reopened action",
    (v) => {
      v.action = "reopened";
    },
  ],
  [
    "current snapshot",
    (v) => {
      v.action = "snapshot";
    },
  ],
  [
    "private source",
    (v) => {
      v.repository.visibility = "private";
    },
  ],
  [
    "invalid complete artifact ID",
    (v) => {
      v.payload.issue.node_id += "\n";
    },
  ],
  [
    "PR discriminator",
    (v) => {
      v.payload.issue.pull_request = {};
    },
  ],
  [
    "PR native type",
    (v) => {
      v.payload.issue.__typename = "PullRequest";
    },
  ],
  [
    "PR wrapper",
    (v) => {
      v.payload.pull_request = structuredClone(v.payload.issue);
      delete v.payload.issue;
    },
  ],
]) {
  test(`creation scope is not inferred from ${name}`, () => {
    const value = creation();
    mutate(value);
    const output = normalize(value);
    assert.deepEqual(output.issueCreationScopes, []);
    assert.deepEqual(output.issueTransfers, []);
  });
}

function input(value) {
  return {
    repository: { id: value.repository.id, slug: value.repository.slug },
    family: "timeline",
    factKey: "synthetic-source-fact",
    observedAt: value.observedAt,
    policyVersion: "synthetic-policy",
    fact: {
      subjectId: value.payload.issue.node_id,
      sourceRevision: value.proof.revision,
      sourceUrl: value.payload.issue.html_url,
      evidence: "observed_transition",
      actorId: null,
      occurredAt: value.occurredAt,
      state: value.action,
    },
  };
}

for (const [name, fixture, field] of [
  ["transfer", transfer, "issueTransfers"],
  ["creation", creation, "issueCreationScopes"],
]) {
  test(`protected factory preserves typed ${name} provenance and rejects an unauthorized repository`, async () => {
    const value = fixture();
    const normalizer = createGithubEvidenceNormalizer({
      client: {
        forRepository() {
          throw new Error("enriched fixture must not perform transport reads");
        },
      },
      source: "synthetic-source",
      allowedRepositoryIds: [2],
      isSynthetic: true,
      enrich: async () => value,
    });
    const current = input(value);
    const output = await normalizer(current);
    assert.equal(output[field].length, 1);
    assert.deepEqual(output[field], normalize(value)[field]);
    current.repository.id = 99;
    const denied = await normalizer(current);
    assert.deepEqual(denied.issueTransfers, []);
    assert.deepEqual(denied.issueCreationScopes, []);
    assert.deepEqual(denied.reasons, ["repository_not_authorized_for_normalization"]);
  });
}
