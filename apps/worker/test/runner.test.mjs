import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runWorker } from "../dist/runner.js";
import { parseWorkerArguments } from "../dist/index.js";

function harness(overrides = {}) {
  const events = [];
  const host = {
    authorize: async () => {
      events.push("authorize");
      return true;
    },
    open: async () => {
      events.push("open");
      return {
        runtime: {
          runOnce: async (options) => {
            events.push(options);
            return { state: "published" };
          },
          stop: async () => {
            events.push("stop");
          },
        },
        close: async () => {
          events.push("close");
        },
      };
    },
    ...overrides,
  };
  return { host, events };
}

test("one approved bounded batch drains before closing; import starts no worker", async () => {
  const { host, events } = harness();
  assert.equal(await runWorker(host, { maxPages: 3 }), "completed");
  assert.deepEqual(events, ["authorize", "open", "authorize", { maxPages: 3 }, "stop", "close"]);
});
test("absent/false authorization cannot acquire resources", async () => {
  const { host, events } = harness({ authorize: async () => false });
  await assert.rejects(runWorker(host, { maxPages: 1 }), /authorization/);
  assert.deepEqual(events, []);
  await assert.rejects(runWorker({ open: host.open }, { maxPages: 1 }), /configuration/);
});
test("revocation during acquisition closes resources without running", async () => {
  let calls = 0;
  const { host, events } = harness({ authorize: async () => ++calls === 1 });
  await assert.rejects(runWorker(host, { maxPages: 1 }), /authorization/);
  assert.deepEqual(events, ["open", "stop", "close"]);
});
test("shutdown awaits in-flight batch before cleanup, then forbids another", async () => {
  const controller = new AbortController();
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const events = [];
  const host = {
    authorize: async () => true,
    open: async () => ({
      runtime: {
        runOnce: async () => {
          entered();
          await gate;
          events.push("finished");
          return { state: "published" };
        },
        stop: async () => {
          events.push("stop");
        },
      },
      close: async () => {
        events.push("close");
      },
    }),
  };
  const running = runWorker(host, { maxPages: 1, intervalMs: 1000, signal: controller.signal });
  await started;
  controller.abort();
  assert.deepEqual(events, []);
  release();
  assert.equal(await running, "stopped");
  assert.deepEqual(events, ["finished", "stop", "close"]);
});
test("failed and blocked batches clean up; collecting is not reported as publication", async () => {
  for (const state of ["blocked", "collecting", "failed"]) {
    const events = [];
    const host = {
      authorize: async () => true,
      open: async () => ({
        runtime: {
          runOnce: async () => ({ state }),
          stop: async () => events.push("stop"),
        },
        close: async () => events.push("close"),
      }),
    };
    if (state === "collecting") assert.equal(await runWorker(host, { maxPages: 1 }), "collecting");
    else await assert.rejects(runWorker(host, { maxPages: 1 }), /batch_not_completed/);
    assert.deepEqual(events, ["stop", "close"]);
  }
});
test("abort before startup does not open resources; invalid bounds fail", async () => {
  const { host, events } = harness();
  assert.equal(await runWorker(host, { maxPages: 1, signal: AbortSignal.abort() }), "stopped");
  assert.deepEqual(events, []);
  for (const options of [{ maxPages: 0 }, { maxPages: 10001 }, { maxPages: 1, intervalMs: 0 }])
    await assert.rejects(runWorker(host, options), /configuration/);
});
test("CLI requires explicit local host and bounded arguments", () => {
  assert.deepEqual(parseWorkerArguments(["--host", "/private/host.mjs"]), {
    hostPath: "/private/host.mjs",
    options: { maxPages: 100 },
  });
  for (const args of [
    [],
    ["--host", "./host.mjs"],
    ["--host", "https://example.test/host.mjs"],
    ["--host", "/host.mjs", "--max-pages", "1e3"],
    ["--host", "/host.mjs", "--host", "/other.mjs"],
    ["--host", "/host.mjs", "--interval-ms", "0"],
  ])
    assert.throws(() => parseWorkerArguments(args));
});
test("CLI prints only fixed status codes, never provider exceptions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synthetic-worker-"));
  try {
    const file = join(dir, "host.mjs");
    await writeFile(
      file,
      'export default { authorize: async () => { throw Error("PRIVATE_SENTINEL"); }, open: async () => {} };',
    );
    const result = spawnSync(
      process.execPath,
      [new URL("../dist/index.js", import.meta.url).pathname, "--host", file],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), "worker_failed");
    assert.ok(!result.stdout.includes("PRIVATE_SENTINEL"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("continuous batches recheck authorization and never overlap", async () => {
  let authorizations = 0,
    runs = 0,
    active = 0;
  const events = [];
  const host = {
    authorize: async () => ++authorizations < 4,
    open: async () => ({
      runtime: {
        runOnce: async () => {
          assert.equal(active++, 0);
          runs++;
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          return { state: "published" };
        },
        stop: async () => {
          assert.equal(active, 0);
          events.push("stop");
        },
      },
      close: async () => events.push("close"),
    }),
  };
  await assert.rejects(runWorker(host, { maxPages: 1, intervalMs: 1000 }), /authorization/);
  assert.equal(runs, 2);
  assert.deepEqual(events, ["stop", "close"]);
});

test("runtime drain failure does not close storage underneath active work", async () => {
  let closed = false;
  const host = {
    authorize: async () => true,
    open: async () => ({
      runtime: {
        runOnce: async () => ({ state: "published" }),
        stop: async () => {
          throw Error("synthetic_drain_failure");
        },
      },
      close: async () => {
        closed = true;
      },
    }),
  };
  await assert.rejects(runWorker(host, { maxPages: 1 }), /drain_failure/);
  assert.equal(closed, false);
});
