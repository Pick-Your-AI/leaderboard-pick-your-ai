import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { basename, join } from "node:path";
import { responseClassification } from "./assertions.ts";

/** Keep every invocation separate, including retries after an interrupted test. */
export async function createAttempt(projectRoot: string) {
  // Playwright deletes its configured output directories at each normal start.
  // Receipts are siblings of both wall-soak and browser runner output, never children.
  const parent = join(projectRoot, "test-results", "wall-soak-attempts");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "attempt-"));
  return { id: basename(directory), directory };
}

/** The public service error contract is { error: string }, not a nested object. */
export function responseKey(response: { statusCode: number; body: string }): string {
  const status = String(response.statusCode);
  if (response.statusCode < 400) return status;
  try {
    return responseClassification(response.statusCode, JSON.parse(response.body));
  } catch {
    // Unexpected bodies remain bounded counters; never retain response payloads.
  }
  return `${status}:unknown`;
}

export function fixturePages(
  stages: readonly { heading: string; actors: readonly string[] }[],
  suppressedActor: string | null = null,
) {
  const pages = new Map<string, string[]>();
  for (const stage of stages) {
    assert.equal(new Set(stage.actors).size, stage.actors.length, "Fixture actors are unique within each stage");
    const actors = stage.actors.filter((id) => id !== suppressedActor);
    for (let offset = 0; offset < actors.length; offset += 6)
      pages.set(`${stage.heading}:Page ${offset / 6 + 1}`, actors.slice(offset, offset + 6));
  }
  return pages;
}

/** Exact fixture membership also rejects an actor repeated from an earlier page. */
export function assertPageActors(pages: ReadonlyMap<string, readonly string[]>, identity: string, ids: string[]) {
  const expected = pages.get(identity);
  assert(expected, `Unexpected displayed page: ${identity}`);
  assert.deepEqual(ids, expected, `Displayed actors must match the complete fixture page: ${identity}`);
}

/** Require fresh coverage throughout each uninterrupted automatic period. */
export class CycleCoverage {
  private readonly required: Set<string>;
  private readonly maximumAbsenceMs: number;
  private activeSince: number | null = null;
  private readonly lastSeen = new Map<string, number>();
  private readonly window = new Set<string>();
  private completeWindows = 0;
  private automaticPeriods = 0;

  constructor(required: Iterable<string>, maximumAbsenceMs = 180_000) {
    this.required = new Set(required);
    assert(this.required.size > 0);
    this.maximumAbsenceMs = maximumAbsenceMs;
  }

  reset() {
    this.activeSince = null;
    this.lastSeen.clear();
    this.window.clear();
  }

  observe(now: number, automatic: boolean, identity: string | null) {
    if (!automatic) {
      this.reset();
      return;
    }
    if (identity !== null) assert(this.required.has(identity), `Unexpected automatic page: ${identity}`);
    if (this.activeSince === null) {
      this.activeSince = now;
      this.automaticPeriods++;
    }
    // Check before updating: a late return must not erase an already excessive gap.
    for (const page of this.required)
      assert(
        now - (this.lastSeen.get(page) ?? this.activeSince) <= this.maximumAbsenceMs,
        `Every healthy automatic cycle must keep visiting ${page} within three real minutes`,
      );
    if (identity !== null) {
      this.lastSeen.set(identity, now);
      this.window.add(identity);
    }
    if (this.window.size === this.required.size) {
      this.completeWindows++;
      this.window.clear();
    }
  }

  summary() {
    return {
      automaticPeriods: this.automaticPeriods,
      completeWindows: this.completeWindows,
      requiredPages: [...this.required],
      maximumPageAbsenceMilliseconds: this.maximumAbsenceMs,
      lastSeenMilliseconds: Object.fromEntries(this.lastSeen),
    };
  }
}
