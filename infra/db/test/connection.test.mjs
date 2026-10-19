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

const rejectedConnectionFields = [
  [
    "NUL in the database pathname",
    "postgres://synthetic_user@127.0.0.1/isolated_nominal%00application_name%00probe_test",
  ],
  [
    "NUL in application_name",
    "postgres://synthetic_user@127.0.0.1/leaderboard_test?application_name=probe%00database%00isolated_nominal",
  ],
  [
    "NUL in fallback_application_name",
    "postgres://synthetic_user@127.0.0.1/leaderboard_test?fallback_application_name=probe%00database%00isolated_nominal",
  ],
  [
    "NUL in options",
    "postgres://synthetic_user@127.0.0.1/leaderboard_test?options=-c%20search_path%3Dpublic%00database%00isolated_nominal",
  ],
  [
    "NUL in replication",
    "postgres://synthetic_user@127.0.0.1/leaderboard_test?replication=false%00database%00isolated_nominal",
  ],
  ["NUL in the username", "postgres://synthetic%00user@127.0.0.1/leaderboard_test"],
  ["NUL in the password", "postgres://synthetic_user:synthetic%00password@127.0.0.1/leaderboard_test"],
  ["NUL in a query parameter name", "postgres://synthetic_user@127.0.0.1/leaderboard_test?application_name%00=probe"],
];

for (const [name, value] of rejectedConnectionFields) {
  test(`local database guard rejects ${name} before client creation`, () => {
    withDatabaseUrl(value, () => {
      assert.throws(() => localDatabaseUrl(), /NUL/);
      assert.throws(() => connectLocalDatabase(), /NUL/);
    });
  });
}

for (const [name, character] of [
  ["TAB", "\t"],
  ["LF", "\n"],
  ["CR", "\r"],
]) {
  test(`local database guard rejects normalized NUL ambiguity from raw ${name}`, () => {
    for (const value of [
      `postgres://synthetic_user@127.0.0.1/isolated_nominal%0${character}0application_name%0${character}0probe_test`,
      `postgres://synthetic_user@127.0.0.1/leaderboard_test?application_name=probe%0${character}0database%0${character}0isolated_nominal`,
    ]) {
      withDatabaseUrl(value, () => {
        assert.throws(() => localDatabaseUrl(), /NUL/);
        assert.throws(() => connectLocalDatabase(), /NUL/);
      });
    }
  });
}

test("local database guard preserves double-escaped percent-zero connection text", () => {
  withDatabaseUrl(
    "postgres://synthetic_user:synthetic%2500password@127.0.0.1/literal%2500_test?application_name=probe%2500text",
    () => {
      const client = connectLocalDatabase();
      assert.equal(client.connectionParameters.user, "synthetic_user");
      assert.equal(client.connectionParameters.password, "synthetic%00password");
      assert.equal(client.connectionParameters.database, "literal%00_test");
      assert.equal(client.connectionParameters.application_name, "probe%00text");
    },
  );
});

test("local database guard preserves ordinary encoded connection fields and options", () => {
  withDatabaseUrl(
    "postgres://synthetic%20user:synthetic%25password@127.0.0.1/leaderboard%20local_test?application_name=review%20fixture&options=-c%20search_path%3Dpublic",
    () => {
      const client = connectLocalDatabase();
      assert.equal(client.connectionParameters.user, "synthetic user");
      assert.equal(client.connectionParameters.password, "synthetic%password");
      assert.equal(client.connectionParameters.database, "leaderboard local_test");
      assert.equal(client.connectionParameters.application_name, "review fixture");
      assert.equal(client.connectionParameters.options, "-c search_path=public");
    },
  );
});

test("local database guard preserves ignored NUL-looking fragments", () => {
  withDatabaseUrl("postgres://synthetic_user@127.0.0.1/leaderboard_test#%00", () => {
    assert.equal(connectLocalDatabase().connectionParameters.database, "leaderboard_test");
  });
});
