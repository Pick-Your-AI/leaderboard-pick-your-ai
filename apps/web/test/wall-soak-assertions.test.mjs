import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../../service/dist/app.js";
import { at, snapshot } from "../browser/wallFixture.ts";
import { responseClassification, WallCycleTracker, wallSoakPages } from "../soak/assertions.ts";

const ids = [["a", "b"], ["c"], ["a", "b"], ["c", "d"], ["e"]];
function observe(tracker, index, elapsed, changes = {}) {
  tracker.observe({
    elapsed,
    automatic: true,
    snapshot: "synthetic-1",
    ...wallSoakPages[index],
    actorIDs: ids[index],
    ...changes,
  });
}

test("the actual expired-cursor error increments the soak's exact expiry category", async (t) => {
  let now = Date.parse(at);
  const data = snapshot();
  const app = createService({
    now: () => now,
    cursorSecret: "synthetic-soak-error-contract-test-0001",
    source: {
      async read(scope, pin) {
        if (pin && pin !== data.head.snapshotId) return null;
        const value = structuredClone(data);
        value.selected.scope = { ...scope };
        return value;
      },
    },
  });
  t.after(() => app.close());
  const url = "/api/v1/boards?metric=pr_merged&limit=6";
  const first = await app.inject(url);
  assert.equal(first.statusCode, 200, first.body);
  const cursor = first.json().nextCursor;
  assert.ok(cursor);
  now += 16 * 60_000;
  const expired = await app.inject(`${url}&cursor=${encodeURIComponent(cursor)}`);
  assert.equal(expired.statusCode, 410);
  assert.equal(responseClassification(expired.statusCode, expired.json()), "410:cursor_expired_refetch");
  assert.equal(responseClassification(first.statusCode, first.json()), "200");
});

test("unknown error envelopes remain unknown instead of inventing a classified response", () => {
  for (const body of [null, "cursor_expired_refetch", {}, { error: { code: "cursor_expired_refetch" } }])
    assert.equal(responseClassification(410, body), "410:unknown");
});

test("same-page refresh is valid but an actor repeated on the following page fails", () => {
  const tracker = new WallCycleTracker();
  observe(tracker, 0, 0);
  observe(tracker, 0, 5_000);
  assert.throws(() => observe(tracker, 1, 20_000, { actorIDs: ["b", "c"] }), /repeat across pages/);
});

test("board and roll overlap is valid and complete cycles continue at the same publication", () => {
  const tracker = new WallCycleTracker();
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let index = 0; index < wallSoakPages.length; index++)
      observe(tracker, index, cycle * 100_000 + index * 20_000);
    observe(tracker, 4, cycle * 100_000 + 85_000);
    assert.equal(tracker.summary().completeCycles, cycle + 1);
  }
  assert.equal(tracker.summary().currentCycleObservedPages, 5);
});

test("an initial good cycle cannot hide later alternation between only two pages", () => {
  const tracker = new WallCycleTracker();
  for (let index = 0; index < wallSoakPages.length; index++) observe(tracker, index, index * 20_000);
  for (let elapsed = 100_000; elapsed < 320_000; elapsed += 20_000)
    observe(tracker, ((elapsed - 100_000) / 20_000) % 2, elapsed);
  assert.equal(tracker.summary().completeCycles, 1);
  assert.throws(() => observe(tracker, 1, 320_000), /must keep completing every board and roll page/);
});

test("replacing the publication without traversing pages cannot reset the full-cycle deadline", () => {
  const tracker = new WallCycleTracker();
  for (let elapsed = 0; elapsed < 240_000; elapsed += 60_000)
    observe(tracker, 0, elapsed, { snapshot: `synthetic-${elapsed}` });
  assert.throws(() => observe(tracker, 0, 240_000, { snapshot: "synthetic-new" }), /must keep completing/);
  assert.equal(tracker.summary().completeCycles, 0);
});

test("a planned hold resets partial observations and requires a new complete cycle after resume", () => {
  const tracker = new WallCycleTracker();
  observe(tracker, 0, 0);
  observe(tracker, 1, 20_000);
  tracker.interrupt();
  for (let index = 2; index < wallSoakPages.length; index++) observe(tracker, index, 3_600_000 + index * 20_000);
  assert.equal(tracker.summary().completeCycles, 0);
  for (let index = 0; index < wallSoakPages.length; index++) observe(tracker, index, 3_700_000 + index * 20_000);
  assert.equal(tracker.summary().completeCycles, 1);
  assert.equal(tracker.summary().automaticWindows, 2);
});

test("a missed page or pages from different publications cannot certify a complete cycle", () => {
  for (const changedPublication of [false, true]) {
    const tracker = new WallCycleTracker();
    for (let index = 0; index < wallSoakPages.length; index++) {
      if (!changedPublication && index === 2) continue;
      observe(tracker, index, index * 20_000, {
        snapshot: changedPublication && index > 1 ? "synthetic-2" : "synthetic-1",
      });
    }
    assert.equal(tracker.summary().completeCycles, 0);
  }
});

test("observed inactive or empty states start a fresh recovery window without retaining page identities", () => {
  for (const changes of [{ automatic: false }, { actorIDs: [] }, { snapshot: null }]) {
    const tracker = new WallCycleTracker();
    observe(tracker, 0, 0);
    observe(tracker, 1, 20_000, changes);
    for (let index = 0; index < wallSoakPages.length; index++) observe(tracker, index, 3_600_000 + index * 20_000);
    assert.equal(tracker.summary().completeCycles, 1);
    assert.equal(tracker.summary().automaticWindows, 2);
  }
});
