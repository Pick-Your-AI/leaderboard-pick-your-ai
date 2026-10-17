import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { connectLocalDatabase } from "./connection.mjs";

function run(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv }
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const here = fileURLToPath(new URL(".", import.meta.url));
const client = connectLocalDatabase();
try {
  await client.connect();
  const applied = await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations'"
  );
  if (applied.rowCount) {
    const rows = await client.query("SELECT count(*)::int AS count FROM schema_migrations");
    const applicationTables = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('projects', 'actors', 'source_observations')"
    );
    if (rows.rows[0].count > 0 || applicationTables.rowCount > 0) {
      throw new Error("Migration validation requires a clean disposable database with no applied migrations or application tables");
    }
  }
} finally {
  await client.end();
}
run([join(here, "migrate.mjs")]);
run([join(here, "rollback.mjs")], { ALLOW_LOCAL_DB_ROLLBACK: "1" });
run([join(here, "migrate.mjs")]);
console.info("Migration forward, rollback, and reapply completed on the configured local database.");
