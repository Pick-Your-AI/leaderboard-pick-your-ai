import assert from "node:assert/strict";
import test from "node:test";
import { readIssueFieldHistory, issueFieldHistoryRevision, createGithubEvidenceNormalizer } from "../dist/index.js";
import { issueFieldFixture, nativeEvent, nativeActor, repository, issue } from "./issue-field-fixture.mjs";

const normalizeFor = (h, extra = {}) =>
  createGithubEvidenceNormalizer({
    client: h.client,
    source: h.options.source,
    allowedRepositoryIds: [repository.id],
    isSynthetic: true,
    ...extra,
  });
const inputFor = (record, extra = {}) => ({
  repository,
  family: "issue_field_history",
  factKey: "synthetic-native-" + record.event.id,
  observedAt: "2026-10-02T00:00:00.000Z",
  policyVersion: "synthetic/v1",
  fact: {
    subjectId: record.event.id,
    historySubjectId: record.subject.id,
    issueFieldId: record.issueField.id,
    sourceRevision: issueFieldHistoryRevision(record),
    sourceUrl: record.subject.url,
    evidence: "observed_transition",
    actorId: record.event.actor?.databaseId ? String(record.event.actor.databaseId) : null,
    occurredAt: new Date(record.event.createdAt).toISOString(),
    state: "present",
  },
  ...extra,
});
async function profile(dataType, event = nativeEvent()) {
  const h = issueFieldFixture([event]);
  h.state.fields.get(event.fieldId).dataType = dataType;
  const [record] = await readIssueFieldHistory(h.options);
  return { h, record, output: await normalizeFor(h)(inputFor(record)) };
}

test("native issue fields bind the issue artifact, editor and native clock with unknown execution", async () => {
  const { record, output } = await profile("TEXT");
  assert.equal(output.isSynthetic, true);
  assert.equal(output.facts.length, 1);
  assert.equal(output.facts[0].metricId, "issue_field_updates");
  assert.equal(output.facts[0].artifactId, issue.id);
  assert.equal(output.facts[0].actorId, "7");
  assert.equal(output.facts[0].role, "triager");
  assert.equal(output.facts[0].state, "observed");
  assert.equal(output.facts[0].occurredAt, "2026-10-01T00:00:00.000Z");
  assert.equal(output.observations[0].source, "github_graphql");
  assert.equal(output.observations[0].sourceRevision, issueFieldHistoryRevision(record));
  assert.equal(output.observations[0].sourceUrl, issue.url);
  assert.equal(output.actors[0].kind, "user");
  assert.equal(output.actors[0].executionMode, "unknown");
  assert.deepEqual(output.assistance, []);
  assert.doesNotMatch(
    JSON.stringify(output),
    /SYNTHETIC_BEFORE_VALUE|SYNTHETIC_AFTER_VALUE|previousOptions|newOptions/,
  );
});

test("nullable actors remain unknown and bot identity does not infer execution", async () => {
  const unknown = await profile("TEXT", nativeEvent(undefined, { actor: null }));
  assert.equal(unknown.output.facts[0].actorId, null);
  assert.equal(unknown.output.facts[0].state, "unknown");
  assert.deepEqual(unknown.output.actors, []);
  const bot = await profile(
    "TEXT",
    nativeEvent(undefined, {
      actor: { ...nativeActor, __typename: "Bot", id: "B_SYNTHETIC_EDITOR" },
    }),
  );
  assert.equal(bot.output.actors[0].kind, "bot");
  assert.equal(bot.output.actors[0].executionMode, "unknown");
});

const reviewedNativeAccount = {
  schemaVersion: "leaderboard-service-account/v1",
  classificationId: "synthetic-native-account-review",
  githubDatabaseId: nativeActor.databaseId,
  githubNodeId: nativeActor.id,
  source: "reviewed_configuration",
  evidenceIds: ["synthetic-native-account-evidence"],
  reviewerActorId: "202",
  reviewedAt: "2026-10-01T00:00:00Z",
};
const nativeClassificationOptions = {
  reviewedServiceAccounts: [reviewedNativeAccount],
  authorizedClassifierIds: ["202"],
};

test("native issue fields preserve protected service-account classification without changing source facts", async () => {
  const { h, record, output: unclassified } = await profile("TEXT");
  const classified = await normalizeFor(h, nativeClassificationOptions)(inputFor(record));
  assert.equal(classified.actors[0].kind, "service_account");
  assert.equal(classified.actors[0].executionMode, "unknown");
  assert.deepEqual(classified.actors[0].serviceAccountClassification, reviewedNativeAccount);
  const { actors: unclassifiedActors, ...originalFacts } = unclassified;
  const { actors: classifiedActors, ...classifiedFacts } = classified;
  assert.deepEqual(classifiedFacts, originalFacts);
  assert.deepEqual(classifiedActors, [
    { ...unclassifiedActors[0], kind: "service_account", serviceAccountClassification: reviewedNativeAccount },
  ]);
});

test("native issue-field classification retains reviewer, exact-time and stable-identity guards", async (t) => {
  const { h, record } = await profile("TEXT");
  for (const [label, options] of [
    ["unauthorized reviewer", { authorizedClassifierIds: [] }],
    [
      "one-nanosecond future review",
      {
        reviewedServiceAccounts: [{ ...reviewedNativeAccount, reviewedAt: "2026-10-02T00:00:00.000000001Z" }],
      },
    ],
    ["mismatched node identity", { reviewedServiceAccounts: [{ ...reviewedNativeAccount, githubNodeId: "U_OTHER" }] }],
  ])
    await t.test(label, async () => {
      await assert.rejects(
        normalizeFor(h, { ...nativeClassificationOptions, ...options })(inputFor(record)),
        /service-account classification/i,
      );
    });
});

test("an unrelated reviewed account cannot classify a native editor by login", async () => {
  const { h, record, output } = await profile("TEXT");
  const unrelated = await normalizeFor(h, {
    ...nativeClassificationOptions,
    reviewedServiceAccounts: [{ ...reviewedNativeAccount, githubDatabaseId: 303, githubNodeId: "U_OTHER" }],
  })(inputFor(record));
  assert.deepEqual(unrelated, output);
});

test("PR subjects, snapshots and absent collected native identities cannot become field history", async (t) => {
  const h = issueFieldFixture();
  const [record] = await readIssueFieldHistory(h.options);
  const normalize = normalizeFor(h);
  for (const [label, patch] of [
    ["PR URL", { sourceUrl: issue.url.replace("/issues/", "/pull/") }],
    ["current snapshot", { evidence: "current_state" }],
    ["missing field", { issueFieldId: undefined }],
    ["missing issue", { historySubjectId: undefined }],
  ])
    await t.test(label, async () => {
      h.calls.length = 0;
      const input = inputFor(record);
      Object.assign(input.fact, patch);
      const output = await normalize(input);
      assert.deepEqual(output.facts, []);
      assert.deepEqual(output.reasons, ["issue_field_collected_binding_unverified"]);
      assert.equal(h.calls.length, 0);
    });
});

test("collected event, field and issue bindings must match independently probed native identities", async (t) => {
  for (const [label, patch, code] of [
    ["wrong event", { subjectId: "E_SYNTHETIC_FOREIGN" }, "issue_field_event_unavailable"],
    ["wrong field", { issueFieldId: "IF_SYNTHETIC_FOREIGN" }, "issue_field_event_unavailable"],
    ["wrong issue", { historySubjectId: "I_SYNTHETIC_FOREIGN" }, "issue_field_subject_identity_unverified"],
  ])
    await t.test(label, async () => {
      const h = issueFieldFixture();
      const [record] = await readIssueFieldHistory(h.options);
      h.state.fields.set("IF_SYNTHETIC_FOREIGN", { id: "IF_SYNTHETIC_FOREIGN", dataType: "TEXT", visibility: "ALL" });
      h.state.events.set(
        "E_SYNTHETIC_FOREIGN",
        nativeEvent("E_SYNTHETIC_FOREIGN", { fieldId: "IF_SYNTHETIC_FOREIGN" }),
      );
      const input = inputFor(record);
      Object.assign(input.fact, patch);
      await assert.rejects(normalizeFor(h)(input), { message: code });
    });
});

test("forged collected attribution or revision cannot replace the actual event evidence", async (t) => {
  const h = issueFieldFixture();
  const [record] = await readIssueFieldHistory(h.options);
  for (const [label, patch, reason] of [
    ["actor", { actorId: "999" }, "issue_field_collected_attribution_unverified"],
    ["clock", { occurredAt: "2026-10-01T01:00:00.000Z" }, "issue_field_collected_attribution_unverified"],
    ["revision", { sourceRevision: "0".repeat(64) }, "issue_field_revision_unverified"],
  ])
    await t.test(label, async () => {
      const input = inputFor(record);
      Object.assign(input.fact, patch);
      const output = await normalizeFor(h)(input);
      assert.deepEqual(output.facts, []);
      assert.deepEqual(output.reasons, [reason]);
    });
  h.state.events.get(record.event.id).newValue = "SYNTHETIC_CHANGED_AFTER_COLLECTION";
  const revised = await normalizeFor(h)(inputFor(record));
  assert.deepEqual(revised.reasons, ["issue_field_revision_unverified"]);
  assert.deepEqual(revised.facts, []);
});

test("explicit null, empty strings and zero text remain distinct without numeric or date coercion", async (t) => {
  for (const dataType of ["TEXT", "NUMBER", "DATE"]) {
    for (const [before, after] of [
      [null, ""],
      ["", "0"],
      ["0", null],
    ]) {
      await t.test(dataType + " " + JSON.stringify([before, after]), async () => {
        const { record, output } = await profile(
          dataType,
          nativeEvent(undefined, { previousValue: before, newValue: after }),
        );
        assert.deepEqual(record.native, {
          before: { value: before, options: null },
          after: { value: after, options: null },
        });
        assert.deepEqual(record.change, { before, after });
        assert.equal(output.facts.length, 1);
      });
    }
  }
});

test("each requested scalar and option property must be present even for SINGLE_SELECT", async (t) => {
  for (const dataType of ["TEXT", "SINGLE_SELECT", "MULTI_SELECT"]) {
    for (const property of ["previousValue", "newValue", "previousOptions", "newOptions"]) {
      await t.test(dataType + " absent " + property, async () => {
        const event = nativeEvent(
          undefined,
          dataType === "MULTI_SELECT"
            ? {
                previousOptions: [{ name: "Synthetic A" }],
                newOptions: [{ name: "Synthetic B" }],
              }
            : {},
        );
        delete event[property];
        const h = issueFieldFixture([event]);
        h.state.fields.get(event.fieldId).dataType = dataType;
        await assert.rejects(readIssueFieldHistory(h.options), { message: "issue_field_value_unverified" });
      });
    }
  }
});

test("MULTI_SELECT retains dual native representations but compares deterministically ordered historical option names", async () => {
  const event = nativeEvent(undefined, {
    previousValue: "Synthetic B, Synthetic A",
    newValue: "Synthetic A, Synthetic B",
    previousOptions: [{ name: "Synthetic B" }, { name: "Synthetic A" }],
    newOptions: [{ name: "Synthetic A" }, { name: "Synthetic B" }],
  });
  const { h, record, output } = await profile("MULTI_SELECT", event);
  assert.deepEqual(record.native.before, { value: event.previousValue, options: ["Synthetic B", "Synthetic A"] });
  assert.deepEqual(record.native.after, { value: event.newValue, options: ["Synthetic A", "Synthetic B"] });
  assert.deepEqual(record.change, { before: ["Synthetic A", "Synthetic B"], after: ["Synthetic A", "Synthetic B"] });
  assert.deepEqual(output.facts, []);
  assert.ok(output.reasons.includes("no_op_field_change"));
  h.state.events.get(event.id).newValue = "Synthetic display text changed";
  const [changedDisplay] = await readIssueFieldHistory(h.options);
  assert.notEqual(issueFieldHistoryRevision(record), issueFieldHistoryRevision(changedDisplay));
  const changedOutput = await normalizeFor(h)(inputFor(changedDisplay));
  assert.deepEqual(changedOutput.facts, []);
  assert.ok(changedOutput.reasons.includes("no_op_field_change"));
});

test("MULTI_SELECT actual membership changes count while duplicates and unlabeled scalar-only forms are unavailable", async (t) => {
  const changed = await profile(
    "MULTI_SELECT",
    nativeEvent(undefined, {
      previousValue: null,
      newValue: "Synthetic B",
      previousOptions: [],
      newOptions: [{ name: "Synthetic B" }],
    }),
  );
  assert.equal(changed.output.facts.length, 1);
  for (const [label, patch, code] of [
    [
      "duplicate names",
      { previousOptions: [{ name: "Synthetic A" }, { name: "Synthetic A" }] },
      "issue_field_option_identity_ambiguous",
    ],
    ["scalar without options", { newOptions: null }, "issue_field_value_unverified"],
    ["malformed option", { newOptions: [{ color: "RED" }] }, "issue_field_value_unverified"],
  ])
    await t.test(label, async () => {
      const event = nativeEvent(undefined, {
        previousValue: null,
        previousOptions: [],
        newOptions: [{ name: "Synthetic B" }],
        ...patch,
      });
      const h = issueFieldFixture([event]);
      h.state.fields.get(event.fieldId).dataType = "MULTI_SELECT";
      await assert.rejects(readIssueFieldHistory(h.options), { message: code });
    });
});

test("SINGLE_SELECT accepts explicit compatible historical profiles and rejects conflicting mixtures", async (t) => {
  for (const [label, patch] of [
    ["scalar with null options", { previousValue: "Synthetic A", newValue: "Synthetic B" }],
    [
      "historical option with null scalar",
      { previousValue: null, newValue: null, previousOptions: [], newOptions: [{ name: "Synthetic B" }] },
    ],
    [
      "matching dual representation",
      {
        previousValue: "Synthetic A",
        newValue: "Synthetic B",
        previousOptions: [{ name: "Synthetic A" }],
        newOptions: [{ name: "Synthetic B" }],
      },
    ],
  ])
    await t.test(label, async () => {
      const { output } = await profile("SINGLE_SELECT", nativeEvent(undefined, patch));
      assert.equal(output.facts.length, 1);
    });
  for (const [label, patch] of [
    ["disagreeing scalar and option", { newValue: "Synthetic C", newOptions: [{ name: "Synthetic B" }] }],
    ["multiple options", { newValue: null, newOptions: [{ name: "Synthetic A" }, { name: "Synthetic B" }] }],
    ["nonempty scalar and empty options", { newOptions: [] }],
  ])
    await t.test(label, async () => {
      const event = nativeEvent(undefined, patch);
      const h = issueFieldFixture([event]);
      h.state.fields.get(event.fieldId).dataType = "SINGLE_SELECT";
      await assert.rejects(readIssueFieldHistory(h.options), { message: "issue_field_value_unverified" });
    });
});

test("unqueried option colors and current field labels cannot manufacture credit or alter the minimized revision", async () => {
  const event = nativeEvent(undefined, {
    previousValue: null,
    newValue: null,
    previousOptions: [{ name: "Synthetic A", color: "RED" }],
    newOptions: [{ name: "Synthetic A", color: "BLUE" }],
  });
  const { h, record, output } = await profile("SINGLE_SELECT", event);
  assert.deepEqual(output.facts, []);
  assert.ok(output.reasons.includes("no_op_field_change"));
  h.state.fields.get(event.fieldId).name = "SYNTHETIC_RENAMED_CURRENT_FIELD";
  h.state.events.get(event.id).newOptions[0].color = "GREEN";
  const [again] = await readIssueFieldHistory(h.options);
  assert.equal(issueFieldHistoryRevision(record), issueFieldHistoryRevision(again));
  assert.doesNotMatch(JSON.stringify(again), /RED|BLUE|GREEN|SYNTHETIC_RENAMED_CURRENT_FIELD/);
});

test("real collection normalization shares one fresh issue membership scan per opaque batch, never across runs", async () => {
  const h = issueFieldFixture([nativeEvent(), nativeEvent("E_SYNTHETIC_FIELD_2")]);
  const records = await readIssueFieldHistory(h.options);
  const normalize = normalizeFor(h);
  const scanCount = () => h.calls.filter((call) => call.operation === "IssueFieldHistory").length;
  h.calls.length = 0;
  const first = Object.freeze({});
  for (const record of records) {
    const result = await normalize(inputFor(record, { issueFieldHistoryBatch: first }));
    assert.equal(result.facts.length, 1);
  }
  assert.equal(scanCount(), 1);
  assert.equal(h.calls.filter((call) => call.operation === "IssueFieldScope").length, 6);
  assert.equal(h.calls.filter((call) => call.operation === "IssueFieldDetail").length, 2);
  const second = Object.freeze({});
  for (const record of records) await normalize(inputFor(record, { issueFieldHistoryBatch: second }));
  assert.equal(scanCount(), 2);
  for (const record of records) await normalize(inputFor(record));
  assert.equal(scanCount(), 4, "standalone normalization must stay fresh");
  const anotherClient = normalizeFor(h, { client: h.makeClient() });
  for (const record of records) await anotherClient(inputFor(record, { issueFieldHistoryBatch: second }));
  assert.equal(scanCount(), 5, "the same token cannot share metadata across different client scopes");
  h.state.fields.get(records[1].issueField.id).visibility = "ORG_ONLY";
  const details = h.calls.filter((call) => call.operation === "IssueFieldDetail").length;
  await assert.rejects(normalize(inputFor(records[1], { issueFieldHistoryBatch: first })), {
    message: "issue_field_public_scope_unverified",
  });
  assert.equal(h.calls.filter((call) => call.operation === "IssueFieldDetail").length, details);
});
