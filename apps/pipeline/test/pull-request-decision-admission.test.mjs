import test from "node:test";
import assert from "node:assert/strict";
import { capturePullRequestDecisionHistory, validatePullRequestDecisionHistory } from "@pick-your-ai/github";
import { compareSourceInstants } from "@pick-your-ai/contracts";
import {
  assertPullRequestDecisionPersistence,
  parsePullRequestDecisionObservation,
  pullRequestDecisionObservationVersion,
  pullRequestDecisionProducerBinding,
} from "../../../packages/ingestion/dist/pull-request-decision-observation.js";
import { migrateDecisionHistoryRuns, readDecisionGenerations } from "../src/pull-request-decision-history.mjs";
import { decisionFixture, decisionRepository } from "../../../tests/fixtures/pull-request-decision-history.mjs";
import { components, harness } from "./harness.mjs";

const sourceId = "synthetic-installation:1";
const sourceRevision = "2026-01-07T00:00:00.000Z";
const eventCutoff = "2026-01-05T00:00:00.000Z";
const request = (runId) => ({
  runId,
  repositoryId: 2,
  family: "pull_requests",
  mode: "reconcile",
  since: null,
  until: eventCutoff,
});
const repositories = [{ ...decisionRepository, families: ["pull_requests"] }];
const row = async (db, runId) =>
  (await db.query("SELECT * FROM leaderboard_ingestion.collection_runs WHERE run_id=$1", [runId])).rows[0];
const counts = async (db, runId) =>
  (
    await db.query(
      "SELECT " +
        "(SELECT count(*)::integer FROM leaderboard_ingestion.source_facts WHERE first_run_id=$1) AS facts," +
        "(SELECT count(*)::integer FROM leaderboard_ingestion.collection_items WHERE run_id=$1) AS items," +
        "(SELECT count(*)::integer FROM leaderboard_ingestion.collection_pages WHERE run_id=$1) AS pages",
      [runId],
    )
  ).rows[0];
const boundedStore = (db, source, dataMode = "synthetic", selectedSource = sourceId) =>
  new components.ingestion.CollectionStore(db, {
    sourceId: selectedSource,
    dataMode,
    repositoryIds: [2],
    source,
  });
const emptyPage = () => ({
  repositoryId: 2,
  visibility: "public",
  facts: [],
  nextCursor: null,
  expectedCount: 0,
});

async function nativeObservation(scan, completedAt) {
  const fixture = decisionFixture();
  const options = {
    ...fixture.options,
    semanticRevision: sourceRevision,
    scanId: scan.runId,
    asOf: scan.until,
    now: () => completedAt,
  };
  const result = await capturePullRequestDecisionHistory(options);
  assert.equal(result.status, "captured");
  assert.equal(
    validatePullRequestDecisionHistory(result.receipt, {
      binding: result.receipt.binding,
      generation: { scanId: scan.runId, asOf: scan.until, cutoffMode: "exclusive" },
    }).status,
    "validated",
  );
  assert.deepEqual(
    fixture.state.calls.map((call) => call.operation),
    ["PullRequestDecisionAnchor", "PullRequestDecisionHistory", "PullRequestDecisionAnchor"],
  );
  return parsePullRequestDecisionObservation({
    schemaVersion: pullRequestDecisionObservationVersion,
    sourceRevision,
    binding: result.receipt.binding,
    generation: result.receipt.generation,
    result,
  });
}
function fact(observation) {
  return {
    subjectId: observation.binding.subject.id,
    sourceRevision,
    sourceUrl: observation.binding.subject.url,
    evidence: "current_state",
    actorId: null,
    occurredAt: null,
    state: "open",
    pullRequestDecisionHistory: observation,
  };
}

test(
  "decision persistence compares native nanoseconds with exact SQL microseconds and rejects missing clocks",
  async () => {
    const scan = request("synthetic-decision-precise-clock");
    const observedAt = "2026-01-08T00:00:00.123456Z";
    for (const [label, completedAt, admitted] of [
      ["before", "2026-01-08T00:00:00.123455999Z", true],
      ["equal", "2026-01-08T00:00:00.123456000Z", true],
      ["after", "2026-01-08T00:00:00.123456001Z", false],
    ]) {
      const observation = await nativeObservation(scan, completedAt);
      assert.equal(observation.result.receipt.capture.completedAt, completedAt);
      const check = () => assertPullRequestDecisionPersistence(observation, scan, observedAt, scan.runId);
      if (admitted) assert.doesNotThrow(check, label);
      else assert.throws(check, { message: "pull_request_decision_persistence_binding_changed" }, label);
      for (const invalid of [undefined, null, "", "not-an-instant", "2026-01-08T00:00:00.1234567890Z"])
        assert.throws(
          () => assertPullRequestDecisionPersistence(observation, scan, invalid, scan.runId),
          { message: "pull_request_decision_persistence_binding_changed" },
          label + ": invalid database clock",
        );
    }
  },
);

test(
  "completed empty runs cannot acquire or change trusted decision provenance or data mode",
  { timeout: 60_000 },
  async (t) => {
    const h = await harness(t, { memoryDatabase: true });
    await h.runtime.stop();
    const ordinary = new components.ingestion.CollectionStore(h.db);
    assert.equal(await ordinary.verifyPublic(2, 1, null), true);
    let reads = 0;
    const source = {
      assertAuthorized() {},
      async readPage() {
        reads++;
        return emptyPage();
      },
    };
    const trusted = boundedStore(h.db, source);
    const legacy = request("synthetic-decision-legacy-empty");
    await ordinary.start(legacy);
    assert.equal(await ordinary.step(legacy.runId, source), "complete");
    const legacyRow = await row(h.db, legacy.runId);
    assert.equal(legacyRow.decision_producer, null);
    assert.equal(legacyRow.item_count, 0);
    assert.equal(legacyRow.expected_count, 0);
    await assert.rejects(trusted.start(legacy), /pull_request_decision_producer_binding_changed/);
    await assert.rejects(trusted.step(legacy.runId, source), /pull_request_decision_producer_binding_changed/);
    assert.equal(await ordinary.step(legacy.runId, source), "complete");
    assert.equal(reads, 1, "complete legacy fast return does not recollect");
    assert.deepEqual(await row(h.db, legacy.runId), legacyRow);

    const selected = request("synthetic-decision-bound-empty");
    await trusted.start(selected);
    assert.equal(await trusted.step(selected.runId, source), "complete");
    const selectedRow = await row(h.db, selected.runId);
    assert.equal(selectedRow.decision_producer, pullRequestDecisionProducerBinding(sourceId, "synthetic"));
    await assert.rejects(ordinary.start(selected), /pull_request_decision_producer_binding_changed/);
    await assert.rejects(ordinary.step(selected.runId, source), /pull_request_decision_producer_binding_changed/);
    await assert.rejects(boundedStore(h.db, source, "public").start(selected), /producer_binding_changed/);
    await assert.rejects(
      boundedStore(h.db, source, "synthetic", "synthetic-other-source:1").start(selected),
      /producer_binding_changed/,
    );
    await assert.rejects(trusted.step(selected.runId, { ...source }), /pull_request_decision_producer_changed/);
    const originalRead = source.readPage;
    source.readPage = async () => {
      throw new Error("replacement must never run");
    };
    try {
      await assert.rejects(trusted.step(selected.runId, source), /pull_request_decision_producer_changed/);
    } finally {
      source.readPage = originalRead;
    }
    const originalAuthorize = source.assertAuthorized;
    source.assertAuthorized = () => {};
    try {
      await assert.rejects(trusted.step(selected.runId, source), /pull_request_decision_producer_changed/);
    } finally {
      source.assertAuthorized = originalAuthorize;
    }
    assert.equal(reads, 2);
    const cutoff = (
      await h.db.query(
        "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS cutoff",
      )
    ).rows[0].cutoff;
    const restore = (dataMode) =>
      h.db.transaction((tx) =>
        readDecisionGenerations(tx, {
          selectedRuns: [{ repositoryId: 2, runId: selected.runId }],
          repositories,
          source: sourceId,
          asOf: eventCutoff,
          observationCutoff: cutoff,
          dataMode,
          assertAuthorized: source.assertAuthorized,
        }),
      );
    const healthy = await restore("synthetic");
    assert.deepEqual(healthy.selections, []);
    assert.deepEqual(healthy.capture.runs[0].observations, []);
    await assert.rejects(restore("public"), /decision_history_selected_run_unavailable/);
    await assert.rejects(
      h.db.query("UPDATE leaderboard_ingestion.collection_runs SET decision_producer=$2 WHERE run_id=$1", [
        legacy.runId,
        pullRequestDecisionProducerBinding(sourceId, "synthetic"),
      ]),
      /immutable_decision_producer/,
    );
    await assert.rejects(
      h.db.query("UPDATE leaderboard_ingestion.collection_runs SET decision_producer=NULL WHERE run_id=$1", [
        selected.runId,
      ]),
      /immutable_decision_producer/,
    );
    await migrateDecisionHistoryRuns(h.db);
    assert.deepEqual(await row(h.db, legacy.runId), legacyRow);
    assert.deepEqual(await row(h.db, selected.runId), selectedRow);
    assert.deepEqual(await counts(h.db, selected.runId), { facts: 0, items: 0, pages: 1 });
  },
);

test(
  "a custom unbound collection cannot promote even an actual valid native decision receipt",
  { timeout: 60_000 },
  async (t) => {
    const h = await harness(t, { memoryDatabase: true });
    await h.runtime.stop();
    const ordinary = new components.ingestion.CollectionStore(h.db);
    assert.equal(await ordinary.verifyPublic(2, 1, null), true);
    const scan = request("synthetic-decision-unbound-native");
    const observation = await nativeObservation(scan, "2026-01-08T00:00:00.000Z");
    const source = {
      async readPage() {
        return { ...emptyPage(), expectedCount: 1, facts: [fact(observation)] };
      },
    };
    await ordinary.start(scan);
    assert.equal(await ordinary.step(scan.runId, source), "failed");
    const failed = await row(h.db, scan.runId);
    assert.equal(failed.decision_producer, null);
    assert.equal(failed.reason, "source_schema_drift");
    assert.equal(failed.page_count, 0);
    assert.deepEqual(await counts(h.db, scan.runId), { facts: 0, items: 0, pages: 0 });
    const config = structuredClone(h.options.config);
    config.repositories[0].families = ["pull_requests"];
    const { createPipeline } = await import("../src/runtime.mjs");
    await assert.rejects(
      createPipeline({ ...h.options, config, source, pullRequestDecisionRepositoryIds: [2] }),
      /decision_history_builtin_source_required/,
    );
  },
);

test(
  "decision collection rejects missing SQL clock aliases inside the actual insertion transaction",
  { timeout: 60_000 },
  async (t) => {
    const h = await harness(t, { memoryDatabase: true });
    await h.runtime.stop();
    const ordinary = new components.ingestion.CollectionStore(h.db);
    assert.equal(await ordinary.verifyPublic(2, 1, null), true);
    let observation;
    const source = {
      assertAuthorized() {},
      async readPage(scan) {
        observation = await nativeObservation(scan, "2026-01-08T00:00:00.000Z");
        return { ...emptyPage(), expectedCount: 1, facts: [fact(observation)] };
      },
    };
    const trusted = boundedStore(h.db, source);
    for (const [index, invalid] of [undefined, null, "not-an-instant"].entries()) {
      const scan = request("synthetic-decision-missing-clock-" + index);
      await trusted.start(scan);
      const transaction = h.db.transaction;
      let actual;
      let rejected;
      h.db.transaction = (work) =>
        transaction(async (tx) => {
          try {
            return await work({
              query: async (sql, params) => {
                const result = await tx.query(sql, params);
                if (sql.startsWith("INSERT INTO leaderboard_ingestion.source_facts")) {
                  assert.match(sql, /AS decision_observed_at/);
                  assert.equal(result.rows.length, 1);
                  actual = structuredClone(result.rows[0]);
                  assertPullRequestDecisionPersistence(
                    observation,
                    scan,
                    actual.decision_observed_at,
                    actual.first_run_id,
                  );
                  result.rows[0].decision_observed_at = invalid;
                }
                return result;
              },
            });
          } catch (error) {
            rejected = error;
            throw error;
          }
        });
      try {
        assert.equal(await trusted.step(scan.runId, source), "failed");
      } finally {
        h.db.transaction = transaction;
      }
      assert.ok(actual);
      assert.match(actual.decision_observed_at, /\.\d{6}Z$/);
      assert.equal(rejected?.message, "pull_request_decision_persistence_binding_changed");
      assert.equal((await row(h.db, scan.runId)).reason, "source_commit_failed");
      assert.deepEqual(await counts(h.db, scan.runId), { facts: 0, items: 0, pages: 0 });
    }
    const healthy = request("synthetic-decision-real-clock");
    await trusted.start(healthy);
    assert.equal(await trusted.step(healthy.runId, source), "complete");
    const persisted = (
      await h.db.query(
        "SELECT first_run_id,document," +
          "to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS observed_at " +
          "FROM leaderboard_ingestion.source_facts WHERE first_run_id=$1",
        [healthy.runId],
      )
    ).rows;
    assert.equal(persisted.length, 1);
    const restored = parsePullRequestDecisionObservation(persisted[0].document.pullRequestDecisionHistory);
    assert.equal(
      compareSourceInstants(restored.result.receipt.capture.completedAt, persisted[0].observed_at) <= 0,
      true,
    );
    assertPullRequestDecisionPersistence(restored, healthy, persisted[0].observed_at, persisted[0].first_run_id);
    assert.deepEqual(await counts(h.db, healthy.runId), { facts: 1, items: 1, pages: 1 });
  },
);

test(
  "a replaced authorization callback cannot bless the final trusted collection commit",
  { timeout: 60_000 },
  async (t) => {
    const h = await harness(t, { memoryDatabase: true });
    await h.runtime.stop();
    const ordinary = new components.ingestion.CollectionStore(h.db);
    assert.equal(await ordinary.verifyPublic(2, 1, null), true);
    let authorizationChecks = 0;
    const source = {
      assertAuthorized() {
        authorizationChecks++;
      },
      async readPage() {
        return emptyPage();
      },
    };
    const originalAuthorize = source.assertAuthorized;
    const trusted = boundedStore(h.db, source);
    const scan = request("synthetic-decision-final-authorization");
    await trusted.start(scan);
    const transaction = h.db.transaction;
    let changed = false;
    let rejected;
    h.db.transaction = (work) =>
      transaction(async (tx) => {
        try {
          return await work({
            query: async (sql, params) => {
              const result = await tx.query(sql, params);
              if (sql.startsWith("UPDATE leaderboard_ingestion.collection_runs SET cursor")) {
                changed = true;
                source.assertAuthorized = () => {};
              }
              return result;
            },
          });
        } catch (error) {
          rejected = error;
          throw error;
        }
      });
    try {
      assert.equal(await trusted.step(scan.runId, source), "failed");
    } finally {
      source.assertAuthorized = originalAuthorize;
      h.db.transaction = transaction;
    }
    assert.equal(changed, true);
    assert.ok(authorizationChecks > 0);
    assert.equal(rejected?.message, "pull_request_decision_producer_changed");
    assert.equal((await row(h.db, scan.runId)).reason, "source_commit_failed");
    assert.deepEqual(await counts(h.db, scan.runId), { facts: 0, items: 0, pages: 0 });
    assert.equal(await trusted.step(scan.runId, source), "complete");
    assert.deepEqual(await counts(h.db, scan.runId), { facts: 0, items: 0, pages: 1 });
    const asyncSource = {
      ...source,
      async assertAuthorized() {
        throw new Error("synthetic asynchronous authorization refusal");
      },
    };
    const asynchronous = request("synthetic-decision-asynchronous-authorization");
    await assert.rejects(
      boundedStore(h.db, asyncSource).start(asynchronous),
      /pull_request_decision_authorization_invalid/,
    );
    assert.equal(await row(h.db, asynchronous.runId), undefined);
  },
);
