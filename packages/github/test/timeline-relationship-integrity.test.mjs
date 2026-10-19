import assert from "node:assert/strict";
import test from "node:test";
import { createGithubEvidenceNormalizer, readTypedIssueHistory, typedHistoryRevision } from "../dist/index.js";
import { syntheticRepositoryClient } from "./synthetic-client.mjs";

const repository = { id: 2, slug: "synthetic-owner/repository" };
const subject = { id: "I_synthetic", url: `https://github.com/${repository.slug}/issues/1` };
const actor = { id: "U_synthetic", __typename: "User", databaseId: 3, login: "synthetic" };
const target = {
  id: "I_target",
  url: `https://github.com/${repository.slug}/issues/2`,
  repository: { databaseId: 2, isPrivate: false },
};
const event = (fields = {}) => ({
  id: "E_synthetic",
  __typename: "ParentIssueAddedEvent",
  actor,
  createdAt: "2026-10-01T00:00:00Z",
  parent: target,
  ...fields,
});
const options = (client) => ({
  client,
  source: "synthetic",
  repository,
  number: 1,
  subjectId: subject.id,
  family: "relationships",
  scanId: "synthetic",
});
const clientFor = (events, cached = false) => ({
  scanGraphql: async (scan) =>
    cached
      ? events.map((value) => ({ event: structuredClone(value), subject: { ...subject } }))
      : scan.select({
          repository: {
            databaseId: 2,
            isPrivate: false,
            issue: {
              ...subject,
              timelineItems: {
                nodes: structuredClone(events),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }).nodes,
});
const normalizeRecord = async (record, client) => {
  const normalize = createGithubEvidenceNormalizer({
    client: syntheticRepositoryClient(repository.id, client),
    source: "synthetic",
    allowedRepositoryIds: [repository.id],
    isSynthetic: true,
  });
  return normalize({
    repository,
    family: "relationships",
    factKey: "synthetic",
    observedAt: "2026-10-02T00:00:00Z",
    policyVersion: "synthetic/v1",
    fact: {
      subjectId: record.event.id,
      sourceRevision: typedHistoryRevision(record),
      sourceUrl: subject.url,
      evidence: "observed_transition",
      actorId: "3",
      occurredAt: "2026-10-01T00:00:00Z",
      state: "present",
    },
  });
};

test("all four selected native relationship types retain their own action, identity and endpoint", async () => {
  for (const [type, field, metric] of [
    ["ParentIssueAddedEvent", "parent", "parent_child_links"],
    ["ParentIssueRemovedEvent", "parent", "parent_child_links"],
    ["BlockedByAddedEvent", "blockingIssue", "blocker_links"],
    ["BlockedByRemovedEvent", "blockingIssue", "blocker_links"],
  ]) {
    const value = event({ __typename: type, parent: null, [field]: target });
    const original = structuredClone(value);
    const outputs = [];
    for (const cached of [false, true]) {
      const client = clientFor([value], cached);
      const [record] = await readTypedIssueHistory(options(client));
      assert.deepEqual(record, { event: original, subject });
      const output = await normalizeRecord(record, client);
      assert.equal(output.facts.length, 1);
      assert.equal(output.facts[0].metricId, metric);
      assert.equal(output.facts[0].state, "observed");
      assert.equal(output.facts[0].actorId, "3");
      assert.equal(output.observations[0].action, type.includes("Removed") ? "removed" : "added");
      outputs.push(output);
    }
    assert.deepEqual(outputs[0], outputs[1]);
    assert.deepEqual(value, original);
  }
});

test("unsupported event types cannot become intentional relationship facts", async (t) => {
  for (const type of [
    "CrossReferencedEvent",
    "ProjectV2ItemStatusChangedEvent",
    "SubIssueAddedEvent",
    "BlockingAddedEvent",
    "UnsupportedRemovedEvent",
    "constructor",
    "",
    null,
    undefined,
  ]) {
    await t.test(String(type), async () => {
      for (const cached of [false, true]) {
        await assert.rejects(
          readTypedIssueHistory(options(clientFor([event({ __typename: type })], cached))),
          /typed_history_event_unverified/,
        );
      }
    });
  }
});

test("native type and endpoint field must agree without a competing endpoint", async (t) => {
  for (const [name, fields] of [
    ["blocked type with parent", { __typename: "BlockedByAddedEvent" }],
    ["parent type with blocker", { parent: undefined, blockingIssue: target }],
    ["both endpoint objects", { blockingIssue: target }],
    ["blocked event with both objects", { __typename: "BlockedByRemovedEvent", blockingIssue: target }],
    ["false competing endpoint", { blockingIssue: false }],
    ["empty competing endpoint", { blockingIssue: "" }],
  ]) {
    await t.test(name, async () => {
      for (const cached of [false, true]) {
        await assert.rejects(
          readTypedIssueHistory(options(clientFor([event(fields)], cached))),
          /typed_history_event_unverified|relationship_endpoint_not_authorized/,
        );
      }
    });
  }
});

test("completed relationship checkpoints receive the same event-shape checks as fresh pages", async (t) => {
  for (const [name, value] of [
    ["null event", null],
    ["array event", []],
    ["missing event id", event({ id: undefined })],
    ["numeric event id", event({ id: 17 })],
    ["empty event id", event({ id: "" })],
    ["blank event id", event({ id: " \t" })],
    ["missing clock field", event({ createdAt: undefined })],
    ["numeric clock field", event({ createdAt: 17 })],
  ]) {
    await t.test(name, async () => {
      for (const cached of [false, true]) {
        await assert.rejects(
          readTypedIssueHistory(options(clientFor([value], cached))),
          /typed_history_event_unverified/,
        );
      }
    });
  }
});

test("relationship endpoint identity requires the exact approved issue URL", async (t) => {
  const prefix = `https://github.com/${repository.slug}/issues/`;
  const badTargets = [
    { ...target, id: "" },
    { ...target, id: " \t" },
    ...[
      prefix,
      `${prefix}0`,
      `${prefix}02`,
      `${prefix}-2`,
      `${prefix}2/`,
      `${prefix}2?source=unverified`,
      `${prefix}2#issuecomment-123`,
      `${prefix}%32`,
      `${prefix}2/more`,
      `${prefix}9007199254740992`,
      `https://github.com/${repository.slug}/pull/2`,
      "https://github.com/synthetic-owner/other/issues/2",
    ].map((url) => ({ ...target, url })),
  ];
  for (const [index, endpoint] of badTargets.entries()) {
    await t.test(String(index), async () => {
      for (const cached of [false, true]) {
        await assert.rejects(
          readTypedIssueHistory(options(clientFor([event({ parent: endpoint })], cached))),
          /relationship_endpoint_not_authorized/,
        );
      }
    });
  }
});

test("a malformed resumed page rejects the entire relationship history in either page order", async () => {
  const good = event();
  const bad = event({ id: "E_unsupported", __typename: "CrossReferencedEvent" });
  for (const events of [
    [good, bad],
    [bad, good],
  ]) {
    await assert.rejects(readTypedIssueHistory(options(clientFor(events, true))), /typed_history_event_unverified/);
  }
});

test("normalization independently rejects a matching revision of an unsupported cached event", async () => {
  const value = event({ __typename: "CrossReferencedEvent" });
  await assert.rejects(
    normalizeRecord({ event: value, subject }, clientFor([value], true)),
    /typed_history_event_unverified/,
  );
});

test("unknown actors and unsupported clock text remain unknown without invented evidence", async () => {
  const value = event({ actor: null, createdAt: "unsupported-clock" });
  const client = clientFor([value], true);
  const [record] = await readTypedIssueHistory(options(client));
  assert.deepEqual(record, { event: value, subject });
  const output = await normalizeRecord(record, client);
  assert.equal(output.facts.length, 1);
  assert.equal(output.facts[0].state, "unknown");
  assert.equal(output.facts[0].actorId, null);
  assert.equal(output.facts[0].occurredAt, null);
  assert.ok(output.reasons.includes("unknown_actor"));
  assert.ok(output.reasons.includes("unknown_event_time"));
});

test("distinct same-second native events remain distinct while duplicate event IDs reject", async () => {
  const values = [event(), event({ id: "E_second" })];
  const client = clientFor(values, true);
  const records = await readTypedIssueHistory(options(client));
  const outputs = await Promise.all(records.map((record) => normalizeRecord(record, client)));
  assert.notEqual(typedHistoryRevision(records[0]), typedHistoryRevision(records[1]));
  assert.notEqual(outputs[0].facts[0].id, outputs[1].facts[0].id);
  await assert.rejects(
    readTypedIssueHistory(options(clientFor([values[0], values[0]], true))),
    /typed_history_duplicate_event/,
  );
});
