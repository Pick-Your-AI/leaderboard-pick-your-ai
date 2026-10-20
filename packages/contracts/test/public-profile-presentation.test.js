import assert from "node:assert/strict";
import test from "node:test";
import {
  publicProfilePresentationVersion,
  publicProfilePresentationSchema,
  publicProfilePresentationMatches,
  safePublicGithubUrl,
} from "../dist/index.js";

const profile = (changes = {}) => ({
  schemaVersion: publicProfilePresentationVersion,
  actorId: "101",
  bio: "Synthetic 日本語 cafe\u0301 café 🧪 & plain text",
  highlights: ["https://github.com/synthetic/example/issues/1#issuecomment-2"],
  ...changes,
});
const actor = {
  schemaVersion: "leaderboard/v1",
  identityState: "resolved",
  githubDatabaseId: 101,
  githubNodeId: "SYNTHETIC_101",
  login: "synthetic-owner",
  kind: "user",
  executionMode: "unknown",
};

test("public presentation preserves exact bounded text and ordered links without mutating input", () => {
  const input = profile({ highlights: Array.from({ length: 6 }, (_, n) => `https://github.com/synthetic/repo/issues/${n}`) });
  Object.freeze(input.highlights);
  Object.freeze(input);
  const parsed = publicProfilePresentationSchema.parse(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.highlights, input.highlights);
  assert.equal(publicProfilePresentationSchema.safeParse(profile({ bio: "x".repeat(500) })).success, true);
  assert.equal(publicProfilePresentationSchema.safeParse(profile({ bio: "", highlights: [] })).success, true);
});

test("public presentation rejects unknown keys, unsafe text, noncanonical identity and any invalid link", () => {
  for (const changes of [
    { privateReceipt: "must never be projected" },
    { schemaVersion: "other/v1" },
    ...["0", "01", "101\n", " 101", "1e2", "x", "1".repeat(21)].map((actorId) => ({ actorId })),
    ...["<b>unsafe</b>", "safe\n", "safe\r", "safe\u0000", "safe\u007f", "x".repeat(501)].map((bio) => ({ bio })),
    { highlights: Array(7).fill("https://github.com/synthetic/repo") },
    ...[
      "javascript:alert(1)",
      "http://github.com/synthetic/repo",
      "https://github.com.evil.invalid/synthetic/repo",
      "https://name:password@github.com/synthetic/repo",
      "https://github.com:444/synthetic/repo",
      "https://github.com/synthetic/repo?private=marker",
      "https://github.com/synthetic/repo#unsupported",
      "https://github.com/synthetic/repo/%3Cunsafe%3E",
      " https://github.com/synthetic/repo ",
      "https://github.com/synthetic/repo/" + "a".repeat(2048),
    ].map((link) => ({ highlights: ["https://github.com/synthetic/repo", link] })),
  ]) {
    assert.equal(publicProfilePresentationSchema.safeParse(profile(changes)).success, false, JSON.stringify(changes));
  }
});

test("shared URL admission preserves the public reader's canonicalization and fragment boundaries", () => {
  for (const [input, expected] of [
    [null, null], [undefined, null], ["", null],
    [" HTTPS://GITHUB.COM:443/synthetic/repo ", "https://github.com/synthetic/repo"],
    ["https://github.com/synthetic/repo", "https://github.com/synthetic/repo"],
    ["https://github.com/synthetic/repo/", "https://github.com/synthetic/repo/"],
    ...["issuecomment-1", "pullrequestreview-2", "discussion_r3", "r4", "discussioncomment-5"].map((fragment) => {
      const url = `https://github.com/synthetic/repo/issues/1#${fragment}`;
      return [url, url];
    }),
    ["https://github.com/synthetic", null],
    ["https://github.com/synthetic/repo#readme", null],
    ["https://github.com/synthetic/repo?x=1", null],
    ["https://github.com:444/synthetic/repo", null],
  ]) assert.equal(safePublicGithubUrl(input), expected);
});

test("public presentation binds the selected numeric account and never a shared login or node alone", () => {
  assert.equal(publicProfilePresentationMatches(profile(), "101", actor), true);
  for (const [value, id, identity] of [
    [profile(), "102", actor],
    [profile({ actorId: "102" }), "101", actor],
    [profile(), "101", { ...actor, githubDatabaseId: 102 }],
    [profile(), "101", { ...actor, githubDatabaseId: undefined }],
    [profile(), "101", { ...actor, githubDatabaseId: Number.MAX_SAFE_INTEGER + 1 }],
    [profile(), "101", { ...actor, identityState: "unknown" }],
  ]) assert.equal(publicProfilePresentationMatches(value, id, identity), false);
});
