import assert from "node:assert/strict";
import test from "node:test";
import {
  readPullRequestMergeTarget,
  verifyGithubPullRequestMergeTargetCapture,
  pullRequestMergeTargetSourceInstant,
} from "../dist/index.js";
import { mergeTargetFixture, mergeOid, mergedAt, observedAt, slug } from "./pull-request-merge-target-fixture.mjs";

test("merge-target reader retains the native event branch rather than the current base or default branch", async () => {
  const s = mergeTargetFixture();
  const capture = await readPullRequestMergeTarget(s.reader);
  assert.equal(capture.status, "known");
  assert.equal(capture.event.mergeRefName, "stack/topic");
  assert.equal(s.payload.base.ref, "main");
  assert.equal(capture.event.commitOid, mergeOid);
  assert.equal(capture.event.createdAt, mergedAt);
  assert.equal(capture.observedAt, observedAt);
  assert.equal(capture.sourceRevision, s.input.fact.sourceRevision);
  assert.equal(capture.reason, null);
  assert.deepEqual(await verifyGithubPullRequestMergeTargetCapture(capture), capture);
  assert.equal(s.state.requests.length, 1);
  assert.deepEqual(s.state.requests[0].variables, {
    owner: "synthetic-owner",
    name: "repository",
    number: 10,
    first: 100,
    after: null,
  });
  assert.match(s.state.requests[0].query, /itemTypes:\[MERGED_EVENT\]/);
  assert.doesNotMatch(s.state.requests[0].query, /\bmergeRef\b|\bbaseRefName\b|\bdefaultBranchRef\b/);
});

test("merge-target reader retains a historical name after current mergeRef deletion", async () => {
  const s = mergeTargetFixture();
  s.event.mergeRef = null;
  const capture = await readPullRequestMergeTarget(s.reader);
  assert.equal(capture.status, "known");
  assert.equal(capture.event.mergeRefName, "stack/topic");
  assert.equal(Object.hasOwn(capture.event, "mergeRef"), false);
});

test("merge-target reader reports no native event as unknown, never an empty branch", async () => {
  const s = mergeTargetFixture();
  s.state.pages.get(null).nodes = [];
  const capture = await readPullRequestMergeTarget(s.reader);
  assert.equal(capture.status, "unknown");
  assert.equal(capture.reason, "merge_event_missing");
  assert.equal(capture.event, null);
});

for (const [name, change, reason] of [
  ["missing historical branch", (s) => (s.event.mergeRefName = null), "merge_event_branch_missing"],
  ["unsafe historical branch", (s) => (s.event.mergeRefName = "topic..private"), "merge_event_unverified"],
  ["missing native commit", (s) => (s.event.commit = null), "merge_event_unverified"],
  ["missing selected commit", (s) => (s.graphqlPullRequest.mergeCommit = null), "merge_event_unverified"],
  ["different native commit", (s) => (s.event.commit.oid = "c".repeat(40)), "merge_event_commit_mismatch"],
  ["different merge event time", (s) => (s.event.createdAt = "2026-10-07T09:59:59Z"), "merge_event_time_mismatch"],
  ["sub-millisecond event time", (s) => (s.event.createdAt = "2026-10-07T10:00:00.0001Z"), "merge_event_unverified"],
  ["offset event time", (s) => (s.event.createdAt = "2026-10-07T10:00:00+00:00"), "merge_event_unverified"],
  ["foreign event PR", (s) => (s.event.pullRequest.id = "PR_other"), "merge_event_unverified"],
])
  test(`merge-target reader keeps ${name} unknown`, async () => {
    const s = mergeTargetFixture();
    change(s);
    const capture = await readPullRequestMergeTarget(s.reader);
    assert.equal(capture.status, "unknown");
    assert.equal(capture.reason, reason);
    assert.deepEqual(await verifyGithubPullRequestMergeTargetCapture(capture), capture);
  });

for (const [name, change, pattern] of [
  ["foreign repository", (s) => (s.graphqlRepository.databaseId = 3), /source_unverified/],
  ["private repository", (s) => (s.graphqlRepository.isPrivate = true), /source_unverified/],
  ["foreign selected PR", (s) => (s.graphqlPullRequest.id = "PR_other"), /source_unverified/],
  [
    "changed selected merge time",
    (s) => (s.graphqlPullRequest.mergedAt = "2026-10-07T10:00:00.0001Z"),
    /source_unverified/,
  ],
  [
    "changed selected commit",
    (s) => (s.graphqlPullRequest.mergeCommit.oid = "c".repeat(40)),
    /selected_commit_changed/,
  ],
])
  test(`merge-target reader rejects ${name} without emitting branch authority`, async () => {
    const s = mergeTargetFixture();
    change(s);
    await assert.rejects(readPullRequestMergeTarget(s.reader), pattern);
  });

test("merge-target reader consumes complete pagination before selecting the sole event", async () => {
  const s = mergeTargetFixture();
  s.state.pages.set(null, { nodes: [], pageInfo: { hasNextPage: true, endCursor: "cursor-1" } });
  s.state.pages.set("cursor-1", { nodes: [s.event], pageInfo: { hasNextPage: false, endCursor: "cursor-2" } });
  const capture = await readPullRequestMergeTarget(s.reader);
  assert.equal(capture.status, "known");
  assert.deepEqual(
    s.state.requests.map((request) => request.variables.after),
    [null, "cursor-1"],
  );
});

test("merge-target reader treats multiple event candidates as ambiguous in either arrival order", async () => {
  for (const reverse of [false, true]) {
    const s = mergeTargetFixture();
    const second = structuredClone(s.event);
    second.id = "ME_fixture_other";
    second.mergeRefName = "other-branch";
    s.state.pages.get(null).nodes = reverse ? [second, s.event] : [s.event, second];
    const capture = await readPullRequestMergeTarget(s.reader);
    assert.equal(capture.status, "unknown");
    assert.equal(capture.reason, "merge_event_ambiguous");
    assert.equal(capture.event, null);
  }
});

test("merge-target reader withholds an apparently valid first event when its scan exceeds the bound", async () => {
  const s = mergeTargetFixture();
  s.reader.maxPages = 1;
  s.state.pages.get(null).pageInfo = { hasNextPage: true, endCursor: "cursor-1" };
  const capture = await readPullRequestMergeTarget(s.reader);
  assert.equal(capture.status, "unknown");
  assert.equal(capture.reason, "merge_event_incomplete");
  assert.equal(capture.event, null);
  assert.equal(s.state.requests.length, 1);
});

test("merge-target reader rejects malformed pagination rather than treating it as complete", async () => {
  const s = mergeTargetFixture();
  s.state.pages.get(null).pageInfo = { hasNextPage: true, endCursor: null };
  await assert.rejects(readPullRequestMergeTarget(s.reader));
});

test("merge-target reader revalidates complete cached proof and every duplicate before ambiguity", async () => {
  for (const duplicate of [false, true]) {
    const s = mergeTargetFixture();
    assert.equal((await readPullRequestMergeTarget(s.reader)).status, "known");
    s.state.onLoad = (value) => {
      if (value?.complete && value.items?.length) {
        if (duplicate) value.items.push(structuredClone(value.items[0]));
        value.items.at(-1).sourceRevision = "unselected-revision";
      }
      return value;
    };
    await assert.rejects(readPullRequestMergeTarget(s.reader), /checkpoint_binding_mismatch/);
    assert.equal(s.state.requests.length, 1, "cached evidence must be validated without a replacement request");
  }
});

test("merge-target reader does not reuse a completed positive checkpoint for a new observation run", async () => {
  const s = mergeTargetFixture();
  assert.equal((await readPullRequestMergeTarget(s.reader)).status, "known");
  s.state.pages.get(null).nodes = [];
  const later = await readPullRequestMergeTarget({
    ...s.reader,
    observedAt: "2026-10-11T10:00:00.000Z",
    scanId: "synthetic-run-2",
  });
  assert.equal(later.reason, "merge_event_missing");
  assert.equal(s.state.requests.length, 2);
});

test("merge-target reader detaches its selected source before asynchronous transport", async () => {
  const s = mergeTargetFixture();
  s.state.onRead = async () => {
    s.reader.repository.id = 3;
    s.reader.repository.slug = "other/repository";
    s.reader.pullRequest.id = "PR_other";
    s.reader.sourceRevision = "different-revision";
  };
  const capture = await readPullRequestMergeTarget(s.reader);
  assert.deepEqual(capture.repository, { id: 2, slug });
  assert.equal(capture.pullRequest.id, "PR_fixture_10");
  assert.equal(capture.sourceRevision, observedAt);
  capture.event.mergeRefName = "mutated-return";
  const again = await readPullRequestMergeTarget({
    ...s.reader,
    repository: { id: 2, slug },
    pullRequest: { id: "PR_fixture_10", number: 10, url: `https://github.com/${slug}/pull/10` },
    sourceRevision: observedAt,
  });
  assert.equal(again.event.mergeRefName, "stack/topic");
});

test("merge-target reader propagates current authorization loss and authentication failures", async () => {
  const revoked = mergeTargetFixture();
  revoked.state.onRead = async () => {
    revoked.state.authorized = false;
  };
  await assert.rejects(readPullRequestMergeTarget(revoked.reader), /authorization-revoked/);
  const denied = mergeTargetFixture();
  denied.state.status = 401;
  await assert.rejects(readPullRequestMergeTarget(denied.reader), /authentication_required/);
});

test("merge-target source clocks reject unsupported precision and invalid calendar dates", () => {
  assert.equal(pullRequestMergeTargetSourceInstant("2026-10-07T10:00:00Z"), mergedAt);
  assert.equal(pullRequestMergeTargetSourceInstant("2026-10-07T10:00:00.01Z"), "2026-10-07T10:00:00.010Z");
  for (const value of ["2026-10-07T10:00:00.0001Z", "2026-10-07T10:00:00+00:00", "2026-02-30T10:00:00Z"])
    assert.equal(pullRequestMergeTargetSourceInstant(value), null, value);
});
