import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGithubObservation, createGithubEvidenceNormalizer } from "../dist/index.js";

const at = "2026-10-02T00:00:00Z";
const author = { id: 101, node_id: "U_synthetic_101", type: "User", login: "synthetic-person-looking-login" };
const classification = {
  schemaVersion: "leaderboard-service-account/v1",
  classificationId: "synthetic-service-account-review-1",
  githubDatabaseId: 101,
  githubNodeId: "U_synthetic_101",
  source: "reviewed_configuration",
  evidenceIds: ["synthetic-reviewed-config-revision-1"],
  reviewerActorId: "202",
  reviewedAt: "2026-10-01T00:00:00Z",
};
const envelope = (patch = {}) => ({
  repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public" },
  proof: { verified: true, source: "github_rest", revision: at, isSynthetic: true },
  family: "pull_request",
  observedAt: at,
  payload: {
    id: 10,
    node_id: "PR_synthetic_10",
    html_url: "https://github.com/synthetic-owner/repository/pull/10",
    user: author,
    created_at: at,
    state: "open",
  },
  reviewedServiceAccounts: [classification],
  authorizedClassifierIds: ["202"],
  ...patch,
});

test("reviewed stable-ID classifications align REST and GraphQL after a login rename", () => {
  const rest = normalizeGithubObservation(envelope());
  const graphql = normalizeGithubObservation(
    envelope({
      proof: { verified: true, source: "github_graphql", revision: at },
      payload: {
        ...envelope().payload,
        user: { databaseId: 101, id: "U_synthetic_101", __typename: "User", login: "synthetic-renamed" },
      },
    }),
  );
  for (const out of [rest, graphql]) {
    assert.equal(out.actors[0].id, "101");
    assert.equal(out.actors[0].kind, "service_account");
    assert.equal(out.actors[0].executionMode, "unknown");
    assert.deepEqual(out.actors[0].serviceAccountClassification, classification);
    assert.equal(out.facts[0].actorId, "101");
    assert.equal(out.facts[0].role, "author");
    assert.deepEqual(out.assistance, []);
  }
  assert.equal(rest.facts[0].canonicalKey, graphql.facts[0].canonicalKey);
  assert.equal(graphql.actors[0].login, "synthetic-renamed");
});

test("unreviewed login, type, payload flags and assistance cannot declare a service account", () => {
  for (const patch of [
    { login: "synthetic-service-bot[bot]" },
    { kind: "service_account", serviceAccountClassification: classification },
    { service_account: true },
  ]) {
    const input = envelope({
      reviewedServiceAccounts: [],
      assistance: [{ model: "Synthetic Model", version: "1" }],
      payload: { ...envelope().payload, user: { ...author, ...patch }, reviewedServiceAccounts: [classification] },
    });
    const out = normalizeGithubObservation(input);
    assert.equal(out.actors[0].kind, "user");
    assert.equal(out.actors[0].executionMode, "unknown");
    assert.equal(out.actors[0].serviceAccountClassification, undefined);
  }
  const unknown = normalizeGithubObservation(
    envelope({
      reviewedServiceAccounts: [],
      payload: { ...envelope().payload, user: { id: 101, login: "synthetic-human", type: "unsupported" } },
    }),
  );
  assert.deepEqual(unknown.actors, []);
  assert.equal(unknown.facts[0].actorId, null);
});

test("malformed, unapproved, future, duplicate and conflicting classifications fail closed", () => {
  for (const patch of [
    { authorizedClassifierIds: [] },
    { reviewedServiceAccounts: [{ ...classification, evidenceIds: [] }] },
    { reviewedServiceAccounts: [{ ...classification, schemaVersion: "unsupported" }] },
    { reviewedServiceAccounts: [{ ...classification, reviewedAt: "2026-10-03T00:00:00Z" }] },
    { reviewedServiceAccounts: [{ ...classification, reviewerActorId: "101" }], authorizedClassifierIds: ["101"] },
    { reviewedServiceAccounts: [classification, classification] },
    { reviewedServiceAccounts: [{ ...classification, githubDatabaseId: 999 }] },
    { reviewedServiceAccounts: [{ ...classification, githubNodeId: "U_mismatch" }] },
    { payload: { ...envelope().payload, user: { ...author, type: "Bot" } } },
    { payload: { ...envelope().payload, user: { ...author, type: "GitHubApp" } } },
  ])
    assert.throws(() => normalizeGithubObservation(envelope(patch)), JSON.stringify(patch));
});

test("unrelated accounts do not match a classification by login; apps and bots stay distinct", () => {
  for (const [sourceActor, kind] of [
    [{ ...author, id: 303, node_id: "U_synthetic_303" }, "user"],
    [{ ...author, id: 303, node_id: "B_synthetic_303", type: "Bot" }, "bot"],
    [{ id: "A_synthetic_303", databaseId: 303, __typename: "App", login: author.login }, "github_app"],
    [{ id: "B_synthetic_303", databaseId: 303, __typename: "Bot", login: author.login }, "bot"],
  ]) {
    const out = normalizeGithubObservation(envelope({ payload: { ...envelope().payload, user: sourceActor } }));
    assert.equal(out.actors[0].kind, kind);
    assert.equal(out.actors[0].serviceAccountClassification, undefined);
    assert.equal(out.actors[0].executionMode, "unknown");
  }
});

test("adapter applies protected reviewed configuration to hydrated and enriched inputs", async () => {
  const input = {
    repository: { id: 2, slug: "synthetic-owner/repository" },
    family: "pull_requests",
    factKey: "synthetic-fact",
    policyVersion: "synthetic-policy/v1",
    observedAt: at,
    fact: {
      subjectId: "PR_synthetic_10",
      sourceRevision: at,
      sourceUrl: "https://github.com/synthetic-owner/repository/pull/10",
      evidence: "current_state",
      actorId: "101",
      occurredAt: at,
      state: "open",
    },
  };
  for (const enriched of [false, true]) {
    const normalize = createGithubEvidenceNormalizer({
      client: {
        rest: async (_source, path) =>
          path.endsWith("/pulls/10") ? { ...envelope().payload, updated_at: at } : { id: 2, private: false },
      },
      source: "synthetic-source",
      allowedRepositoryIds: [2],
      isSynthetic: true,
      reviewedServiceAccounts: [classification],
      authorizedClassifierIds: ["202"],
      ...(enriched
        ? { enrich: async () => envelope({ reviewedServiceAccounts: [], authorizedClassifierIds: [] }) }
        : {}),
    });
    const out = await normalize(input);
    assert.equal(out.actors[0].kind, "service_account");
    assert.deepEqual(out.actors[0].serviceAccountClassification, classification);
  }
});

test("conflicting typed actor or numeric ID evidence remains unresolved rather than preferred", () => {
  for (const patch of [
    { __typename: "Bot" },
    { githubDatabaseId: 303 },
    { databaseId: 303 },
    { githubNodeId: "U_conflicting" },
  ]) {
    const out = normalizeGithubObservation(
      envelope({ payload: { ...envelope().payload, user: { ...author, ...patch } } }),
    );
    assert.deepEqual(out.actors, []);
    assert.equal(out.facts[0].actorId, null);
  }
});

test("service-account authorship stays separate from a merger and release automation", () => {
  const other = { id: 303, node_id: "U_synthetic_303", type: "User", login: "synthetic-other" };
  const merged = normalizeGithubObservation(
    envelope({ payload: { ...envelope().payload, merged: true, merged_at: at, merged_by: other, state: "closed" } }),
  );
  assert.equal(merged.facts.find((fact) => fact.metricId === "pr_merged").actorId, "101");
  assert.equal(merged.facts.find((fact) => fact.metricId === "maintainer_merges").actorId, "303");
  const release = normalizeGithubObservation(
    envelope({
      family: "release",
      action: "published",
      occurredAt: at,
      payload: {
        release: {
          id: 22,
          node_id: "REL_synthetic_22",
          author: other,
          draft: false,
          html_url: "https://github.com/synthetic-owner/repository/releases/tag/v1",
        },
        sender: author,
      },
    }),
  );
  assert.equal(release.facts[0].actorId, "101");
  assert.equal(release.facts[0].role, "automation");
  assert.equal(release.actors.find((actor) => actor.id === "101").executionMode, "unknown");
});

test("optional review node IDs cannot bypass observed identity conflicts in any actor role or order", () => {
  const { githubNodeId, ...databaseOnlyReview } = classification;
  const inputFor = (first, second, slot) => {
    const input = envelope({ reviewedServiceAccounts: [databaseOnlyReview] });
    input.payload = { ...input.payload, user: first };
    if (slot === "merger") Object.assign(input.payload, { merged: true, merged_at: at, merged_by: second });
    if (slot === "sender") input.payload.sender = second;
    if (slot === "coauthor") input.verifiedCoauthors = [{ actor: second, verificationReceipt: "synthetic-coauthor" }];
    if (slot === "reviewer") {
      input.family = "review";
      input.payload = {
        pull_request: input.payload,
        review: {
          id: 50,
          node_id: "R_synthetic_50",
          user: second,
          state: "APPROVED",
          created_at: at,
          submitted_at: at,
        },
      };
    }
    if (slot === "committer") {
      input.family = "commit";
      input.payload = {
        sha: "a".repeat(40),
        html_url: `https://github.com/synthetic-owner/repository/commit/${"a".repeat(40)}`,
        author: first,
        committer: second,
      };
    }
    return input;
  };
  for (const conflict of [
    { ...author, id: 999 },
    { ...author, node_id: "U_synthetic_conflicting" },
  ]) {
    for (const [first, second] of [
      [author, conflict],
      [conflict, author],
    ]) {
      for (const slot of ["merger", "sender", "coauthor", "reviewer", "committer"]) {
        assert.throws(
          () => normalizeGithubObservation(inputFor(first, second, slot)),
          /Conflicting observed actor database\/node identity bindings/,
          `${slot}: ${JSON.stringify([first, second])}`,
        );
      }
    }
  }
  // A duplicate lacking a node cannot make the first complete binding disappear.
  const { node_id, ...withoutNode } = author;
  assert.throws(
    () =>
      normalizeGithubObservation({
        ...inputFor(withoutNode, { ...author, node_id: "U_synthetic_conflicting" }, "merger"),
        payload: {
          ...inputFor(withoutNode, { ...author, node_id: "U_synthetic_conflicting" }, "merger").payload,
          sender: author,
        },
      }),
    /Conflicting observed actor database\/node identity bindings/,
  );
  const laterNode = normalizeGithubObservation(inputFor(withoutNode, author, "merger"));
  assert.equal(laterNode.actors.length, 1);
  assert.equal(laterNode.actors[0].id, "101");
  assert.equal(laterNode.actors[0].githubNodeId, author.node_id);
  // Consistent repetition and truly distinct IDs still preserve their own roles.
  const consistent = normalizeGithubObservation(inputFor(author, { ...author, login: "synthetic-renamed" }, "merger"));
  assert.equal(consistent.actors.length, 1);
  assert.equal(consistent.actors[0].kind, "service_account");
  assert.ok(consistent.facts.every((fact) => fact.actorId === "101"));
  const distinct = normalizeGithubObservation(
    inputFor(author, { ...author, id: 999, node_id: "U_synthetic_999" }, "merger"),
  );
  assert.deepEqual(
    distinct.actors.map((actor) => [actor.id, actor.kind]),
    [
      ["101", "service_account"],
      ["999", "user"],
    ],
  );
});

test("repeated observed actor IDs cannot silently pick a kind from the first role", () => {
  for (const [first, second] of [
    [author, { ...author, type: "Bot" }],
    [{ ...author, type: "Bot" }, author],
  ]) {
    assert.throws(
      () =>
        normalizeGithubObservation(
          envelope({
            reviewedServiceAccounts: [],
            payload: { ...envelope().payload, user: first, sender: second },
          }),
        ),
      /Conflicting observed actor kinds/,
    );
  }
});
