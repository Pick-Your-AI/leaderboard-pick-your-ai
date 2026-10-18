import assert from "node:assert/strict";
import test from "node:test";
import { WallCycleTracker, wallSoakPages } from "../soak/assertions.ts";
import { CycleCoverage } from "../soak/monitor.ts";
import { interruptionLimits, WallIntent } from "../soak/intent.ts";

const automatic = { visibility: "visible", controlState: "Automatic page boundaries · 20 seconds per page" };
const paused = { visibility: "visible", controlState: "Paused" };
const hidden = { visibility: "hidden", controlState: "Paused in background" };
const actors = [["a", "b"], ["c"], ["a", "b"], ["c", "d"], ["e"]];
const pageKeys = wallSoakPages.map((page) => `${page.view}:${page.page}`);

function observe(intent, cycles, coverage, elapsed, index, state = automatic) {
  const expectedAutomatic = intent.observe(elapsed, state);
  coverage.observe(elapsed, expectedAutomatic, pageKeys[index]);
  cycles.observe({
    elapsed,
    automatic: expectedAutomatic,
    snapshot: "synthetic-1",
    view: wallSoakPages[index].view,
    page: wallSoakPages[index].page,
    actorIDs: actors[index],
  });
}

test("an initial complete cycle cannot exempt an unsolicited persistent pause", () => {
  for (const label of ["Paused", "Paused while reading", "Paused for reduced motion", "Paused in background"])
    for (const nonempty of [true, false]) {
      const intent = new WallIntent(),
        cycles = new WallCycleTracker(),
        coverage = new CycleCoverage(pageKeys);
      for (let index = 0; index < 5; index++) observe(intent, cycles, coverage, index * 20_000, index);
      assert.equal(cycles.summary().completeCycles, 1);
      assert.equal(coverage.summary().completeWindows, 1);
      const state = { visibility: "visible", controlState: label, links: nonempty ? ["e"] : [] };
      assert.throws(() => observe(intent, cycles, coverage, 100_000, 4, state), /unsolicited hold/);
    }
});

test("a claimed automatic mode still has to complete fresh cycles and rolling page coverage", () => {
  const intent = new WallIntent(),
    cycles = new WallCycleTracker(),
    coverage = new CycleCoverage(pageKeys);
  for (let index = 0; index < 5; index++) observe(intent, cycles, coverage, index * 20_000, index);
  assert.throws(() => {
    for (let elapsed = 100_000; elapsed <= 300_000; elapsed += 15_000) observe(intent, cycles, coverage, elapsed, 4);
  }, /must keep visiting|must keep completing/);
});

test("spontaneous hidden or visible states cannot create a planned background exception", () => {
  const intent = new WallIntent();
  assert.throws(() => intent.observe(1, hidden), /planned tab state/);
  intent.begin("background", 2);
  assert.throws(() => intent.observe(3, automatic), /planned tab state/);
  assert.equal(intent.observe(4, hidden), false);
  intent.end("background", 5);
  assert.equal(intent.observe(6, automatic), true);
  assert.throws(() => intent.observe(7, hidden), /planned tab state/);
});

test("outage intent exempts progress only within its fixed lease and does not permit an unsolicited pause", () => {
  for (const kind of ["network", "source"]) {
    const intent = new WallIntent();
    intent.begin(kind, 0);
    assert.equal(intent.observe(1, automatic), false);
    assert.throws(() => intent.observe(2, paused), /unsolicited hold/);
    intent.end(kind, 3);
    assert.equal(intent.observe(4, automatic), true);
  }
});

test("only deliberate cursor and privacy actions permit the ordinary paused label", () => {
  for (const kind of ["suppression", "cursor", "revocation"]) {
    const intent = new WallIntent();
    intent.begin(kind, 0);
    assert.equal(intent.observe(1, { ...paused, controlState: "Paused · Rechecking controls…" }), false);
    assert.throws(() => intent.observe(2, automatic), /must match harness intent/);
    assert.throws(() => intent.observe(3, { ...paused, controlState: "Paused while reading" }), /unsolicited hold/);
    intent.end(kind, 4);
    assert.equal(intent.observe(5, automatic), true);
    assert.throws(() => intent.observe(6, paused), /unsolicited hold/);
  }
});

test("every finite planned lease rejects an overrun before observation or late completion can erase it", () => {
  for (const [kind, limit] of Object.entries(interruptionLimits)) {
    const state = kind === "background" ? hidden : ["network", "source"].includes(kind) ? automatic : paused;
    for (const end of [false, true]) {
      const intent = new WallIntent();
      intent.begin(kind, 100);
      assert.equal(intent.observe(100 + limit, state), false);
      assert.throws(
        () => (end ? intent.end(kind, 101 + limit) : intent.observe(101 + limit, state)),
        /exceeded its fixed real-time bound/,
      );
    }
  }
});

test("an eighteen-minute cursor hold starts new bounded coverage after its deliberate resume", () => {
  const intent = new WallIntent(),
    cycles = new WallCycleTracker(),
    coverage = new CycleCoverage(pageKeys);
  observe(intent, cycles, coverage, 0, 0);
  intent.begin("cursor", 20_000);
  observe(intent, cycles, coverage, 20_001, 1, paused);
  observe(intent, cycles, coverage, 18 * 60_000 + 20_000, 0, paused);
  intent.end("cursor", 18 * 60_000 + 20_001);
  for (let index = 0; index < 5; index++)
    observe(intent, cycles, coverage, 18 * 60_000 + 40_000 + index * 20_000, index);
  assert.equal(cycles.summary().completeCycles, 1);
  assert.equal(coverage.summary().completeWindows, 1);
  assert.equal(coverage.summary().automaticPeriods, 2);
});

test("unknown, overlapping, repeated and mismatched interruption grants fail closed", () => {
  const intent = new WallIntent();
  assert.throws(() => intent.begin("unknown", 0), /fixed scheduled/);
  assert.throws(() => intent.begin("__proto__", 1), /fixed scheduled/);
  intent.begin("network", 2);
  assert.throws(() => intent.begin("source", 3), /cannot overlap/);
  assert.throws(() => intent.end("source", 4), /matching planned/);
  intent.end("network", 5);
  assert.throws(() => intent.begin("network", 6), /repeated or renewed/);
});

test("malformed or backwards elapsed values cannot extend a lease", () => {
  for (const value of [NaN, Infinity, -Infinity, -1, false, "1"]) {
    const intent = new WallIntent();
    assert.throws(() => intent.begin("network", value), /finite monotonic/);
  }
  const intent = new WallIntent();
  intent.begin("cursor", 100);
  intent.observe(200, paused);
  assert.throws(() => intent.end("cursor", 199), /finite monotonic/);
});

test("matrix completion requires every intended interruption to finish exactly once", () => {
  for (const full of [false, true]) {
    const required = full ? Object.keys(interruptionLimits) : ["network", "background"];
    const intent = new WallIntent();
    assert.throws(() => intent.finish(0, full), /Every required/);
    let elapsed = 1;
    for (const kind of required) {
      intent.begin(kind, elapsed++);
      assert.throws(() => intent.finish(elapsed++, full), /Every planned interruption must finish/);
      intent.end(kind, elapsed++);
    }
    intent.finish(elapsed, full);
  }
});
