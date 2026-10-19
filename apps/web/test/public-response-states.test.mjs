import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithOxc } from "vite";
import { createService } from "../../service/dist/app.js";
import { readFixture, at } from "../../../tests/fixtures/pending-metric.mjs";
import { activity, activityDetail, evidence, health, profile, ReadFailure, selection } from "../src/remote/client.ts";

// Exercise the shared production renderers, not a copied representation of their state labels.
async function rendererUrl(source, replacements = new Map()) {
  const transformed = await transformWithOxc(await readFile(source, "utf8"), fileURLToPath(source), {
    jsx: { runtime: "classic" },
  });
  const code = transformed.code.replace(/from "([^"]+)"/g, (_match, specifier) => {
    const target =
      replacements.get(specifier) ??
      (specifier.startsWith(".") ? new URL(specifier, source).href : import.meta.resolve(specifier));
    return `from ${JSON.stringify(target)}`;
  });
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}
const receiptUrl = await rendererUrl(new URL("../src/remote/Evidence.tsx", import.meta.url));
const { Receipt } = await import(receiptUrl);
const { ActivityFeed } = await import(
  await rendererUrl(new URL("../src/remote/Activity.tsx", import.meta.url), new Map([["./Evidence.tsx", receiptUrl]]))
);
const query = "category=pr_merged&snapshot=synthetic-pending-1";
const selected = selection(`?${query}`);
const states = ["observed", "pending", "accepted", "unknown"];

function stateFixture(versioned) {
  const input = readFixture();
  input.selected.portfolioEvidence = input.selected.evidence.map((entry, index) => {
    const state = states[index % states.length];
    if (versioned)
      entry.evidenceMetadata = {
        schemaVersion: "leaderboard-evidence/v1",
        artifactTitle: null,
        sourceAction: state === "accepted" ? "recognition_accepted" : "unknown",
        sourceOccurredAt: at,
        observedAt: at,
        activityState: state,
        acceptedAt: state === "accepted" ? at : null,
        history: { coverage: "not_supplied", records: [] },
      };
    return { ...structuredClone(entry), activityState: state, observedAt: at };
  });
  return input;
}

async function responses(t, input = readFixture()) {
  const original = JSON.stringify(input);
  const app = createService({
    now: () => Date.parse(at),
    source: {
      async read() {
        return structuredClone(input);
      },
    },
  });
  t.after(() => app.close());
  async function get(path) {
    const result = await app.inject(`/api/v1${path}?${query}`);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(JSON.stringify(input), original, "the service must preserve source inputs");
    return result.json();
  }
  const page = await get("/contributors/101");
  const feed = await get("/activity");
  const detail = await get(`/activity/${feed.groups[0].groupId}`);
  const proof = await get(`/evidence/${page.timeline[0].contribution.contributionId}`);
  return { page, feed, detail, proof, health: await get("/health") };
}

function unchanged(value, read) {
  const original = JSON.stringify(value);
  try {
    return read(value);
  } finally {
    assert.equal(JSON.stringify(value), original, "client reads must not normalize source bytes");
  }
}
function rejects(value, read, code) {
  assert.throws(
    () => unchanged(value, read),
    (error) => error instanceof ReadFailure && error.status === 502 && error.code === code,
  );
}
const readProfile = (value) => profile(value, selected);
const readFeed = (value) => activity(value, selected);
const readDetail = (value) => activityDetail(value, selected);
const readHealth = (value) => health(value, selected);
const readEvidence = (value) => evidence(value, selected);
const receipt = (value) => renderToStaticMarkup(React.createElement(Receipt, { value, selected }));
const feedMarkup = (value) => renderToStaticMarkup(React.createElement(ActivityFeed, { value, selected }));

test("service-produced legacy profile, evidence and groups retain explicit unknown states", async (t) => {
  const values = await responses(t);
  const parsed = unchanged(values.page, readProfile);
  assert.ok(parsed.timeline.every((row) => row.activityState === "unknown"));
  assert.deepEqual(parsed.categories, [{ metricId: "pr_merged", observed: 0, pending: 0, accepted: 0, unknown: 14 }]);
  assert.equal(readEvidence(values.proof).activityState, "unknown");
  assert.ok(readFeed(values.feed).groups.every((row) => row.activityState === "unknown"));
  assert.equal(readDetail(values.detail).group.activityState, "unknown");
  assert.equal(readHealth(values.health).status, "stale_or_degraded");
  assert.match(receipt(parsed.timeline[0]), /Acceptance state unknown/);
  assert.match(feedMarkup(readFeed(values.feed)), /Acceptance state unknown/);
});

for (const versioned of [false, true])
  test(`service-produced ${versioned ? "versioned" : "legacy"} metadata preserves all four literal work states`, async (t) => {
    const values = await responses(t, stateFixture(versioned));
    const parsed = unchanged(values.page, readProfile);
    assert.deepEqual([...new Set(parsed.timeline.map((row) => row.activityState))].sort(), [...states].sort());
    assert.deepEqual(
      [...new Set(readFeed(values.feed).groups.map((row) => row.activityState))].sort(),
      [...states].sort(),
    );
    assert.equal(readDetail(values.detail).proofs[0].activityState, values.detail.group.activityState);
    for (const state of states) {
      const row = parsed.timeline.find((row) => row.activityState === state);
      const html = receipt(row);
      assert.ok(
        html.includes(`<dt>Work state</dt><dd>${state === "unknown" ? "Acceptance state unknown" : state}</dd>`),
      );
      if (versioned && state === "accepted") assert.match(html, /Independent recognition receipt/);
      if (!versioned && state === "accepted") assert.match(html, /Unknown; the API supplies no acceptance timestamp/);
    }
  });

test("legacy absent and null evidence states preserve the existing unknown fallback", async (t) => {
  const { proof } = await responses(t);
  for (const omitted of [true, false]) {
    const value = structuredClone(proof);
    if (omitted) delete value.activityState;
    else value.activityState = null;
    const parsed = unchanged(value, readEvidence);
    assert.equal(parsed.activityState, "unknown");
    assert.match(receipt(parsed), /Unknown; neither acceptance nor its time can be inferred/);
  }
});

test("versioned metadata retains its fallback and rejects mismatching optional states", async (t) => {
  const { page } = await responses(t, stateFixture(true));
  for (const original of page.timeline) {
    const value = structuredClone(original);
    delete value.activityState;
    assert.equal(unchanged(value, readEvidence).activityState, original.evidenceMetadata.activityState);
    for (const state of [null, [original.activityState], [[original.activityState]]])
      rejects({ ...value, activityState: state }, readEvidence, "invalid_api_response");
  }
});

test("service health statuses and supported correction-history strings remain admitted", async (t) => {
  const input = readFixture();
  input.selected.snapshot.coverage[0].state = "complete";
  const values = await responses(t, input);
  assert.equal(readHealth(values.health).status, "recently_reconciled");
  for (const correctionHistory of ["not_supplied", "per_proof"]) {
    assert.ok(unchanged({ ...values.feed, correctionHistory }, readFeed).groups.length > 0);
    assert.ok(unchanged({ ...values.detail, correctionHistory }, readDetail).proofs.length > 0);
  }
});

for (const nested of [false, true])
  test(`${nested ? "nested" : "single"} array work states cannot become a profile or receipt label`, async (t) => {
    const values = await responses(t);
    for (const state of states) {
      const malformed = nested ? [[state]] : [state];
      const page = structuredClone(values.page);
      page.timeline[0].activityState = malformed;
      rejects(page, readProfile, "invalid_api_response");
      rejects(
        { ...values.proof, activityState: malformed },
        (value) => receipt(readEvidence(value)),
        "invalid_api_response",
      );
    }
  });

for (const nested of [false, true])
  test(`${nested ? "nested" : "single"} array group states cannot become an accepted activity label`, async (t) => {
    const values = await responses(t);
    for (const state of states) {
      const feed = structuredClone(values.feed);
      feed.groups[0].activityState = nested ? [[state]] : [state];
      rejects(feed, (value) => feedMarkup(readFeed(value)), "invalid_activity_response");
    }
  });

for (const nested of [false, true])
  test(`${nested ? "nested" : "single"} array health statuses are rejected`, async (t) => {
    const values = await responses(t);
    for (const status of ["recently_reconciled", "stale_or_degraded"])
      rejects({ ...values.health, status: nested ? [[status]] : [status] }, readHealth, "invalid_api_response");
  });

for (const nested of [false, true])
  test(`${nested ? "nested" : "single"} array history contracts are rejected for both feed and detail`, async (t) => {
    const values = await responses(t);
    for (const state of ["not_supplied", "per_proof"]) {
      const correctionHistory = nested ? [[state]] : [state];
      rejects({ ...values.feed, correctionHistory }, readFeed, "invalid_activity_response");
      rejects({ ...values.detail, correctionHistory }, readDetail, "invalid_activity_response");
    }
  });

test("non-state values and group contract changes retain their existing rejection", async (t) => {
  const values = await responses(t);
  for (const state of ["", "Accepted", " accepted ", "unreviewed", 0, true, {}, [], ["accepted", "pending"]]) {
    rejects({ ...values.proof, activityState: state }, readEvidence, "invalid_api_response");
    rejects({ ...values.health, status: state }, readHealth, "invalid_api_response");
    rejects({ ...values.feed, correctionHistory: state }, readFeed, "invalid_activity_response");
    const feed = structuredClone(values.feed);
    feed.groups[0].activityState = state;
    rejects(feed, readFeed, "invalid_activity_response");
  }
  for (const patch of [{ groupingVersion: "unreviewed" }, { previewLimit: 6 }, { previewLimit: "5" }])
    rejects({ ...values.feed, ...patch }, readFeed, "invalid_activity_response");
  for (const state of [null, undefined]) {
    rejects({ ...values.health, status: state }, readHealth, "invalid_api_response");
    rejects({ ...values.feed, correctionHistory: state }, readFeed, "invalid_activity_response");
  }
});

test("state validation preserves actor, category, scope and snapshot denial controls", async (t) => {
  const values = await responses(t);
  const page = structuredClone(values.page);
  page.timeline[0].contribution.actorId = "102";
  rejects(page, readProfile, "api_actor_mismatch");
  page.timeline[0].contribution.actorId = "101";
  page.timeline[0].contribution.metricIds = ["pr_opened"];
  rejects(page, readProfile, "api_filter_mismatch");
  rejects({ ...values.feed, category: "pr_opened" }, readFeed, "api_filter_mismatch");
  rejects({ ...values.feed, snapshotId: "foreign" }, readFeed, "api_snapshot_mismatch");
  rejects({ ...values.feed, scope: { ...values.feed.scope, repository: "foreign" } }, readFeed, "api_scope_mismatch");
  const detail = structuredClone(values.detail);
  detail.proofs[0].activityState = detail.group.activityState === "accepted" ? "observed" : "accepted";
  rejects(detail, readDetail, "invalid_activity_response");
});
