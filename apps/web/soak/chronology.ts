import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { WallCycleTracker } from "./assertions.ts";
import { assertPageActors, CycleCoverage, fixturePages } from "./monitor.ts";
import { requireSoakMidnightWindow } from "./midnight.ts";

/** This reader applies only to the retained, unmodified 480-minute recorder. */
export const frozenSoakProfile = Object.freeze({
  id: "wall-soak-16437501-480m/v1",
  head: "16437501b119615d82d054b16749aa667f231e0f",
  tree: "cd3bdcf19dec49d834a1f9f8d27988fc90607000",
  minutes: 480,
  sampleIntervalMilliseconds: 15_000,
  maximumLoopGapMilliseconds: 30_000,
  maximumCaptureOverheadMilliseconds: 5_000,
  maximumAppendDelayMilliseconds: 15_000,
  clockToleranceMilliseconds: 1_000,
});

const MINUTE = 60_000;
const DURATION = frozenSoakProfile.minutes * MINUTE;
const CLOCK = frozenSoakProfile.clockToleranceMilliseconds;
type RecordValue = Record<string, unknown>;

// These are the fixed source's action order and finite, conservative ceilings
// for its sequential 10/45/65-second waits. They are not measured start times.
// In particular, no action-start event exists in the historical recorder.
export const frozenSoakSchedule = [
  { minute: 30, name: "network-loss", maximumDuration: 5_000 },
  { minute: 30.6, name: "network-cleared-display", maximumDuration: 25_000 },
  { minute: 31.5, name: "network-recovery", maximumDuration: 135_000 },
  { minute: 60, name: "source-exception", maximumDuration: 5_000 },
  { minute: 61, name: "source-cleared-display", maximumDuration: 25_000 },
  { minute: 61.5, name: "source-recovery", maximumDuration: 135_000 },
  { minute: 90, name: "current-suppression", maximumDuration: 370_000 },
  { minute: 120, name: "hold-real-cursor", maximumDuration: 450_000 },
  { minute: 138, name: "natural-cursor-expiry-recovery", maximumDuration: 195_000 },
  { minute: 150, name: "real-tab-background", maximumDuration: 60_000 },
  { minute: 151, name: "real-tab-foreground", maximumDuration: 180_000 },
  { minute: 180, name: "revoke-held-snapshot", maximumDuration: 400_000 },
  { minute: 240, name: "resize-4k", maximumDuration: 30_000 },
  { minute: 255, name: "change-device-scale", maximumDuration: 30_000 },
  { minute: 270, name: "restore-device-scale", maximumDuration: 30_000 },
  { minute: 300, name: "stop-source-heartbeat", maximumDuration: 5_000 },
  { minute: 306, name: "real-stale-source", maximumDuration: 145_000 },
  { minute: 317, name: "resume-source-heartbeat", maximumDuration: 5_000 },
  { minute: 320, name: "fresh-source-recovery", maximumDuration: 200_000 },
  { minute: 360, name: "change-display-timezone", maximumDuration: 30_000 },
] as const;

const requiredChecks = [
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
];
const resourceLimits = {
  heap: 64 * 1024 * 1024,
  nodeHeap: 128 * 1024 * 1024,
  rss: 256 * 1024 * 1024,
  nodes: 1_000,
  listeners: 200,
};
const stages = [
  { heading: "PRs merged", actors: Array.from({ length: 12 }, (_, i) => `wall-${String(i + 1).padStart(2, "0")}`) },
  {
    heading: "Contributors in this scope",
    actors: Array.from({ length: 15 }, (_, i) => `wall-${String(i + 1).padStart(2, "0")}`),
  },
];
const originalPages = fixturePages(stages);
const pageNames = [...originalPages.keys()];
const exclusions = [
  "real provider or collector authorization",
  "deployed hosting",
  "human assistive technology acceptance",
  "browser process/GPU/operating-system memory",
];

function object(value: unknown, label: string): RecordValue {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as RecordValue;
}
function text(value: unknown, label: string): string {
  assert(typeof value === "string" && value.trim() !== "", `${label} must be nonempty text`);
  return value;
}
function number(value: unknown, label: string): number {
  assert(
    typeof value === "number" && Number.isFinite(value) && value >= 0,
    `${label} must be a finite nonnegative number`,
  );
  return value;
}
function integer(value: unknown, label: string): number {
  const result = number(value, label);
  assert(Number.isSafeInteger(result), `${label} must be a safe integer`);
  return result;
}
function timestamp(value: unknown, label: string): number {
  const source = text(value, label);
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(source), `${label} must be an exact UTC timestamp`);
  const result = Date.parse(source);
  assert(Number.isFinite(result) && new Date(result).toISOString() === source, `${label} must be a real UTC timestamp`);
  return result;
}
function array(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `${label} must be an array`);
  return value;
}
function same(actual: unknown, expected: unknown, label: string) {
  assert.deepEqual(actual, expected, label);
}
function sha(value: unknown, label: string): string {
  const result = text(value, label);
  assert(/^[a-f0-9]{64}$/.test(result), `${label} must be a SHA-256`);
  return result;
}
function attemptRecord(value: unknown, id: string, label: string): RecordValue {
  const result = object(value, label);
  same(result.attemptId, id, `${label} must identify this attempt`);
  return result;
}
function sourceIdentity(value: RecordValue, label: string) {
  same(value.head, frozenSoakProfile.head, `${label} source revision`);
  same(value.tree, frozenSoakProfile.tree, `${label} source tree`);
  same(value.status, "", `${label} tracked source must have been clean`);
}
function resource(value: unknown, label: string): Record<string, number> {
  const source = object(value, label);
  same(Object.keys(source).sort(), Object.keys(resourceLimits).sort(), `${label} resource fields`);
  return Object.fromEntries(Object.keys(resourceLimits).map((key) => [key, integer(source[key], `${label}.${key}`)]));
}
function canonicalZone(value: unknown, label: string): string {
  const zone = text(value, label);
  same(
    new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone,
    zone,
    `${label} must be canonical`,
  );
  return zone;
}

/**
 * Reconstruct chronology from captured observations and the pinned schedule.
 * Recorded page state and summary counters never decide when verification stops.
 * This validates retained evidence; it neither executes nor authenticates a run.
 */
export function auditFrozenSoak(files: Readonly<Record<string, unknown>>, options: { prefix?: boolean } = {}) {
  const attempt = object(files["attempt.json"], "attempt.json");
  const id = text(attempt.id, "attempt.id");
  assert(/^attempt-[A-Za-z0-9_-]{6,80}$/.test(id), "An exclusive attempt identity is required");
  assert(
    text(attempt.directory, "attempt.directory").replaceAll("\\", "/").endsWith(`/${id}`),
    "The original attempt directory must identify this attempt",
  );
  const attemptStart = timestamp(attempt.startedAt, "attempt.startedAt");
  const events = array(files["events.jsonl"], "events.jsonl").map((value, i) =>
    attemptRecord(value, id, `event[${i}]`),
  );
  const samples = array(files["samples.jsonl"], "samples.jsonl").map((value, i) =>
    attemptRecord(value, id, `sample[${i}]`),
  );
  assert(events.length >= 1 && events.length <= 24, "The frozen event sequence must be bounded and nonempty");
  assert(samples.length >= 1 && samples.length <= 2_100, "The frozen sample sequence must be bounded and nonempty");
  same(events[0]!.event, "start", "The first event must start the elapsed matrix");
  const startedAt = timestamp(events[0]!.at, "start.at");
  assert(
    startedAt >= attemptStart && startedAt - attemptStart <= 180_000,
    "Attempt setup must precede the elapsed matrix within its startup allowance",
  );
  const start = object(events[0]!.detail, "start.detail");
  sourceIdentity(start, "start");
  same(start.requestedMinutes, 480, "Only the fixed 480-minute profile is supported");
  same(start.fullMatrix, true, "A short rehearsal is not this profile");
  same(start.clocks, "real; no installed clock or time advancement", "The frozen clock declaration is required");
  text(start.browser, "start.browser");
  sha(start.executableSha256, "start.executableSha256");
  assert(
    ["explicit executable override", "Playwright pinned executable"].includes(
      text(start.browserSelection, "start.browserSelection"),
    ),
    "Browser selection must remain explicit",
  );
  assert(/^v24\./.test(text(start.node, "start.node")), "The frozen profile requires Node 24");

  const build = attemptRecord(files["build-inputs.json"], id, "build-inputs.json");
  const buildFiles = array(build.files, "build.files");
  assert(buildFiles.length > 0 && buildFiles.length < 10_000, "Compiled inputs must be nonempty and bounded");
  const paths = new Set<string>();
  const normalizedBuild = buildFiles.map((value, index) => {
    const entry = object(value, `build.files[${index}]`);
    const path = text(entry.path, "compiled path");
    assert(
      /^(?:packages\/(?:contracts|metrics)|apps\/(?:service|web))\/dist\/[A-Za-z0-9_./-]+$/.test(path) &&
        !path.split("/").includes(".."),
      "Compiled paths must stay in the frozen four output roots",
    );
    assert(!paths.has(path), "Compiled paths must be unique");
    paths.add(path);
    return { path, bytes: integer(entry.bytes, "compiled bytes"), sha256: sha(entry.sha256, "compiled SHA-256") };
  });
  for (const root of ["packages/contracts/dist/", "packages/metrics/dist/", "apps/service/dist/", "apps/web/dist/"])
    assert(
      [...paths].some((path) => path.startsWith(root)),
      `Compiled input root missing: ${root}`,
    );
  const compiledHash = createHash("sha256").update(JSON.stringify(normalizedBuild)).digest("hex");
  same(build.sha256, compiledHash, "Compiled manifest digest must match its exact ordered records");

  const zone = attemptRecord(files["timezone-start.json"], id, "timezone-start.json");
  const initialZone = canonicalZone(zone.actual, "initial actual timezone");
  same(zone.expected, initialZone, "The expected and actual initial timezone must agree");
  same(
    new Intl.DateTimeFormat("en", { timeZone: text(zone.requested, "requested timezone") }).resolvedOptions().timeZone,
    initialZone,
    "The requested initial timezone must agree",
  );
  const midnight = attemptRecord(files["midnight-window.json"], id, "midnight-window.json");
  const midnightObserved = timestamp(midnight.observedAt, "midnight.observedAt");
  assert(Math.abs(midnightObserved - startedAt) <= CLOCK, "The midnight window must be checked at the elapsed start");
  same(
    { ...midnight, attemptId: undefined },
    { ...requireSoakMidnightWindow(initialZone, midnightObserved), attemptId: undefined },
    "The retained midnight window must match the real calendar",
  );
  const changedZone = initialZone === "Pacific/Kiritimati" ? "UTC" : "Pacific/Kiritimati";

  const names = [
    "start",
    ...frozenSoakSchedule.map((action) => action.name),
    "final-resources",
    "matrix-end",
    "attempt-end",
  ];
  let previousEvent = startedAt;
  for (let index = 0; index < events.length; index++) {
    same(events[index]!.event, names[index], `Event ${index} must follow the fixed action order`);
    const at = timestamp(events[index]!.at, `event[${index}].at`);
    assert(at >= previousEvent, "Event timestamps must remain ordered");
    previousEvent = at;
    if (index > 0 && index <= frozenSoakSchedule.length)
      same(events[index]!.detail, null, "Historical action events have no invented detail");
  }
  const actionEvents = events.slice(1, Math.min(events.length, frozenSoakSchedule.length + 1));
  const eventTime = new Map(actionEvents.map((event) => [String(event.event), timestamp(event.at, "action.at")]));
  const during = (at: number, from: string, until: string) => {
    const lower = eventTime.get(from);
    return lower !== undefined && at >= lower && (eventTime.get(until) === undefined || at < eventTime.get(until)!);
  };
  const hasHappened = (at: number, name: string) => eventTime.has(name) && at >= eventTime.get(name)!;

  const coverage = new CycleCoverage(pageNames);
  const cycles = new WallCycleTracker();
  let actionIndex = 0;
  let previousLoop = -1,
    previousCapture = startedAt - 1,
    previousAppend = startedAt;
  let maximumLoopGap = 0,
    maximumCaptureLag = 0,
    maximumAppendDelay = 0;
  let previousRequests = 0,
    previousRetained = 0;
  let lastCollection: number | null = null;
  let baseline: Record<string, number> | null = null;
  const maximumGrowth = Object.fromEntries(Object.keys(resourceLimits).map((key) => [key, 0]));
  const observeResource = (value: unknown, label: string) => {
    const current = resource(value, label);
    baseline ??= current;
    for (const [key, limit] of Object.entries(resourceLimits)) {
      maximumGrowth[key] = Math.max(maximumGrowth[key]!, current[key]! - baseline[key]!);
      assert(maximumGrowth[key]! <= limit, `Retained ${key} growth exceeds the frozen limit`);
    }
    return current;
  };
  const snapshotTimes = new Map<string, string>();
  let suppressedCandidates = [...stages[1]!.actors];
  let suppressionObserved = false;
  let cursorPin: string | null = null;
  let cursorPageOneObserved = false,
    cursorPageTwoObserved = false;
  let naturalRollover = false,
    priorDay = "",
    priorZone = "";
  let automaticSince: number | null = null,
    unchangedSince = 0,
    lastIdentity = "";
  let emptySince: number | null = null;
  const pagesSeen = new Set<string>();
  const observations = { networkBlank: false, sourceBlank: false, hidden: false };
  const actionUncertainty: {
    action: string;
    loopStartedAt: string;
    completedAt: string;
    maximumDurationMilliseconds: number;
  }[] = [];

  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!;
    const label = `sample[${index}]`;
    const loop = number(sample.elapsedMilliseconds, `${label}.elapsedMilliseconds`);
    const captured = timestamp(sample.utc, `${label}.utc`);
    const appended = timestamp(sample.at, `${label}.at`);
    assert(
      loop < DURATION && loop > previousLoop,
      "Loop-top elapsed observations must strictly increase within the requested duration",
    );
    assert(
      captured > previousCapture &&
        appended >= captured &&
        appended - captured <= frozenSoakProfile.maximumAppendDelayMilliseconds,
      "Capture/append chronology must be ordered and bounded",
    );
    const loopAt = startedAt + loop;
    const loopGap = loopAt - previousAppend;
    if (index === 0) assert(loop <= 5_000, "The first sample must observe the beginning of the elapsed matrix");
    else
      assert(
        loopGap >= 15_000 - CLOCK && loopGap <= frozenSoakProfile.maximumLoopGapMilliseconds,
        "A missing or accelerated sampling interval cannot certify continuity",
      );
    maximumLoopGap = Math.max(maximumLoopGap, loopGap);
    let allowance = frozenSoakProfile.maximumCaptureOverheadMilliseconds;
    let completionAnchor = loopAt;
    const justCompleted: string[] = [];
    while (actionIndex < frozenSoakSchedule.length && frozenSoakSchedule[actionIndex]!.minute * MINUTE <= loop) {
      const action = frozenSoakSchedule[actionIndex]!;
      const event = actionEvents[actionIndex];
      assert(event, `Missing scheduled action: ${action.name}`);
      const ended = timestamp(event.at, `${action.name}.at`);
      assert(
        ended >= completionAnchor - CLOCK && ended <= completionAnchor + action.maximumDuration && ended <= captured,
        `Action ${action.name} must complete in its first eligible loop within its finite ceiling`,
      );
      allowance += action.maximumDuration;
      completionAnchor = ended;
      justCompleted.push(action.name);
      actionUncertainty.push({
        action: action.name,
        loopStartedAt: new Date(Math.round(loopAt)).toISOString(),
        completedAt: String(event.at),
        maximumDurationMilliseconds: action.maximumDuration,
      });
      actionIndex++;
    }
    if (actionIndex < actionEvents.length)
      assert(
        timestamp(actionEvents[actionIndex]!.at, "next action.at") > captured,
        "An action cannot be completed before its fixed schedule is due",
      );
    const captureLag = captured - loopAt;
    assert(
      captureLag >= -CLOCK && captureLag <= allowance,
      "Post-action capture must remain bound to its loop-top observation and completed actions",
    );
    maximumCaptureLag = Math.max(maximumCaptureLag, captureLag);
    maximumAppendDelay = Math.max(maximumAppendDelay, appended - captured);

    const hidden = during(captured, "real-tab-background", "real-tab-foreground");
    const held = during(captured, "hold-real-cursor", "natural-cursor-expiry-recovery");
    const networkOutage = during(captured, "network-loss", "network-cleared-display");
    const sourceOutage = during(captured, "source-exception", "source-cleared-display");
    same(
      sample.visibility,
      hidden ? "hidden" : "visible",
      `${label} visibility must follow the fixed background interval`,
    );
    const control = text(sample.controlState, `${label}.controlState`);
    const expectedControl = hidden
      ? "Paused in background"
      : held
        ? "Paused"
        : "Automatic page boundaries · 20 seconds per page";
    assert(
      control === expectedControl || control === `${expectedControl} · Rechecking controls…`,
      `${label} unsolicited hold or changed automatic interval`,
    );
    // Short suppression/revocation pauses finish before their next sample. Their
    // completion can reset a window once; their UI cannot authorize a later hold.
    if (justCompleted.some((name) => name === "current-suppression" || name === "revoke-held-snapshot")) {
      coverage.reset();
      cycles.interrupt();
      automaticSince = null;
      lastIdentity = "";
    }
    const automatic = !hidden && !held && !networkOutage && !sourceOutage;
    const links = array(sample.links, `${label}.links`).map((value) => object(value, `${label}.link`));
    assert(links.length <= 6, "Only a bounded current page may remain mounted");
    const ids = links.map((link) => text(link.id, "link.id"));
    same(new Set(ids).size, ids.length, "A contributor cannot be duplicated within a page");
    const page = typeof sample.page === "string" ? sample.page.split(" · ")[0]! : "";
    const view = typeof sample.heading === "string" ? sample.heading : "";
    const identity = `${view}:${page}`;
    const values = array(sample.values, `${label}.values`);
    const suppressed = hasHappened(captured, "current-suppression");
    if (links.length) {
      assert(!hidden, "Hidden content must be cleared");
      if (suppressed) {
        suppressionObserved = true;
        suppressedCandidates = suppressedCandidates.filter((actor) => {
          const expected = fixturePages(stages, actor).get(identity);
          return expected !== undefined && JSON.stringify(expected) === JSON.stringify(ids);
        });
        assert(
          suppressedCandidates.length > 0,
          "Post-suppression membership must exclude one consistent fixture actor only",
        );
      } else assertPageActors(originalPages, identity, ids);
      const possibleCounts = (suppressed ? suppressedCandidates : [null]).map(
        (actor) => stages.find((stage) => stage.heading === view)!.actors.filter((id) => id !== actor).length,
      );
      assert(
        possibleCounts.some((count) => {
          const caption = `${page} · ${count} ${view === "PRs merged" ? "contributor rows" : "contributors"}`;
          return (
            sample.page === caption ||
            (view === "PRs merged" &&
              page === "Page 2" &&
              sample.page === `${caption} · Rank 1 continues from the previous page`)
          );
        }),
        "The displayed page total must retain exact fixture membership",
      );
      const pin = text(sample.snapshot, `${label}.snapshot`);
      assert(/^wall-soak-[1-9]\d*$/.test(pin), "The displayed source pin must belong to the frozen fixture");
      for (const link of links) same(link.pin, pin, "Every displayed link must match its visible source pin");
      const generated = timestamp(sample.generated, `${label}.generated`);
      assert(generated <= captured + CLOCK, "Source generation cannot occur after its captured display");
      same(sample.renderedTime, sample.generated, "Display timezone changes must preserve the exact source UTC text");
      if (snapshotTimes.has(pin))
        same(sample.generated, snapshotTimes.get(pin), "A source pin cannot change its generation timestamp");
      snapshotTimes.set(pin, String(sample.generated));
      const expectedValues = view === "PRs merged" ? ids.map((id) => (Number(id.slice(5)) <= 7 ? "5" : "1")) : [];
      same(values, expectedValues, "Fixed contributor values must match their actual fixture actors");
      pagesSeen.add(identity);
      if (held || justCompleted.includes("natural-cursor-expiry-recovery")) {
        cursorPin ??= pin;
        same(pin, cursorPin, "Natural cursor expiry must preserve its held publication pin");
        same(view, "PRs merged", "The cursor hold must remain on the board");
        assert(page === "Page 1" || page === "Page 2", "The held cursor must use a board page");
        if (page === "Page 1") cursorPageOneObserved = true;
        if (page === "Page 2") cursorPageTwoObserved = true;
        if (justCompleted.includes("hold-real-cursor")) same(page, "Page 2", "The cursor hold starts on page two");
        if (justCompleted.includes("natural-cursor-expiry-recovery"))
          same(page, "Page 1", "Cursor expiry returns to page one");
      }
    } else {
      same(values, [], "A cleared display cannot retain measured values");
      same(sample.snapshot, null, "A cleared display cannot retain a source snapshot");
      same(sample.generated, null, "A cleared display cannot retain a source generation timestamp");
      same(sample.renderedTime, null, "A cleared display cannot retain rendered source provenance");
      if (networkOutage) observations.networkBlank = true;
      if (sourceOutage) observations.sourceBlank = true;
      if (hidden) observations.hidden = true;
    }
    if (!hidden) {
      same(sample.scopeFits, true, "Visible scope controls must fit");
      same(sample.controlsFit, true, "Visible footer controls must fit");
      same(sample.overflow, false, "A visible wall must not overflow");
    }
    const sampleZone = canonicalZone(sample.timezone, `${label}.timezone`);
    same(
      sampleZone,
      hasHappened(captured, "change-display-timezone") ? changedZone : initialZone,
      "Only the scheduled timezone change is allowed",
    );
    const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: sampleZone }).format(captured);
    same(sample.localDay, localDay, "A displayed local day must agree with its actual capture UTC and timezone");
    if (priorZone === sampleZone && priorDay && priorDay !== localDay) naturalRollover = true;
    priorZone = sampleZone;
    priorDay = localDay;
    if (justCompleted.includes("real-stale-source"))
      same(sample.health, "STALE OR DEGRADED DATA", "The stale-source action must have an observed stale display");
    if (justCompleted.includes("fresh-source-recovery"))
      same(sample.health, "Recently reconciled", "The source must be observed fresh after recovery");
    if (
      justCompleted.some((name) =>
        ["network-recovery", "source-recovery", "real-tab-foreground", "natural-cursor-expiry-recovery"].includes(name),
      )
    ) {
      assert(links.length > 0, "A completed recovery must have observed contributor content");
      same(sample.error, "", "A completed recovery cannot retain an alert");
    }
    if (!hidden && !networkOutage && !sourceOutage && links.length === 0) {
      emptySince ??= captured;
      assert(captured - emptySince < 70_000, "Ordinary empty display must recover within its bounded polling interval");
    } else emptySince = null;
    if (automatic) {
      if (automaticSince === null) {
        automaticSince = captured;
        unchangedSince = captured;
        lastIdentity = "";
      }
      assert(captured - unchangedSince < 120_000, "A healthy automatic page must continue advancing");
      if (links.length && identity !== lastIdentity) {
        unchangedSince = captured;
        lastIdentity = identity;
      }
    } else {
      automaticSince = null;
      lastIdentity = "";
    }
    coverage.observe(captured - startedAt, automatic, links.length ? identity : null);
    cycles.observe({
      elapsed: captured - startedAt,
      automatic,
      snapshot: links.length ? String(sample.snapshot) : null,
      view,
      page,
      actorIDs: ids,
    });
    const recordedCycles = object(sample.cycles, `${label}.cycles`);
    const recomputedCycles = cycles.summary();
    for (const field of [
      "completeCycles",
      "automaticWindows",
      "currentCycleObservedPages",
      "maximumAllowedGapMilliseconds",
    ] as const)
      same(
        recordedCycles[field],
        recomputedCycles[field],
        `${label} cycle counts must be recomputed from observations`,
      );
    assert(
      Math.abs(
        number(recordedCycles.maximumObservedGapMilliseconds, "recorded cycle gap") -
          recomputedCycles.maximumObservedGapMilliseconds,
      ) <= frozenSoakProfile.maximumCaptureOverheadMilliseconds,
      "Recorded cycle timing must agree with actual capture timing within the recorder overhead",
    );
    const recordedCoverage = object(sample.cycleCoverage, `${label}.cycleCoverage`);
    const recomputedCoverage = coverage.summary();
    for (const field of [
      "automaticPeriods",
      "completeWindows",
      "requiredPages",
      "maximumPageAbsenceMilliseconds",
    ] as const)
      same(
        recordedCoverage[field],
        recomputedCoverage[field],
        `${label} coverage counts must be recomputed from observations`,
      );
    const seenTimes = object(recordedCoverage.lastSeenMilliseconds, "recorded coverage timestamps");
    same(
      Object.keys(seenTimes).sort(),
      Object.keys(recomputedCoverage.lastSeenMilliseconds).sort(),
      "Coverage cannot invent observed pages",
    );
    for (const [key, value] of Object.entries(recomputedCoverage.lastSeenMilliseconds))
      assert(
        Math.abs(number(seenTimes[key], "recorded last seen") - value) <=
          frozenSoakProfile.maximumCaptureOverheadMilliseconds,
        "Coverage timestamps must use real post-action observations",
      );
    const requestCount = integer(sample.requestCount, `${label}.requestCount`);
    assert(requestCount >= previousRequests, "Request counts cannot move backwards");
    previousRequests = requestCount;
    const retained = integer(sample.retainedSnapshots, `${label}.retainedSnapshots`);
    assert(
      retained >= 1 && retained <= 16 && retained >= previousRetained,
      "Retained publication history must remain bounded",
    );
    previousRetained = retained;
    const collectionDue = lastCollection === null ? loop >= 600_000 : loop - lastCollection >= 3_600_000;
    if (collectionDue) {
      observeResource(sample.resource, `${label}.resource`);
      lastCollection = loop;
    } else same(sample.resource, null, "Resource observations must follow the fixed warmup/hourly schedule");
    previousLoop = loop;
    previousCapture = captured;
    previousAppend = appended;
  }

  // A prefix may end while the next action is finishing, before its next sample.
  // Such events do not turn an unobserved tail into verified automatic time.
  const trailingLoopLimit = previousAppend + frozenSoakProfile.maximumLoopGapMilliseconds;
  let trailingAnchor = trailingLoopLimit;
  for (; actionIndex < actionEvents.length; actionIndex++) {
    const action = frozenSoakSchedule[actionIndex]!;
    assert(
      action.minute * MINUTE <= trailingLoopLimit - startedAt + CLOCK,
      "A trailing action cannot hide a missing stretch of samples",
    );
    const ended = timestamp(actionEvents[actionIndex]!.at, "trailing action.at");
    assert(
      ended > previousCapture &&
        ended >= startedAt + action.minute * MINUTE - CLOCK &&
        ended <= trailingAnchor + action.maximumDuration,
      "A trailing action must fit its bounded unobserved tail",
    );
    trailingAnchor = ended;
  }

  const result = {
    profile: frozenSoakProfile.id,
    attemptId: id,
    source: { head: frozenSoakProfile.head, tree: frozenSoakProfile.tree },
    compiledOutputsSha256: compiledHash,
    result: options.prefix ? "incomplete-prefix-not-acceptance" : "completed-frozen-chronology-audit",
    acceptedCompleteChronology: !options.prefix,
    startedAt: new Date(startedAt).toISOString(),
    lastCapturedAt: new Date(previousCapture).toISOString(),
    observedMilliseconds: previousCapture - startedAt,
    sampleCount: samples.length,
    completedActions: actionEvents.map((event) => event.event),
    suppressedActor: suppressionObserved && suppressedCandidates.length === 1 ? suppressedCandidates[0] : null,
    naturalRollover,
    cycles: cycles.summary(),
    cycleCoverage: coverage.summary(),
    timing: {
      maximumLoopGapMilliseconds: maximumLoopGap,
      maximumCaptureLagMilliseconds: maximumCaptureLag,
      maximumAppendDelayMilliseconds: maximumAppendDelay,
    },
    actionUncertainty,
    limits: [
      "Historical action events record completion only; action starts and internal states during those finite gaps are unobserved.",
      "Frozen final-section and cleanup heartbeat/route/page error latches were not retained; their absence cannot be certified or reconstructed by this audit.",
      "The suppressed actor is inferred only from a unique consistent exclusion across the retained complete fixture pages.",
      "Recorded source/build/response identities are retained evidence, not an independent attestation of physical execution or unavailable response bodies.",
      "A prefix never establishes completed duration, final cleanups or acceptance.",
      ...exclusions,
    ],
  };
  if (options.prefix) {
    for (const name of ["summary.json", "run-status.json", "service-cleanup.json", "browser-cleanup.json"])
      if (files[name] !== undefined) {
        const receipt = attemptRecord(files[name], id, name);
        if (name.endsWith("-cleanup.json")) {
          timestamp(receipt.at, `${name}.at`);
          array(receipt.failures, `${name}.failures`).forEach((failure) => text(failure, "cleanup failure"));
        } else {
          timestamp(receipt.startedAt, `${name}.startedAt`);
          timestamp(receipt.endedAt, `${name}.endedAt`);
          text(receipt.result, `${name}.result`);
          if (name === "summary.json") {
            sourceIdentity(object(receipt.input, "prefix summary.input"), "prefix summary");
            same(receipt.requestedMinutes, 480, "A prefix summary must retain this profile");
            same(receipt.fullMatrix, true, "A prefix summary must retain the full matrix");
            number(receipt.elapsedMilliseconds, "prefix summary elapsed");
            same(receipt.sampleCount, samples.length, "A prefix summary cannot invent retained samples");
          } else {
            same(receipt.startedAt, attempt.startedAt, "Prefix runtime and attempt must agree");
            text(receipt.bodyStatus, "prefix runtime bodyStatus");
            text(receipt.testStatus, "prefix runtime testStatus");
          }
        }
      }
    return result;
  }

  same(events.length, names.length, "A complete audit requires every action and final event");
  assert(
    previousCapture - startedAt >= DURATION - frozenSoakProfile.maximumLoopGapMilliseconds,
    "Samples must continue to the end of the complete duration",
  );
  assert(
    actionUncertainty.length === frozenSoakSchedule.length,
    "Every action must have a following bounded observation",
  );
  assert(
    suppressionObserved && suppressedCandidates.length === 1,
    "Complete post-suppression pages must identify one unique excluded actor",
  );
  assert(
    cursorPin && cursorPageOneObserved && cursorPageTwoObserved,
    "Both held cursor pages and the unchanged pin must have been observed",
  );
  assert(
    observations.networkBlank && observations.sourceBlank && observations.hidden,
    "The planned outages/background must have actual cleared observations",
  );
  assert(naturalRollover, "A real same-timezone local midnight must be observed");
  same([...pagesSeen].sort(), [...pageNames].sort(), "Every full fixture page must have been observed");
  assert(cycles.summary().completeCycles > 0, "Complete pinned cycles must have been observed");

  const summary = attemptRecord(files["summary.json"], id, "summary.json");
  sourceIdentity(object(summary.input, "summary.input"), "summary");
  for (const field of ["requestedMinutes", "fullMatrix", "browser", "executableSha256", "browserSelection", "node"])
    same(summary[field], start[field], `Summary ${field} must match the elapsed-start receipt`);
  same(summary.compiledOutputsSha256, compiledHash, "Summary and original build manifest must match");
  same(summary.result, "completed-full-real-duration-matrix", "The primary receipt must have finalized successfully");
  same(summary.matrixResult, summary.result, "The completed primary and matrix result must agree");
  same(summary.failure, null, "No matrix failure may be hidden");
  same(summary.sampleCount, samples.length, "Summary sample count must match the retained records");
  same(
    summary.completed,
    frozenSoakSchedule.map((action) => action.name),
    "Summary completion must match exact action order",
  );
  same(summary.naturalRollover, naturalRollover, "Summary midnight claim must match observed dates");
  same(
    [...array(summary.pagesSeen, "summary.pagesSeen")].sort(),
    [...pagesSeen].sort(),
    "Summary page coverage must match observations",
  );
  same(summary.cycles, samples.at(-1)!.cycles, "Final cycle counters must match the last recorded observation");
  same(
    summary.cycleCoverage,
    samples.at(-1)!.cycleCoverage,
    "Final coverage counters must match the last recorded observation",
  );
  const checks = object(summary.checks, "summary.checks");
  same(Object.keys(checks).sort(), [...requiredChecks].sort(), "The complete frozen matrix checks are required");
  for (const key of requiredChecks) same(checks[key], true, `Required matrix check: ${key}`);
  const finalResources = events[21]!;
  const finalResourceAt = timestamp(finalResources.at, "final-resources.at");
  assert(
    finalResourceAt >= previousAppend &&
      finalResourceAt >= startedAt + DURATION - CLOCK &&
      finalResourceAt - (startedAt + DURATION) <= 180_000,
    "The final resource observation must follow the complete sample timeline within the test timeout",
  );
  observeResource(finalResources.detail, "final resources");
  same(summary.baseline, baseline, "Resource baseline must match the first actual scheduled observation");
  same(
    summary.maxRetainedGrowth,
    maximumGrowth,
    "Resource growth must be recomputed from all retained observations including the final one",
  );
  same(
    summary.limits,
    { rendererRetainedHeapMiB: 64, testApiNodeHeapMiB: 128, testApiNodeRssMiB: 256, domNodes: 1000, listeners: 200 },
    "Frozen resource limits must remain unchanged",
  );
  same(summary.exclusions, exclusions, "Resource and receiving exclusions must remain explicit");
  const summaryStart = timestamp(summary.startedAt, "summary.startedAt");
  const summaryEnd = timestamp(summary.endedAt, "summary.endedAt");
  const duration = number(summary.elapsedMilliseconds, "summary.elapsedMilliseconds");
  assert(
    Math.abs(summaryStart - startedAt) <= CLOCK &&
      duration >= DURATION &&
      duration <= DURATION + 180_000 &&
      Math.abs(summaryEnd - summaryStart - duration) <= CLOCK,
    "Complete duration must match real start/end chronology and the fixed test timeout",
  );
  assert(summaryEnd >= finalResourceAt, "The primary body cannot end before final resource collection");
  const matrixEnd = events[22]!;
  const matrixAt = timestamp(matrixEnd.at, "matrix-end.at");
  assert(
    matrixAt >= summaryEnd && matrixAt - summaryEnd <= 5_000,
    "Matrix-end must follow the body summary without an unbounded gap",
  );
  same(
    matrixEnd.detail,
    { matrixResult: summary.result, elapsedMilliseconds: duration, acceptance: "pending-owned-cleanup" },
    "The matrix-end receipt must match the pending-cleanup body result",
  );
  let cleanupAt = matrixAt;
  for (const [stage, budget] of [
    ["service", 15_000],
    ["browser", 25_000],
  ] as const) {
    const cleanup = attemptRecord(files[`${stage}-cleanup.json`], id, `${stage} cleanup`);
    same(cleanup.failures, [], `The owned ${stage} cleanup must have no failures`);
    const at = timestamp(cleanup.at, `${stage} cleanup.at`);
    assert(
      at >= cleanupAt && at - cleanupAt <= budget + CLOCK,
      "Cleanup order and duration must match the owned bounded teardown",
    );
    cleanupAt = at;
  }
  const status = attemptRecord(files["run-status.json"], id, "run-status.json");
  same(status.startedAt, attempt.startedAt, "Runtime and attempt setup identities must match");
  same(status.bodyStatus, "passed", "The actual test body must have passed");
  same(status.testStatus, "passed", "The runtime must have finalized as passed");
  same(status.result, summary.result, "The runtime and primary result must agree");
  const endedAt = timestamp(status.endedAt, "run-status.endedAt");
  assert(endedAt >= cleanupAt && endedAt - cleanupAt <= 5_000, "Finalization must follow both owned cleanup receipts");
  same(summary.cleanupFinishedAt, status.endedAt, "The primary receipt must retain actual finalization time");
  same(summary.testStatus, "passed", "The primary receipt must retain successful runtime status");
  same(summary.cleanupChecks, { service: true, browser: true }, "Both owned cleanups must be affirmed");
  same(summary.cleanupFailures, [], "No cleanup/finalization failure may be hidden");
  same(events[23]!.at, status.endedAt, "Attempt-end must match final runtime completion");
  same(
    events[23]!.detail,
    { result: summary.result, testStatus: "passed" },
    "Attempt-end must retain the same successful result",
  );
  const counters = object(summary.counters, "summary.counters");
  const requests = integer(counters.requests, "summary requests");
  const aborted = integer(counters.networkAborts, "summary network aborts");
  assert(
    requests >= previousRequests && aborted > 0,
    "Final request counters must retain observed reads and the actual outage",
  );
  const responses = object(counters.responses, "summary responses");
  let responsesCount = 0;
  for (const [key, value] of Object.entries(responses)) {
    assert(/^[1-5]\d\d(?::[a-z][a-z0-9_]{0,127})?$/.test(key), "Response counter keys must remain bounded categories");
    const count = integer(value, `responses.${key}`);
    assert(count > 0, "Recorded response categories must have positive counts");
    responsesCount += count;
  }
  const classified = responsesCount + aborted;
  assert(classified <= requests, "Classified responses and aborts cannot exceed entered requests");
  const concurrent = integer(counters.concurrent, "body concurrent reads");
  const unclassified = requests - classified;
  assert(
    unclassified <= concurrent,
    "Unclassified requests must be bounded by reads still pending at the body snapshot",
  );
  assert(
    integer(responses["410:cursor_expired_refetch"], "actual cursor-expiry count") > 0,
    "The actual public cursor-expiry category is required",
  );
  integer(counters.bytes, "response bytes");
  const maximumConcurrent = integer(counters.maxConcurrent, "maximum concurrent reads");
  assert(
    maximumConcurrent > 0 && concurrent <= maximumConcurrent && maximumConcurrent <= requests,
    "Concurrent read counters must be coherent",
  );
  return {
    ...result,
    endedAt: status.endedAt,
    elapsedMilliseconds: duration,
    baseline,
    maxRetainedGrowth: maximumGrowth,
    bodyReadAccounting: {
      requests,
      responses: responsesCount,
      networkAborts: aborted,
      pendingReads: concurrent,
      unclassifiedRequests: unclassified,
      maximumConcurrentReads: maximumConcurrent,
      phase:
        "Body snapshot before owned service cleanup; pending reads may already be classified. The later cleanup receipt supplies the bounded drain outcome.",
    },
  };
}
