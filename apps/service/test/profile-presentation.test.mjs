import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../dist/app.js";
import { projectRead, filterPublicActors } from "../dist/public-source.js";
import { readFixture, at, scope } from "../../../tests/fixtures/pending-metric.mjs";

const pin = "synthetic-pending-1";
const path = `/api/v1/contributors/101?snapshot=${pin}`;
const text = "Synthetic opted-in cafe\u0301 日本語 & plain text";
const presentation = {
  schemaVersion: "public-profile-presentation/v1",
  actorId: "101",
  bio: text,
  highlights: ["https://github.com/synthetic/repo/issues/1#issuecomment-2"],
};
function fixture() {
  const input = readFixture();
  for (const entry of input.selected.actors) entry.actor.githubDatabaseId = Number(entry.actorId);
  return input;
}
function service(t, capability = true) {
  const state = { input: fixture(), presentation: structuredClone(presentation) };
  const calls = [];
  const source = {
    async read(selectedScope, snapshotId, signal) {
      calls.push({ kind: "read", scope: structuredClone(selectedScope), snapshotId, aborted: signal.aborted });
      return structuredClone(state.input);
    },
    ...(capability
      ? {
          async readProfile(selectedScope, snapshotId, actorId, signal) {
            calls.push({
              kind: "profile",
              scope: structuredClone(selectedScope),
              snapshotId,
              actorId,
              aborted: signal.aborted,
            });
            const value = structuredClone(state.input);
            if (value !== null) value.presentation = structuredClone(state.presentation);
            return value;
          },
        }
      : {}),
  };
  const app = createService({ now: () => Date.parse(at), source });
  t.after(() => app.close());
  return { app, state, calls };
}

test("the anonymous profile selects one current presentation without adding personal text to directory reads", async (t) => {
  const h = service(t);
  const before = structuredClone(h.state);
  const response = await h.app.inject(path);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().presentation, presentation);
  assert.deepEqual(h.calls, [{ kind: "profile", scope, snapshotId: pin, actorId: "101", aborted: false }]);
  assert.deepEqual(h.state, before);
  assert.equal(response.headers["set-cookie"], undefined);
  const directory = await h.app.inject(`/api/v1/contributors?snapshot=${pin}`);
  assert.equal(directory.statusCode, 200, directory.body);
  assert.equal(h.calls.at(-1).kind, "read");
  assert.doesNotMatch(directory.body, /Synthetic opted-in|profile-presentation\/v1|issuecomment-2/);
  // The legacy source still returns the same contribution profile, with no optional text.
  const legacy = service(t, false);
  const older = await legacy.app.inject(path);
  assert.equal(older.statusCode, 200, older.body);
  const actual = response.json();
  actual.presentation = null;
  assert.deepEqual(older.json(), actual);
  assert.deepEqual(
    legacy.calls.map((entry) => entry.kind),
    ["read"],
  );
});

test("a malformed present field or foreign numeric account fails with a fixed response and no private input", async (t) => {
  const h = service(t);
  const variants = [
    () => {
      h.state.presentation = undefined;
    },
    () => {
      h.state.presentation.privateReceipt = "PRIVATE_INPUT_MARKER";
    },
    () => {
      h.state.presentation.bio = "PRIVATE_INPUT_MARKER\n";
    },
    () => {
      h.state.presentation.highlights = ["https://github.com/synthetic/repo?PRIVATE_INPUT_MARKER=1"];
    },
    () => {
      h.state.presentation.actorId = "102";
    },
    () => {
      h.state.input.selected.actors[0].actor.githubDatabaseId = 102;
    },
    () => {
      delete h.state.input.selected.actors[0].actor.githubDatabaseId;
    },
    () => {
      h.state.input.selected.actors[0].actor.identityState = "unknown";
    },
  ];
  for (const change of variants) {
    h.state.input = fixture();
    h.state.presentation = structuredClone(presentation);
    change();
    const before = structuredClone(h.state);
    const response = await h.app.inject(path);
    assert.equal(response.statusCode, 503, response.body);
    assert.match(response.body, /public_projection_unavailable/);
    assert.doesNotMatch(response.body, /PRIVATE_INPUT_MARKER|Synthetic opted-in|issuecomment-2/);
    assert.deepEqual(h.state, before);
  }
});

test("current suppression and every nonpublic identity state remove the presentation with the actor", async (t) => {
  const h = service(t);
  for (const state of [
    "hidden",
    "deleted",
    "unlinked",
    "suppressed",
    "identity:unresolved",
    "identity:deleted",
    "identity:suspended",
    "identity:unavailable",
  ]) {
    h.state.input = fixture();
    if (state === "suppressed") h.state.input.controls.suppressedActorIds = ["101"];
    else if (state.startsWith("identity:")) h.state.input.selected.actors[0].actor.identityState = state.slice(9);
    else h.state.input.selected.actors[0].state = state;
    const before = structuredClone(h.state);
    const response = await h.app.inject(path);
    assert.equal(response.statusCode, 404, `${state}: ${response.body}`);
    assert.match(response.body, /profile_unavailable/);
    assert.doesNotMatch(response.body, /Synthetic opted-in|issuecomment-2/);
    assert.deepEqual(h.state, before);
  }
});

test("actor filtering drops the optional projection and a detached projection cannot mutate its provider", () => {
  const input = fixture();
  input.presentation = structuredClone(presentation);
  const before = structuredClone(input);
  const projected = projectRead(input, scope, pin);
  assert.deepEqual(projected.presentation, presentation);
  assert.equal(filterPublicActors(projected, "automation").presentation, null);
  assert.deepEqual(filterPublicActors(projected, "user").presentation, presentation);
  projected.presentation.highlights.push("https://github.com/synthetic/another-repo");
  projected.presentation.bio = "Changed only in the detached result";
  assert.deepEqual(input, before);
});

test("a historical pin and old ETag cannot preserve newly private text or hide source unavailability", async (t) => {
  const h = service(t);
  const first = await h.app.inject(path);
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json().presentation, presentation);
  assert.ok(first.headers.etag);
  h.state.presentation = null;
  h.state.input.controls.version = "synthetic-current-opt-out";
  const privateRead = await h.app.inject({ url: path, headers: { "if-none-match": first.headers.etag } });
  assert.equal(privateRead.statusCode, 200, privateRead.body);
  assert.equal(privateRead.json().snapshotId, pin);
  assert.equal(privateRead.json().presentation, null);
  assert.notEqual(privateRead.headers.etag, first.headers.etag);
  assert.doesNotMatch(privateRead.body, /Synthetic opted-in|issuecomment-2/);
  h.state.input = null;
  const unavailable = await h.app.inject({ url: path, headers: { "if-none-match": first.headers.etag } });
  assert.equal(unavailable.statusCode, 410);
  assert.doesNotMatch(unavailable.body, /Synthetic opted-in|issuecomment-2/);
});
