import assert from "node:assert/strict";
import test from "node:test";
import { connectLocalDatabase, localDatabaseUrl } from "../connection.mjs";

function withDatabaseUrl(value, check) {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = value;
  try {
    check();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

test("local database guard rejects remote query-string host overrides before connecting", () => {
  for (const key of ["host", "%68ost"]) {
    withDatabaseUrl(`postgres://127.0.0.1/leaderboard_test?${key}=remote.example.invalid`, () => {
      assert.throws(() => localDatabaseUrl(), /host overrides/);
      assert.throws(() => connectLocalDatabase(), /host overrides/);
    });
  }
});

test("local database guard accepts IPv4 and IPv6 loopback with development database names", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    withDatabaseUrl(`postgres://${host}/leaderboard_test`, () => {
      const client = connectLocalDatabase();
      assert.equal(client.connectionParameters.host, host.replace(/^\[|\]$/g, ""));
      assert.equal(client.connectionParameters.database, "leaderboard_test");
    });
  }
});

test("local database guard rejects remote authorities and production database names", () => {
  for (const value of ["postgres://remote.example.invalid/leaderboard_test", "postgres://127.0.0.1/leaderboard"]) {
    withDatabaseUrl(value, () => assert.throws(() => localDatabaseUrl(), /require a local host/));
  }
});
