import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { auditFrozenSoak, frozenSoakProfile, frozenSoakSchedule } from "../soak/chronology.ts";
import { WallCycleTracker } from "../soak/assertions.ts";
import { CycleCoverage, fixturePages } from "../soak/monitor.ts";
import { requireSoakMidnightWindow } from "../soak/midnight.ts";

// Entirely synthetic retained records. The fixture never sleeps, executes a
// browser or claims actual elapsed-time evidence. UTC values drive the reader.
const START = Date.parse("2026-10-18T08:19:06.473Z");
const MINUTE = 60_000;
const DURATION = 480 * MINUTE;
const ID = "attempt-fixture1";
const at = (elapsed) => new Date(START + elapsed).toISOString();
const stages = [
  { heading: "PRs merged", actors: Array.from({ length: 12 }, (_, i) => `wall-${String(i + 1).padStart(2, "0")}`) },
  {
    heading: "Contributors in this scope",
    actors: Array.from({ length: 15 }, (_, i) => `wall-${String(i + 1).padStart(2, "0")}`),
  },
];
const keys = [...fixturePages(stages).keys()];
const INITIAL_RESOURCE = { heap: 4_000_000, nodeHeap: 80_000_000, rss: 220_000_000, nodes: 154, listeners: 166 };

function fixture() {
  const start = {
    head: frozenSoakProfile.head,
    tree: frozenSoakProfile.tree,
    status: "",
    requestedMinutes: 480,
    fullMatrix: true,
    browser: "155.0.8059.84",
    executableSha256: "b".repeat(64),
    browserSelection: "explicit executable override",
    node: "v24.19.0",
    clocks: "real; no installed clock or time advancement",
  };
  const events = [{ attemptId: ID, at: at(0), event: "start", detail: start }];
  const samples = [];
  const actionTimes = new Map();
  let actionIndex = 0,
    loop = 1,
    lastCollection = null,
    cursorPin = null,
    ordinal = 0;
  const coverage = new CycleCoverage(keys),
    cycles = new WallCycleTracker();
  const publications = new Map();
  while (loop < DURATION) {
    const actions = [];
    let actionDelay = 0;
    while (actionIndex < frozenSoakSchedule.length && frozenSoakSchedule[actionIndex].minute * MINUTE <= loop) {
      const action = frozenSoakSchedule[actionIndex++];
      // An actual positive timing control: suppression takes 32 seconds between
      // loop top and its completed action. Its stale elapsed field stays intact.
      actionDelay += action.name === "current-suppression" ? 32_000 : 20;
      actionTimes.set(action.name, loop + actionDelay);
      events.push({ attemptId: ID, at: at(loop + actionDelay), event: action.name, detail: null });
      actions.push(action.name);
    }
    const capture = loop + actionDelay + 5;
    const happened = (name) => actionTimes.has(name);
    const hidden = happened("real-tab-background") && !happened("real-tab-foreground");
    const held = happened("hold-real-cursor") && !happened("natural-cursor-expiry-recovery");
    const network = happened("network-loss") && !happened("network-cleared-display");
    const source = happened("source-exception") && !happened("source-cleared-display");
    const suppressed = happened("current-suppression");
    const automatic = !hidden && !held && !network && !source;
    if (actions.some((name) => ["current-suppression", "revoke-held-snapshot"].includes(name))) {
      coverage.reset();
      cycles.interrupt();
    }
    const pageIndex = held
      ? capture < 136 * MINUTE
        ? 1
        : 0
      : actions.includes("natural-cursor-expiry-recovery")
        ? 0
        : Math.floor(capture / 20_000) % 5;
    const [heading, page] = keys[pageIndex].split(":");
    const expected = fixturePages(stages, suppressed ? "wall-03" : null).get(keys[pageIndex]);
    const ids = hidden || network || source ? [] : [...expected];
    let pin = `wall-soak-${Math.floor(capture / 100_000) + 1}`;
    if (held) cursorPin ??= pin;
    if (held || actions.includes("natural-cursor-expiry-recovery")) pin = cursorPin;
    if (!publications.has(pin)) publications.set(pin, at(Math.floor(capture / 100_000) * 100_000));
    const generated = ids.length ? publications.get(pin) : null;
    const timezone = happened("change-display-timezone") ? "Pacific/Kiritimati" : "Pacific/Honolulu";
    const count = stages
      .find((entry) => entry.heading === heading)
      .actors.filter((id) => !suppressed || id !== "wall-03").length;
    const collect = lastCollection === null ? loop >= 600_000 : loop - lastCollection >= 3_600_000;
    if (collect) lastCollection = loop;
    coverage.observe(capture, automatic, ids.length ? keys[pageIndex] : null);
    cycles.observe({
      elapsed: capture,
      automatic,
      snapshot: ids.length ? pin : null,
      view: heading,
      page,
      actorIDs: ids,
    });
    samples.push({
      attemptId: ID,
      at: at(capture + 1),
      elapsedMilliseconds: loop,
      utc: at(capture),
      visibility: hidden ? "hidden" : "visible",
      localDay: new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(START + capture),
      timezone,
      page: `${page} · ${count} ${heading === "PRs merged" ? "contributor rows" : "contributors"}`,
      heading,
      health:
        happened("real-stale-source") && !happened("fresh-source-recovery")
          ? "STALE OR DEGRADED DATA"
          : "Recently reconciled",
      error: network || source ? "Synthetic unavailable" : "",
      snapshot: ids.length ? pin : null,
      controlState: hidden
        ? "Paused in background"
        : held
          ? "Paused"
          : "Automatic page boundaries · 20 seconds per page",
      generated,
      renderedTime: generated,
      links: ids.map((id) => ({ id, pin })),
      values: heading === "PRs merged" ? ids.map((id) => (Number(id.slice(5)) <= 7 ? "5" : "1")) : [],
      scopeFits: true,
      controlsFit: true,
      overflow: false,
      resource: collect ? structuredClone(INITIAL_RESOURCE) : null,
      requestCount: ++ordinal * 4,
      retainedSnapshots: Math.min(16, Math.floor(capture / 120_000) + 1),
      cycles: cycles.summary(),
      cycleCoverage: coverage.summary(),
    });
    loop = capture + 1 + 15_000;
  }
  const finalResourceAt = DURATION + 100;
  const bodyEnd = DURATION + 200;
  const finish = DURATION + 500;
  events.push({
    attemptId: ID,
    at: at(finalResourceAt),
    event: "final-resources",
    detail: structuredClone(INITIAL_RESOURCE),
  });
  events.push({
    attemptId: ID,
    at: at(bodyEnd + 1),
    event: "matrix-end",
    detail: {
      matrixResult: "completed-full-real-duration-matrix",
      elapsedMilliseconds: bodyEnd,
      acceptance: "pending-owned-cleanup",
    },
  });
  events.push({
    attemptId: ID,
    at: at(finish),
    event: "attempt-end",
    detail: { result: "completed-full-real-duration-matrix", testStatus: "passed" },
  });
  const buildFiles = [
    "packages/contracts/dist/index.js",
    "packages/metrics/dist/index.js",
    "apps/service/dist/app.js",
    "apps/web/dist/index.html",
  ].map((path) => ({ path, bytes: 1, sha256: "a".repeat(64) }));
  const buildHash = createHash("sha256").update(JSON.stringify(buildFiles)).digest("hex");
  const summary = {
    attemptId: ID,
    result: "completed-full-real-duration-matrix",
    matrixResult: "completed-full-real-duration-matrix",
    failure: null,
    startedAt: at(0),
    endedAt: at(bodyEnd),
    requestedMinutes: 480,
    elapsedMilliseconds: bodyEnd,
    fullMatrix: true,
    input: { head: start.head, tree: start.tree, status: "" },
    compiledOutputsSha256: buildHash,
    browser: start.browser,
    executableSha256: start.executableSha256,
    browserSelection: start.browserSelection,
    node: start.node,
    checks: Object.fromEntries(
      [
        "networkCleared",
        "networkRecovered",
        "sourceCleared",
        "sourceRecovered",
        "suppressionApplied",
        "realCursorExpired",
        "realBackgroundCleared",
        "realForegroundRecovered",
        "revocationRecovered",
        "fourK",
        "deviceScale",
        "sourceStale",
        "sourceFreshAgain",
        "timezoneChanged",
      ].map((name) => [name, true]),
    ),
    completed: frozenSoakSchedule.map((action) => action.name),
    naturalRollover: true,
    sampleCount: samples.length,
    pagesSeen: [...keys],
    cycleCoverage: samples.at(-1).cycleCoverage,
    cycles: samples.at(-1).cycles,
    counters: {
      requests: ordinal * 4 + 2,
      bytes: 123_000,
      concurrent: 0,
      maxConcurrent: 2,
      networkAborts: 1,
      responses: { 200: ordinal * 4, "410:cursor_expired_refetch": 1 },
    },
    baseline: structuredClone(INITIAL_RESOURCE),
    maxRetainedGrowth: { heap: 0, nodeHeap: 0, rss: 0, nodes: 0, listeners: 0 },
    limits: {
      rendererRetainedHeapMiB: 64,
      testApiNodeHeapMiB: 128,
      testApiNodeRssMiB: 256,
      domNodes: 1000,
      listeners: 200,
    },
    exclusions: [
      "real provider or collector authorization",
      "deployed hosting",
      "human assistive technology acceptance",
      "browser process/GPU/operating-system memory",
    ],
    cleanupFinishedAt: at(finish),
    testStatus: "passed",
    cleanupChecks: { service: true, browser: true },
    cleanupFailures: [],
  };
  return {
    "attempt.json": {
      id: ID,
      directory: `/synthetic/frozen/test-results/wall-soak-attempts/${ID}`,
      startedAt: at(-1_000),
    },
    "timezone-start.json": {
      attemptId: ID,
      requested: "Pacific/Honolulu",
      actual: "Pacific/Honolulu",
      expected: "Pacific/Honolulu",
    },
    "midnight-window.json": { attemptId: ID, ...requireSoakMidnightWindow("Pacific/Honolulu", START) },
    "build-inputs.json": { attemptId: ID, sha256: buildHash, files: buildFiles },
    "events.jsonl": events,
    "samples.jsonl": samples,
    "summary.json": summary,
    "service-cleanup.json": { attemptId: ID, at: at(bodyEnd + 100), failures: [] },
    "browser-cleanup.json": { attemptId: ID, at: at(bodyEnd + 200), failures: [] },
    "run-status.json": {
      attemptId: ID,
      startedAt: at(-1_000),
      endedAt: at(finish),
      bodyStatus: "passed",
      testStatus: "passed",
      result: summary.result,
    },
  };
}

const original = fixture();
const fresh = () => structuredClone(original);
function prefix(data, maximum = 20 * MINUTE) {
  const result = structuredClone(data);
  result["samples.jsonl"] = result["samples.jsonl"].filter((entry) => Date.parse(entry.utc) - START < maximum);
  const end = Date.parse(result["samples.jsonl"].at(-1).utc);
  result["events.jsonl"] = result["events.jsonl"].filter((entry) => Date.parse(entry.at) <= end);
  for (const name of ["summary.json", "run-status.json", "service-cleanup.json", "browser-cleanup.json"])
    delete result[name];
  return result;
}

function finalResourceOffset(offset) {
  const data = fresh();
  const event = data["events.jsonl"].find((entry) => entry.event === "final-resources");
  event.at = at(DURATION + offset);
  assert(
    Date.parse(event.at) >= Date.parse(data["samples.jsonl"].at(-1).at),
    "The boundary control changes only the duration endpoint, not sample ordering",
  );
  return data;
}

test("final resource observation at the complete duration endpoint accepts", () => {
  assert.equal(auditFrozenSoak(finalResourceOffset(0)).acceptedCompleteChronology, true);
});

test("final resource observation at the declared one-second clock boundary accepts", () => {
  assert.equal(frozenSoakProfile.clockToleranceMilliseconds, 1_000);
  assert.equal(auditFrozenSoak(finalResourceOffset(-1_000)).acceptedCompleteChronology, true);
});

test("final resource observation before the clock boundary cannot complete the audit", () => {
  for (const offset of [-1_001, -1_110])
    assert.throws(() => auditFrozenSoak(finalResourceOffset(offset)), /final resource observation/);
});

test("synthetic full chronology recomputes all five pages, unique suppression, real dates and bounded resources", () => {
  const result = auditFrozenSoak(original);
  assert.equal(result.acceptedCompleteChronology, true);
  assert.equal(result.suppressedActor, "wall-03");
  assert.equal(result.completedActions.length, 20);
  assert.equal(result.naturalRollover, true);
  assert(result.cycles.completeCycles > 100);
  assert(result.timing.maximumCaptureLagMilliseconds >= 32_000);
  assert.equal(result.actionUncertainty.length, 20);
});

test("an ongoing prefix is explicitly incomplete and cannot pass the complete audit", () => {
  const data = prefix(original);
  const result = auditFrozenSoak(data, { prefix: true });
  assert.equal(result.result, "incomplete-prefix-not-acceptance");
  assert.equal(result.acceptedCompleteChronology, false);
  assert.throws(() => auditFrozenSoak(data), /complete audit requires|complete duration/);
  assert.equal(auditFrozenSoak(original, { prefix: true }).acceptedCompleteChronology, false);
});

test("one good cycle followed by an unsolicited eight-hour pause or hidden state cannot stop verification", () => {
  for (const mode of ["Paused", "Paused while reading", "Paused for reduced motion", "hidden"]) {
    const data = fresh();
    for (const sample of data["samples.jsonl"].slice(10)) {
      if (mode === "hidden") {
        sample.visibility = "hidden";
        sample.controlState = "Paused in background";
        sample.links = [];
        sample.values = [];
      } else sample.controlState = mode;
    }
    assert.throws(() => auditFrozenSoak(data), /unsolicited hold|visibility must follow/);
  }
});

test("fixed action order rejects omitted, duplicate, reordered, invented, early and late actions", () => {
  const mutations = [
    (data) => data["events.jsonl"].splice(2, 1),
    (data) => data["events.jsonl"].splice(2, 0, structuredClone(data["events.jsonl"][1])),
    (data) => ([data["events.jsonl"][1], data["events.jsonl"][2]] = [data["events.jsonl"][2], data["events.jsonl"][1]]),
    (data) => (data["events.jsonl"][1].event = "operator-approved-pause"),
    (data) => (data["events.jsonl"][1].at = at(15 * MINUTE)),
    (data) => (data["events.jsonl"][1].at = at(30.5 * MINUTE)),
  ];
  for (const mutate of mutations) {
    const data = fresh();
    mutate(data);
    assert.throws(() => auditFrozenSoak(data));
  }
});

test("missing early, middle, held-period and final timeline stretches cannot be hidden by a fake sample count", () => {
  for (const [start, end] of [
    [0, 60_000],
    [10 * MINUTE, 20 * MINUTE],
    [125 * MINUTE, 130 * MINUTE],
    [470 * MINUTE, 480 * MINUTE],
  ]) {
    const data = fresh();
    data["samples.jsonl"] = data["samples.jsonl"].filter(
      (entry) => entry.elapsedMilliseconds < start || entry.elapsedMilliseconds >= end,
    );
    data["summary.json"].sampleCount = data["samples.jsonl"].length;
    assert.throws(() => auditFrozenSoak(data), /beginning|sampling interval|end of the complete duration/);
  }
});

test("cursor and background holds expire at their actual scheduled recovery completion", () => {
  for (const event of ["natural-cursor-expiry-recovery", "real-tab-foreground"]) {
    const data = fresh();
    const completion = Date.parse(data["events.jsonl"].find((entry) => entry.event === event).at);
    const sample = data["samples.jsonl"].find((entry) => Date.parse(entry.utc) >= completion);
    sample.controlState = event === "real-tab-foreground" ? "Paused in background" : "Paused";
    assert.throws(() => auditFrozenSoak(data), /unsolicited hold/);
  }
});

test("network, source and hidden empty observations cannot retain stale source provenance", () => {
  for (const minute of [30, 60, 150]) {
    for (const field of ["snapshot", "generated", "renderedTime", "all"]) {
      const data = fresh();
      const sample = data["samples.jsonl"].find(
        (entry) => entry.elapsedMilliseconds >= minute * MINUTE && entry.links.length === 0,
      );
      assert(sample, "The synthetic complete fixture has this actual cleared observation");
      const stale = { snapshot: "wall-soak-1", generated: at(0), renderedTime: at(0) };
      if (field === "all") Object.assign(sample, stale);
      else sample[field] = stale[field];
      assert.throws(() => auditFrozenSoak(data), /cleared display cannot retain/);
    }
  }
});

test("all loop, capture and append timestamps are finite, ordered and independently bound", () => {
  const mutations = [
    (sample) => (sample.elapsedMilliseconds = true),
    (sample) => (sample.elapsedMilliseconds = NaN),
    (sample) => (sample.elapsedMilliseconds = -1),
    (sample) => (sample.utc = "2026-02-30T08:19:06.473Z"),
    (sample) => (sample.at = at(0)),
    (sample) => (sample.utc = at(30 * MINUTE)),
    (sample) => (sample.elapsedMilliseconds = 500_000),
  ];
  for (const mutate of mutations) {
    const data = fresh();
    mutate(data["samples.jsonl"][20]);
    assert.throws(() => auditFrozenSoak(data));
  }
});

test("post-action timing is not falsely compared to the earlier loop-top timestamp", () => {
  const data = fresh();
  const suppression = data["events.jsonl"].find((entry) => entry.event === "current-suppression");
  const sample = data["samples.jsonl"].find((entry) => Date.parse(entry.utc) >= Date.parse(suppression.at));
  assert(Date.parse(sample.utc) - START - sample.elapsedMilliseconds > 30_000);
  assert.doesNotThrow(() => auditFrozenSoak(data));
  sample.elapsedMilliseconds = Date.parse(sample.utc) - START;
  assert.throws(() => auditFrozenSoak(data), /sampling interval|complete in its first eligible loop/);
});

test("changed source, dirty input, short duration, browser identity and build digests fail closed", () => {
  const mutations = [
    (data) => (data["events.jsonl"][0].detail.head = "a".repeat(40)),
    (data) => (data["summary.json"].input.tree = "b".repeat(40)),
    (data) => (data["summary.json"].input.status = " M changed.ts"),
    (data) => (data["summary.json"].elapsedMilliseconds = 120_000),
    (data) => (data["summary.json"].requestedMinutes = 2),
    (data) => (data["summary.json"].executableSha256 = "c".repeat(64)),
    (data) => data["build-inputs.json"].files[0].bytes++,
    (data) => (data["build-inputs.json"].files[0].path = "../private"),
  ];
  for (const mutate of mutations) {
    const data = fresh();
    mutate(data);
    assert.throws(() => auditFrozenSoak(data));
  }
});

test("changed actor membership, inconsistent exclusions and fabricated pins or values are rejected", () => {
  const mutations = [
    (data) => (data["samples.jsonl"][20].links[0].id = "other-actor"),
    (data) => (data["samples.jsonl"][20].links[0].pin = "wall-soak-900"),
    (data) => (data["samples.jsonl"][20].snapshot = "wall-soak-900"),
    (data) => {
      const sample = data["samples.jsonl"].find(
        (entry) => entry.elapsedMilliseconds > 95 * MINUTE && entry.links.length,
      );
      sample.links[0].id = "wall-03";
    },
    (data) => (data["samples.jsonl"][0].values[0] = "500"),
    (data) => (data["samples.jsonl"][0].renderedTime = "local time"),
    (data) => {
      const sample = data["samples.jsonl"][1];
      sample.generated = at(1);
      sample.renderedTime = at(1);
    },
    (data) => {
      const sample = data["samples.jsonl"].find((entry) => entry.elapsedMilliseconds > 125 * MINUTE);
      sample.snapshot = "wall-soak-999";
      sample.links.forEach((link) => (link.pin = sample.snapshot));
    },
  ];
  for (const mutate of mutations) {
    const data = fresh();
    mutate(data);
    assert.throws(() => auditFrozenSoak(data));
  }
});

test("recorded success counts cannot invent missing cycles, retained history or resource observations", () => {
  const mutations = [
    (data) => (data["samples.jsonl"][10].cycles.completeCycles += 50),
    (data) => (data["samples.jsonl"][10].cycleCoverage.completeWindows += 50),
    (data) => (data["summary.json"].sampleCount += 10),
    (data) => (data["summary.json"].cycles = { ...data["summary.json"].cycles, completeCycles: 900_000 }),
    (data) => (data["samples.jsonl"][10].retainedSnapshots = 17),
    (data) => (data["samples.jsonl"].find((entry) => entry.resource).resource = null),
    (data) => (data["events.jsonl"][21].detail.heap += 65 * 1024 * 1024),
    (data) => (data["summary.json"].maxRetainedGrowth.heap = 1),
    (data) => (data["summary.json"].counters.requests += 50),
    (data) => (data["summary.json"].counters.responses["410:cursor_expired_refetch"] = 0),
  ];
  for (const mutate of mutations) {
    const data = fresh();
    mutate(data);
    assert.throws(() => auditFrozenSoak(data));
  }
});

test("rolling coverage and coherent-cycle deadlines are recomputed independently of forged tracker summaries", () => {
  for (const failure of ["stalled", "two-pages", "changed-pins"]) {
    const data = fresh();
    for (let index = 10; index < 30; index++) {
      const sample = data["samples.jsonl"][index];
      const originalSample = data["samples.jsonl"][failure === "two-pages" ? index % 2 : 0];
      if (failure !== "changed-pins")
        for (const key of ["heading", "page", "links", "values", "snapshot", "generated", "renderedTime"])
          sample[key] = structuredClone(originalSample[key]);
      else {
        sample.snapshot = `wall-soak-${10_000 + index}`;
        for (const link of sample.links) link.pin = sample.snapshot;
      }
      // Inventing the same old successful tracker values cannot turn a dead or
      // non-coherent timeline into a new complete cycle.
      sample.cycles = structuredClone(data["samples.jsonl"][9].cycles);
    }
    assert.throws(() => auditFrozenSoak(data), /cycle counts|advancing|must keep|cycle timing/);
  }
});

test("matching final cleanup and runtime receipts are required; no missing, failed or mixed attempt succeeds", () => {
  const mutations = [
    (data) => delete data["summary.json"],
    (data) => delete data["run-status.json"],
    (data) => delete data["service-cleanup.json"],
    (data) => data["browser-cleanup.json"].failures.push("owned process did not exit"),
    (data) => (data["service-cleanup.json"].attemptId = "attempt-different"),
    (data) => (data["events.jsonl"][5].attemptId = "attempt-different"),
    (data) => (data["run-status.json"].bodyStatus = "interrupted"),
    (data) => (data["run-status.json"].endedAt = at(DURATION - 1)),
    (data) => (data["summary.json"].result = "pending-owned-cleanup"),
    (data) => (data["summary.json"].checks.realCursorExpired = false),
    (data) => (data["summary.json"].cleanupFailures = ["hidden failure"]),
    (data) => (data["browser-cleanup.json"].at = at(DURATION + 60_000)),
  ];
  for (const mutate of mutations) {
    const data = fresh();
    mutate(data);
    assert.throws(() => auditFrozenSoak(data));
  }
});

test("body request counters preserve pre-inject and post-classification pending phases until later cleanup", () => {
  for (const phase of ["unclassified", "response", "abort"]) {
    const data = fresh();
    const counters = data["summary.json"].counters;
    counters.requests++;
    counters.concurrent = 1;
    if (phase === "response") counters.responses["200"]++;
    if (phase === "abort") counters.networkAborts++;
    const result = auditFrozenSoak(data);
    assert.equal(result.acceptedCompleteChronology, true);
    assert.equal(result.bodyReadAccounting.pendingReads, 1);
    assert.equal(result.bodyReadAccounting.unclassifiedRequests, phase === "unclassified" ? 1 : 0);
    data["service-cleanup.json"].failures = ["finish public routes exceeded five seconds"];
    assert.throws(() => auditFrozenSoak(data), /owned service cleanup must have no failures/);
  }
});

test("body accounting rejects impossible missing, double-counted and underreported concurrency", () => {
  const mutations = [
    (counters) => {
      counters.requests += 2;
      counters.concurrent = 1;
    },
    (counters) => counters.responses["200"]++,
    (counters) => counters.networkAborts++,
    (counters) => (counters.concurrent = counters.maxConcurrent + 1),
    (counters) => (counters.concurrent = true),
  ];
  for (const mutate of mutations) {
    const data = fresh();
    mutate(data["summary.json"].counters);
    assert.throws(() => auditFrozenSoak(data), /Classified|Unclassified|Concurrent|safe integer|finite/);
  }
});

test("fake local midnight, unsupported timezone changes and changed UTC source text cannot satisfy calendar evidence", () => {
  const mutations = [
    (data) => (data["samples.jsonl"][0].localDay = "2026-10-18"),
    (data) => (data["samples.jsonl"][20].timezone = "UTC"),
    (data) => (data["midnight-window.json"].nextRolloverAt = at(2 * MINUTE)),
    (data) => (data["summary.json"].naturalRollover = false),
    (data) => (data["timezone-start.json"].expected = "UTC"),
  ];
  for (const mutate of mutations) {
    const data = fresh();
    mutate(data);
    assert.throws(() => auditFrozenSoak(data));
  }
});

async function writeFixture(directory, data) {
  await mkdir(directory, { recursive: true });
  for (const [name, value] of Object.entries(data))
    await writeFile(
      join(directory, name),
      name.endsWith(".jsonl")
        ? value.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
        : JSON.stringify(value, null, 2) + "\n",
    );
}
const cli = fileURLToPath(new URL("../../../scripts/audit-wall-soak.mjs", import.meta.url));
const run = (input, output, extra = []) =>
  spawnSync(process.execPath, [cli, "--input", input, "--output", output, ...extra], {
    encoding: "utf8",
    timeout: 20_000,
  });

test("actual offline CLI writes a new external prefix receipt and preserves every input byte", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wall-chronology-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "evidence"),
    output = join(root, "prefix-audit.json");
  const data = prefix(original);
  await writeFixture(input, data);
  const before = new Map(
    await Promise.all(Object.keys(data).map(async (name) => [name, await readFile(join(input, name), "utf8")])),
  );
  const response = run(input, output, ["--prefix"]);
  assert.equal(response.status, 0, response.stderr);
  const audit = JSON.parse(await readFile(output, "utf8"));
  assert.equal(audit.acceptedCompleteChronology, false);
  assert.equal(audit.inputFiles.length, 6);
  for (const [name, source] of before) assert.equal(await readFile(join(input, name), "utf8"), source);
  assert.notEqual(run(input, output, ["--prefix"]).status, 0, "The CLI must not replace an earlier audit");
  assert.notEqual(
    run(input, join(input, "audit.json"), ["--prefix"]).status,
    0,
    "The CLI must not write into evidence",
  );
});

test("actual offline CLI requires complete matching finalization before writing a complete audit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wall-chronology-complete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "evidence"),
    output = join(root, "complete-audit.json");
  await writeFixture(input, original);
  const result = run(input, output);
  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(await readFile(output, "utf8"));
  assert.equal(audit.acceptedCompleteChronology, true);
  assert.equal(audit.inputFiles.length, 10);
  assert.equal(audit.sampleCount, original["samples.jsonl"].length);
  await rm(join(input, "browser-cleanup.json"));
  const rejected = join(root, "missing-cleanup.json");
  assert.notEqual(run(input, rejected).status, 0);
  await assert.rejects(readFile(rejected), { code: "ENOENT" });
});

test("a prefix trailing action is bounded to the next eligible loop and cannot hide missing samples", () => {
  const event = original["events.jsonl"][1];
  const eventAt = Date.parse(event.at);
  const data = prefix(original, eventAt - START);
  data["events.jsonl"].push(structuredClone(event));
  assert.equal(auditFrozenSoak(data, { prefix: true }).acceptedCompleteChronology, false);
  data["events.jsonl"].push(structuredClone(original["events.jsonl"][2]));
  assert.throws(() => auditFrozenSoak(data, { prefix: true }), /trailing action cannot hide/);
  data["events.jsonl"].pop();
  data["events.jsonl"][1].at = at(29 * MINUTE);
  assert.throws(() => auditFrozenSoak(data, { prefix: true }));
  const malformed = prefix(original);
  malformed["summary.json"] = { attemptId: ID };
  assert.throws(() => auditFrozenSoak(malformed, { prefix: true }), /timestamp|nonempty text/);
});

test("actual offline CLI rejects incomplete JSONL, malformed receipts and linked input files without output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wall-chronology-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "evidence");
  const data = prefix(original);
  await writeFixture(input, data);
  for (const invalid of ["{}", "{}\n\n", '{"attemptId":"broken"\n', "null\n", "[]\n"]) {
    await writeFile(join(input, "samples.jsonl"), invalid);
    const output = join(root, `invalid-${createHash("sha256").update(invalid).digest("hex")}.json`);
    assert.notEqual(run(input, output, ["--prefix"]).status, 0);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  }
  await writeFixture(input, data);
  await rm(join(input, "attempt.json"));
  await writeFile(join(root, "linked-attempt.json"), JSON.stringify(data["attempt.json"]));
  await symlink(join(root, "linked-attempt.json"), join(input, "attempt.json"));
  assert.notEqual(run(input, join(root, "linked.json"), ["--prefix"]).status, 0);
});
