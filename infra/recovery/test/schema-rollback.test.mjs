import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { encryptBackup, restoreBackup } from "../backup.mjs";

const container = process.env.RECOVERY_TEST_CONTAINER;
const literal = (value) => (value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`);

test(
  "actual fixture schema survives encrypted backup, full migration rollback and exact restoration",
  { skip: !container },
  async () => {
    assert.match(container, /^leaderboard-task-[a-zA-Z0-9-]+$/);
    const database = `leaderboard_schema_recovery_${process.pid}_test`;
    function docker(args, input) {
      const result = spawnSync("docker", ["exec", "-i", container, ...args], {
        input,
        timeout: 60_000,
        maxBuffer: 96 * 1024 * 1024,
      });
      if (result.status !== 0) throw new Error(`Isolated schema recovery operation failed (exit ${result.status})`);
      return result.stdout;
    }
    const sql = (query) =>
      docker(["psql", "-U", "leaderboard", "-d", database, "-v", "ON_ERROR_STOP=1", "-At"], query).toString().trim();
    const state = () =>
      JSON.parse(
        sql(`SELECT json_build_object(
    'projects',(SELECT json_agg(p ORDER BY id) FROM projects p),
    'actors',(SELECT json_agg(a ORDER BY id) FROM actors a),
    'observations',(SELECT json_agg(o ORDER BY id) FROM source_observations o),
    'migrations',(SELECT json_agg(m ORDER BY name) FROM schema_migrations m),
    'columns',(SELECT json_agg(c ORDER BY table_name,ordinal_position) FROM
      (SELECT table_name,column_name,ordinal_position,data_type,is_nullable,column_default
       FROM information_schema.columns WHERE table_schema='public') c),
    'constraints',(SELECT json_agg(c ORDER BY table_name,constraint_name) FROM
      (SELECT r.relname AS table_name,c.conname AS constraint_name,c.contype AS constraint_type,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public') c),
    'indexes',(SELECT json_agg(i ORDER BY tablename,indexname) FROM
      (SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public') i)
  );`),
      );
    docker(["createdb", "-U", "leaderboard", database]);
    try {
      const directory = new URL("../../db/migrations/", import.meta.url);
      const migrations = (await readdir(directory)).filter((name) => name.endsWith(".up.sql")).sort();
      assert.ok(migrations.length > 0);
      sql(
        "CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());",
      );
      for (const name of migrations) {
        const migration = await readFile(new URL(name, directory), "utf8");
        sql(
          `BEGIN; ${migration}\nINSERT INTO schema_migrations(name,checksum) VALUES (${literal(name)},${literal(createHash("sha256").update(migration).digest("hex"))}); COMMIT;`,
        );
      }
      const fixture = JSON.parse(
        await readFile(new URL("../../../tests/fixtures/synthetic-observations.json", import.meta.url), "utf8"),
      );
      assert.match(fixture.fixture_notice, /^Synthetic data for local development only\./);
      for (const [table, records, columns] of [
        ["projects", fixture.projects, ["id", "name", "repository_url"]],
        ["actors", fixture.actors, ["id", "display_name"]],
        [
          "source_observations",
          fixture.observations,
          ["id", "project_id", "actor_id", "action", "subject", "occurred_at", "observed_at", "source_url"],
        ],
      ]) {
        assert.ok(records.length > 0);
        for (const record of records) {
          assert.ok(columns.every((key) => typeof record[key] === "string"));
          sql(
            `INSERT INTO ${table}(${columns.join(",")},is_synthetic) VALUES (${columns.map((key) => literal(record[key])).join(",")},true);`,
          );
        }
      }
      const expectedState = state();
      assert.equal(expectedState.projects.length, fixture.projects.length);
      assert.equal(expectedState.actors.length, fixture.actors.length);
      assert.equal(expectedState.observations.length, fixture.observations.length);
      assert.ok(expectedState.observations.every((row) => row.is_synthetic));
      const now = new Date().toISOString(),
        key = randomBytes(32);
      const envelope = encryptBackup({
        databaseDump: docker(["pg_dump", "-U", "leaderboard", "--no-owner", "--no-acl", "-d", database]),
        key,
        createdAt: now,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        sourceCutoff: now,
        configuration: { fixtureOnly: true },
        policyVersions: ["synthetic-fixture/v1"],
        watermarks: {},
      });
      for (const name of [...migrations].reverse()) {
        const rollback = await readFile(new URL(name.replace(/\.up\.sql$/, ".down.sql"), directory), "utf8");
        sql(`BEGIN; ${rollback}\nDELETE FROM schema_migrations WHERE name=${literal(name)}; COMMIT;`);
      }
      assert.equal(sql("SELECT count(*) FROM schema_migrations;"), "0");
      assert.equal(
        sql(
          "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name <> 'schema_migrations';",
        ),
        "0",
      );
      sql("DROP TABLE schema_migrations;");
      const receipt = await restoreBackup({
        envelope,
        key,
        now,
        observedSourceCutoff: now,
        expectedState,
        assertEmptyTarget: async () =>
          assert.equal(sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"), "0"),
        restoreDatabase: async (bytes) =>
          docker(["psql", "-U", "leaderboard", "-d", database, "-v", "ON_ERROR_STOP=1", "--single-transaction"], bytes),
        // The local fixture schema has no publication or suppression state and is never public.
        reapplySuppressions: async () => {},
        inspectRestoredState: async () => state(),
      });
      assert.deepEqual(state(), expectedState);
      assert.equal(receipt.restoredSnapshotLoss, 0);
      console.info(JSON.stringify({ syntheticSchemaRollbackRecovery: receipt, migrationCount: migrations.length }));
    } finally {
      docker(["dropdb", "-U", "leaderboard", "--if-exists", database]);
    }
  },
);
