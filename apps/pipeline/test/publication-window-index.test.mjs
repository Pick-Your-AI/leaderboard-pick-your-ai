import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPublicScope, publicScopeKey } from "@pick-your-ai/contracts";
import { resolveMetricWindow } from "@pick-your-ai/metrics";
import { ControlStore } from "../../controls/src/store.mjs";
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
const options = (periods = ["30d"], changes = {}) => ({
  configurationVersion: "windows-v1",
  configurationHash: "a".repeat(64),
  dataMode: "synthetic",
  templates: periods.map((period) => ({ ...structuredClone(filter), period })),
  resolveMetricWindow,
  ...changes,
});
const fresh = () => ({ pipelinePublications: {}, pipelineHeads: {} });
function scopeAt(period, cutoff) {
  if (period === "all") return structuredClone(filter);
  const { from, to } = resolveMetricWindow(period, cutoff);
  return canonicalPublicScope({ ...filter, start: from, end: to });
}
function confirmation(scope, snapshotId, revision = 1, changes = {}) {
  return {
    recognitionFingerprint: null,
    configurationVersion: "windows-v1",
    configurationHash: "a".repeat(64),
    controlsConfigurationRevision: 0,
    aggregateExplanationHash: "b".repeat(64),
    dataMode: "synthetic",
    scopeKey: publicScopeKey(scope),
    snapshotId,
    revision,
    ...changes,
  };
}
function acknowledge(state, value) {
  state.pipelinePublications[value.snapshotId] = structuredClone(value);
  const prior = state.pipelineHeads[value.scopeKey];
  if (!prior || prior.revision <= value.revision) state.pipelineHeads[value.scopeKey] = structuredClone(value);
  return value;
}
function confirmed(index, state, scope, periods, id, revision = 1, changes = {}) {
  const value = acknowledge(state, confirmation(scope, id, revision, changes));
  index.record(state, scope, periods, value);
  return value;
}
const indexEntries = (state) => Object.values(state.pipelineWindowIndex)[0].entries;

test("unapproved full filters are unavailable; approved unpublished filters are empty", () => {
  const index = createPublicationWindowIndex(options());
  assert.deepEqual(index.read(fresh(), filter), { scope: filter, windows: [] });
  for (const changed of [
    { organization: "other" },
    { repository: null },
    { workstream: null },
    { context: "event" },
    { projects: ["project_a"] },
    { roles: ["reviewer"] },
  ]) {
    assert.equal(index.read(fresh(), canonicalPublicScope({ ...filter, ...changed })), null);
  }
  assert.throws(() => index.read(fresh(), scopeAt("30d", "2026-02-15T00:00:00.000Z")));
});

test("a SQL or historical receipt alone cannot create a discoverable window", () => {
  const index = createPublicationWindowIndex(options());
  const state = fresh();
  const scope = scopeAt("30d", "2026-02-15T00:00:00.000Z");
  const value = confirmation(scope, "snapshot-1");
  state.pipelinePublications[value.snapshotId] = value;
  assert.throws(() => index.record(state, scope, ["30d"], value));
  assert.equal(state.pipelineWindowIndex, undefined);
  assert.deepEqual(index.read(state, filter).windows, []);
  state.pipelineHeads[value.scopeKey] = value;
  delete state.pipelinePublications[value.snapshotId];
  assert.throws(() => index.record(state, scope, ["30d"], value));
  assert.equal(state.pipelineWindowIndex, undefined);
});

test("a confirmed publication preserves the complete exact filter and private confirmation", () => {
  const index = createPublicationWindowIndex(options());
  const state = fresh();
  const scope = scopeAt("30d", "2026-02-15T00:00:00.000Z");
  const value = confirmed(index, state, scope, ["30d"], "snapshot-1");
  assert.deepEqual(index.read(state, filter), {
    scope: filter,
    windows: [{ period: "30d", scope, confirmation: value }],
  });
  assert.equal(index.record(state, scope, ["30d"], value), false);
  assert.equal(Object.keys(indexEntries(state)).length, 1);
});

test("later cutoffs advance despite revision one; delayed high revisions cannot rewind them", () => {
  const index = createPublicationWindowIndex(options());
  const state = fresh();
  const earlier = scopeAt("30d", "2026-02-14T00:00:00.000Z");
  const later = scopeAt("30d", "2026-02-15T00:00:00.000Z");
  confirmed(index, state, earlier, ["30d"], "old-500", 500);
  confirmed(index, state, later, ["30d"], "new-1");
  const before = structuredClone(state.pipelineWindowIndex);
  const delayed = acknowledge(state, confirmation(earlier, "old-501", 501));
  assert.equal(index.record(state, earlier, ["30d"], delayed), false);
  assert.deepEqual(state.pipelineWindowIndex, before);
  assert.equal(index.read(state, filter).windows[0].confirmation.snapshotId, "new-1");
  assert.equal(state.pipelinePublications["old-501"].revision, 501);
});

test("same-scope confirmation follows its revision and retains delayed history without promotion", () => {
  const index = createPublicationWindowIndex(options());
  const state = fresh();
  const scope = scopeAt("30d", "2026-02-15T00:00:00.000Z");
  const first = confirmed(index, state, scope, ["30d"], "first");
  confirmed(index, state, scope, ["30d"], "second", 2);
  acknowledge(state, first);
  assert.equal(index.record(state, scope, ["30d"], first), false);
  assert.equal(index.read(state, filter).windows[0].confirmation.snapshotId, "second");
});

test("explicit calendar aliases require the complete approved label set and one confirmation", () => {
  const index = createPublicationWindowIndex(options(["year", "quarter", "month"]));
  const state = fresh();
  const scope = scopeAt("year", "2026-02-15T00:00:00.000Z");
  assert.deepEqual(scope, scopeAt("quarter", scope.end));
  const value = acknowledge(state, confirmation(scope, "q1-current"));
  for (const periods of [["year"], ["quarter"], ["year", "quarter", "quarter"], ["year", "quarter", "month"]]) {
    assert.throws(() => index.record(state, scope, periods, value));
    assert.equal(state.pipelineWindowIndex, undefined);
  }
  assert.equal(index.record(state, scope, ["year", "quarter"], value), true);
  assert.deepEqual(
    index.read(state, filter).windows.map(({ period, confirmation }) => [period, confirmation.snapshotId]),
    [
      ["quarter", "q1-current"],
      ["year", "q1-current"],
    ],
  );
  const month = scopeAt("month", scope.end);
  confirmed(index, state, month, ["month"], "feb-current");
  assert.deepEqual(
    index.read(state, filter).windows.map(({ period }) => period),
    ["month", "quarter", "year"],
  );
});

test("all-time is explicit and follows the confirmed undated scope without a client clock", () => {
  const index = createPublicationWindowIndex(options(["all"]));
  const state = fresh();
  confirmed(index, state, filter, ["all"], "all-1");
  confirmed(index, state, filter, ["all"], "all-2", 2);
  const selected = index.read(state, filter).windows[0];
  assert.equal(selected.period, "all");
  assert.equal(selected.scope.start, null);
  assert.equal(selected.scope.end, null);
  assert.equal(selected.confirmation.snapshotId, "all-2");
});

test("matching legacy and custom durations never infer a public period", () => {
  const scope = scopeAt("30d", "2026-02-15T00:00:00.000Z");
  for (const templates of [[scope], [{ ...scope, period: "custom" }], [{ ...filter }]]) {
    const index = createPublicationWindowIndex(options([], { templates }));
    const state = fresh();
    const value = acknowledge(state, confirmation(scope, "legacy"));
    assert.equal(index.record(state, scope, [], value), false);
    assert.equal(index.read(state, filter), null);
    assert.throws(() => index.record(state, scope, ["30d"], value));
    assert.equal(state.pipelineWindowIndex, undefined);
  }
});

test("configuration and data-mode namespaces do not borrow or replace earlier authority", () => {
  const state = fresh();
  const scope = scopeAt("30d", "2026-02-15T00:00:00.000Z");
  const first = createPublicationWindowIndex(options());
  confirmed(first, state, scope, ["30d"], "original");
  const original = structuredClone(state.pipelineWindowIndex);
  for (const changes of [
    { configurationVersion: "windows-v2" },
    { configurationHash: "c".repeat(64) },
    { dataMode: "public" },
  ]) {
    const index = createPublicationWindowIndex(options(["30d"], changes));
    assert.deepEqual(index.read(state, filter).windows, []);
    assert.deepEqual(state.pipelineWindowIndex, original);
  }
  const changed = { configurationVersion: "windows-v2", configurationHash: "c".repeat(64) };
  const second = createPublicationWindowIndex(options(["30d"], changed));
  confirmed(second, state, scope, ["30d"], "new-config", 2, changed);
  for (const [key, value] of Object.entries(original)) assert.deepEqual(state.pipelineWindowIndex[key], value);
  assert.equal(Object.keys(state.pipelineWindowIndex).length, 2);
  assert.equal(second.read(state, filter).windows[0].confirmation.snapshotId, "new-config");
  assert.equal(first.read(state, filter), null);
});

test("inputs and returned descriptions are detached; reading does not repair or mutate state", () => {
  const config = options();
  const index = createPublicationWindowIndex(config);
  config.templates[0].projects.length = 0;
  config.templates[0].period = "all";
  const state = fresh();
  const scope = scopeAt("30d", "2026-02-15T00:00:00.000Z");
  const value = confirmed(index, state, scope, ["30d"], "detached");
  const before = structuredClone(state);
  value.aggregateExplanationHash = "f".repeat(64);
  scope.projects.length = 0;
  const result = index.read(state, filter);
  result.scope.projects.length = 0;
  result.windows[0].scope.roles.length = 0;
  result.windows[0].confirmation.snapshotId = "forged";
  assert.deepEqual(state, before);
  assert.equal(index.read(state, filter).windows[0].confirmation.snapshotId, "detached");
});

test("changed or missing current private authority withholds the menu without an older fallback", () => {
  const index = createPublicationWindowIndex(options());
  const state = fresh();
  const scope = scopeAt("30d", "2026-02-15T00:00:00.000Z");
  confirmed(index, state, scope, ["30d"], "current");
  for (const mutate of [
    (copy) => delete copy.pipelineHeads[publicScopeKey(scope)],
    (copy) => delete copy.pipelinePublications.current,
    (copy) => {
      copy.pipelineHeads[publicScopeKey(scope)].aggregateExplanationHash = "f".repeat(64);
    },
    (copy) => {
      copy.pipelinePublications.current.configurationHash = "f".repeat(64);
    },
    (copy) => {
      copy.pipelineHeads[publicScopeKey(scope)].controlsConfigurationRevision++;
    },
  ]) {
    const copy = structuredClone(state);
    mutate(copy);
    const before = structuredClone(copy);
    assert.equal(index.read(copy, filter), null);
    assert.deepEqual(copy, before);
  }
});

test("corrupt index shapes, scope bindings and alias identities reject the complete read", () => {
  const index = createPublicationWindowIndex(options(["year", "quarter"]));
  const state = fresh();
  const scope = scopeAt("year", "2026-02-15T00:00:00.000Z");
  confirmed(index, state, scope, ["quarter", "year"], "shared");
  for (const mutate of [
    (namespace) => {
      namespace.schemaVersion = "private-publication-window-index/v2";
    },
    (namespace) => {
      namespace.configurationHash = "f".repeat(64);
    },
    (namespace) => {
      namespace.extra = true;
    },
    (namespace) => {
      namespace.entries = [];
    },
    (namespace) => {
      namespace.entries.extra = structuredClone(Object.values(namespace.entries)[0]);
    },
    (namespace) => {
      Object.values(namespace.entries)[0].scope.roles = ["reviewer"];
    },
    (namespace) => {
      Object.values(namespace.entries)[0].period = "custom";
    },
    (namespace) => {
      Object.values(namespace.entries)[0].confirmation.revision = 0;
    },
    (namespace) => {
      Object.values(namespace.entries)[0].confirmation.extra = true;
    },
    (namespace) => {
      Object.values(namespace.entries)[0].confirmation.snapshotId = "forked-alias";
    },
  ]) {
    const copy = structuredClone(state);
    mutate(Object.values(copy.pipelineWindowIndex)[0]);
    const before = structuredClone(copy);
    assert.throws(() => index.read(copy, filter));
    assert.deepEqual(copy, before);
  }
});

test("many cutoffs retain one bounded pointer and never scan confirmation history", () => {
  const index = createPublicationWindowIndex(options());
  const state = fresh();
  for (let day = 0; day < 400; day++) {
    const cutoff = new Date(Date.UTC(2025, 0, 1) + day * 86400000).toISOString();
    const scope = scopeAt("30d", cutoff);
    confirmed(index, state, scope, ["30d"], "rolling-" + day);
  }
  assert.equal(Object.keys(state.pipelinePublications).length, 400);
  assert.equal(Object.keys(indexEntries(state)).length, 1);
  state.pipelinePublications = new Proxy(state.pipelinePublications, {
    ownKeys() {
      throw new Error("history scan");
    },
  });
  state.pipelineHeads = new Proxy(state.pipelineHeads, {
    ownKeys() {
      throw new Error("head history scan");
    },
  });
  assert.equal(index.read(state, filter).windows[0].confirmation.snapshotId, "rolling-399");
});

test("invalid factory and publication metadata cannot create or partially modify the index", () => {
  for (const changed of [
    { configurationVersion: "" },
    { configurationHash: "invalid" },
    { dataMode: "unqualified" },
    { templates: Array(101).fill({ ...filter, period: "30d" }) },
    {
      templates: [
        { ...filter, period: "30d" },
        { ...filter, period: "30d" },
      ],
    },
    { templates: [{ ...filter, period: "future" }] },
    { templates: [{ ...scopeAt("30d", "2026-02-15T00:00:00.000Z"), period: "30d" }] },
    { resolveMetricWindow: null },
  ])
    assert.throws(() => createPublicationWindowIndex(options(["30d"], changed)));
  const index = createPublicationWindowIndex(options());
  const state = fresh();
  const scope = scopeAt("30d", "2026-02-15T00:00:00.000Z");
  const value = confirmed(index, state, scope, ["30d"], "original");
  for (const altered of [
    { ...value, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...value, recognitionFingerprint: "unqualified" },
    { ...value, controlsConfigurationRevision: -1 },
    { ...value, snapshotId: "bad\n" },
    { ...value, scopeKey: "other" },
    { ...value, aggregateExplanationHash: "bad" },
  ]) {
    const before = structuredClone(state);
    assert.throws(() => index.record(state, scope, ["30d"], altered));
    assert.deepEqual(state, before);
  }
});

test("confirmation, private head and discovery pointer commit or roll back in one actual SQLite transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "publication-window-index-"));
  const filename = join(directory, "controls.sqlite");
  let store = new ControlStore(filename);
  try {
    const index = createPublicationWindowIndex(options());
    const scope = scopeAt("30d", "2026-02-15T00:00:00.000Z");
    const initial = store.read();
    assert.throws(
      () =>
        store.transaction((state) => {
          state.pipelinePublications = {};
          state.pipelineHeads = {};
          confirmed(index, state, scope, ["30d"], "rolled-back");
          throw new Error("failure after pointer write");
        }),
      /failure after pointer write/,
    );
    assert.deepEqual(store.read(), initial);
    const publicBefore = store.publicSnapshot();
    store.transaction((state) => {
      state.pipelinePublications = {};
      state.pipelineHeads = {};
      confirmed(index, state, scope, ["30d"], "durable");
    });
    assert.deepEqual(store.publicSnapshot(), publicBefore);
    store.close();
    store = new ControlStore(filename);
    assert.equal(index.read(store.read(), filter).windows[0].confirmation.snapshotId, "durable");
    assert.equal(store.read().pipelinePublications["rolled-back"], undefined);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
