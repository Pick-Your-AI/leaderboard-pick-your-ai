import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createPipeline } from "../src/index.mjs";
import { components, fixtureId, harness } from "./harness.mjs";
import {
  operatorAllow,
  operatorHarness,
  operatorSettings,
  insertOperatorDelivery,
  queueOperatorReplay,
  publishedOperatorReplay,
} from "./operator-harness.mjs";

const unavailable = (error) => {
  assert.match(error.message, /^operation_result_(?:unavailable|changed)$/);
  return true;
};
async function retained(h) {
  const result = {};
  for (const [table, order] of [
    ["replay_receipts", "receipt_id"],
    ["replay_processing_results", "receipt_id"],
    ["inbox", "delivery_id"],
    ["attempt_history", "lease_token"],
    ["observations", "event_key"],
    ["outbox", "event_key"],
  ])
    result[table] = (
      await h.db.query(
        `SELECT row_to_json(retained)::text AS bytes FROM leaderboard_ingestion.${table} AS retained ORDER BY ${order}`,
      )
    ).rows;
  return result;
}
async function resultFixture(h, state) {
  if (state === "legacy") {
    await insertOperatorDelivery(h);
    await h.db.query(
      "INSERT INTO leaderboard_ingestion.replay_receipts(receipt_id,delivery_id,prior_attempts,audit) VALUES('synthetic-legacy',$1,0,$2::jsonb)",
      [fixtureId(1), JSON.stringify({ repositoryId: 2, operatorId: "201", policyVersion: "synthetic-legacy-policy" })],
    );
    return { id: "synthetic-legacy", expected: ["unknown", "legacy_unbound"] };
  }
  const receipt = await queueOperatorReplay(h);
  if (state === "processing") {
    assert.ok(await h.runtime.inbox.claim());
  } else if (state === "failed" || state === "superseded") {
    assert.equal(await h.runtime.inbox.fail(await h.runtime.inbox.claim(), "source_unavailable", true), true);
    if (state === "superseded") {
      const row = (await h.runtime.operations.read(2, operatorAllow)).quarantined[0];
      await h.runtime.operations.replay(
        {
          repositoryId: 2,
          deliveryId: row.deliveryId,
          expectedRevision: row.revision,
          reason: "source_recovered",
          operatorId: "201",
        },
        operatorAllow,
      );
    }
  } else if (state === "processed") {
    assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
  } else if (state === "unavailable") {
    await h.db.query(
      "UPDATE leaderboard_ingestion.repository_access SET generation=generation+1 WHERE repository_id=2",
    );
  }
  const expected = {
    queued: ["queued", "awaiting_intake"],
    processing: ["processing", "intake_in_progress"],
    failed: ["failed", "intake_failed"],
    superseded: ["superseded", "later_replay_queued"],
    processed: ["processed", "awaiting_publication"],
    unavailable: ["unavailable", "source_generation_changed"],
  }[state];
  return { ...receipt, expected };
}

for (const state of ["legacy", "queued", "processing", "failed", "superseded", "processed", "unavailable"]) {
  test(`runtime replay currentness covers the ${state} retained result without requiring publication`, async (t) => {
    let current = () => true;
    let readAt;
    const scopes = [];
    const h = await operatorHarness(t, {
      now: () => readAt ?? new Date().toISOString(),
      operatorDiagnostics: operatorSettings((scope) => {
        scopes.push(structuredClone(scope));
        return current();
      }),
    });
    const receipt = await resultFixture(h, state);
    readAt = new Date().toISOString();
    const read = (authorize = operatorAllow, observe) =>
      h.runtime.operations.readReplayResult(2, receipt.id, authorize, observe);
    const original = await read();
    assert.deepEqual([original.status, original.reason], receipt.expected);
    assert.deepEqual(original.publications, []);
    assert.doesNotMatch(JSON.stringify(original), /SYNTHETIC_ISSUE|sourceUrl|synthetic-test-token|configurationHash/);
    const before = await retained(h);
    const githubBefore = { ...h.githubReads };

    await t.test("the current host receives the exact immutable configuration and current source binding", () => {
      assert.ok(scopes.length > 0);
      for (const scope of scopes) {
        assert.deepEqual(Object.keys(scope).sort(), [
          "configurationHash",
          "configurationVersion",
          "dataMode",
          "installationId",
          "repositoryId",
          "sourceGeneration",
        ]);
        assert.equal(
          scope.configurationHash,
          createHash("sha256").update(components.metrics.stableJSON(h.config)).digest("hex"),
        );
        assert.equal(scope.configurationVersion, h.config.version);
        assert.equal(scope.dataMode, "synthetic");
        assert.equal(scope.repositoryId, 2);
        assert.equal(scope.installationId, "1");
        assert.equal(scope.sourceGeneration, state === "unavailable" ? "2" : "1");
      }
    });

    for (const [name, invalid] of [
      ["false", () => false],
      [
        "throwing",
        () => {
          throw new Error("synthetic-private-host-error");
        },
      ],
      ["resolved promise", () => Promise.resolve(true)],
      ["rejected promise", () => Promise.reject(new Error("synthetic-private-host-rejection"))],
      ["truthy string", () => "true"],
      ["truthy number", () => 1],
    ]) {
      await t.test(`${name} currentness denies this result and exact true restores it`, async () => {
        current = invalid;
        try {
          await assert.rejects(read, unavailable);
        } finally {
          current = () => true;
        }
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(await read(), original);
        assert.deepEqual(await retained(h), before);
      });
    }

    await t.test("currentness is checked after the final asynchronous native grant", async () => {
      let grants = 0;
      try {
        await assert.rejects(
          () =>
            read(async () => {
              if (++grants === 2) {
                await Promise.resolve();
                current = () => false;
              }
              return operatorAllow();
            }),
          unavailable,
        );
      } finally {
        current = () => true;
      }
      assert.equal(grants, 2);
    });

    await t.test("a final awaited native observer cannot return a newly stale result", async () => {
      try {
        await assert.rejects(
          () =>
            read(operatorAllow, async (_data, beforeSend) => {
              beforeSend();
              await Promise.resolve();
              current = () => false;
            }),
          unavailable,
        );
      } finally {
        current = () => true;
      }
    });

    await t.test("a private configuration revision change invalidates the captured read", async () => {
      const configuration = structuredClone(h.controlsStore.read().configuration);
      let grants = 0;
      try {
        await assert.rejects(
          () =>
            read(async () => {
              if (++grants === 2)
                h.controlsStore.transaction((value) => {
                  value.configuration = {
                    revision: (configuration?.revision ?? 0) + 1,
                    active: null,
                    proposals: {},
                    history: [],
                  };
                });
              return operatorAllow();
            }),
          unavailable,
        );
      } finally {
        h.controlsStore.transaction((value) => {
          if (configuration === undefined) delete value.configuration;
          else value.configuration = configuration;
        });
      }
      assert.deepEqual(await read(), original);
    });

    await h.runtime.stop();
    for (const authorized of [false, true])
      await t.test(`a stopped runtime denies this result with host currentness ${authorized}`, async () => {
        current = () => authorized;
        await assert.rejects(read, unavailable);
      });
    current = () => true;
    const recovered = await createPipeline(h.options);
    try {
      assert.deepEqual(await recovered.operations.readReplayResult(2, receipt.id, operatorAllow), original);
    } finally {
      await recovered.stop();
    }
    assert.deepEqual(await retained(h), before);
    assert.deepEqual(h.githubReads, githubBefore);
  });
}

test("a runtime without diagnostic opt-in has no native operator diagnostics", async (t) => {
  const h = await harness(t);
  assert.equal(h.runtime.operations, null);
});

for (const suppressed of [false, true])
  test(`host currentness and stop also fence a ${suppressed ? "publication-unavailable" : "published"} retained result`, async (t) => {
    let current = true;
    const { h, receipt } = await publishedOperatorReplay(t, { operatorDiagnostics: operatorSettings(() => current) });
    if (suppressed)
      h.controlsStore.transaction((value) => {
        value.profiles["101"] = { ...value.profiles["101"], suppressed: true };
      });
    const read = () => h.runtime.operations.readReplayResult(2, receipt.id, operatorAllow);
    const original = await read();
    assert.equal(original.status, suppressed ? "unavailable" : "published");
    assert.equal(original.reason, suppressed ? "publication_verification_unavailable" : "verified_publication");
    assert.equal(original.publications.length, suppressed ? 0 : 2);
    const before = await retained(h);
    const githubBefore = { ...h.githubReads };
    current = false;
    await assert.rejects(read, unavailable);
    current = true;
    assert.deepEqual(await read(), original);
    await h.runtime.stop();
    await assert.rejects(read, unavailable);
    const recovered = await createPipeline(h.options);
    try {
      assert.deepEqual(await recovered.operations.readReplayResult(2, receipt.id, operatorAllow), original);
    } finally {
      await recovered.stop();
    }
    assert.deepEqual(await retained(h), before);
    assert.deepEqual(h.githubReads, githubBefore);
  });

test("native replay return remains fenced across asynchronous transaction completion", async (t) => {
  let current = true;
  const h = await operatorHarness(t, { operatorDiagnostics: operatorSettings(() => current) });
  const receipt = await queueOperatorReplay(h);
  const read = (observe) => h.runtime.operations.readReplayResult(2, receipt.id, operatorAllow, observe);
  const original = await read();
  const before = await retained(h);
  const githubBefore = { ...h.githubReads };
  const transaction = h.db.transaction;
  const configuration = structuredClone(h.controlsStore.read().configuration);
  let afterCommit = () => {},
    completions = 0;
  h.db.transaction = async (work) => {
    const value = await transaction(work);
    completions++;
    await afterCommit();
    return value;
  };
  for (const withObserver of [false, true]) {
    for (const change of ["host", "private configuration revision"]) {
      await t.test(`${change} changing after commit with observer ${withObserver} withholds native data`, async () => {
        let observed = 0;
        const observer = withObserver
          ? async (_data, beforeSend) => {
              observed++;
              beforeSend();
              await Promise.resolve();
            }
          : undefined;
        afterCommit = async () => {
          await Promise.resolve();
          if (change === "host") current = false;
          else
            h.controlsStore.transaction((value) => {
              value.configuration = {
                revision: (configuration?.revision ?? 0) + 1,
                active: null,
                proposals: {},
                history: [],
              };
            });
        };
        const priorCompletions = completions;
        try {
          await assert.rejects(() => read(observer), unavailable);
        } finally {
          afterCommit = () => {};
          current = true;
          h.controlsStore.transaction((value) => {
            if (configuration === undefined) delete value.configuration;
            else value.configuration = structuredClone(configuration);
          });
        }
        assert.equal(completions, priorCompletions + 1, "the real database transaction completed before invalidation");
        assert.equal(observed, withObserver ? 1 : 0);
        assert.deepEqual(await read(), original);
      });
    }
  }
  assert.deepEqual(await retained(h), before);
  assert.deepEqual(h.githubReads, githubBefore);
});
