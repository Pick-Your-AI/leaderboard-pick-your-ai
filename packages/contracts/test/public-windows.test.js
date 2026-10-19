import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalPublicScope,
  parsePublicWindows,
  publicWindowPeriods,
  publicWindowsSchemaVersion,
} from "../dist/index.js";
import { resolveMetricWindow } from "../../metrics/dist/index.js";

const filter = { organization: "Pick-Your-AI", repository: "2", workstream: null, start: null, end: null };
const end = "2026-10-18T12:00:00.000Z";
const starts = {
  "7d": "2026-10-11T12:00:00.000Z",
  "30d": "2026-09-18T12:00:00.000Z",
  "90d": "2026-07-20T12:00:00.000Z",
  month: "2026-10-01T00:00:00.000Z",
  quarter: "2026-10-01T00:00:00.000Z",
  year: "2026-01-01T00:00:00.000Z",
  all: null,
};
function fixture(scope = filter) {
  return {
    schemaVersion: publicWindowsSchemaVersion,
    scope: structuredClone(scope),
    windows: publicWindowPeriods.map((period) => ({
      period,
      scope: { ...structuredClone(scope), start: starts[period], end: period === "all" ? null : end },
      snapshotId: "synthetic-" + (period === "quarter" ? "month" : period),
      revision: 2,
    })),
  };
}
const parse = (value, scope = filter) => parsePublicWindows(value, scope, resolveMetricWindow);
const rejected = (change, scope = filter) => {
  const value = fixture(scope);
  change(value);
  assert.throws(() => parse(value, scope), /invalid_public_windows/);
};

test("discovery preserves all seven exact UTC choices and canonical legacy, Project and role identities", () => {
  for (const scope of [
    filter,
    canonicalPublicScope({ ...filter, context: "current", projects: ["PVT_A", "PVT_B="] }),
    canonicalPublicScope({ ...filter, context: "current", projects: ["PVT_A"], roles: ["author", "reviewer"] }),
  ]) {
    const value = fixture(scope);
    assert.deepEqual(parse(value, scope), value);
    const reordered = JSON.parse(JSON.stringify(value), (_key, v) =>
      v && !Array.isArray(v) && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse()) : v,
    );
    assert.deepEqual(parse(reordered, scope), value);
  }
});

test("calendar labels can share a confirmed publication in January and throughout Q1", () => {
  for (const [date, periods] of [
    ["2026-01-05T12:00:00.000Z", ["month", "quarter", "year"]],
    ["2026-02-18T12:00:00.000Z", ["quarter", "year"]],
    ["2026-03-31T12:00:00.000Z", ["quarter", "year"]],
  ]) {
    const value = { schemaVersion: publicWindowsSchemaVersion, scope: filter, windows: periods.map((period) => ({
      period, scope: { ...filter, start: "2026-01-01T00:00:00.000Z", end: date },
      snapshotId: "synthetic-shared-calendar", revision: 1,
    })) };
    assert.deepEqual(parse(value), value);
    value.windows[1].revision = 2;
    assert.throws(() => parse(value), /invalid_public_windows/);
  }
  rejected((v) => { v.windows[4].snapshotId = "synthetic-other"; });
  rejected((v) => { v.windows[1].snapshotId = v.windows[0].snapshotId; });
});

test("every full filter dimension is bound without organization or role fallback", () => {
  const scope = canonicalPublicScope({ ...filter, context: "current", projects: ["PVT_A"], roles: ["author"] });
  for (const change of [
    (s) => { s.organization = "Other"; },
    (s) => { s.repository = null; },
    (s) => { s.workstream = "other"; },
    (s) => { s.context = "event"; },
    (s) => { s.projects = ["PVT_B"]; },
    (s) => { s.roles = ["reviewer"]; },
  ]) {
    rejected((v) => change(v.scope), scope);
    rejected((v) => change(v.windows[0].scope), scope);
  }
});

test("wire scopes reject aliases, duplicate or unsorted dimensions and extra fields", () => {
  const scope = canonicalPublicScope({ ...filter, context: "current", projects: ["PVT_A", "PVT_B"], roles: ["author", "reviewer"] });
  for (const change of [
    (s) => { s.projects.reverse(); },
    (s) => { s.projects.push("PVT_A"); },
    (s) => { s.roles.reverse(); },
    (s) => { s.roles.push("author"); },
    (s) => { delete s.roles; },
    (s) => { s.schemaVersion = "public-scope/v2"; },
    (s) => { s.period = "30d"; },
  ]) rejected((v) => change(v.windows[0].scope), scope);
  rejected((v) => { v.scope.context = "event"; });
  rejected((v) => { v.scope.projects = []; });
});

test("a period label cannot certify a different duration, calendar anchor or non-UTC clock", () => {
  for (const change of [
    (v) => { v.windows[0].period = "30d"; },
    (v) => { v.windows[0].scope.start = "2026-10-12T12:00:00.000Z"; },
    (v) => { v.windows[3].scope.start = "2026-09-01T00:00:00.000Z"; },
    (v) => { v.windows[0].scope.end = "2026-10-18T12:00:00.001Z"; },
    (v) => { v.windows[0].scope.end = "2026-10-18T08:00:00.000-04:00"; },
    (v) => { v.windows[0].scope.end = "2026-02-30T12:00:00.000Z"; },
    (v) => { v.windows[0].scope.start = null; },
    (v) => { v.windows[6].scope.start = starts["30d"]; v.windows[6].scope.end = end; },
    (v) => { v.windows[3].scope.start = v.windows[3].scope.end; },
  ]) rejected(change);
});

test("UTC rolling and calendar validation survives DST, leap day and years below 100", () => {
  for (const [period, start, cutoff] of [
    ["7d", "2026-03-02T07:00:00.000Z", "2026-03-09T07:00:00.000Z"],
    ["7d", "2026-10-26T06:00:00.000Z", "2026-11-02T06:00:00.000Z"],
    ["month", "2024-02-01T00:00:00.000Z", "2024-02-29T23:59:59.000Z"],
    ["year", "0099-01-01T00:00:00.000Z", "0099-12-31T23:59:59.000Z"],
  ]) {
    const value = { schemaVersion: publicWindowsSchemaVersion, scope: filter, windows: [
      { period, scope: { ...filter, start, end: cutoff }, snapshotId: "synthetic-boundary", revision: 1 },
    ] };
    assert.deepEqual(parse(value), value);
  }
});

test("discovery rejects unsupported versions, fields, periods and unbounded or ambiguous menus", () => {
  for (const change of [
    (v) => { v.schemaVersion = "public-windows/v2"; },
    (v) => { v.privateControls = "synthetic-private"; },
    (v) => { v.windows[0].cutoff = end; },
    (v) => { v.windows[0].period = "custom"; },
    (v) => { v.windows[0].period = "30D"; },
    (v) => { v.windows.reverse(); },
    (v) => { v.windows.push(structuredClone(v.windows[0])); },
    (v) => { v.windows[1] = structuredClone(v.windows[0]); },
    (v) => { delete v.windows[0]; },
    (v) => { delete v.scope; },
  ]) rejected(change);
  assert.deepEqual(parse({ schemaVersion: publicWindowsSchemaVersion, scope: filter, windows: [] }).windows, []);
});

test("only positive safe revisions and bounded public snapshot identifiers are admitted", () => {
  for (const revision of [0, -1, 1.5, "1", true, null, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])
    rejected((v) => { v.windows[0].revision = revision; });
  for (const snapshotId of ["", "x".repeat(201), "a/b", "a b", null, 1, "a\n"])
    rejected((v) => { v.windows[0].snapshotId = snapshotId; });
});

test("discovery cannot reinterpret a dated request or silently replace the trusted resolver", () => {
  assert.throws(() => parse(fixture(), { ...filter, start: starts["30d"], end }), /invalid_public_windows/);
  assert.throws(() => parsePublicWindows(fixture(), filter, () => { throw new Error("unavailable"); }), /invalid_public_windows/);
  assert.throws(() => parsePublicWindows(fixture(), filter, () => ({ from: null, to: end })), /invalid_public_windows/);
});

test("parsed choices detach every mutable scope dimension from the provider and caller", () => {
  const scope = canonicalPublicScope({ ...filter, projects: ["PVT_A"], roles: ["author"] });
  const value = fixture(scope);
  const parsed = parse(value, scope);
  const before = structuredClone(parsed);
  scope.projects.push("PVT_B");
  value.scope.roles.push("reviewer");
  value.windows[0].scope.projects.push("PVT_C");
  assert.deepEqual(parsed, before);
});
