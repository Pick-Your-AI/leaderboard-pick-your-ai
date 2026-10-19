import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPublicScope, publicScopeKey } from "@pick-your-ai/contracts";
import { selection, uiHref } from "../src/remote/client.ts";
import {
  choosePublishedWindow,
  readPublishedWindows,
  windowFilterScope,
  windowParameters,
  windowStartHref,
  windowStartIntent,
} from "../src/remote/published-windows.ts";

const filters = canonicalPublicScope({
  organization: "Pick-Your-AI",
  repository: "2",
  workstream: "w1",
  start: null,
  end: null,
  context: "current",
  projects: ["PVT_A", "PVT_B="],
  roles: ["author", "reviewer"],
});
const start = "2026-09-18T12:00:00.000Z";
const end = "2026-10-18T12:00:00.000Z";
const selected = () => ({
  ...selection("?actors=automation&metric=pr_merged&limit=25&tz=Pacific%2FHonolulu"),
  ...structuredClone(filters),
  start: "2026-08-01T00:00:00.000Z",
  end: "2026-09-01T00:00:00.000Z",
  snapshot: "old-publication",
  cursor: "old.signature",
  proof: "old-proof",
  compare: "baseline-publication",
  compareStart: "2026-07-01T00:00:00.000Z",
  compareEnd: "2026-08-01T00:00:00.000Z",
});
const published = () => ({
  schemaVersion: "public-windows/v1",
  scope: structuredClone(filters),
  windows: [
    { period: "30d", scope: { ...structuredClone(filters), start, end }, snapshotId: "confirmed-30d", revision: 3 },
    { period: "all", scope: structuredClone(filters), snapshotId: "confirmed-all", revision: 8 },
  ],
});
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const reordered = (object) => Object.fromEntries(Object.entries(object).reverse());

test("only the new start route acquires a 30-day default", () => {
  const intent = windowStartIntent("/start", "");
  assert.equal(intent.period, "30d");
  assert.equal(intent.selected.start, null);
  assert.equal(intent.selected.end, null);
  assert.equal(intent.selected.snapshot, null);
  for (const path of ["/", "/health", "/leaderboards/pr_merged", "/contributors/101", "/live", "/start/"])
    assert.equal(windowStartIntent(path, "?snapshot=retained&start=unchanged"), null, path);
  const legacy = selection("?snapshot=retained");
  assert.equal(legacy.snapshot, "retained");
  assert.equal(legacy.start, null);
  assert.equal(legacy.end, null);
});

test("explicit new-entry intent retains complete filters, actors, metric and display zone", () => {
  const intent = windowStartIntent(
    "/start",
    "?period=quarter&organization=Pick-Your-AI&repository=2&workstream=w1&context=current&project=PVT_B%3D,PVT_A&role=reviewer,author&actors=automation&metric=pr_merged&limit=25&tz=Pacific%2FHonolulu&ui=api",
  );
  assert.equal(intent.period, "quarter");
  assert.deepEqual(windowFilterScope(intent.selected), filters);
  assert.equal(intent.selected.actors, "automation");
  assert.equal(intent.selected.metric, "pr_merged");
  assert.equal(intent.selected.limit, "25");
  assert.equal(intent.selected.timeZone, "Pacific/Honolulu");
});

test("new entry rejects retained dates, pins, cursors, proof and baseline instead of reinterpreting them", () => {
  for (const key of ["start", "end", "snapshot", "cursor", "proof", "compare", "compareStart", "compareEnd"])
    for (const value of ["", "retained"])
      assert.throws(() => windowStartIntent("/start", `?${key}=${value}`), { code: "invalid_window_entry" });
  for (const raw of ["period=30d&period=7d", "ui=prototype", "ui="])
    assert.throws(() => windowStartIntent("/start", `?${raw}`), { code: "invalid_window_entry" });
  for (const raw of ["period=", "period=custom", "period=latest", "period=30D"])
    assert.throws(() => windowStartIntent("/start", `?${raw}`), { code: "invalid_window_period" });
});

test("new entry preserves existing validation and budgets the complete route", () => {
  for (const raw of ["actors=manual", "project=A,,B", "role=operator", "context=historical", "tz=unknown", "unknown=1"])
    assert.throws(() => windowStartIntent("/start", `?${raw}`), { status: 400 });
  assert.throws(() => windowStartIntent("/start", `?${"a".repeat(48 * 1024 - 6)}`), { code: "query_too_large" });
});

test("new Browse links clear retained identities while copied legacy links keep them", () => {
  const value = selected();
  const before = structuredClone(value);
  const oldHref = uiHref("/leaderboards/pr_merged", value, { cursor: value.cursor });
  const href = windowStartHref(value);
  const url = new URL(href, "https://synthetic.example");
  assert.equal(url.pathname, "/start");
  assert.equal(url.searchParams.get("period"), "30d");
  for (const key of ["start", "end", "snapshot", "cursor", "proof", "compare", "compareStart", "compareEnd"])
    assert.equal(url.searchParams.has(key), false, key);
  assert.equal(url.searchParams.get("ui"), "api");
  const intent = windowStartIntent(url.pathname, url.search);
  assert.deepEqual(windowFilterScope(intent.selected), filters);
  assert.equal(intent.selected.actors, value.actors);
  assert.equal(intent.selected.metric, value.metric);
  assert.equal(intent.selected.timeZone, value.timeZone);
  assert.deepEqual(value, before);
  assert.equal(uiHref("/leaderboards/pr_merged", value, { cursor: value.cursor }), oldHref);
  assert.equal(new URL(oldHref, "https://synthetic.example").searchParams.get("snapshot"), "old-publication");
});

test("discovery parameters include only the canonical undated source filter", () => {
  const value = selected();
  const before = structuredClone(value);
  assert.equal(
    windowParameters(value).toString(),
    "organization=Pick-Your-AI&repository=2&workstream=w1&context=current&project=PVT_A%2CPVT_B%3D&role=author%2Creviewer",
  );
  assert.deepEqual(windowFilterScope(value), filters);
  assert.deepEqual(value, before);
});

test("discovery uses the existing bounded public transport and exact full scope", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return response(published());
  });
  const value = await readPublishedWindows("/api/v1", selected(), new AbortController().signal);
  assert.deepEqual(value, published());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/v1/windows?${windowParameters(selected())}`);
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.accept, "application/json");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test("transport mutation cannot replace the original requested membership or roles", async (t) => {
  const original = selected();
  t.mock.method(globalThis, "fetch", async () => {
    original.projects.splice(0, 2, "PVT_OTHER");
    original.roles.splice(0, 2, "author");
    const body = published();
    body.scope = windowFilterScope(original);
    for (const item of body.windows) item.scope = { ...body.scope, start: item.scope.start, end: item.scope.end };
    return response(body);
  });
  await assert.rejects(readPublishedWindows("/api/v1", original, new AbortController().signal), {
    status: 502,
    code: "api_windows_mismatch",
  });
});

test("discovery accepts object key reordering without accepting changed scope bytes", async (t) => {
  const body = published();
  body.scope = reordered(body.scope);
  body.windows = body.windows.map((item) => reordered({ ...item, scope: reordered(item.scope) }));
  t.mock.method(globalThis, "fetch", async () => response(reordered(body)));
  const value = await readPublishedWindows("/api/v1", selected(), new AbortController().signal);
  assert.deepEqual(value, published());
});

test("browser discovery rejects false period labels and scope/version substitution", async (t) => {
  let body;
  t.mock.method(globalThis, "fetch", async () => response(body));
  const mutations = [
    (x) => (x.schemaVersion = "public-read/v3"),
    (x) => (x.scope.context = "event"),
    (x) => x.scope.projects.reverse(),
    (x) => x.windows[0].scope.roles.pop(),
    (x) => (x.windows[0].scope.schemaVersion = "public-scope/v2"),
    (x) => (x.windows[0].scope.start = "2026-09-19T12:00:00.000Z"),
    (x) => (x.windows[0].scope.end = "2026-10-18T12:00:00.001Z"),
    (x) => (x.windows[0].scope.end = "2026-02-30T12:00:00.000Z"),
    (x) => (x.windows[0].snapshotId = ""),
    (x) => (x.windows[0].revision = 0),
    (x) => (x.windows[0].privateDocument = {}),
    (x) => (x.approval = true),
  ];
  for (const mutate of mutations) {
    body = published();
    mutate(body);
    await assert.rejects(readPublishedWindows("/api/v1", selected(), new AbortController().signal), {
      status: 502,
      code: "api_windows_mismatch",
    });
  }
});

test("missing 30-day publication never selects all-time or issues a data request", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(new URL(url, "https://synthetic.example").pathname);
    const value = published();
    value.windows.shift();
    return response(value);
  });
  const intent = windowStartIntent("/start", windowStartHref(selected()).split("?")[1]);
  const available = await readPublishedWindows("/api/v1", intent.selected, new AbortController().signal);
  assert.throws(() => choosePublishedWindow(intent.selected, available, intent.period), {
    status: 503,
    code: "public_window_unavailable",
  });
  assert.deepEqual(calls, ["/api/v1/windows"]);
  assert.equal(available.windows[0].period, "all");
});

test("unavailable discovery preserves the service failure without another source or endpoint", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return response({ error: "public_windows_unavailable" }, 503);
  });
  await assert.rejects(readPublishedWindows("/api/v1", selected(), new AbortController().signal), {
    status: 503,
    code: "public_windows_unavailable",
  });
  assert.equal(calls, 1);
});

test("pre-aborted discovery makes no transport call", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return response(published());
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readPublishedWindows("/api/v1", selected(), controller.signal), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("a late transport response cannot resolve an aborted preset intent", async (t) => {
  let finish;
  t.mock.method(globalThis, "fetch", () => new Promise((resolve) => (finish = resolve)));
  const controller = new AbortController();
  const pending = readPublishedWindows("/api/v1", selected(), controller.signal);
  controller.abort();
  finish(response(published()));
  await assert.rejects(pending, { name: "AbortError" });
});

test("100 maximum-length encoded Project IDs retain the default, complete scope and confirmed pin", async (t) => {
  const projects = Array.from(
    { length: 100 },
    (_, index) => `PVT_${String(index).padStart(3, "0")}_${":".repeat(120)}`,
  );
  assert.ok(projects.every((value) => value.length === 128));
  let body;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    return response(body);
  });
  for (const roles of [[], ["author", "reviewer"]]) {
    const input = { ...filters, projects, roles };
    delete input.schemaVersion;
    const scope = canonicalPublicScope(input);
    const query = new URLSearchParams({
      ...Object.fromEntries(windowParameters(scope)),
      actors: "user",
      metric: "pr_merged",
      limit: "25",
      tz: "America/New_York",
    });
    assert.ok(query.toString().length > 16 * 1024);
    assert.ok(query.toString().length < 48 * 1024);
    const intent = windowStartIntent("/start", `?${query}`);
    assert.equal(intent.period, "30d");
    assert.equal(intent.selected.snapshot, null);
    assert.deepEqual(windowFilterScope(intent.selected), scope);
    body = {
      ...published(),
      scope,
      windows: published().windows.map((item) => ({
        ...item,
        scope: { ...scope, start: item.scope.start, end: item.scope.end },
      })),
    };
    const available = await readPublishedWindows("/api/v1", intent.selected, new AbortController().signal);
    assert.equal(calls.at(-1), `/api/v1/windows?${windowParameters(scope)}`);
    const chosen = choosePublishedWindow(intent.selected, available, intent.period);
    const board = new URL(uiHref("/leaderboards/pr_merged", chosen), "https://synthetic.example");
    const pinned = selection(board.search);
    assert.deepEqual(windowFilterScope(pinned), scope);
    assert.equal(pinned.start, start);
    assert.equal(pinned.end, end);
    assert.equal(pinned.snapshot, "confirmed-30d");
    assert.equal(pinned.actors, "user");
    assert.equal(pinned.metric, "pr_merged");
    assert.equal(pinned.limit, "25");
    assert.equal(pinned.timeZone, "America/New_York");
    const entry = new URL(windowStartHref(chosen), board);
    assert.ok(entry.pathname.length + entry.search.length < 48 * 1024);
    assert.deepEqual(windowFilterScope(windowStartIntent(entry.pathname, entry.search).selected), scope);
    assert.equal(entry.searchParams.has("snapshot"), false);
  }
  assert.equal(calls.length, 2);
});

test("discovery budgets the complete configured target before any fetch", async (t) => {
  const projects = Array.from(
    { length: 100 },
    (_, index) => `PVT_${String(index).padStart(3, "0")}_${":".repeat(120)}`,
  );
  const value = selection(`?${windowParameters({ ...filters, projects })}`);
  const base = `/synthetic/${"b".repeat(16 * 1024)}`;
  assert.ok(`${base}/windows?${windowParameters(value)}`.length > 48 * 1024);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return response(published());
  });
  await assert.rejects(readPublishedWindows(base, value, new AbortController().signal), {
    status: 414,
    code: "query_too_large",
  });
  assert.equal(calls, 0);
});

test("preset selection uses published dates and pin while retaining view and baseline intent", (t) => {
  t.mock.method(Date, "now", () => Date.parse("2099-01-01T00:00:00.000Z"));
  const original = selected();
  const available = published();
  const before = structuredClone({ original, available });
  const value = choosePublishedWindow(original, available, "30d");
  assert.equal(value.start, start);
  assert.equal(value.end, end);
  assert.equal(value.snapshot, "confirmed-30d");
  assert.equal(value.cursor, null);
  assert.equal(value.proof, null);
  assert.equal(value.actors, original.actors);
  assert.equal(value.metric, original.metric);
  assert.equal(value.timeZone, original.timeZone);
  assert.equal(value.compare, original.compare);
  assert.equal(value.compareStart, original.compareStart);
  assert.equal(value.compareEnd, original.compareEnd);
  assert.equal(publicScopeKey(windowFilterScope(value)), publicScopeKey(filters));
  value.projects.push("PVT_DETACHED");
  assert.deepEqual({ original, available }, before);
});

test("all-time remains an explicit confirmed null-bound choice", () => {
  const value = choosePublishedWindow(selected(), published(), "all");
  assert.equal(value.start, null);
  assert.equal(value.end, null);
  assert.equal(value.snapshot, "confirmed-all");
  assert.equal(value.cursor, null);
});

test("choice application rechecks descriptor identity instead of trusting a mutable prior read", () => {
  const body = published();
  body.windows[0].scope.projects.push("PVT_OTHER");
  assert.throws(() => choosePublishedWindow(selected(), body, "30d"), { status: 502, code: "api_windows_mismatch" });
  assert.throws(() => choosePublishedWindow(selected(), published(), "custom"), {
    status: 400,
    code: "invalid_window_period",
  });
});

test("explicit January and February calendar aliases share only their exact confirmed materialization", async (t) => {
  let body;
  t.mock.method(globalThis, "fetch", async () => response(body));
  for (const [periods, cutoff] of [
    [["month", "quarter", "year"], "2026-01-18T12:00:00.000Z"],
    [["quarter", "year"], "2026-02-18T12:00:00.000Z"],
  ]) {
    body = {
      schemaVersion: "public-windows/v1",
      scope: structuredClone(filters),
      windows: periods.map((period) => ({
        period,
        scope: { ...structuredClone(filters), start: "2026-01-01T00:00:00.000Z", end: cutoff },
        snapshotId: "confirmed-calendar",
        revision: 4,
      })),
    };
    const available = await readPublishedWindows("/api/v1", selected(), new AbortController().signal);
    for (const period of periods) {
      const value = choosePublishedWindow(selected(), available, period);
      assert.equal(value.start, "2026-01-01T00:00:00.000Z");
      assert.equal(value.end, cutoff);
      assert.equal(value.snapshot, "confirmed-calendar");
    }
  }
});

test("named aliases cannot fork the same scope identity or reuse a snapshot in another scope", async (t) => {
  let body;
  t.mock.method(globalThis, "fetch", async () => response(body));
  for (const mismatch of ["snapshotId", "revision"]) {
    body = {
      schemaVersion: "public-windows/v1",
      scope: structuredClone(filters),
      windows: ["quarter", "year"].map((period) => ({
        period,
        scope: {
          ...structuredClone(filters),
          start: "2026-01-01T00:00:00.000Z",
          end: "2026-02-18T12:00:00.000Z",
        },
        snapshotId: "confirmed-calendar",
        revision: 4,
      })),
    };
    body.windows[1][mismatch] = mismatch === "revision" ? 5 : "other-confirmation";
    await assert.rejects(readPublishedWindows("/api/v1", selected(), new AbortController().signal), {
      code: "api_windows_mismatch",
    });
  }
  body = published();
  body.windows[1].snapshotId = body.windows[0].snapshotId;
  await assert.rejects(readPublishedWindows("/api/v1", selected(), new AbortController().signal), {
    code: "api_windows_mismatch",
  });
});

test("selected display timezone cannot move a discovered half-open UTC window", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    const body = published();
    body.windows[0].scope.start = "2026-10-16T12:00:00.000Z";
    body.windows[0].scope.end = "2026-11-15T12:00:00.000Z";
    return response(body);
  });
  const values = [];
  for (const timeZone of ["UTC", "America/New_York"]) {
    const value = { ...selected(), timeZone };
    const available = await readPublishedWindows("/api/v1", value, new AbortController().signal);
    values.push(choosePublishedWindow(value, available, "30d"));
  }
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1]);
  assert.equal(values[0].start, "2026-10-16T12:00:00.000Z");
  assert.equal(values[0].end, "2026-11-15T12:00:00.000Z");
  assert.equal(values[1].start, values[0].start);
  assert.equal(values[1].end, values[0].end);
  assert.equal(values[0].snapshot, values[1].snapshot);
  assert.equal(values[1].timeZone, "America/New_York");
});
