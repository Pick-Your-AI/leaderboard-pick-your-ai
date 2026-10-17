import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("replay CLI rejects invalid scopes before connecting and never reflects credential-bearing configuration", () => {
  const cases = [
    [],
    ["2"],
    ["0", "SYNTHETIC_ISSUE"],
    ["2", "invalid subject"],
    ["9007199254740993", "SYNTHETIC_ISSUE"],
    ["2", "SYNTHETIC_ISSUE", "extra"],
  ];
  for (const args of cases) {
    const result = spawnSync(process.execPath, [cli, "replay", ...args], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        INGESTION_DATABASE_URL: "postgres://synthetic-user:synthetic-sensitive@127.0.0.1:1/unused",
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^ingestion: startup or runtime failed; check approved configuration and database availability\r?\n$/,
    );
    assert.doesNotMatch(result.stderr, /synthetic-sensitive|postgres:\/\//);
  }
});

test("snapshot CLI validates scope, definition, revision and pin before database access", () => {
  const cases = [
    ["snapshot-publish", "2", "SYNTHETIC_ISSUE", "synthetic-policy-v1", "-1"],
    ["snapshot-publish", "2", "SYNTHETIC_ISSUE", "bad version", "0"],
    ["snapshot-publish", "2", "SYNTHETIC_ISSUE", "synthetic-policy-v1", "9223372036854775808"],
    ["snapshot-publish", "2", "SYNTHETIC_ISSUE"],
    ["snapshot-latest", "2", "invalid subject"],
    ["snapshot-read", "invalid-pin"],
  ];
  for (const args of cases) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        INGESTION_DATABASE_URL: "postgres://synthetic-user:synthetic-sensitive@127.0.0.1:1/unused",
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^ingestion: startup or runtime failed; check approved configuration and database availability\r?\n$/,
    );
    assert.doesNotMatch(result.stderr, /synthetic-sensitive|postgres:\/\//);
  }
});
