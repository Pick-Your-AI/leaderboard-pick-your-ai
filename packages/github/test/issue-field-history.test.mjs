import assert from "node:assert/strict";
import test from "node:test";
import {
  GithubClientError,
  readIssueFieldHistory,
  readIssueFieldEvent,
  issueFieldHistoryRevision,
} from "../dist/index.js";
import { issueFieldFixture, nativeEvent, issue } from "./issue-field-fixture.mjs";

test("native issue-field pagination retains only public identities before value hydration", async () => {
  const h = issueFieldFixture([nativeEvent(), nativeEvent("E_SYNTHETIC_FIELD_2")]);
  h.state.pageSize = 1;
  const records = await readIssueFieldHistory(h.options);
  assert.equal(records.length, 2);
  assert.equal(h.calls.filter((call) => call.operation === "IssueFieldHistory").length, 2);
  assert.equal(h.calls.filter((call) => call.operation === "IssueFieldDetail").length, 2);
  const persisted = JSON.stringify(h.checkpoints.writes);
  assert.doesNotMatch(
    persisted,
    /SYNTHETIC_BEFORE_VALUE|SYNTHETIC_AFTER_VALUE|previousValue|newValue|previousOptions|newOptions|synthetic-editor/,
  );
  assert.ok(
    h.checkpoints.writes
      .filter((row) => row.items)
      .every((row) => row.items.every((item) => Object.keys(item).sort().join(",") === "event,issueField,subject")),
  );
  assert.notEqual(issueFieldHistoryRevision(records[0]), issueFieldHistoryRevision(records[1]));
  const firstDetail = h.calls.findIndex((call) => call.operation === "IssueFieldDetail");
  assert.ok(firstDetail > h.calls.findIndex((call) => call.operation === "IssueFieldScope"));
  assert.ok(
    h.calls
      .filter((call) => call.query)
      .every((call) => !/\bintent\b|\bcolor\b|\bnewColor\b|\bpreviousColor\b/.test(call.query)),
  );
});

test("interrupted metadata pagination resumes, then freshly proves issue membership before exposing values", async () => {
  const h = issueFieldFixture([nativeEvent(), nativeEvent("E_SYNTHETIC_FIELD_2")]);
  h.state.pageSize = 1;
  h.state.failCursor = "1";
  await assert.rejects(readIssueFieldHistory(h.options), (error) => error.outcome?.kind === "transient_failure");
  assert.equal(h.calls.filter((call) => call.operation === "IssueFieldDetail").length, 0);
  h.state.failCursor = undefined;
  const records = await readIssueFieldHistory({ ...h.options, client: h.makeClient() });
  assert.equal(records.length, 2);
  const pages = h.calls.filter((call) => call.operation === "IssueFieldHistory");
  assert.deepEqual(
    pages.map((call) => call.variables.after),
    [null, "1", "1", null, "1"],
  );
});

test("completed metadata checkpoints still probe current public field, event and issue scope", async (t) => {
  for (const [label, mutate, code] of [
    [
      "field hidden",
      (h) => {
        h.state.fields.get("IF_SYNTHETIC_PUBLIC").visibility = "ORG_ONLY";
      },
      "issue_field_public_scope_unverified",
    ],
    [
      "field removed",
      (h) => {
        h.state.fields.delete("IF_SYNTHETIC_PUBLIC");
      },
      "issue_field_public_scope_unverified",
    ],
    [
      "event removed",
      (h) => {
        h.state.unavailableEvents.add("E_SYNTHETIC_FIELD_1");
      },
      "issue_field_event_unavailable",
    ],
    [
      "issue private",
      (h) => {
        h.state.privateRepository = true;
      },
      "issue_field_subject_identity_unverified",
    ],
    [
      "issue rebound",
      (h) => {
        h.state.issue.id = "I_SYNTHETIC_OTHER";
      },
      "issue_field_subject_identity_unverified",
    ],
  ])
    await t.test(label, async () => {
      const h = issueFieldFixture();
      await readIssueFieldHistory(h.options);
      const priorDetails = h.calls.filter((call) => call.operation === "IssueFieldDetail").length;
      mutate(h);
      await assert.rejects(readIssueFieldHistory({ ...h.options, client: h.makeClient() }), { message: code });
      assert.equal(h.calls.filter((call) => call.operation === "IssueFieldDetail").length, priorDetails);
    });
});

test("explicit never-admitted organization-only events are excluded without checkpointing their identities", async () => {
  const hidden = nativeEvent("E_SYNTHETIC_ORG_ONLY", { fieldId: "IF_SYNTHETIC_ORG_ONLY" });
  const h = issueFieldFixture([nativeEvent(), hidden]);
  h.state.fields.set(hidden.fieldId, { id: hidden.fieldId, dataType: "TEXT", visibility: "ORG_ONLY" });
  const records = await readIssueFieldHistory(h.options);
  assert.equal(records.length, 1);
  assert.doesNotMatch(JSON.stringify(h.checkpoints.writes), /E_SYNTHETIC_ORG_ONLY|IF_SYNTHETIC_ORG_ONLY/);
  assert.ok(
    h.calls.filter((call) => call.operation === "IssueFieldDetail").every((call) => call.variables.id !== hidden.id),
  );
});

test("unknown visibility, absent field, wrong event subtype and invalid event clocks are unavailable", async (t) => {
  for (const [label, mutate] of [
    [
      "unknown visibility",
      (h) => {
        h.state.fields.get("IF_SYNTHETIC_PUBLIC").visibility = "UNKNOWN";
      },
    ],
    [
      "absent field",
      (h) => {
        h.state.fields.clear();
      },
    ],
    [
      "wrong native subtype",
      (h) => {
        h.state.events.get("E_SYNTHETIC_FIELD_1").__typename = "ProjectV2ItemStatusChangedEvent";
      },
    ],
    [
      "invalid clock",
      (h) => {
        h.state.events.get("E_SYNTHETIC_FIELD_1").createdAt = "2026-02-30T00:00:00Z";
      },
    ],
  ])
    await t.test(label, async () => {
      const h = issueFieldFixture();
      mutate(h);
      await assert.rejects(readIssueFieldHistory(h.options), /invalid_response/);
      assert.equal(h.calls.filter((call) => call.operation === "IssueFieldDetail").length, 0);
    });
});

test("replayed metadata rejects subject swaps, unexpected retained content and duplicate event identity", async (t) => {
  for (const [label, mutate] of [
    [
      "subject swap",
      (row) => {
        row.items[0].subject.id = "I_SYNTHETIC_OTHER";
      },
    ],
    [
      "unexpected content",
      (row) => {
        row.items[0].change = { before: "retained-content", after: "forbidden" };
      },
    ],
    [
      "duplicate event",
      (row) => {
        row.items.push(structuredClone(row.items[0]));
      },
    ],
  ])
    await t.test(label, async () => {
      const h = issueFieldFixture();
      await readIssueFieldHistory(h.options);
      for (const row of h.checkpoints.repositoryValues.get(2).values()) if (row.items?.length) mutate(row);
      await assert.rejects(
        readIssueFieldHistory(h.options),
        /issue_field_checkpoint_invalid|issue_field_duplicate_event/,
      );
    });
});

test("previously collected hidden fields are reprobed before an empty refreshed timeline can erase evidence", async () => {
  const h = issueFieldFixture();
  const [record] = await readIssueFieldHistory(h.options);
  h.state.timelineIds = [];
  h.state.fields.get(record.issueField.id).visibility = "ORG_ONLY";
  h.calls.length = 0;
  await assert.rejects(
    readIssueFieldEvent({
      ...h.options,
      eventId: record.event.id,
      issueFieldId: record.issueField.id,
    }),
    { message: "issue_field_public_scope_unverified" },
  );
  assert.deepEqual(
    h.calls.map((call) => call.operation),
    ["IssueFieldScope"],
  );
});

test("normalization hydration proves fresh membership despite an old complete timeline checkpoint", async () => {
  const h = issueFieldFixture();
  const [record] = await readIssueFieldHistory(h.options);
  h.state.timelineIds = [];
  await assert.rejects(
    readIssueFieldEvent({
      ...h.options,
      eventId: record.event.id,
      issueFieldId: record.issueField.id,
    }),
    { message: "issue_field_event_unavailable" },
  );
  assert.equal(h.calls.filter((call) => call.operation === "IssueFieldHistory").length, 2);
});

test("metadata and detail field identities must agree before a normalized event is returned", async () => {
  const h = issueFieldFixture();
  h.state.mutate = ({ operation, data }) => {
    if (operation === "IssueFieldDetail") data.node.issueField.id = "IF_SYNTHETIC_OTHER";
    return data;
  };
  await assert.rejects(readIssueFieldHistory(h.options), { message: "issue_field_event_unavailable" });
});

test("authorization revoked after detail cannot expose its hydrated values", async () => {
  const h = issueFieldFixture();
  let revoked = false;
  h.state.mutate = ({ operation, data }) => {
    if (operation === "IssueFieldDetail") revoked = true;
    return data;
  };
  await assert.rejects(
    readIssueFieldHistory({
      ...h.options,
      assertAuthorized() {
        if (revoked) throw Error("synthetic-current-authorization-revoked");
      },
    }),
    (error) => error instanceof GithubClientError && error.outcome.kind === "unsafe_request",
  );
  assert.equal(h.calls.filter((call) => call.operation === "IssueFieldDetail").length, 1);
  assert.equal(issue.url.includes("/issues/1"), true);
});

test("a valid-shaped completed checkpoint cannot hydrate a foreign public event", async () => {
  const h = issueFieldFixture();
  await readIssueFieldHistory(h.options);
  const foreign = nativeEvent("E_SYNTHETIC_FOREIGN", { fieldId: "IF_SYNTHETIC_FOREIGN" });
  h.state.events.set(foreign.id, foreign);
  h.state.fields.set(foreign.fieldId, { id: foreign.fieldId, dataType: "TEXT", visibility: "ALL" });
  for (const row of h.checkpoints.repositoryValues.get(2).values()) {
    if (!row.items?.length) continue;
    row.items[0].event = { id: foreign.id, createdAt: foreign.createdAt };
    row.items[0].issueField = { id: foreign.fieldId, dataType: "TEXT" };
  }
  h.calls.length = 0;
  await assert.rejects(readIssueFieldHistory(h.options), { message: "issue_field_event_unavailable" });
  assert.equal(h.calls.filter((call) => call.operation === "IssueFieldDetail").length, 0);
  const scope = h.calls.findIndex((call) => call.operation === "IssueFieldScope");
  const timeline = h.calls.findIndex((call) => call.operation === "IssueFieldHistory");
  assert.ok(scope >= 0 && timeline > scope, "retained identities are probed before fresh membership");
  assert.equal(h.state.timelineIds.includes(foreign.id), false);
});

test("scope revoked by the detail response is detected by the final public-field probe", async () => {
  const h = issueFieldFixture();
  h.state.mutate = ({ operation, data }) => {
    if (operation === "IssueFieldDetail") h.state.fields.get("IF_SYNTHETIC_PUBLIC").visibility = "ORG_ONLY";
    return data;
  };
  await assert.rejects(readIssueFieldHistory(h.options), { message: "issue_field_public_scope_unverified" });
  assert.equal(h.calls.at(-1).operation, "IssueFieldScope");
});
