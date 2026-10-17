import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connectLocalDatabase } from "./connection.mjs";

if (process.env.ALLOW_SYNTHETIC_FIXTURES !== "1") {
  throw new Error("Set ALLOW_SYNTHETIC_FIXTURES=1 to import explicitly synthetic local fixtures");
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(await readFile(join(here, "../../tests/fixtures/synthetic-observations.json"), "utf8"));
if (!fixture.fixture_notice?.startsWith("Synthetic data for local development only.")) {
  throw new Error("Fixture is missing its synthetic-data notice");
}
const client = connectLocalDatabase();
try {
  await client.connect();
  await client.query("BEGIN");
  try {
    for (const project of fixture.projects) {
      await client.query(
        "INSERT INTO projects (id, name, repository_url, is_synthetic) VALUES ($1, $2, $3, true) ON CONFLICT (id) DO NOTHING",
        [project.id, project.name, project.repository_url]
      );
    }
    for (const actor of fixture.actors) {
      await client.query(
        "INSERT INTO actors (id, display_name, is_synthetic) VALUES ($1, $2, true) ON CONFLICT (id) DO NOTHING",
        [actor.id, actor.display_name]
      );
    }
    for (const item of fixture.observations) {
      await client.query(
        `INSERT INTO source_observations
         (id, project_id, actor_id, action, subject, occurred_at, observed_at, source_url, is_synthetic)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
         ON CONFLICT (id) DO NOTHING`,
        [item.id, item.project_id, item.actor_id, item.action, item.subject, item.occurred_at, item.observed_at, item.source_url]
      );
    }
    await client.query("COMMIT");
    console.info(`Imported ${fixture.projects.length} synthetic projects, ${fixture.actors.length} synthetic actors, and ${fixture.observations.length} synthetic observations`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
} finally {
  await client.end();
}
