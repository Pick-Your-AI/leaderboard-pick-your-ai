import assert from "node:assert/strict";
import test from "node:test";
import { metricRegistrySchema } from "@pick-your-ai/contracts";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import { catalog, parameters, selection, uiHref } from "../src/remote/client.ts";
import { discoverMetrics, validateCatalogRoute } from "../src/remote/registry.ts";

const scope = selection(
  "?organization=Pick-Your-AI&repository=repo-1&workstream=T6&context=current&project=PVT_B,PVT_A" +
    "&role=reviewer,author&actors=user&start=2026-10-01T00:00:00.000Z&end=2026-10-18T00:00:00.000Z" +
    "&snapshot=served-pin&tz=America%2FNew_York&limit=37&q=pr%20merged",
);
const catalogPaths = ["/leaderboards", "/methodology", "/methodology/changes"];
const errorCode = (code) => (error) => error?.status === 400 && error?.code === code;

for (const { name, id } of [
  { name: "existing ASCII", id: "delivery" },
  { name: "spaces", id: "Future Department" },
  { name: "Unicode", id: "résearch" },
  { name: "paired Unicode", id: "Methods 🧪" },
  { name: "literal replacement character", id: "Literal �" },
  { name: "URL punctuation", id: "école / methods?version=1#A+B%" },
  { name: "more than 200 characters", id: "D".repeat(201) },
]) {
  test(`catalog department URLs retain the exact supplied ${name} ID`, () => {
    const raw = structuredClone(metricRegistryV1);
    const expected = discoverMetrics(catalog(raw), { ...scope, department: "delivery" }).map((metric) => metric.id);
    assert.ok(expected.includes("pr_merged"));
    raw.ui_metadata.departments.find((department) => department.id === "delivery").id = id;
    for (const entry of raw.ui_metadata.metrics) if (entry.department === "delivery") entry.department = id;
    const before = structuredClone(raw);
    const registry = catalog(raw);
    assert.ok(registry.ui_metadata.departments.some((department) => department.id === id));

    for (const path of catalogPaths) {
      const url = new URL(uiHref(path, { ...scope, department: id }), "https://example.invalid");
      validateCatalogRoute(path, url.search);
      const restored = selection(new URL(url.href).search);
      assert.equal(restored.department, id);
      assert.deepEqual({ ...restored, department: null }, scope);
      assert.deepEqual(
        discoverMetrics(registry, restored).map((metric) => metric.id),
        expected,
      );
      assert.equal(parameters(restored, { board: true }).toString(), parameters(scope, { board: true }).toString());
      assert.equal(parameters(restored).has("department"), false);
      for (const destination of ["/leaderboards/pr_merged", "/methodology/pr_merged", "/contributors", "/activity"]) {
        const next = new URL(uiHref(destination, restored), "https://example.invalid");
        assert.equal(next.searchParams.has("department"), false);
        assert.equal(next.searchParams.get("snapshot"), "served-pin");
        assert.throws(
          () => validateCatalogRoute(destination, url.search),
          errorCode("unsupported_catalog_filter_for_route"),
        );
      }
    }
    assert.deepEqual(raw, before);
  });
}

test("catalog department selection rejects empty, noncanonical, duplicate and unknown values", () => {
  for (const value of ["", " ", " delivery", "delivery ", "\tdepartment", "department\n"])
    assert.throws(() => selection(`?department=${encodeURIComponent(value)}`), errorCode("invalid_identifier"));
  for (const query of ["?department=delivery&department=delivery", "?department=delivery&unknown=x"])
    assert.throws(() => selection(query), errorCode("unsupported_or_duplicate_filter"));
  assert.throws(
    () => discoverMetrics(catalog(metricRegistryV1), selection("?department=Missing%20Department")),
    errorCode("unknown_registry_department"),
  );
  for (const key of ["snapshot", "metric", "category", "proof"])
    assert.throws(
      () => selection(`?department=delivery&${key}=not%20an%20identifier`),
      errorCode("invalid_identifier"),
    );
  for (const key of ["organization", "repository", "workstream"])
    assert.throws(() => selection(`?${key}=not%20an%20identifier`), errorCode("invalid_public_scope"));
  assert.throws(() => selection("?actors=not-an-actor-filter"), errorCode("invalid_actor_filter"));
  assert.throws(
    () => selection("?compare=not%20an%20identifier", { comparison: true }),
    errorCode("invalid_identifier"),
  );
});

test("catalog department URLs retain the complete navigation budget including encoded expansion", () => {
  const budget = 48 * 1024;
  const prefix = "?department=";
  const exact = prefix + "d".repeat(budget - prefix.length);
  assert.equal(selection(exact).department.length, budget - prefix.length);
  assert.throws(() => selection(exact + "d"), errorCode("selection_too_large"));
  const url = new URL(
    uiHref("/leaderboards", { ...scope, department: "é".repeat(budget / 6) }),
    "https://example.invalid",
  );
  assert.ok(url.search.length > budget);
  assert.throws(() => selection(url.search), errorCode("selection_too_large"));
});

const malformedIds = ["Malformed\ud800", "Malformed\udc00"];

test("non-transportable registry department IDs fail before form values can alias another supplied ID", () => {
  for (const id of malformedIds) {
    const raw = structuredClone(metricRegistryV1);
    const second = raw.ui_metadata.departments.find((department) => department.id !== "delivery").id;
    const renamed = new Map([
      ["delivery", id],
      [second, "Malformed�"],
    ]);
    for (const department of raw.ui_metadata.departments)
      if (renamed.has(department.id)) department.id = renamed.get(department.id);
    for (const entry of raw.ui_metadata.metrics)
      if (renamed.has(entry.department)) entry.department = renamed.get(entry.department);
    // The shared schema admits both exact strings; transport must not pick the other department.
    assert.equal(metricRegistrySchema.safeParse(raw).success, true);
    const form = new FormData();
    form.set("department", id);
    assert.equal(form.get("department"), "Malformed�");
    const before = structuredClone(raw);
    assert.throws(
      () => catalog(raw),
      (error) => error?.status === 502 && error?.code === "invalid_metric_registry",
    );
    assert.deepEqual(raw, before);
  }
});

test("catalog link producers reject ill-formed IDs before encoding and other routes still drop them", () => {
  for (const id of [...malformedIds, "before\ud800after", "before\udc00after"]) {
    for (const path of catalogPaths)
      assert.throws(() => uiHref(path, { ...scope, department: id }), errorCode("invalid_identifier"));
    for (const path of ["/leaderboards/pr_merged", "/methodology/pr_merged", "/contributors", "/activity"]) {
      const next = new URL(uiHref(path, { ...scope, department: id }), "https://example.invalid");
      assert.equal(next.searchParams.has("department"), false);
      assert.equal(next.searchParams.get("snapshot"), "served-pin");
    }
  }
});

test("department parsing rejects malformed UTF-8 and literal unpaired surrogates before identity replacement", () => {
  for (const encoded of ["%ED%A0%80", "%ED%B0%80", "%FF", "%C0%AF", "%E2%82", "%F4%90%80%80", "%80"])
    for (const key of ["department", "depart%6dent"]) {
      const query = `?q=valid&${key}=Malformed${encoded}&metric=pr_merged`;
      assert.match(new URLSearchParams(query).get("department"), /�/);
      assert.throws(() => selection(query), errorCode("invalid_identifier"));
    }
  for (const id of malformedIds) assert.throws(() => selection(`?department=${id}`), errorCode("invalid_identifier"));
});

test("department parsing preserves lossless percent punctuation and ordinary encoded Unicode", () => {
  for (const id of ["100%", "percent%2", "percent%GG", "percent%0G"])
    assert.equal(selection(`?department=${id}`).department, id);
  assert.equal(selection("?depart%6dent=Methods+%f0%9f%a7%aa").department, "Methods 🧪");
  assert.equal(selection("?department=Literal+%EF%BF%BD").department, "Literal �");
  assert.equal(selection("?department=Literal+�").department, "Literal �");
  assert.equal(selection("?department=percent%2520").department, "percent%20");
});
