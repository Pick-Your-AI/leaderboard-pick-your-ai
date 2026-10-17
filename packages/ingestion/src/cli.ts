import { Pool } from "pg";
import { createIngestionServer, runWorker } from "./runtime.js";
import { InboxStore, postgresDatabase } from "./store.js";

function scopeFromEnvironment(raw: string | undefined): Map<number, Set<number>> {
  if (!raw) throw new Error("Missing scope");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Invalid scope");
  const scope = new Map<number, Set<number>>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid scope");
    const { installationId, repositoryIds } = entry as Record<string, unknown>;
    if (typeof installationId !== "number" || !Number.isSafeInteger(installationId) || installationId < 1 ||
        !Array.isArray(repositoryIds) || repositoryIds.some(id => !Number.isSafeInteger(id) || id < 1) || scope.has(installationId)) {
      throw new Error("Invalid scope");
    }
    scope.set(installationId, new Set(repositoryIds as number[]));
  }
  return scope;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "service" && mode !== "worker") throw new Error("Choose service or worker");
  const connectionString = process.env.INGESTION_DATABASE_URL;
  if (!connectionString) throw new Error("Missing database configuration");
  const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, query_timeout: 10_000, statement_timeout: 8000 });
  // A disconnected idle client is not an unhandled process-level error.
  pool.on("error", () => { console.error("ingestion: database connection unavailable"); });
  const store = new InboxStore(postgresDatabase(pool));
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    // No automatic migrations or source collection at startup.
    await pool.query("SELECT delivery_id FROM leaderboard_ingestion.inbox LIMIT 0");
    if (mode === "worker") {
      await runWorker(store, { signal: abort.signal,
        onStatus: status => { if (status !== "idle") console.log(`ingestion-worker: ${status}`); } });
    } else {
      const scope = scopeFromEnvironment(process.env.INGESTION_SCOPE_JSON);
      const portText = process.env.INGESTION_PORT ?? "8788";
      if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error("Invalid port");
      const secrets = [process.env.INGESTION_WEBHOOK_SECRET ?? ""];
      if (process.env.INGESTION_PREVIOUS_WEBHOOK_SECRET) secrets.push(process.env.INGESTION_PREVIOUS_WEBHOOK_SECRET);
      const server = createIngestionServer({ secrets, scope, store });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(Number(portText), "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      console.log(`ingestion-service: listening on 127.0.0.1:${Number(portText)}`);
      if (!abort.signal.aborted) await new Promise<void>(resolve => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
      // Stop accepting work, let active transactions finish, then bound socket drain.
      const deadline = setTimeout(() => server.closeAllConnections(), 15_000);
      deadline.unref();
      try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
      finally { clearTimeout(deadline); }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await pool.end();
  }
}

main().catch(() => {
  // Configuration/database exceptions can contain credentials. Emit no raw message.
  console.error("ingestion: startup or runtime failed; check approved configuration and database availability");
  process.exitCode = 1;
});
