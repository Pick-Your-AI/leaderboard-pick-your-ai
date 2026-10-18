import assert from "node:assert/strict";

// These leases belong to the fixed harness actions. They cannot be granted or
// renewed by a product label, a blank page, an error response or a hidden tab.
// Short action bounds include the action's existing sequential UI waits; only
// the deliberately held cursor has an eighteen-minute observation interval.
export const interruptionLimits = Object.freeze({
  network: 90_000,
  source: 120_000,
  suppression: 210_000,
  cursor: 19 * 60_000,
  revocation: 240_000,
  background: 210_000,
});

export type WallInterruption = keyof typeof interruptionLimits;

interface Interruption {
  kind: WallInterruption;
  startedElapsedMilliseconds: number;
  maximumMilliseconds: number;
}

/** Require observed operation to match the harness's independently owned intent. */
export class WallIntent {
  private active: Interruption | null = null;
  private readonly used = new Set<WallInterruption>();
  private lastElapsed = 0;

  private check(elapsed: number) {
    assert(
      typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed >= this.lastElapsed,
      "Harness intent requires a finite monotonic elapsed clock",
    );
    this.lastElapsed = elapsed;
    if (this.active)
      assert(
        elapsed - this.active.startedElapsedMilliseconds <= this.active.maximumMilliseconds,
        `Planned ${this.active.kind} interruption exceeded its fixed real-time bound`,
      );
  }

  begin(kind: WallInterruption, elapsed: number) {
    this.check(elapsed);
    assert(Object.hasOwn(interruptionLimits, kind), "Only a fixed scheduled interruption may suspend progress");
    assert.equal(this.active, null, "Planned interruption leases cannot overlap");
    assert(!this.used.has(kind), "A planned interruption lease cannot be repeated or renewed");
    this.used.add(kind);
    this.active = {
      kind,
      startedElapsedMilliseconds: elapsed,
      maximumMilliseconds: interruptionLimits[kind],
    };
    return this.summary();
  }

  end(kind: WallInterruption, elapsed: number) {
    // Check the original deadline before clearing it: a late resume cannot erase
    // the unobserved or unexpectedly long part of an intended hold.
    this.check(elapsed);
    assert.equal(this.active?.kind, kind, "Only the matching planned interruption can finish");
    this.active = null;
  }

  observe(elapsed: number, state: { visibility: string; controlState: string }) {
    this.check(elapsed);
    const hidden = this.active?.kind === "background";
    assert.equal(
      state.visibility,
      hidden ? "hidden" : "visible",
      "The wall visibility must match the harness's planned tab state",
    );
    const paused =
      this.active?.kind === "suppression" || this.active?.kind === "cursor" || this.active?.kind === "revocation";
    const expected = hidden ? "Paused in background" : paused ? "Paused" : "Automatic page boundaries";
    assert.equal(
      state.controlState.split(" · ")[0],
      expected,
      "The wall mode must match harness intent; an unsolicited hold cannot suspend progress checks",
    );
    // The observed label is asserted, never used to decide whether to monitor
    // progress. Deliberate network/source faults retain an automatic UI intent.
    return this.active === null;
  }

  finish(elapsed: number, full: boolean) {
    this.check(elapsed);
    assert.equal(this.active, null, "Every planned interruption must finish before the matrix can pass");
    const expected = full ? Object.keys(interruptionLimits) : ["network", "background"];
    assert.deepEqual([...this.used].sort(), expected.sort(), "Every required planned interruption must execute once");
  }

  summary() {
    return this.active ? { ...this.active } : null;
  }
}
