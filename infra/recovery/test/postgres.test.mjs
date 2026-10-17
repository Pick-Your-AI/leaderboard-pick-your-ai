import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { encryptBackup, restoreBackup } from "../backup.mjs";

const container = process.env.RECOVERY_TEST_CONTAINER;
test(
  "PostgreSQL encrypted dump restores known snapshot/correction state and reapplies current tombstones",
  { skip: !container },
  async () => {
    assert.match(container, /^leaderboard-task-[a-zA-Z0-9-]+$/);
    const source = `leaderboard_recovery_source_${process.pid}_test`;
    const target = `leaderboard_recovery_target_${process.pid}_test`;
    function docker(args, input) {
      const result = spawnSync("docker", ["exec", "-i", container, ...args], { input, maxBuffer: 96 * 1024 * 1024 });
      if (result.status !== 0) throw new Error(`Isolated PostgreSQL operation failed (exit ${result.status})`);
      return result.stdout;
    }
    const sql = (db, query) =>
      docker(["psql", "-U", "leaderboard", "-d", db, "-v", "ON_ERROR_STOP=1", "-At", "-c", query]);
    for (const db of [source, target]) docker(["createdb", "-U", "leaderboard", db]);
    try {
      sql(
        source,
        `CREATE TABLE synthetic_recovery_state(snapshot text PRIMARY KEY, correction text NOT NULL, suppressed boolean NOT NULL);
      INSERT INTO synthetic_recovery_state VALUES ('synthetic-snapshot-1','synthetic-correction-2',false);`,
      );
      const dump = docker(["pg_dump", "-U", "leaderboard", "--no-owner", "--no-acl", "-d", source]);
      const now = new Date().toISOString();
      const key = randomBytes(32);
      const envelope = encryptBackup({
        databaseDump: dump,
        configuration: { scope: "synthetic-only" },
        policyVersions: ["synthetic-policy/v1"],
        watermarks: { synthetic: "12" },
        key,
        createdAt: now,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        sourceCutoff: now,
      });
      const receipt = await restoreBackup({
        envelope,
        key,
        now,
        observedSourceCutoff: now,
        expectedState: { snapshot: "synthetic-snapshot-1", correction: "synthetic-correction-2", suppressed: true },
        assertEmptyTarget: async () =>
          assert.equal(
            sql(target, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").toString().trim(),
            "0",
          ),
        restoreDatabase: async (bytes) =>
          docker(["psql", "-U", "leaderboard", "-d", target, "-v", "ON_ERROR_STOP=1", "--single-transaction"], bytes),
        reapplySuppressions: async () => sql(target, "UPDATE synthetic_recovery_state SET suppressed=true"),
        inspectRestoredState: async () =>
          JSON.parse(sql(target, "SELECT row_to_json(s) FROM synthetic_recovery_state s").toString()),
      });
      assert.equal(receipt.restoredSnapshotLoss, 0);
      assert.equal(receipt.sourceGapMilliseconds, 0);
      console.info(JSON.stringify({ recoveryDrill: receipt }));
    } finally {
      for (const db of [source, target]) docker(["dropdb", "-U", "leaderboard", "--if-exists", db]);
    }
  },
);
