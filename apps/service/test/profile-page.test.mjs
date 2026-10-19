import assert from "node:assert/strict";
import test from "node:test";
import { profilePage, profileResponseByteLimit } from "../dist/profile-page.js";

const proof = (id, content = "") => ({ contribution: { contributionId: id }, content });
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

test("profile paging budgets its fixed envelope and actual multibyte cursor at the exact ceiling", () => {
  const evidence = [proof("one", "界".repeat(100)), proof("two", "é".repeat(100)), proof("three")];
  const cursor = (offset) => `synthetic-cursor-${offset}${"界".repeat(500)}`;
  const base = profilePage(evidence, 0, 2, { padding: "" }, cursor);
  const exactEnvelope = { padding: "x".repeat(profileResponseByteLimit - bytes(base)) };
  const exact = profilePage(evidence, 0, 2, exactEnvelope, cursor);
  assert.equal(bytes(exact), profileResponseByteLimit);
  assert.equal(exact.timeline.length, 2);
  assert.equal(exact.nextCursor, cursor(2));
  const above = profilePage(evidence, 0, 2, { padding: `${exactEnvelope.padding}x` }, cursor);
  assert.equal(above.timeline.length, 1);
  assert.equal(above.nextCursor, cursor(1));
  assert.ok(bytes(above) < profileResponseByteLimit);
});

test("profile paging evaluates a smaller final null cursor and retains an empty complete envelope", () => {
  const evidence = [proof("one"), proof("two")];
  const cursor = () => "x".repeat(profileResponseByteLimit);
  const result = profilePage(evidence, 0, 2, { retained: "metadata" }, cursor);
  assert.equal(result.timeline.length, 2);
  assert.equal(result.nextCursor, null);
  assert.equal(result.timelineTruncated, false);
  assert.deepEqual(profilePage([], 0, 50, { retained: "metadata" }, cursor), {
    retained: "metadata",
    timeline: [],
    nextCursor: null,
    timelineTruncated: false,
    evidenceIds: [],
  });
});

test("a profile item or fixed envelope that cannot fit is rejected without a partial receipt", () => {
  for (const [evidence, envelope] of [
    [[proof("one", "x".repeat(profileResponseByteLimit))], { retained: "metadata" }],
    [[], { metadata: "x".repeat(profileResponseByteLimit) }],
  ])
    assert.throws(() => profilePage(evidence, 0, 100, envelope, () => "cursor"), {
      status: 503,
      code: "profile_response_too_large",
    });
});
