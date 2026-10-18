import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../dist/app.js";
import { projectRead } from "../dist/public-source.js";
import { readFixture, at } from "../../../tests/fixtures/pending-metric.mjs";

// Synthetic provider contradictions only; no real actor or source acceptance.
function contradictory(input, mutate, first = false) {
  const copy = structuredClone(input.selected.actors[0]);
  mutate(copy);
  if (first) input.selected.actors.unshift(copy);
  else input.selected.actors.push(copy);
}

for (const state of ["hidden", "deleted", "unlinked"]) {
  test(`a ${state} duplicate cannot be discarded to publish the same actor ID`, () => {
    for (const first of [false, true]) {
      const input = readFixture();
      contradictory(input, (actor) => (actor.state = state), first);
      assert.throws(() => projectRead(input, input.selected.scope, null), {
        status: 503,
        code: "public_projection_unavailable",
      });
    }
  });
}

for (const identityState of ["unresolved", "deleted", "suspended", "unavailable"]) {
  test(`an identity-state ${identityState} duplicate cannot be discarded to publish a resolved actor ID`, () => {
    for (const first of [false, true]) {
      const input = readFixture();
      contradictory(input, (actor) => (actor.actor.identityState = identityState), first);
      assert.throws(() => projectRead(input, input.selected.scope, null), {
        status: 503,
        code: "public_projection_unavailable",
      });
    }
  });
}

test("current and pinned conditional reads reject contradictory actors across public routes", async (t) => {
  const input = readFixture();
  const app = createService({
    now: () => Date.parse(at),
    source: {
      async read() {
        return structuredClone(input);
      },
    },
  });
  t.after(() => app.close());
  const actorId = input.selected.actors[0].actorId;
  const proofId = input.selected.evidence[0].contribution.contributionId;
  const paths = [
    "/api/v1/boards?metric=pr_merged",
    "/api/v1/contributors",
    `/api/v1/contributors/${actorId}`,
    `/api/v1/evidence/${proofId}`,
    "/api/v1/exports?metric=pr_merged&format=json",
    "/api/v1/exports?metric=pr_merged&format=csv",
    "/api/v1/health",
    "/api/v1/updates",
  ];
  const previous = new Map();
  for (const path of paths) {
    const response = await app.inject(path);
    assert.equal(response.statusCode, 200, path);
    previous.set(path, response.headers.etag);
  }
  contradictory(input, (actor) => (actor.state = "hidden"));
  for (const path of paths) {
    // Update notices intentionally accept current scope only; all other routes
    // must also reject a pinned conditional response after the contradiction.
    for (const pin of path === "/api/v1/updates" ? [false] : [false, true]) {
      const url = pin ? `${path}${path.includes("?") ? "&" : "?"}snapshot=${input.head.snapshotId}` : path;
      const response = await app.inject({
        url,
        headers: previous.get(path) ? { "if-none-match": previous.get(path) } : {},
      });
      assert.equal(response.statusCode, 503, url);
      assert.deepEqual(response.json(), { error: "public_projection_unavailable" });
      assert.equal(response.headers["cache-control"], "no-store");
    }
  }
});

test("unique non-public actors remain suppressed without withholding unrelated contributors", () => {
  for (const mutate of [
    (actor) => (actor.state = "hidden"),
    (actor) => (actor.state = "deleted"),
    (actor) => (actor.state = "unlinked"),
    (actor) => (actor.actor.identityState = "suspended"),
  ]) {
    const input = readFixture();
    const hiddenId = input.selected.actors[0].actorId;
    const retainedId = input.selected.actors[1].actorId;
    mutate(input.selected.actors[0]);
    const projected = projectRead(input, input.selected.scope, null);
    assert.deepEqual(
      projected.selected.actors.map((actor) => actor.actorId),
      [retainedId],
    );
    assert.ok(projected.selected.rows.length > 0);
    assert.ok(projected.selected.rows.every((row) => row.actorId !== hiddenId));
    assert.ok(projected.selected.evidence.every((entry) => entry.contribution.actorId !== hiddenId));
    assert.ok((projected.selected.pendingEvidence ?? []).every((entry) => entry.contribution.actorId !== hiddenId));
  }
});
