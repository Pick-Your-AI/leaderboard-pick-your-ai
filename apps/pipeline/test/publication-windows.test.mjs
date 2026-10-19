import assert from "node:assert/strict";
import test from "node:test";
import { resolveMetricWindow } from "../../../packages/metrics/dist/index.js";
import {
  approvedPublicationScope,
  resolvePublicationWindow,
  resolvePublicationWindows,
  validatePublicationPeriods,
} from "../src/publication-windows.mjs";
const base = { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null };
const cutoff = "2026-11-02T12:00:00.000Z";
const resolve = (template, at = cutoff) => resolvePublicationWindow(template, at, resolveMetricWindow);

test("all named presets materialize explicit UTC public bounds without publishing their internal label", () => {
  for (const [period, start] of [
    ["7d", "2026-10-26T12:00:00.000Z"],
    ["30d", "2026-10-03T12:00:00.000Z"],
    ["90d", "2026-08-04T12:00:00.000Z"],
    ["month", "2026-11-01T00:00:00.000Z"],
    ["quarter", "2026-10-01T00:00:00.000Z"],
    ["year", "2026-01-01T00:00:00.000Z"],
  ]) {
    const template = { ...base, period };
    validatePublicationPeriods([template]);
    const result = resolve(template);
    assert.deepEqual(result.scope, { ...base, start, end: cutoff });
    assert.equal(result.window.period, period);
    assert.equal(result.window.timezone, "UTC");
    assert.equal(approvedPublicationScope([template], result.scope, resolveMetricWindow), true);
    // A valid same-duration custom window has no authority under another preset.
    assert.equal(
      approvedPublicationScope(
        [{ ...base, period: "month" }],
        resolve({ ...base, period: "30d" }).scope,
        resolveMetricWindow,
      ),
      false,
    );
    assert.equal(
      approvedPublicationScope([template], { ...result.scope, repository: "2" }, resolveMetricWindow),
      false,
    );
    assert.deepEqual(template, { ...base, period });
  }
});

test("legacy exact/custom and all-time scopes retain their bounds and accept millisecond cutoffs", () => {
  const at = "2026-11-02T12:00:00.123Z";
  for (const template of [base, { ...base, period: "all" }]) {
    const result = resolve(template, at);
    assert.deepEqual(result.scope, base);
    assert.equal(result.window.period, "all");
    assert.equal(result.window.to, at);
  }
  const custom = { ...base, start: "2026-10-03T12:00:00.000Z", end: cutoff };
  for (const template of [custom, { ...custom, period: "custom" }]) {
    const result = resolve(template, at);
    assert.deepEqual(result.scope, custom);
    assert.equal(result.window.period, "custom");
  }
});

test("fractional or empty named cutoffs and ambiguous public identities fail closed", () => {
  assert.throws(() => resolve({ ...base, period: "30d" }, "2026-11-02T12:00:00.123Z"), /whole_second_cutoff/);
  assert.throws(() => resolve({ ...base, period: "month" }, "2026-11-01T00:00:00.000Z"), /empty_named_period/);
  for (const period of [null, "week", 30])
    assert.throws(() => validatePublicationPeriods([{ ...base, period }]), /invalid_public_period/);
  assert.throws(() => validatePublicationPeriods([{ ...base, period: "custom" }]), /custom_period_requires_bounds/);
  assert.throws(
    () => validatePublicationPeriods([{ ...base, period: "30d", start: "2026-10-03T12:00:00.000Z", end: cutoff }]),
    /unresolved_bounds/,
  );
  assert.throws(() => validatePublicationPeriods([base, { ...base, period: "all" }]), /duplicate_public_scope/);
  const templates = ["month", "quarter"].map((period) => ({ ...base, period }));
  const at = "2026-10-18T12:00:00.000Z";
  assert.throws(() => resolvePublicationWindows(templates, at, resolveMetricWindow), /ambiguous_public_period_bounds/);
  assert.equal(approvedPublicationScope(templates, resolve(templates[0], at).scope, resolveMetricWindow), false);
  const fixed = resolve({ ...base, period: "30d" }).scope;
  assert.throws(
    () => resolvePublicationWindows([fixed, { ...base, period: "30d" }], cutoff, resolveMetricWindow),
    /ambiguous_public_period_bounds/,
  );
});
