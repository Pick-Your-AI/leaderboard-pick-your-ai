import assert from "node:assert/strict";
import test from "node:test";
import { privateAttribution } from "../src/private-attribution.mjs";

const source = { subject_id: "PR_SYNTHETIC", family: "pull_requests", repository_id: "2" };
const assistance = { artifactId: source.subject_id, model: "Claude Opus", version: "5.5" };
const participation = {
  artifactId: source.subject_id,
  actorId: "101",
  role: "author",
  conservedUnit: `${source.subject_id}:merged`,
};
const output = () => ({
  actors: [{ id: "101" }],
  evidence: [],
  assistance: [structuredClone(assistance)],
  participation: [structuredClone(participation)],
});

test("private attribution projects only bounded artifact metadata and distinct participation", () => {
  const input = output();
  Object.assign(input.assistance[0], { email: "synthetic-model@example.invalid", actorId: "999", credit: 100 });
  Object.assign(input.participation[0], { email: "synthetic-user@example.invalid", executionMode: "manual" });
  assert.deepEqual(privateAttribution(input, source), { assistance: [assistance], participation: [participation] });
  assert.deepEqual(privateAttribution({ actors: [], evidence: [] }, source), { assistance: [], participation: [] });
  input.assistance[0].version = null;
  assert.equal(privateAttribution(input, source).assistance[0].version, null);
});

test("private attribution rejects unbound, malformed, email-bearing or excessive metadata", () => {
  for (const mutate of [
    (input) => (input.assistance = null),
    (input) => (input.assistance = {}),
    (input) => (input.assistance = Array(101).fill(assistance)),
    (input) => (input.assistance[0] = null),
    (input) => (input.assistance[0].artifactId = "PR_UNRELATED"),
    (input) => (input.assistance[0].model = " "),
    (input) => (input.assistance[0].model = "m".repeat(101)),
    (input) => (input.assistance[0].model = "synthetic-model@example.invalid"),
    (input) => (input.assistance[0].model = "Claude\nOpus"),
    (input) => (input.assistance[0].model = "Claude\u202eOpus"),
    (input) => (input.assistance[0].version = undefined),
    (input) => (input.assistance[0].version = 5.5),
    (input) => (input.assistance[0].version = "v".repeat(101)),
    (input) => (input.assistance[0].version = "synthetic-version@example.invalid"),
    (input) => (input.participation = null),
    (input) => (input.participation = Array(101).fill(participation)),
    (input) => (input.participation[0].artifactId = "PR_UNRELATED"),
    (input) => (input.participation[0].actorId = "999"),
    (input) => (input.participation[0].role = "merger"),
    (input) => (input.participation[0].conservedUnit = "unrelated-credit"),
  ]) {
    const input = output();
    mutate(input);
    assert.throws(() => privateAttribution(input, source), /invalid_private_attribution/);
  }
});

test("unranked commits retain source-bound metadata without inventing integration facts", () => {
  const sha = "a".repeat(40);
  const artifactId = `github:commit:2:${sha}`;
  const input = output();
  input.assistance[0].artifactId = artifactId;
  input.participation = [
    { ...participation, artifactId, conservedUnit: artifactId },
    { ...participation, artifactId, conservedUnit: artifactId, role: "committer" },
  ];
  const result = privateAttribution(input, { subject_id: sha, family: "commits", repository_id: "2" });
  assert.equal(result.assistance[0].artifactId, artifactId);
  assert.deepEqual(
    result.participation.map((entry) => entry.role),
    ["author", "committer"],
  );
  assert.deepEqual(Object.keys(result).sort(), ["assistance", "participation"]);
});
