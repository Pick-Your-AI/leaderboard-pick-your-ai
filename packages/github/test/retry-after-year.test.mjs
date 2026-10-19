import assert from "node:assert/strict";
import test from "node:test";
import { classifyGithubFailure } from "../dist/index.js";

const now = new Date("2026-01-01T00:00:00.000Z");
const classify = (value, status = 429, extraHeaders = []) =>
  classifyGithubFailure({
    status,
    headers: new Map([["retry-after", value], ...extraHeaders]),
    now,
  });

for (const value of [
  "Sat, 01 Jan 0000 00:00:00 GMT",
  "Sat Jan  1 00:00:00 0000",
  "Mon, 01 Jan 0001 00:00:00 GMT",
  "Mon Jan  1 00:00:00 0001",
  "Sun, 01 Jan 1899 00:00:00 GMT",
  "Sun Jan  1 00:00:00 1899",
])
  test(`pre-1900 HTTP year ${JSON.stringify(value)} cannot supply a retry deadline`, () => {
    assert.equal(classify(value).retryAt, "2026-01-01T00:01:00.000Z");
    assert.equal(classify(value, 403).kind, "permission_denied");
    assert.equal(
      classify(value, 403, [
        ["x-ratelimit-remaining", "0"],
        ["x-ratelimit-reset", String((now.getTime() + 120000) / 1000)],
      ]).retryAt,
      "2026-01-01T00:02:00.000Z",
    );
  });

test("the valid 1900 HTTP year boundary retains its supplied past deadline", () => {
  for (const value of ["Mon, 01 Jan 1900 00:00:00 GMT", "Mon Jan  1 00:00:00 1900"])
    assert.equal(classify(value).retryAt, "1900-01-01T00:00:00.000Z");
});

test("an obsolete leap second beyond fifty years selects the past century", () => {
  for (const receivedAt of ["2026-12-31T23:59:59.000Z", "2026-12-31T23:59:59.999Z"])
    assert.equal(
      classifyGithubFailure({
        status: 429,
        headers: new Map([["retry-after", "Friday, 31-Dec-76 23:59:60 GMT"]]),
        now: new Date(receivedAt),
      }).retryAt,
      "1977-01-01T00:00:00.000Z",
      receivedAt,
    );
});

test("the obsolete leap-second weekday must match the selected past century", () => {
  const receivedAt = new Date("2026-12-31T23:59:59.000Z");
  const headers = new Map([["retry-after", "Thursday, 31-Dec-76 23:59:60 GMT"]]);
  assert.equal(classifyGithubFailure({ status: 429, headers, now: receivedAt }).retryAt, "2027-01-01T00:00:59.000Z");
  assert.equal(classifyGithubFailure({ status: 403, headers, now: receivedAt }).kind, "permission_denied");
});

test("ordinary and rounded leap-second instants exactly fifty years ahead remain valid", () => {
  for (const [value, receivedAt, expected] of [
    ["Thursday, 31-Dec-76 23:59:59 GMT", "2026-12-31T23:59:59.000Z", "2076-12-31T23:59:59.000Z"],
    ["Thursday, 31-Dec-76 23:59:60 GMT", "2027-01-01T00:00:00.000Z", "2077-01-01T00:00:00.000Z"],
  ])
    assert.equal(
      classifyGithubFailure({ status: 429, headers: new Map([["retry-after", value]]), now: new Date(receivedAt) })
        .retryAt,
      expected,
      value,
    );
});
