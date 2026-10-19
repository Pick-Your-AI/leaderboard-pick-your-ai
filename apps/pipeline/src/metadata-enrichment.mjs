import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const fail = () => {
  throw new Error("enrichment_authorization_changed");
};
const clone = (value) => structuredClone(value);
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const hash = (value) => createHash("sha256").update(canonical(value)).digest("hex");

/** Explicit trusted host composition; never installs an adapter or a public route. */
export function createMetadataEnrichment({ db, ingestion, setting, config, dataMode, capture }) {
  if (setting === undefined) return null;
  if (
    !setting ||
    typeof setting !== "object" ||
    Array.isArray(setting) ||
    Object.keys(setting).some((key) => !["source", "policyVersion", "configurationCurrent"].includes(key)) ||
    typeof setting.source?.readMetadata !== "function" ||
    typeof setting.configurationCurrent !== "function" ||
    typeof setting.policyVersion !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(setting.policyVersion)
  )
    throw new Error("invalid_metadata_enrichment_options");
  // Capture functions and immutable configuration before the first asynchronous call.
  const readMetadata = setting.source.readMetadata.bind(setting.source);
  const configurationCurrent = setting.configurationCurrent;
  const policyVersion = setting.policyVersion;
  const configured = clone(config);
  const configurationHash = hash(configured);
  const scopes = configured.repositories.flatMap((repo) =>
    repo.families.map((family) => ({
      repositoryId: repo.id,
      installationId: repo.installationId,
      family,
    })),
  );
  if (
    !scopes.length ||
    scopes.length > 1200 ||
    new Set(scopes.map((scope) => `${scope.repositoryId}:${scope.family}`)).size !== scopes.length
  )
    throw new Error("invalid_metadata_enrichment_scope");
  const store = new ingestion.EnrichmentStore(db);
  const lifetime = new AbortController();
  let next = 0;
  let operation = Promise.resolve();
  const serialize = (work) => {
    const result = operation.then(work);
    operation = result.catch(() => undefined);
    return result;
  };
  async function authority(selected) {
    const captured = await capture();
    // Source restoration advances this durable generation independently of
    // controls/configuration changes. Capture it before deriving a job identity.
    const accessGeneration = await db.transaction(async (tx) => {
      await captured.authorize(tx);
      const access = (
        await tx.query(
          "SELECT state,generation,installation_id FROM leaderboard_ingestion.repository_access WHERE repository_id=$1 FOR SHARE",
          [selected.repositoryId],
        )
      ).rows[0];
      await captured.authorize(tx);
      return access?.state === "public" && Number(access.installation_id) === selected.installationId
        ? String(access.generation)
        : null;
    });
    captured.current();
    if (accessGeneration === null) return null;
    const binding = {
      ...selected,
      accessGeneration,
      configurationHash,
      controlsConfigurationRevision: captured.revision,
      policyVersion,
      dataMode,
    };
    const current = () => {
      if (lifetime.signal.aborted) return false;
      captured.current();
      let allowed;
      try {
        allowed = configurationCurrent(clone(binding));
      } catch {
        return false;
      }
      if (allowed !== true) {
        if (allowed && typeof allowed.then === "function") void Promise.resolve(allowed).catch(() => undefined);
        return false;
      }
      captured.current();
      return true;
    };
    if (!current()) fail();
    return {
      ...selected,
      accessGeneration,
      policyVersion: `metadata:v1:${hash(binding)}`,
      current,
      signal: lifetime.signal,
      authorize: async (tx) => {
        await captured.authorize(tx);
        return current();
      },
    };
  }
  function selectedScope(repositoryId, family) {
    const selected = scopes.find((scope) => scope.repositoryId === repositoryId && scope.family === family);
    if (!selected) throw new Error("unconfigured_enrichment_scope");
    return selected;
  }
  async function processOne() {
    if (!scopes.length) fail();
    const selected = scopes[next++ % scopes.length];
    const scoped = await authority(selected);
    if (!scoped) return "idle";
    // Sweep retained collection membership so a crash between page commit and
    // enqueue is recoverable. One call admits at most 100 exact source keys.
    const keys = await db.transaction(async (tx) => {
      if (!(await scoped.authorize(tx))) fail();
      const access = (
        await tx.query(
          `SELECT state,generation,installation_id FROM
        leaderboard_ingestion.repository_access WHERE repository_id=$1 FOR SHARE`,
          [selected.repositoryId],
        )
      ).rows[0];
      if (
        access?.state !== "public" ||
        Number(access.installation_id) !== selected.installationId ||
        String(access.generation) !== scoped.accessGeneration
      )
        throw new Error("enrichment_authorization_changed");
      const rows = (
        await tx.query(
          `SELECT fact.fact_key FROM leaderboard_ingestion.source_facts AS fact
        JOIN leaderboard_pipeline.source_modes AS mode USING(fact_key)
        WHERE fact.repository_id=$1 AND fact.family=$2 AND mode.data_mode=$3
          AND NOT EXISTS (SELECT 1 FROM leaderboard_ingestion.object_suppressions AS removed
            WHERE removed.repository_id=fact.repository_id AND removed.subject_id=fact.subject_id)
          AND EXISTS (SELECT 1 FROM leaderboard_ingestion.collection_items AS item
            JOIN leaderboard_ingestion.collection_runs AS run USING(run_id)
            WHERE item.fact_key=fact.fact_key AND run.repository_id=fact.repository_id
              AND run.family=fact.family AND run.access_generation=$4)
          AND NOT EXISTS (SELECT 1 FROM leaderboard_ingestion.enrichment_jobs AS job
            WHERE job.fact_key=fact.fact_key AND job.policy_version=$5)
        ORDER BY fact.observed_at,fact.fact_key LIMIT 100`,
          [selected.repositoryId, selected.family, dataMode, access.generation, scoped.policyVersion],
        )
      ).rows;
      if (!(await scoped.authorize(tx))) fail();
      return rows.map((row) => row.fact_key);
    });
    if (!scoped.current()) fail();
    if (keys.length) await store.enqueueScoped(keys, scoped);
    return store.processOne({ readMetadata }, 60, scoped);
  }
  return {
    processOne: () => serialize(processOne),
    async readStates(repositoryId, family, limit = 100) {
      const scoped = await authority(selectedScope(repositoryId, family));
      if (!scoped) throw new Error("source_access_changed");
      return store.readStates(scoped, limit);
    },
    async run(signal) {
      while (!signal.aborted) {
        let pause = 100;
        try {
          pause = (await serialize(processOne)) === "idle" ? 1000 : 100;
        } catch {
          pause = 1000;
        }
        try {
          await delay(pause, undefined, { signal });
        } catch {
          if (!signal.aborted) throw new Error("enrichment_wait_failed");
        }
      }
    },
    settled: () => operation,
    stop: () => lifetime.abort(),
  };
}
