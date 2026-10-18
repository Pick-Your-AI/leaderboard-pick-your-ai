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
