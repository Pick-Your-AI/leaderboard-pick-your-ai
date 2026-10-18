import assert from "node:assert/strict";

/** Classify the actual public API's string error envelope, never an invented shape. */
export function responseClassification(status: number, body: unknown): string {
  if (status < 400) return String(status);
  const error = body && typeof body === "object" && "error" in body ? body.error : null;
  return `${status}:${typeof error === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(error) ? error : "unknown"}`;
}

export const wallSoakPages = [
  { view: "PRs merged", page: "Page 1" },
  { view: "PRs merged", page: "Page 2" },
  { view: "Contributors in this scope", page: "Page 1" },
  { view: "Contributors in this scope", page: "Page 2" },
  { view: "Contributors in this scope", page: "Page 3" },
] as const;

interface Observation {
  elapsed: number;
  automatic: boolean;
  snapshot: string | null;
  view: string;
  page: string;
  actorIDs: string[];
}

interface Cycle {
  snapshot: string;
  lastIndex: number;
  pages: Map<number, Set<string>>;
  completed: boolean;
}

/**
 * Bounded observation of whole display cycles. A cycle starts at board page one,
 * keeps one publication, and visits every board/roll page. Missing a sampled page
 * cannot certify that cycle. Repeated refreshes of one page are not duplicates;
 * an actor on two different pages of the same view is. Board/roll overlap is valid.
 */
export class WallCycleTracker {
  private readonly maximumGap: number;
  private windowAnchor: number | null = null;
  private cycle: Cycle | null = null;
  private completeCycles = 0;
  private windows = 0;
  private longestGap = 0;

  constructor(maximumGap = 240_000) {
    assert(Number.isFinite(maximumGap) && maximumGap > 0);
    this.maximumGap = maximumGap;
  }

  /** Actual holds, hidden tabs and intentional outages start a new automatic window. */
  interrupt() {
    this.windowAnchor = null;
    this.cycle = null;
  }

  observe(value: Observation) {
    if (!value.automatic) {
      this.interrupt();
      return;
    }
    if (this.windowAnchor === null) {
      this.windowAnchor = value.elapsed;
      this.windows++;
    }
    const gap = value.elapsed - this.windowAnchor;
    assert(gap >= 0, "Cycle observations must use a monotonic elapsed clock");
    this.longestGap = Math.max(this.longestGap, gap);
    assert(gap < this.maximumGap, "A healthy automatic window must keep completing every board and roll page");
    if (!value.snapshot || value.actorIDs.length === 0) {
      // An incidental blank cannot certify a partial cycle or erase the deadline.
      this.cycle = null;
      return;
    }
    const index = wallSoakPages.findIndex((page) => page.view === value.view && page.page === value.page);
    assert(index >= 0, "An automatic page must belong to the configured synthetic cycle");
    const actors = new Set(value.actorIDs);
    assert.equal(actors.size, value.actorIDs.length, "Contributors must not be duplicated on a page");

    if (index === 0 && (!this.cycle || this.cycle.snapshot !== value.snapshot || this.cycle.lastIndex !== 0)) {
      this.cycle = { snapshot: value.snapshot, lastIndex: -1, pages: new Map(), completed: false };
    }
    const cycle = this.cycle;
    if (!cycle || cycle.snapshot !== value.snapshot || index < cycle.lastIndex) {
      // A recovery or missed transition can prevent observation of a whole cycle.
      // Wait for its next start, keeping the existing healthy-window deadline.
      this.cycle = null;
      return;
    }
    for (const [priorIndex, priorActors] of cycle.pages) {
      if (priorIndex === index || wallSoakPages[priorIndex]!.view !== value.view) continue;
      for (const actor of actors)
        assert(!priorActors.has(actor), "A contributor must not repeat across pages of one publication/view cycle");
    }
    cycle.pages.set(index, actors);
    cycle.lastIndex = index;
    if (index === wallSoakPages.length - 1 && cycle.pages.size === wallSoakPages.length && !cycle.completed) {
      cycle.completed = true;
      this.completeCycles++;
      this.windowAnchor = value.elapsed;
    }
  }

  summary() {
    return {
      completeCycles: this.completeCycles,
      automaticWindows: this.windows,
      maximumObservedGapMilliseconds: this.longestGap,
      maximumAllowedGapMilliseconds: this.maximumGap,
      currentCycleObservedPages: this.cycle?.pages.size ?? 0,
    };
  }
}
