import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cwd = fileURLToPath(new URL("../../../", import.meta.url));
async function child(mode) {
  const assert = (await import("node:assert/strict")).default;
  const { capturePullRequestDecisionHistory: capture, GithubClientError } =
    await import("./packages/github/dist/index.js");
  const { decisionFixture } = await import("./tests/fixtures/pull-request-decision-history.mjs");
  const h = decisionFixture();
  let invoked = 0;
  const invalid = () => {
    if (mode.includes("thenable"))
      return Object.defineProperty({}, "then", {
        get() {
          invoked++;
          throw new Error("Foreign then getter must not be evaluated");
        },
      });
    if (mode.includes("nested")) return Promise.reject(Promise.reject(new Error("Synthetic nested rejection")));
    return Promise.reject(new Error("Synthetic rejected callback"));
  };
  if (mode.startsWith("authority"))
    h.options.assertAuthorized = () => {
      const value = invalid();
      if (mode.includes("thrown")) throw value;
      return value;
    };
  if (mode.startsWith("clock")) {
    let calls = 0;
    h.options.now = () => {
      calls++;
      if (mode.includes("final") && calls === 1) return "2026-01-08T00:00:00Z";
      if (mode.includes("revoke")) {
        h.state.authorized = false;
        throw new Error("Synthetic clock failure after revocation");
      }
      const value = invalid();
      if (mode.includes("thrown")) throw value;
      return value;
    };
  }
  if (mode.startsWith("authority") || mode.includes("revoke")) {
    await assert.rejects(
      capture(h.options),
      (error) => error instanceof GithubClientError && error.outcome.kind === "unsafe_request",
    );
  } else if (mode.startsWith("clock")) {
    assert.deepEqual(await capture(h.options), { status: "unavailable", reason: "clock_inconsistent" });
  } else {
    assert.equal((await capture(h.options)).status, "captured");
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(invoked, 0);
  process.stdout.write("callback boundary verified\n");
}

const modes = [
  "valid",
  "authority-returned",
  "authority-thrown",
  "authority-returned-nested",
  "authority-thrown-nested",
  "authority-returned-thenable",
  "authority-thrown-thenable",
  "clock-initial-returned",
  "clock-initial-thrown",
  "clock-initial-returned-nested",
  "clock-initial-thrown-nested",
  "clock-final-returned",
  "clock-final-thrown",
  "clock-final-returned-nested",
  "clock-final-thrown-nested",
  "clock-initial-returned-thenable",
  "clock-initial-thrown-thenable",
  "clock-final-returned-thenable",
  "clock-final-thrown-thenable",
  "clock-initial-revoke",
  "clock-final-revoke",
];
for (const mode of modes)
  test("synchronous decision callback boundary: " + mode, () => {
    const program =
      "(" +
      child.toString() +
      ")(" +
      JSON.stringify(mode) +
      ").catch((error) => { console.error(error); process.exitCode = 1; });";
    const result = spawnSync(
      process.execPath,
      ["--unhandled-rejections=strict", "--input-type=module", "-e", program],
      {
        cwd,
        encoding: "utf8",
        timeout: 5_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(result.stdout, "callback boundary verified\n");
    assert.equal(result.stderr, "");
  });
