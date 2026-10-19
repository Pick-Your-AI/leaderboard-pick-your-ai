import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { components, clock, fixtureId } from "./harness.mjs";
import { operatorHarness, operatorScopes, insertOperatorDelivery } from "./operator-harness.mjs";
import { createPipeline } from "../src/index.mjs";

const fixtureBytes = await readFile(new URL("../../../tests/fixtures/operator-operating-drill.json", import.meta.url));
export const operatorDrillFixture = JSON.parse(fixtureBytes);
export const operatorDrillFixtureHash = createHash("sha256").update(fixtureBytes).digest("hex");
const stable = components.metrics.stableJSON;
const sha = (value) => createHash("sha256").update(stable(value)).digest("hex");
const closeServer = (server) =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
const closeOnce = (store) => {
  const close = store.close.bind(store);
  let closed = false;
  store.close = () => {
    if (!closed) {
      close();
      closed = true;
    }
  };
};

/** Reuses real production handlers/stores. The explicitly synthetic specialist
 * approval is derived from the persisted request and collected fact, never from
 * a browser's claimed identity, acceptance boolean or proposed fact contents. */
export async function operatorOperatingHarness() {
  const fixture = operatorDrillFixture;
  const cleanup = [],
    directHttp = [],
    faults = [],
    authorizations = [],
    reopens = [];
  let h,
    runtime,
    server,
    approvalPath,
    allowed = true,
    failSql = false,
    failControls = false;
  const principals = new Map(fixture.principals.map((p) => [p.actorId, p]));
  const dispose = async () => {
    const errors = [];
    if (server) {
      const closing = server;
      server = undefined;
      try {
        await closeServer(closing);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const close of cleanup.splice(0).reverse()) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "operator_drill_cleanup_failed");
  };
  const authorizeCorrection = async (operation) => {
    let approved;
    try {
      approved = JSON.parse(await readFile(approvalPath, "utf8"));
    } catch {
      return false;
    }
    const authorized =
      allowed &&
      approved.schemaVersion === "synthetic-exclusion-approval/v1" &&
      approved.fixtureSHA256 === operatorDrillFixtureHash &&
      approved.validUntil > Date.now() &&
      approved.receiptId === `synthetic-exclusion:${sha(approved.binding)}` &&
      principals.get(operation.operatorId)?.roles.includes("operator") &&
      stable(operation) === stable(approved.operation);
    authorizations.push({ operation: structuredClone(operation), authorized });
    return authorized;
  };
  try {
    h = await operatorHarness(
      { after: (fn) => cleanup.push(fn) },
      {
        webhookDispatch: true,
        configure(config) {
          config.scopes = operatorScopes;
        },
        authorizeCorrection,
      },
    );
    runtime = h.runtime;
    approvalPath = join(h.directory, "synthetic-specialist-approval.json");
    closeOnce(h.controlsStore);
    const nativeTransaction = h.db.transaction;
    h.db.transaction = (work) =>
      nativeTransaction(async (tx) => {
        let correctionWritten = false;
        const result = await work({
          query: async (sql, params) => {
            const value = await tx.query(sql, params);
            if (/INSERT INTO leaderboard_pipeline\.corrections/.test(sql)) correctionWritten = true;
            return value;
          },
        });
        if (failSql && correctionWritten) {
          failSql = false;
          faults.push({ boundary: "correction SQL transaction before commit", state: "interrupted" });
          throw Error("synthetic_correction_sql_interruption");
        }
        return result;
      });
    const armPublisher = () => {
      h.controlsStore.publisher = () => {
        if (failControls) {
          failControls = false;
          faults.push({
            boundary: "private SQLite publication before commit, after correction SQL commit",
            state: "interrupted",
          });
          throw Error("synthetic_controls_publication_interruption");
        }
      };
    };
    armPublisher();
    const users = Object.fromEntries(
      fixture.principals.map((p, i) => {
        const token = String.fromCharCode(97 + i).repeat(43),
          csrf = String.fromCharCode(107 + i).repeat(43);
        h.controlsStore.transaction((s) => {
          s.sessions[createHash("sha256").update(token).digest("base64url")] = {
            actorId: p.actorId,
            csrf,
            roles: [...p.roles],
            roleVersion: fixture.roleVersion,
            expires: Date.now() + 900000,
          };
        });
        return [p.actorId, { actorId: p.actorId, cookie: `__Host-controls_session=${token}`, csrf }];
      }),
    );
    const start = async () => {
      server = components.controls.createControlsServer({
        store: h.controlsStore,
        origin: fixture.origin,
        operations: runtime.operations,
        provider: {
          exchange() {
            throw Error("Established synthetic sessions only");
          },
          authorizationURL() {
            throw Error("Established synthetic sessions only");
          },
        },
        rolesForActor: (actorId) => ({ roles: principals.get(actorId)?.roles ?? [], version: fixture.roleVersion }),
        authorizeRepository: async ({ actorId, repositoryId }) => ({
          allowed: allowed && actorId === fixture.correction.operator && repositoryId === fixture.repositoryId,
          policyVersion: fixture.policyVersion,
          revision: fixture.grantRevision,
        }),
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      await runtime.app.listen({ host: "127.0.0.1", port: 0 });
    };
    await start();
    assert.equal((await runtime.runOnce({ cutoff: clock() })).state, "published");
    await insertOperatorDelivery(h);
    const failing = new components.ingestion.InboxStore(h.db, 1);
    assert.equal(await failing.fail(await failing.claim(), "source_unavailable", true), true);
    const request = async (path, { user, input, csrf, requestOrigin = fixture.origin } = {}) => {
      const method = input === undefined ? "GET" : "POST";
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method,
        redirect: "error",
        headers: {
          cookie: user?.cookie ?? "",
          origin: requestOrigin,
          ...(input === undefined
            ? {}
            : { "content-type": "application/json", "x-csrf-token": csrf ?? user?.csrf ?? "" }),
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      const data = await response.json();
      directHttp.push({ method, path, status: response.status });
      return { status: response.status, data };
    };
    const reopen = async (label) => {
      const before = h.controlsStore.read();
      await closeServer(server);
      server = undefined;
      await runtime.stop();
      h.controlsStore.close();
      await h.reopenDatabase();
      h.controlsStore = new components.controls.ControlStore(join(h.directory, "controls.sqlite"));
      closeOnce(h.controlsStore);
      armPublisher();
      const reopenedStore = h.controlsStore;
      cleanup.push(() => reopenedStore.close());
      h.options.controlsStore = h.controlsStore;
      runtime = await createPipeline(h.options);
      h.runtime = runtime;
      const reopenedRuntime = runtime;
      cleanup.push(() => reopenedRuntime.stop());
      assert.deepEqual(h.controlsStore.read(), before);
      reopens.push({
        label,
        controlsRevision: before.revision,
        requestVersions: Object.fromEntries(Object.entries(before.requests).map(([id, r]) => [id, r.version])),
      });
      await start();
    };
    return {
      fixture,
      users,
      request,
      directHttp,
      faults,
      authorizations,
      reopens,
      get controlsAddress() {
        return `http://127.0.0.1:${server.address().port}`;
      },
      get publicAddress() {
        return runtime.app.server.address() && `http://127.0.0.1:${runtime.app.server.address().port}`;
      },
      get runtime() {
        return runtime;
      },
      get store() {
        return h.controlsStore;
      },
      get db() {
        return h.db;
      },
      setAllowed(value) {
        allowed = value;
      },
      async restartQueuedReplay() {
        const stale = await runtime.inbox.claim();
        assert.ok(stale);
        await h.db.query(
          "UPDATE leaderboard_ingestion.inbox SET lease_until=clock_timestamp()-interval '1 second' WHERE delivery_id=$1",
          [fixtureId(1)],
        );
        await reopen("queued replay with expired worker lease");
        assert.equal(await runtime.inbox.complete(stale), false);
        const fresh = await runtime.inbox.claim();
        assert.notEqual(fresh.token, stale.token);
        assert.equal(await runtime.inbox.complete(fresh), true);
        assert.equal(await runtime.inbox.complete(fresh), false);
        assert.equal(await runtime.dispatchOnce(), "processed");
        assert.equal(await runtime.dispatchOnce(), "idle");
        return { staleTokenRejected: true, freshCompletionAcceptedOnce: true, deliveryId: fixtureId(1) };
      },
      async approveCorrection(requestId) {
        const r = h.controlsStore.read().requests[requestId];
        assert.equal(r.kind, "correction");
        assert.equal(r.status, "pending");
        assert.equal(r.owner, fixture.correction.owner);
        assert.equal(r.locator, fixture.correction.locator);
        assert.equal(r.detail, fixture.correction.reason);
        const documents = (await h.db.query("SELECT document FROM leaderboard_pipeline.normalizations")).rows.map(
          (r) => r.document,
        );
        const candidates = documents
          .flatMap((d) => d.facts)
          .filter((f) => f.actorId === fixture.correction.owner && f.metricId === fixture.correction.metricId);
        const unique = new Map(candidates.map((f) => [f.id, f]));
        assert.equal(unique.size, 1);
        assert.equal(
          new Set(candidates.map((f) => stable({ id: f.id, revision: f.revision, state: f.state }))).size,
          1,
        );
        const fact = [...unique.values()][0];
        const evidence = documents.flatMap((d) => d.evidence).find((e) => e.contribution.contributionId === fact.id);
        assert.equal(evidence.artifact.publicUrl, r.locator);
        const binding = {
          requestId,
          requestVersion: r.version,
          owner: r.owner,
          locator: r.locator,
          reason: r.detail,
          factId: fact.id,
          factRevision: fact.revision,
          factState: fact.state,
          operatorId: fixture.correction.operator,
          fixtureSHA256: operatorDrillFixtureHash,
        };
        const receiptId = `synthetic-exclusion:${sha(binding)}`;
        const operation = {
          requestId,
          expectedVersion: r.version,
          factId: fact.id,
          operatorId: fixture.correction.operator,
          approvalReceipt: receiptId,
        };
        const approval = {
          schemaVersion: "synthetic-exclusion-approval/v1",
          fixtureSHA256: operatorDrillFixtureHash,
          binding,
          receiptId,
          operation,
          validUntil: Date.now() + 300000,
        };
        await writeFile(approvalPath, JSON.stringify(approval), { mode: 0o600 });
        return structuredClone(approval);
      },
      interruptSql() {
        failSql = true;
      },
      interruptControls() {
        failControls = true;
      },
      apply(operation) {
        return runtime.applyCorrection(operation);
      },
      reopen,
      async checkpoint(label) {
        return {
          label,
          controls: h.controlsStore.read(),
          corrections: (await h.db.query("SELECT * FROM leaderboard_pipeline.corrections ORDER BY request_id")).rows,
          receipts: await runtime.receipts(),
          replayReceipts: (await h.db.query("SELECT * FROM leaderboard_ingestion.replay_receipts ORDER BY receipt_id"))
            .rows,
          replayResults: (
            await h.db.query("SELECT * FROM leaderboard_ingestion.replay_processing_results ORDER BY receipt_id")
          ).rows,
        };
      },
      close: dispose,
    };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "operator_drill_setup_failed");
    }
    throw error;
  }
}
