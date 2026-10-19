import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomBytes } from "node:crypto";
import { canonicalPublicScope, publicScopeKey, publicScopeParameters } from "@pick-your-ai/contracts";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { createPipeline } from "../src/index.mjs";
import { components, publicScope, fixtureId, ago } from "./harness.mjs";
import { publicScopeHarness, projectIds } from "./public-scope-harness.mjs";

const second = (value) => value.replace(/\.\d{3}Z$/, ".000Z");
const selected = (template, cutoff) => {
  const { period, ...scope } = template;
  const window = components.metrics.resolveMetricWindow(period, cutoff);
  return canonicalPublicScope({ ...scope, start: window.from, end: window.to });
};
const url = (scope, extra = {}) =>
  `/api/v1/boards?${new URLSearchParams({ ...publicScopeParameters(scope), metric: "issues_opened", ...extra })}`;
const board = async (runtime, scope, extra) => {
  const response = await runtime.app.inject(url(scope, extra));
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
};

test("named membership scopes preserve distinct pins, overlap counts and unknown event history", async (t) => {
  const templates = [
    { ...publicScope, context: "event", projects: [], period: "30d" },
    { ...publicScope, context: "current", projects: [], period: "30d" },
    { ...publicScope, context: "current", projects: [...projectIds].reverse(), period: "30d" },
    { ...publicScope, context: "event", projects: projectIds, period: "30d" },
  ];
  const h = await publicScopeHarness(t, { scopes: templates });
  const configured = structuredClone(h.config);
  const firstEnd = second(ago(1 / 24));
  const scopes = templates.map((template) => selected(template, firstEnd));
  const result = await h.runtime.runOnce({ cutoff: firstEnd });
  assert.equal(result.publications.length, templates.length);
  assert.equal(new Set(result.publications.map((p) => p.snapshotId)).size, templates.length);
  const views = [];
  for (const [index, scope] of scopes.entries()) {
    const view = await board(h.runtime, scope);
    views.push(view);
    assert.deepEqual(view.scope, scope);
    assert.equal(view.snapshotId, result.publications[index].snapshotId);
    const frozen = await h.frozen({ snapshotId: view.snapshotId });
    assert.equal(frozen.document.engineScope.period, "30d");
    assert.equal(frozen.document.engineScope.to, firstEnd);
    assert.equal(frozen.document.engineScope.context, scope.context ?? "event");
    assert.deepEqual(frozen.document.engineScope.projects, scope.projects ?? []);
    assert.ok(frozen.document.frozen.cutoff >= firstEnd);
    assert.equal(
      h.controlsStore.read().pipelinePublications[view.snapshotId].configurationHash,
      comparisonHash(configured),
    );
  }
  assert.equal(views[0].rows[0].result.value, 2, "unboarded work remains in the organization total");
  assert.equal(views[1].rows[0].result.value, 2);
  assert.equal(views[2].rows[0].result.value, 1, "overlapping Projects retain one underlying issue action");
  assert.equal(views[2].rows[0].evidenceIds.length, 1);
  assert.deepEqual(views[3].rows, [], "current inventory does not invent an event membership history");
  const unknown = await h.runtime.aggregateExplanations.read(views[3].snapshotId);
  assert.equal(unknown.document.metrics[0].coverage, "incomplete");
  assert.ok(unknown.document.metrics[0].audit.every((entry) => entry.reason === "unknown_membership_context"));
  for (const wrongScope of [scopes[0], scopes[1], scopes[3]]) {
    const rejected = await h.runtime.app.inject(url(wrongScope, { snapshot: views[2].snapshotId }));
    assert.equal(rejected.statusCode, 410, rejected.body);
  }
  const before = (await h.db.query("SELECT run_id FROM leaderboard_ingestion.collection_runs ORDER BY run_id")).rows;
  const absent = { ...scopes[2], projects: [projectIds[0]] };
  assert.equal((await h.runtime.app.inject(url(absent))).statusCode, 503);
  assert.deepEqual(
    (await h.db.query("SELECT run_id FROM leaderboard_ingestion.collection_runs ORDER BY run_id")).rows,
    before,
  );
  const nextEnd = second(new Date(Date.parse(firstEnd) + 1_800_000).toISOString());
  h.setMemberships([[], []]);
  await h.runtime.runOnce({ cutoff: nextEnd });
  const current = await board(h.runtime, selected(templates[2], nextEnd));
  assert.deepEqual(current.rows, []);
  assert.equal((await board(h.runtime, scopes[2], { snapshot: views[2].snapshotId })).rows[0].result.value, 1);
  assert.deepEqual(h.config, configured, "template resolution retains the exact approved configuration bytes");
});

test("webhook retry binds the original named current-Project key through confirmation and restart", async (t) => {
  const template = { ...publicScope, context: "current", projects: [...projectIds].reverse(), period: "30d" };
  const cutoff = second(new Date(Date.now() + 10000).toISOString());
  let now = cutoff;
  const h = await publicScopeHarness(t, { scopes: [template] });
  await h.runtime.stop();
  const options = { ...h.options, now: () => now, webhookDispatch: true };
  const runtime = await createPipeline(options);
  t.after(() => runtime.stop());
  const secret = randomBytes(32).toString("hex");
  const handler = components.ingestion.createWebhookHandler({
    secrets: [secret],
    scope: new Map([[1, new Set([2])]]),
    store: runtime.inbox,
  });
  const body = JSON.stringify({
    action: "opened",
    installation: { id: 1 },
    repository: { id: 2, private: false, visibility: "public", full_name: "synthetic-org/synthetic-repo" },
    sender: { node_id: "SYNTHETIC_SENDER_NOT_AUTHOR" },
    issue: { node_id: "SYNTHETIC_ISSUE_1", number: 1, created_at: ago(2).replace(/\.\d{3}Z$/, "Z") },
  });
  const response = await handler(
    new Request("http://localhost/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": fixtureId(9191),
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
    }),
  );
  assert.equal(response.status, 202, await response.text());
  assert.equal(await runtime.inbox.complete(await runtime.inbox.claim()), true);
  h.setSourceFailure(true);
  assert.equal(await runtime.dispatchOnce(), "retry_scheduled");
  const original = (await h.db.query("SELECT operation FROM leaderboard_ingestion.outbox")).rows[0].operation;
  assert.equal(original.cutoff, cutoff);
  now = new Date(Date.parse(cutoff) + 10000).toISOString();
  h.setSourceFailure(false);
  await h.db.query("UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp() WHERE state='pending'");
  assert.equal(await runtime.dispatchOnce(), "processed");
  const done = (await h.db.query("SELECT operation,completion FROM leaderboard_ingestion.outbox")).rows[0];
  assert.deepEqual(done.operation, original);
  const scope = selected(template, cutoff);
  const publication = done.completion.publications[0];
  assert.equal(publication.scopeKey, publicScopeKey(scope));
  assert.equal(h.controlsStore.read().pipelinePublications[publication.snapshotId].scopeKey, publicScopeKey(scope));
  const accepted = await board(runtime, scope, { snapshot: publication.snapshotId });
  assert.equal(accepted.rows[0].result.value, 1);
  assert.equal((await runtime.app.inject(url(selected(template, now)))).statusCode, 503);
  await runtime.stop();
  await h.reopenDatabase();
  const restarted = await createPipeline(options);
  t.after(() => restarted.stop());
  assert.deepEqual(await board(restarted, scope, { snapshot: publication.snapshotId }), accepted);
});

test("named role materializations preserve authorization, engine selection and retained pins", async (t) => {
  const templates = [
    { ...publicScope, period: "30d" },
    { ...publicScope, roles: ["reporter"], period: "30d" },
    { ...publicScope, roles: ["author"], period: "30d" },
    {
      ...publicScope,
      context: "current",
      projects: [...projectIds].reverse(),
      roles: ["reporter", "author", "reporter"],
      period: "30d",
    },
  ];
  const h = await publicScopeHarness(t, { scopes: templates });
  const configured = structuredClone(h.config);
  const cutoff = second(ago(1 / 24));
  const scopes = templates.map((template) => selected(template, cutoff));
  const result = await h.runtime.runOnce({ cutoff });
  assert.equal(result.state, "published");
  assert.equal(result.publications.length, templates.length);
  assert.equal(new Set(result.publications.map((entry) => entry.snapshotId)).size, templates.length);
  const views = [];
  for (const [index, scope] of scopes.entries()) {
    const view = await board(h.runtime, scope);
    views.push(view);
    assert.deepEqual(view.scope, scope);
    assert.equal(view.snapshotId, result.publications[index].snapshotId);
    assert.equal(view.schemaVersion, index === 0 ? "leaderboard/v1" : "public-read/v3");
    const frozen = await h.frozen({ snapshotId: view.snapshotId });
    assert.equal(frozen.document.engineScope.period, "30d");
    assert.deepEqual(frozen.document.engineScope.roles, scope.roles ?? []);
    assert.deepEqual(frozen.document.engineScope.projects, scope.projects ?? []);
    assert.equal(frozen.document.engineScope.to, cutoff);
    const confirmation = h.controlsStore.read().pipelinePublications[view.snapshotId];
    assert.equal(confirmation.scopeKey, publicScopeKey(scope));
    assert.equal(confirmation.configurationHash, comparisonHash(configured));
  }
  assert.equal(views[0].rows[0].result.value, 2);
  assert.equal(views[1].rows[0].result.value, 2);
  assert.deepEqual(views[2].rows, [], "an author-only named window cannot include issue reporter contributions");
  assert.ok(views[2].coverage.every((entry) => entry.state === "partial"));
  assert.equal(views[3].rows[0].result.value, 1, "overlapping roles and Projects do not sum duplicate actions");
  for (const wrongScope of [scopes[0], scopes[2], scopes[3]]) {
    const response = await h.runtime.app.inject(url(wrongScope, { snapshot: views[1].snapshotId }));
    assert.equal(response.statusCode, 410, response.body);
  }
  const before = (await h.db.query("SELECT run_id FROM leaderboard_ingestion.collection_runs ORDER BY run_id")).rows;
  const absent = canonicalPublicScope({ ...scopes[1], roles: ["reviewer"] });
  assert.equal((await h.runtime.app.inject(url(absent))).statusCode, 503);
  assert.deepEqual(
    (await h.db.query("SELECT run_id FROM leaderboard_ingestion.collection_runs ORDER BY run_id")).rows,
    before,
  );
  await h.reopenDatabase();
  assert.deepEqual(await board(h.runtime, scopes[1], { snapshot: views[1].snapshotId }), views[1]);
  assert.deepEqual(h.config, configured, "named role resolution preserves the original approval bytes and hash");
});
