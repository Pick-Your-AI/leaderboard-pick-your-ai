import { randomUUID } from "node:crypto";

export const scanContinuationSchema = `CREATE TABLE IF NOT EXISTS leaderboard_pipeline.scan_continuations (
  configuration_key text PRIMARY KEY CHECK(configuration_key ~ '^[a-f0-9]{64}$'),
  context_hash text NOT NULL CHECK(context_hash ~ '^[a-f0-9]{64}$'),
  cycle_token uuid NOT NULL,
  scope_heads jsonb NOT NULL CHECK(jsonb_typeof(scope_heads)='object'),
  event_cutoff timestamptz NOT NULL,
  observation_cutoff timestamptz CHECK(observation_cutoff >= event_cutoff))`;

export class ScanSupersededError extends Error {
  constructor() {
    super("pipeline_scan_superseded");
  }
}

const fail = (code) => {
  throw new Error(code);
};
const iso = (value) => new Date(value).toISOString();
const sameCycle = (row, scan) =>
  row?.context_hash === scan.contextHash && row.cycle_token === scan.token && iso(row.event_cutoff) === scan.cutoff;
const savedScan = (row, requested) => ({
  ...requested,
  token: row.cycle_token,
  cutoff: iso(row.event_cutoff),
  observationCutoff: row.observation_cutoff === null ? null : iso(row.observation_cutoff),
});

/** One pending scan per approved configuration/mode. Completed cycles leave no row. */
export class ScanContinuationStore {
  constructor(db) {
    this.db = db;
  }

  async assertSources(tx, scan) {
    const access = (
      await tx.query(
        `SELECT repository_id,generation FROM leaderboard_ingestion.repository_access
       WHERE repository_id=ANY($1::bigint[]) AND state='public' ORDER BY repository_id FOR SHARE`,
        [scan.sources.map((source) => source.repositoryId)],
      )
    ).rows;
    if (
      access.length !== scan.sources.length ||
      scan.sources.some(
        (source) =>
          !access.some(
            (row) =>
              String(row.repository_id) === String(source.repositoryId) && String(row.generation) === source.generation,
          ),
      )
    )
      fail("pipeline_scan_source_changed");
  }

  async claim(requested, assertAuthorized, currentCutoff, scopeKeysAt, preparePlan = null) {
    return this.db.transaction(async (tx) => {
      assertAuthorized();
      const token = randomUUID();
      const inserted = await tx.query(
        `INSERT INTO leaderboard_pipeline.scan_continuations
         (configuration_key,context_hash,cycle_token,event_cutoff,scope_heads)
         VALUES($1,$2,$3,$4,'{}'::jsonb) ON CONFLICT DO NOTHING RETURNING cycle_token`,
        [requested.key, requested.contextHash, token, requested.cutoff],
      );
      let row = (
        await tx.query("SELECT * FROM leaderboard_pipeline.scan_continuations WHERE configuration_key=$1 FOR UPDATE", [
          requested.key,
        ])
      ).rows[0];
      await this.assertSources(tx, requested);
      const fresh = Boolean(inserted.rows.length || row.context_hash !== requested.contextHash);
      if (fresh) {
        // Select and validate a new window while holding this context's row.
        // Retried cycles use their saved cutoff without resolving today's window.
        const cutoff = currentCutoff();
        const scopeKeys = scopeKeysAt(cutoff);
        const heads = (
          await tx.query(
            "SELECT scope_key,snapshot_id FROM leaderboard_pipeline.heads WHERE scope_key=ANY($1::text[])",
            [scopeKeys],
          )
        ).rows;
        const scopeHeads = Object.fromEntries(
          scopeKeys.map((key) => [key, heads.find((head) => head.scope_key === key)?.snapshot_id ?? null]),
        );
        row = (
          await tx.query(
            `UPDATE leaderboard_pipeline.scan_continuations
           SET context_hash=$2,cycle_token=$3,event_cutoff=$4,observation_cutoff=NULL,scope_heads=$5::jsonb
           WHERE configuration_key=$1 RETURNING *`,
            [requested.key, requested.contextHash, token, cutoff, JSON.stringify(scopeHeads)],
          )
        ).rows[0];
      }
      const scan = savedScan(row, requested);
      // Plan rows and the selected cycle commit together, before any source read.
      // A resumed token must reload its original plan; it cannot choose new work.
      if (preparePlan) scan.plan = await preparePlan(tx, scan, { fresh });
      assertAuthorized();
      return scan;
    });
  }

  async freeze(scan, observationCutoff, assertAuthorized) {
    return this.db.transaction(async (tx) => {
      let row = (
        await tx.query("SELECT * FROM leaderboard_pipeline.scan_continuations WHERE configuration_key=$1 FOR UPDATE", [
          scan.key,
        ])
      ).rows[0];
      if (!sameCycle(row, scan)) throw new ScanSupersededError();
      await this.assertSources(tx, scan);
      if (row.observation_cutoff === null) {
        if (observationCutoff < scan.cutoff) fail("observation_clock_precedes_event_cutoff");
        row = (
          await tx.query(
            `UPDATE leaderboard_pipeline.scan_continuations SET observation_cutoff=$2
           WHERE configuration_key=$1 RETURNING *`,
            [scan.key, observationCutoff],
          )
        ).rows[0];
      }
      assertAuthorized();
      return savedScan(row, scan);
    });
  }

  // Hold the row lock through publication and its expected-head update. Taking
  // the exclusive lock first avoids shared-lock upgrades between publishers.
  async lockForPublication(tx, scan, assertAuthorized) {
    const row = (
      await tx.query("SELECT * FROM leaderboard_pipeline.scan_continuations WHERE configuration_key=$1 FOR UPDATE", [
        scan.key,
      ])
    ).rows[0];
    if (
      !sameCycle(row, scan) ||
      row.observation_cutoff === null ||
      iso(row.observation_cutoff) !== scan.observationCutoff
    )
      throw new ScanSupersededError();
    await this.assertSources(tx, scan);
    assertAuthorized();
    return row.scope_heads;
  }

  assertHead(heads, scopeKey, currentSnapshotId) {
    if (
      !heads ||
      Array.isArray(heads) ||
      !Object.hasOwn(heads, scopeKey) ||
      (heads[scopeKey] !== null && typeof heads[scopeKey] !== "string")
    )
      fail("pipeline_scan_head_integrity_error");
    // This also fences explicit-cutoff publishers, which do not share a cycle.
    if (heads[scopeKey] !== currentSnapshotId) throw new ScanSupersededError();
  }

  async rememberPublication(tx, scan, scopeKey, snapshotId) {
    const saved = await tx.query(
      `UPDATE leaderboard_pipeline.scan_continuations
       SET scope_heads=jsonb_set(scope_heads,ARRAY[$2]::text[],to_jsonb($3::text))
       WHERE configuration_key=$1 AND cycle_token=$4 RETURNING cycle_token`,
      [scan.key, scopeKey, snapshotId, scan.token],
    );
    if (saved.rows.length !== 1) throw new ScanSupersededError();
  }

  async retire(scan, assertAuthorized) {
    return this.db.transaction(async (tx) => {
      // Another successful worker may already have retired this exact cycle.
      // Never delete its replacement, including after a process restart (ABA).
      await tx.query(
        `DELETE FROM leaderboard_pipeline.scan_continuations
         WHERE configuration_key=$1 AND context_hash=$2 AND cycle_token=$3
         AND event_cutoff=$4 AND observation_cutoff=$5`,
        [scan.key, scan.contextHash, scan.token, scan.cutoff, scan.observationCutoff],
      );
      assertAuthorized();
    });
  }
}
