import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { EnrichmentStore } from "../../../../packages/ingestion/dist/enrichment.js";
import { createMetadataEnrichment } from "../../src/metadata-enrichment.mjs";

export const scenarios = [
  "literal true",
  "literal false",
  "truthy non-Boolean",
  "ordinary thrown error",
  "fulfilled native promise",
  "returned native rejection",
  "thrown native rejection",
  "native rejection chain",
  "native rejection cycle",
  "cross-realm native rejection",
  "shadowed native methods",
  "foreign thenable",
  "foreign getter returns rejection",
  "foreign getter throws rejection",
  "asynchronous authorize",
  "revoked during authorize",
  "revoked after transaction",
];

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function observe(boundary, scenario) {
  assert.ok(["pipeline", "ingestion"].includes(boundary));
  assert.ok(scenarios.includes(scenario));
  const counters = {
    callbacks: 0,
    foreignGetters: 0,
    foreignThenCalls: 0,
    authorizations: 0,
    asynchronousAuthorizations: 0,
    recordReads: 0,
    metadataCalls: 0,
  };
  const unhandledRejections = [];
  const pending = [];
  const onUnhandled = (reason, promise) => {
    unhandledRejections.push(reason instanceof Error ? reason.message : String(reason));
    pending.push(promise);
  };
  const onHandled = () => {};
  process.on("unhandledRejection", onUnhandled);
  process.on("rejectionHandled", onHandled);
  let live = true;
  const current = () => {
    counters.callbacks++;
    switch (scenario) {
      case "literal false":
        return false;
      case "truthy non-Boolean":
        return 1;
      case "ordinary thrown error":
        throw new Error("SYNTHETIC provider detail");
      case "fulfilled native promise":
        return Promise.resolve(true);
      case "returned native rejection":
        return Promise.reject(new Error("SYNTHETIC returned rejection"));
      case "thrown native rejection":
        throw Promise.reject(new Error("SYNTHETIC thrown rejection"));
      case "native rejection chain": {
        let value = Promise.reject(new Error("SYNTHETIC deepest rejection"));
        for (let index = 0; index < 32; index++) value = Promise.reject(value);
        return value;
      }
      case "native rejection cycle": {
        let rejectFirst, rejectSecond;
        const first = new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
        const second = new Promise((_resolve, reject) => {
          rejectSecond = reject;
        });
        rejectFirst(second);
        rejectSecond(first);
        return first;
      }
      case "cross-realm native rejection":
        return runInNewContext('Promise.reject("SYNTHETIC other realm")');
      case "shadowed native methods": {
        const value = Promise.reject(new Error("SYNTHETIC shadowed rejection"));
        for (const name of ["then", "catch"])
          Object.defineProperty(value, name, {
            get() {
              counters.foreignGetters++;
              throw new Error("SYNTHETIC shadowed method");
            },
          });
        return value;
      }
      case "foreign thenable":
      case "foreign getter returns rejection":
      case "foreign getter throws rejection":
        return Object.defineProperty({}, "then", {
          get() {
            counters.foreignGetters++;
            if (scenario === "foreign getter returns rejection")
              return Promise.reject(new Error("SYNTHETIC getter return"));
            if (scenario === "foreign getter throws rejection")
              throw Promise.reject(new Error("SYNTHETIC getter throw"));
            return (resolve) => {
              counters.foreignThenCalls++;
              resolve(true);
            };
          },
        });
      default:
        return live;
    }
  };
  const authorize = () => {
    counters.authorizations++;
    if (scenario === "asynchronous authorize")
      return {
        then(resolve) {
          setImmediate(() => {
            counters.asynchronousAuthorizations++;
            resolve(true);
          });
        },
      };
    return Promise.resolve().then(() => {
      if (scenario === "revoked during authorize") live = false;
      return true;
    });
  };
  const record = {
    fact_key: "1".repeat(64),
    source_revision: "synthetic-revision",
    state: "failed",
    attempts: 1,
    reason: "enrichment_unavailable",
  };
  const tx = {
    async query(sql) {
      // This is a synthetic read adapter, never a real SQL connection or write.
      assert.match(sql.trim(), /^SELECT /);
      if (sql.includes("SELECT state")) return { rows: [{ state: "public", generation: "1", installation_id: 2 }] };
      assert.ok(sql.includes("SELECT job.fact_key"));
      counters.recordReads++;
      return { rows: [structuredClone(record)] };
    },
  };
  const db = {
    query: tx.query,
    async transaction(work) {
      const result = await work(tx);
      if (scenario === "revoked after transaction" && counters.recordReads) live = false;
      return result;
    },
  };
  let api;
  let result = null;
  let error = null;
  try {
    if (boundary === "pipeline") {
      api = createMetadataEnrichment({
        db,
        ingestion: { EnrichmentStore },
        setting: {
          source: {
            async readMetadata() {
              counters.metadataCalls++;
              assert.fail("readStates must not call the metadata adapter");
            },
          },
          policyVersion: "synthetic",
          configurationCurrent: current,
        },
        config: { repositories: [{ id: 1, installationId: 2, families: ["issues"] }] },
        dataMode: "synthetic",
        capture: async () => ({ revision: "synthetic", current() {}, authorize }),
      });
      result = await api.readStates(1, "issues");
    } else {
      api = new EnrichmentStore(db);
      result = await api.readStates({
        repositoryId: 1,
        installationId: 2,
        accessGeneration: "1",
        family: "issues",
        policyVersion: "synthetic",
        authorize,
        current,
      });
    }
  } catch (reason) {
    error = reason instanceof Error ? reason.message : String(reason);
  } finally {
    api?.stop?.();
    await tick();
    await tick();
    // Preserve any observed failure before releasing its native rejection.
    // This observer is confined to a subprocess; it cannot hide test-runner events.
    for (const promise of pending) void Promise.prototype.then.call(promise, undefined, () => undefined);
    await tick();
    process.off("unhandledRejection", onUnhandled);
    process.off("rejectionHandled", onHandled);
  }
  return { boundary, scenario, result, error, counters, unhandledRejections };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const observations = [];
  for (const boundary of ["pipeline", "ingestion"])
    for (const scenario of scenarios) observations.push(await observe(boundary, scenario));
  process.stdout.write(`${JSON.stringify(observations)}\n`);
}
