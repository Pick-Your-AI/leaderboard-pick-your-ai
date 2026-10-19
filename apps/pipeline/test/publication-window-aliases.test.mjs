import test from "node:test";
import assert from "node:assert/strict";
import { canonicalPublicScope, publicScopeKey, publicWindowPeriods } from "@pick-your-ai/contracts";
import { resolveMetricWindow } from "@pick-your-ai/metrics";
import {
  approvedDiscoverablePublicationScope,
  resolveDiscoverablePublicationWindows,
} from "../src/publication-window-aliases.mjs";
import { createPublicationWindowIndex } from "../src/publication-window-index.mjs";

const filter = canonicalPublicScope({
  organization: "example",
  repository: "101",
  workstream: "T3",
  start: null,
  end: null,
  context: "current",
  projects: ["project_b", "project_a"],
  roles: ["author"],
});
const templates = (periods = publicWindowPeriods, changes = {}) =>
  periods.map((period) => ({ ...structuredClone(filter), ...structuredClone(changes), period }));
const resolve = (input, cutoff) => resolveDiscoverablePublicationWindows(input, cutoff, resolveMetricWindow);
const aliases = (publications) => publications.flatMap((item) => item.publicPeriods);
const scopeAt = (period, cutoff, changes = {}) => {
  const window = resolveMetricWindow(period, cutoff);
  return canonicalPublicScope({
    ...filter,
    ...changes,
    start: period === "all" ? null : window.from,
    end: period === "all" ? null : window.to,
  });
};
const byScope = (publications) => Object.fromEntries(publications.map((item) => [publicScopeKey(item.scope), item]));
const approved = (input, scope) => approvedDiscoverablePublicationScope(input, scope, resolveMetricWindow);

test("all seven explicit choices survive identical month, quarter and year boundaries", () => {
  for (const [cutoff, expectedCount, expectedAliases] of [
    ["2026-01-15T12:00:00.000Z", 5, ["month", "quarter", "year"]],
    ["2026-02-15T12:00:00.000Z", 6, ["quarter", "year"]],
    ["2026-10-18T12:00:00.000Z", 6, ["month", "quarter"]],
  ]) {
    const result = resolve(templates(), cutoff);
    assert.equal(result.length, expectedCount);
    assert.deepEqual(new Set(aliases(result)), new Set(publicWindowPeriods));
    const shared = result.find((item) => item.publicPeriods.length > 1);
    assert.deepEqual(shared.publicPeriods, expectedAliases);
    assert.equal(shared.window.period, expectedAliases.at(-1));
    assert.equal(new Set(result.map((item) => publicScopeKey(item.scope))).size, result.length);
    for (const item of result) {
      assert.equal(approved(templates(), item.scope), true);
      assert.equal(item.scope.context, "current");
      assert.deepEqual(item.scope.projects, ["project_a", "project_b"]);
      assert.deepEqual(item.scope.roles, ["author"]);
    }
  }
});

test("representative periods and alias order are independent of template order", () => {
  const input = templates();
  const cutoff = "2026-01-15T12:00:00.000Z";
  const forward = resolve(input, cutoff);
  const reversed = resolve([...input].reverse(), cutoff);
  assert.deepEqual(byScope(forward), byScope(reversed));
  assert.equal(forward.find((item) => item.publicPeriods.includes("month")).window.period, "year");
  assert.equal(resolve(templates(["month"]), cutoff)[0].window.period, "month");
  assert.equal(resolve(templates(["quarter"]), cutoff)[0].window.period, "quarter");
  assert.deepEqual(resolve(templates(["quarter", "year"]), cutoff)[0].publicPeriods, ["quarter", "year"]);
});

test("rolling and calendar coincidences share only their exact approved materialization", () => {
  const result = resolve(templates(), "2026-07-08T00:00:00.000Z");
  const shared = result.find((item) => item.publicPeriods.includes("7d"));
  assert.deepEqual(shared.publicPeriods, ["7d", "month", "quarter"]);
  assert.equal(shared.window.period, "quarter");
  assert.equal(shared.scope.start, "2026-07-01T00:00:00.000Z");
  const january = resolve(templates(), "2026-01-31T00:00:00.000Z");
  assert.deepEqual(january.find((item) => item.publicPeriods.includes("30d")).publicPeriods, [
    "30d",
    "month",
    "quarter",
    "year",
  ]);
  assert.equal(january.find((item) => item.publicPeriods.includes("30d")).window.period, "year");
});

test("only empty calendar-to-date intervals are omitted at exact UTC boundaries", () => {
  for (const [cutoff, missing] of [
    ["2026-01-01T00:00:00.000Z", ["month", "quarter", "year"]],
    ["2026-04-01T00:00:00.000Z", ["month", "quarter"]],
    ["2026-05-01T00:00:00.000Z", ["month"]],
  ]) {
    const result = resolve(templates(), cutoff);
    assert.deepEqual(
      new Set(aliases(result)),
      new Set(publicWindowPeriods.filter((period) => !missing.includes(period))),
    );
    for (const item of result) {
      assert.equal(item.scope.end, item.publicPeriods.includes("all") ? null : cutoff);
      assert.ok(item.window.from === null || item.window.from < item.window.to);
    }
  }
  assert.deepEqual(resolve(templates(["month", "quarter", "year"]), "2026-01-01T00:00:00.000Z"), []);
  assert.deepEqual(new Set(aliases(resolve(templates(), "2026-01-01T00:00:01.000Z"))), new Set(publicWindowPeriods));
});

test("UTC alias decisions preserve leap years, years below 100 and DST transitions", () => {
  for (const cutoff of [
    "2024-02-29T12:00:00.000Z",
    "0042-01-15T12:00:00.000Z",
    "2026-03-08T07:00:00.000Z",
    "2026-11-01T06:00:00.000Z",
  ]) {
    const result = resolve(templates(), cutoff);
    for (const item of result) {
      if (!item.publicPeriods.includes("all")) assert.equal(item.scope.end, cutoff);
      for (const period of item.publicPeriods) {
        assert.deepEqual(item.scope, scopeAt(period, cutoff));
      }
    }
    const rolling = result.find((item) => item.publicPeriods.includes("7d"));
    assert.equal(Date.parse(rolling.scope.end) - Date.parse(rolling.scope.start), 7 * 86400000);
  }
});

test("invalid clocks, sub-second clocks and inverted resolver intervals are never omitted", () => {
  for (const cutoff of [
    "2026-01-01T00:00:00.001Z",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00.000+00:00",
    "2026-02-30T00:00:00.000Z",
    "invalid",
  ]) {
    assert.throws(() => resolve(templates(["month"]), cutoff));
  }
  const cutoff = "2026-01-01T00:00:00.000Z";
  for (const replacement of [
    { from: "2026-01-02T00:00:00.000Z", to: cutoff },
    { from: "2026-02-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" },
  ]) {
    assert.throws(
      () =>
        resolveDiscoverablePublicationWindows(templates(["month"]), cutoff, (period) => ({
          timezone: "UTC",
          period,
          ...replacement,
        })),
      /empty_named_period_window/,
    );
  }
});

test("duplicate labels and legacy or custom collisions remain ambiguous", () => {
  const cutoff = "2026-02-15T12:00:00.000Z";
  const named = templates(["30d"]);
  const concrete = scopeAt("30d", cutoff);
  for (const input of [
    [...named, ...templates(["30d"])],
    [...templates(["all"]), structuredClone(filter)],
    [...named, { ...concrete, period: "custom" }],
    [...named, concrete],
  ]) {
    assert.throws(() => resolve(input, cutoff), /duplicate_public_scope|ambiguous_public_period_bounds/);
    assert.equal(approved(input, concrete), false);
  }
  assert.throws(
    () => resolve([{ ...filter, period: "month", start: concrete.start, end: concrete.end }], cutoff),
    /named_period_requires_unresolved_bounds/,
  );
});

test("legacy and custom scopes retain their engine window without acquiring a public period", () => {
  const cutoff = "2026-02-15T12:00:00.000Z";
  const concrete = scopeAt("30d", cutoff);
  for (const template of [concrete, { ...concrete, period: "custom" }, structuredClone(filter)]) {
    const [result] = resolve([template], cutoff);
    assert.deepEqual(result.publicPeriods, []);
    assert.equal(result.window.period, template.start === null ? "all" : "custom");
    assert.equal(approved([template], result.scope), true);
  }
  const [explicitAll] = resolve(templates(["all"]), cutoff);
  assert.deepEqual(explicitAll.publicPeriods, ["all"]);
  assert.equal(explicitAll.window.period, "all");
  assert.equal(explicitAll.scope.start, null);
  assert.equal(explicitAll.scope.end, null);
});

test("every full filter dimension remains distinct when bounds and period labels coincide", () => {
  const cutoff = "2026-01-15T12:00:00.000Z";
  for (const changes of [
    { organization: "other" },
    { repository: null },
    { workstream: null },
    { context: "event" },
    { projects: ["project_a"] },
    { roles: ["reviewer"] },
  ]) {
    const input = [...templates(["month", "year"]), ...templates(["month", "year"], changes)];
    const result = resolve(input, cutoff);
    assert.equal(result.length, 2);
    assert.notEqual(publicScopeKey(result[0].scope), publicScopeKey(result[1].scope));
    assert.deepEqual(result[0].publicPeriods, ["month", "year"]);
    assert.deepEqual(result[1].publicPeriods, ["month", "year"]);
    assert.equal(approved(templates(["month", "year"]), result[1].scope), false);
  }
});

test("retained scope approval uses the supplied cutoff without authorizing another date or label", () => {
  const input = templates(["month", "quarter", "year"]);
  const selected = scopeAt("month", "2026-01-15T12:00:00.000Z");
  const calls = [];
  assert.equal(
    approvedDiscoverablePublicationScope(input, selected, (...args) => {
      calls.push(args);
      return resolveMetricWindow(...args);
    }),
    true,
  );
  assert.equal(calls.length, 3);
  assert.ok(calls.every((args) => args[1] === selected.end));
  assert.equal(approved(input, { ...selected, start: "2026-01-02T00:00:00.000Z" }), false);
  assert.equal(approved(input, filter), false);
  assert.equal(approved(templates(["all"]), selected), false);
  assert.equal(approved(templates(["30d"]), selected), false);
  assert.equal(approved([], selected), false);
  assert.throws(() => approved(input, { ...selected, end: selected.start }));
});

test("input templates and previously resolved scope objects remain detached and unchanged", () => {
  const input = templates();
  const before = structuredClone(input);
  const first = resolve(input, "2026-01-15T12:00:00.000Z");
  const preserved = structuredClone(first);
  const second = resolve(input, "2026-01-15T12:00:00.000Z");
  assert.deepEqual(input, before);
  second[0].scope.projects.push("another");
  second[0].scope.roles.push("reviewer");
  second[0].publicPeriods.push("month");
  second[0].window.to = "2026-01-16T12:00:00.000Z";
  assert.deepEqual(first, preserved);
  assert.deepEqual(input, before);
});

test("finite configuration limits and unsupported period identities fail closed", () => {
  const cutoff = "2026-01-15T12:00:00.000Z";
  assert.throws(() => resolve(null, cutoff), /invalid_publication_window_templates/);
  assert.throws(() =>
    resolve(
      Array.from({ length: 101 }, () => templates(["30d"])[0]),
      cutoff,
    ),
  );
  assert.throws(() => resolve(templates(["week"]), cutoff), /invalid_public_period/);
  assert.throws(() => resolve(templates(["custom"]), cutoff), /custom_period_requires_bounds/);
  assert.throws(() => resolveDiscoverablePublicationWindows(templates(), cutoff, null));
  assert.equal(approved(templates(["week"]), scopeAt("30d", cutoff)), false);
  assert.deepEqual(resolve([], cutoff), []);
});

test("all approved aliases bind to one exact private confirmation per materialized scope", () => {
  for (const cutoff of ["2026-01-15T12:00:00.000Z", "2026-01-01T00:00:00.000Z"]) {
    const input = templates();
    const index = createPublicationWindowIndex({
      configurationVersion: "windows-v1",
      configurationHash: "a".repeat(64),
      dataMode: "synthetic",
      templates: input,
      resolveMetricWindow,
    });
    const state = { pipelinePublications: {}, pipelineHeads: {} };
    const publications = resolve(input, cutoff);
    for (const [position, publication] of publications.entries()) {
      const confirmation = {
        recognitionFingerprint: null,
        configurationVersion: "windows-v1",
        configurationHash: "a".repeat(64),
        controlsConfigurationRevision: 0,
        aggregateExplanationHash: "b".repeat(64),
        dataMode: "synthetic",
        scopeKey: publicScopeKey(publication.scope),
        snapshotId: "scope-" + position,
        revision: 1,
      };
      state.pipelinePublications[confirmation.snapshotId] = structuredClone(confirmation);
      state.pipelineHeads[confirmation.scopeKey] = structuredClone(confirmation);
      index.record(state, publication.scope, publication.publicPeriods, confirmation);
    }
    const menu = index.read(state, filter);
    assert.deepEqual(new Set(menu.windows.map((item) => item.period)), new Set(aliases(publications)));
    for (const publication of publications) {
      const choices = menu.windows.filter((item) => publication.publicPeriods.includes(item.period));
      assert.equal(new Set(choices.map((item) => item.confirmation.snapshotId)).size, 1);
      assert.ok(choices.every((item) => publicScopeKey(item.scope) === publicScopeKey(publication.scope)));
    }
  }
});
