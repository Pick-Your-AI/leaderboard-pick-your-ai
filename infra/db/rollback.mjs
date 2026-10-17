import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connectLocalDatabase } from "./connection.mjs";

if (process.env.ALLOW_LOCAL_DB_ROLLBACK !== "1") {
  throw new Error("Set ALLOW_LOCAL_DB_ROLLBACK=1 to allow one local development migration rollback");
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationDir = join(here, "migrations");
const client = connectLocalDatabase();
try {
  await client.connect();
  const latest = await client.query("SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1");
  if (!latest.rowCount) {
    console.info("No migrations to roll back");
  } else {
    const name = latest.rows[0].name;
    const downName = name.replace(/\.up\.sql$/, ".down.sql");
    const sql = await readFile(join(migrationDir, downName), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("DELETE FROM schema_migrations WHERE name = $1", [name]);
      await client.query("COMMIT");
      console.info(`Rolled back ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.end();
}
