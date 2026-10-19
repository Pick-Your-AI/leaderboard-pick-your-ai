import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { harness, components, publicScope, fixtureId, discoveryTestAuthority } from "./harness.mjs";

const { canonicalPublicScope, publicScopeParameters, publicScopeKey } = components.contracts;
const cutoff = "2026-10-18T12:00:00.000Z";
const scope = canonicalPublicScope({ ...publicScope, repository: "2", context: "current", roles: ["reporter"] });
const url = `/api/v1/windows?${new URLSearchParams(publicScopeParameters(scope))}`;

for (const [changed, boundary] of [
  ["unchanged", 1],
  ["head", 1],
  ["index", 1],
  ["approval", 1],
  ["head", 2],
  ["index", 2],
  ["approval", 2],
])
  test(`actual discovery transaction return retains ${changed} authority${boundary === 2 ? " after final SQL commit" : ""}`, async (t) => {
    let approved = true;
    const h = await harness(t, {
      discoveryAuthority: true,
      verifyConfiguration: async () => approved,
      configure(config) {
        config.scopes = [{ ...scope, period: "30d" }];
      },
      transformPayloads(payloads) {
        return payloads.map((payload, index) => ({
          ...payload,
          created_at: new Date(Date.parse(cutoff) - (index === 0 ? 2 : 45) * 86400000).toISOString(),
          updated_at: new Date(Date.parse(cutoff) - 86400000).toISOString(),
        }));
      },
    });
    const publication = await h.runtime.runOnce({ cutoff });
    assert.equal(publication.state, "published");
    assert.equal(publication.publications.length, 1);
    const before = await h.runtime.app.inject(url);
    assert.equal(before.statusCode, 200, before.body);
    const window = before.json().windows[0];
    assert.equal(window.snapshotId, publication.publications[0].snapshotId);
    const reads = { ...h.githubReads };
    const initial = h.controlsStore.read();
    const transaction = h.db.transaction.bind(h.db);
    let completed = 0;
    h.db.transaction = async (work) => {
      const result = await transaction(work);
      completed++;
      if (completed !== boundary) return result;
      assert.equal(result.windows[0].read.selected.snapshot.snapshotId, window.snapshotId);
      if (changed === "approval") {
        approved = false;
        if (boundary === 2) h.discoveryAuthority.revoke(h.config);
      } else if (changed !== "unchanged")
        h.controlsStore.transaction((state) => {
          if (changed === "head") delete state.pipelineHeads[publicScopeKey(window.scope)];
          else delete state.pipelineWindowIndex;
        });
      return result;
    };
    let response;
    try {
      response = await h.runtime.app.inject(url);
    } finally {
      h.db.transaction = transaction;
    }
    assert.equal(
      completed,
      changed === "approval" && boundary === 1 ? 1 : 2,
      "discovery uses one captured read and one final SQL admission, unless host approval fails first",
    );
    assert.deepEqual(h.githubReads, reads, "a public read must not collect source data");
    if (changed === "unchanged") {
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), before.json());
      assert.deepEqual(h.controlsStore.read(), initial);
    } else {
      const subsequent = await h.runtime.app.inject(url);
      if (changed === "index") {
        assert.equal(subsequent.statusCode, 200, subsequent.body);
        assert.deepEqual(subsequent.json().windows, []);
      } else assert.equal(subsequent.statusCode, 503, subsequent.body);
      assert.equal(response.statusCode, 503, "the same read returned confirmed pointers after its authority changed");
      assert.equal(response.json().windows, undefined);
    }
  });

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const waitFor = (promise) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("expected verifier boundary was not reached")), 5000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
const deferred = () => {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

// The host callback waits only after the first real transaction has committed.
// SQL mutations below finish before releasing it; none replace database results.
for (const populated of [true, false])
  for (const changed of [
    "unchanged",
    "lifecycle",
    "installation",
    "generation",
    "suppression",
    "correction",
    "project denial",
    ...(populated ? ["derived suppression"] : []),
  ])
    test(`post-verifier SQL ${populated ? "populated" : "empty"} discovery checks ${changed}`, async (t) => {
      const reached = deferred(),
        release = deferred();
      let armed = false,
        committed = false,
        held = false;
      const h = await harness(t, {
        discoveryAuthority: true,
        async verifyConfiguration() {
          if (armed && committed && !held) {
            held = true;
            reached.resolve();
            await release.promise;
          }
          return true;
        },
        configure(config) {
          config.scopes = [{ ...scope, period: "30d" }];
        },
        transformPayloads(payloads) {
          return payloads.map((payload, index) => ({
            ...payload,
            created_at: new Date(Date.parse(cutoff) - (index === 0 ? 2 : 45) * 86400000).toISOString(),
            updated_at: new Date(Date.parse(cutoff) - 86400000).toISOString(),
          }));
        },
      });
      const collection = new components.ingestion.CollectionStore(h.db);
      if (populated) assert.equal((await h.runtime.runOnce({ cutoff })).state, "published");
      else assert.equal(await collection.verifyPublic(2, 1, null), true);
      // Retained derived dependencies have a distinct artifact identity. A source
      // suppression must include them even though repository generation is stable.
      if (changed === "derived suppression") {
        const fact = (
          await h.db.query(
            "SELECT fact_key FROM leaderboard_ingestion.source_facts WHERE subject_id='SYNTHETIC_ISSUE_1'",
          )
        ).rows[0];
        assert.ok(fact);
        await h.db.query(
          "INSERT INTO leaderboard_pipeline.source_artifacts(fact_key,artifact_id) VALUES($1,'SYNTHETIC_DERIVED_WINDOW')",
          [fact.fact_key],
        );
      }
      const before = await h.runtime.app.inject(url);
      assert.equal(before.statusCode, 200, before.body);
      assert.equal(before.json().windows.length, populated ? 1 : 0);
      const controls = h.controlsStore.read();
      const reads = { ...h.githubReads };
      const readAccess = async () =>
        (
          await h.db.query(
            "SELECT repository_id,installation_id,state,generation FROM leaderboard_ingestion.repository_access ORDER BY repository_id",
          )
        ).rows;
      const initialAccess = await readAccess();
      const transaction = h.db.transaction.bind(h.db);
      h.db.transaction = async (work) => {
        const result = await transaction(work);
        if (armed && !committed && result && Array.isArray(result.windows)) committed = true;
        return result;
      };
      armed = true;
      const pending = h.runtime.app.inject(url);
      let response;
      try {
        await waitFor(reached.promise);
        assert.equal(committed, true, "the host wait begins after the actual SQL transaction commits");
        if (changed === "lifecycle") {
          assert.equal(
            await collection.suppress(
              fixtureId(populated ? 933503 : 933504),
              hash({ changed, populated }),
              1,
              [2],
              "private",
            ),
            "accepted",
          );
        } else if (changed === "installation") {
          await h.db.query(
            "UPDATE leaderboard_ingestion.repository_access SET installation_id=3 WHERE repository_id=2",
          );
        } else if (changed === "generation") {
          await h.db.query(
            "UPDATE leaderboard_ingestion.repository_access SET generation=generation+1 WHERE repository_id=2",
          );
        } else if (["suppression", "derived suppression"].includes(changed)) {
          await h.db.query(
            "INSERT INTO leaderboard_ingestion.object_suppressions(repository_id,subject_id,reason) VALUES(2,'SYNTHETIC_ISSUE_1','unavailable')",
          );
        } else if (changed === "correction") {
          await h.db.query(
            "INSERT INTO leaderboard_pipeline.corrections(request_id,fact_id,artifact_id,repository_id,document) VALUES('synthetic-window-correction','synthetic-window-fact','SYNTHETIC_ISSUE_1',2,$1::jsonb)",
            [JSON.stringify({ fact: { id: "synthetic-window-fact", state: "excluded" } })],
          );
        } else if (changed === "project denial") {
          const key = `project-scope-denial:2:${hash(h.config.version)}`;
          const document = {
            repositoryId: 2,
            configurationVersion: h.config.version,
            reason: "project_scope_unavailable",
          };
          await h.db.query(
            "INSERT INTO leaderboard_pipeline.receipts(receipt_id,operation_key,kind,document,document_hash,operation_hash) VALUES($1,$2,'project_scope_denial',$3::jsonb,$4,pg_catalog.sha256(pg_catalog.convert_to($2,'UTF8')))",
            [hash(key), key, JSON.stringify(document), hash(document)],
          );
        }
        assert.deepEqual(
          h.controlsStore.read(),
          controls,
          "committed SQL authority changes do not require a SQLite revision change",
        );
        const access = await readAccess();
        if (changed === "lifecycle") {
          assert.equal(access[0].state, "unavailable");
          assert.equal(Number(access[0].generation), Number(initialAccess[0].generation) + 1);
        } else if (changed === "installation") assert.equal(String(access[0].installation_id), "3");
        else if (changed === "generation")
          assert.equal(Number(access[0].generation), Number(initialAccess[0].generation) + 1);
        else
          assert.deepEqual(
            access,
            initialAccess,
            "suppression, correction and Project denial must not rely only on repository generations",
          );
        release.resolve();
        response = await pending;
      } finally {
        release.resolve();
        await pending;
        h.db.transaction = transaction;
      }
      assert.deepEqual(h.githubReads, reads, "discovery performs no collection or publication");
      assert.deepEqual(h.controlsStore.read(), controls);
      if (changed === "unchanged") {
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json(), before.json());
      } else {
        assert.equal(
          response.statusCode,
          503,
          "the pending menu must reject SQL authority changed during the final host verifier",
        );
        assert.equal(response.json().windows, undefined);
      }
    });

async function epochHarness(t, extra = {}) {
  return harness(t, {
    discoveryAuthority: true,
    configure(config) {
      config.scopes = [{ ...scope, period: "30d" }];
    },
    transformPayloads(payloads) {
      return payloads.map((payload, index) => ({
        ...payload,
        created_at: new Date(Date.parse(cutoff) - (index === 0 ? 2 : 45) * 86400000).toISOString(),
        updated_at: new Date(Date.parse(cutoff) - 86400000).toISOString(),
      }));
    },
    ...extra,
  });
}

for (const boundary of ["after BEGIN", "after statement", "after COMMIT"])
  for (const changed of ["revocation", "revoke/reapprove", "expiry"])
    test(`discovery epoch rejects ${changed} ${boundary}`, async (t) => {
      let approved = true;
      let now = 1_000;
      const h = await epochHarness(t, { verifyConfiguration: async () => approved });
      const authority = discoveryTestAuthority({ now: () => now });
      authority.approve(h.config, { validUntil: 2_000 });
      h.options.configurationAuthorityEpoch = (binding) => authority.read(binding);
      assert.equal((await h.runtime.runOnce({ cutoff })).state, "published");
      const before = await h.runtime.app.inject(url);
      assert.equal(before.statusCode, 200, before.body);
      const controls = h.controlsStore.read();
      const source = (await h.db.query("SELECT * FROM leaderboard_ingestion.repository_access ORDER BY repository_id"))
        .rows;
      const transaction = h.db.transaction.bind(h.db);
      let transactions = 0,
        changes = 0,
        statements = 0;
      const finalQueries = [];
      const isFinalAuthority = (sql) =>
        sql.includes("WITH access AS MATERIALIZED") && sql.includes("correction_rows AS MATERIALIZED");
      const change = () => {
        changes++;
        if (changed === "expiry") now = 2_000;
        else {
          authority.revoke(h.config);
          if (changed === "revoke/reapprove") authority.approve(h.config, { validUntil: 2_000 });
          // The BEGIN case also makes the original async host predicate false
          // before the final SQL authorization point, without another callback.
          else if (boundary === "after BEGIN") approved = false;
        }
      };
      h.db.transaction = async (work) => {
        const number = ++transactions;
        const result = await transaction(async (tx) => {
          if (number === 2 && boundary === "after BEGIN") change();
          return work({
            query: async (sql, params) => {
              const rows = await tx.query(sql, params);
              if (number === 2) {
                finalQueries.push(sql);
                if (isFinalAuthority(sql)) {
                  statements++;
                  if (boundary === "after statement") change();
                }
              }
              return rows;
            },
          });
        });
        if (number === 2 && boundary === "after COMMIT") change();
        return result;
      };
      let response;
      try {
        response = await h.runtime.app.inject(url);
      } finally {
        h.db.transaction = transaction;
      }
      assert.equal(transactions, 2);
      assert.equal(changes, 1);
      if (boundary !== "after BEGIN") {
        assert.equal(statements, 1, "one complete final SQL authority statement");
        assert.match(finalQueries[0], /pg_advisory_xact_lock_shared/, "dependency preparation is graph-first");
        assert.equal(isFinalAuthority(finalQueries.at(-1)), true, "no SQL follows the complete final authority");
        assert.match(finalQueries.at(-1), /project_scope_denial/);
        assert.match(finalQueries.at(-1), /UNION ALL SELECT 'correction'/);
      }
      assert.deepEqual(h.controlsStore.read(), controls, "the host transition does not require a controls revision");
      assert.deepEqual(
        (await h.db.query("SELECT * FROM leaderboard_ingestion.repository_access ORDER BY repository_id")).rows,
        source,
      );
      assert.equal(response.statusCode, 503, "the same menu must deny a changed approval interval");
      assert.equal(response.json().windows, undefined);
    });

test("discovery requires an exact synchronous host witness while ordinary pinned boards remain independent", async (t) => {
  const h = await epochHarness(t);
  assert.equal((await h.runtime.runOnce({ cutoff })).state, "published");
  const before = await h.runtime.app.inject(url);
  assert.equal(before.statusCode, 200, before.body);
  const entry = before.json().windows[0];
  const provider = h.options.configurationAuthorityEpoch;
  const expected = {
    configurationHash: createHash("sha256").update(components.metrics.stableJSON(h.config)).digest("hex"),
    configurationVersion: h.config.version,
    dataMode: "synthetic",
  };
  let foreignReads = 0,
    observed = 0;
  const foreign = Object.defineProperties(
    {},
    {
      then: {
        get() {
          foreignReads++;
          throw new Error("foreign then getter must not execute");
        },
      },
      catch: {
        get() {
          foreignReads++;
          throw new Error("foreign catch getter must not execute");
        },
      },
    },
  );
  const denied = [
    ["missing", undefined],
    [
      "throws",
      () => {
        throw new Error("host unavailable");
      },
    ],
    ["null", () => null],
    ["boolean", () => true],
    ["number", () => 1],
    ["empty", () => ""],
    ["too long", () => "a".repeat(101)],
    ["LF", () => "epoch\n"],
    ["CR", () => "epoch\r"],
    ["space", () => "epoch "],
    ["unicode", () => "époch"],
    ["boxed", () => new String("epoch")],
    ["foreign thenable", () => foreign],
    [
      "thrown foreign thenable",
      () => {
        throw foreign;
      },
    ],
    ["resolved promise", () => Promise.resolve("epoch")],
    [
      "async rejection",
      async () => {
        throw new Error("synthetic rejected host reader");
      },
    ],
    [
      "thrown rejected promise",
      () => {
        throw Promise.reject(new Error("synthetic thrown rejection"));
      },
    ],
    ["nested native rejection", () => Promise.reject(Promise.reject(new Error("synthetic nested rejection")))],
    ["wrong digest", (binding) => h.discoveryAuthority.read({ ...binding, configurationHash: "0".repeat(64) })],
    ["wrong version", (binding) => h.discoveryAuthority.read({ ...binding, configurationVersion: "different" })],
    ["wrong mode", (binding) => h.discoveryAuthority.read({ ...binding, dataMode: "api" })],
  ];
  try {
    for (const [label, reader] of denied)
      await t.test(label, async () => {
        h.options.configurationAuthorityEpoch = reader;
        const response = await h.runtime.app.inject(url);
        assert.equal(response.statusCode, 503, response.body);
        assert.equal(response.json().windows, undefined);
        await new Promise((resolve) => setImmediate(resolve));
      });
    assert.equal(foreignReads, 0, "foreign then/catch properties are never inspected or invoked");
    h.options.configurationAuthorityEpoch = undefined;
    const pinned = await h.runtime.app.inject(
      `/api/v1/boards?${new URLSearchParams({
        ...publicScopeParameters(entry.scope),
        metric: "issues_opened",
        snapshot: entry.snapshotId,
      })}`,
    );
    assert.equal(pinned.statusCode, 200, pinned.body);
    h.options.configurationAuthorityEpoch = (binding) => {
      assert.deepEqual(binding, expected);
      assert.equal(Object.isFrozen(binding), true);
      observed++;
      return provider(binding);
    };
    const restored = await h.runtime.app.inject(url);
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(restored.json(), before.json());
    assert.ok(observed >= 2, "the exact binding is rechecked across the final SQL interval");
  } finally {
    h.options.configurationAuthorityEpoch = provider;
  }
});
