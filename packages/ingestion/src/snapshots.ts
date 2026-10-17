import { createHash } from "node:crypto";
import { replayTransitions, type ReplayResult } from "./replay.js";
import { readObjectReplay, type RetainedObjectReplay, type SqlDatabase } from "./store.js";
import { assertRepositoryAvailable } from "./collection.js";

export interface SnapshotDocument {
  version: "retained-state-snapshot/v1";
  scope: { repositoryId: number; subjectId: string };
  definitionVersion: string;
  computationVersion: "transition-replay/v1";
  coverage: "retained_observations_only";
  sourceObservationCount: number;
  replay: ReplayResult;
}
export interface StoredSnapshot {
  snapshotId: string;
  createdAt: string;
  document: SnapshotDocument;
}
export interface SnapshotHead {
  revision: string;
  publishedAt: string;
  snapshot: StoredSnapshot;
}
export interface SnapshotNotice {
  revision: string;
  snapshotId: string;
  publishedAt: string;
}

const maxRevision = 9_223_372_036_854_775_807n;
function revision(value: string): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > maxRevision) throw new Error("invalid_snapshot_revision");
  return value;
}
function scopeKey(repositoryId: number, subjectId: string): string {
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1 || typeof subjectId !== "string" || !/^[A-Za-z0-9_=-]{1,200}$/.test(subjectId)) {
    throw new Error("invalid_snapshot_scope");
  }
  return JSON.stringify([repositoryId, subjectId]);
}
function definition(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new Error("invalid_definition_version");
  return value;
}
/** JSONB can reorder object keys. Hash a canonical representation on both write and read. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("invalid_snapshot_document");
  return result;
}
function digest(document: SnapshotDocument): string { return createHash("sha256").update(canonical(document)).digest("hex"); }
function makeDocument(repositoryId: number, subjectId: string, definitionVersion: string, source: RetainedObjectReplay): SnapshotDocument {
  return { version: "retained-state-snapshot/v1", scope: { repositoryId, subjectId }, definitionVersion,
    computationVersion: "transition-replay/v1", coverage: "retained_observations_only",
    sourceObservationCount: source.sourceObservationCount, replay: source.replay };
}
function decode(row: Record<string, unknown>): StoredSnapshot {
  try {
    const document = row.document as SnapshotDocument;
    const { repositoryId, subjectId } = document.scope;
    if (scopeKey(repositoryId, subjectId) !== row.scope_key ||
        !Number.isInteger(document.sourceObservationCount) || document.sourceObservationCount < 1 || document.sourceObservationCount > 256) {
      throw new Error();
    }
    const replay = replayTransitions(document.replay.events);
    if (replay.events.length > document.sourceObservationCount) throw new Error();
    const expected = makeDocument(repositoryId, subjectId, definition(document.definitionVersion), {
      coverage: "retained_observations_only", sourceObservationCount: document.sourceObservationCount, replay,
    });
    if (canonical(document) !== canonical(expected) || digest(expected) !== row.snapshot_id) throw new Error();
    return { snapshotId: String(row.snapshot_id), createdAt: new Date(row.created_at as string).toISOString(), document: expected };
  } catch { throw new Error("snapshot_integrity_error"); }
}

/** Internal publication only; no public HTTP projection or contributor eligibility is implied. */
export class SnapshotStore {
  constructor(readonly db: SqlDatabase) {}

  async publishObjectState(repositoryId: number, subjectId: string, definitionVersion: string,
    expectedRevision: string): Promise<SnapshotHead & { changed: boolean }> {
    const key = scopeKey(repositoryId, subjectId);
    definition(definitionVersion);
    revision(expectedRevision);
    return this.db.transaction(async tx => {
      await assertRepositoryAvailable(tx, repositoryId, subjectId);
      // Transaction-owned lock covers first publication as well as existing heads.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`leaderboard-snapshots:${key}`]);
      const heads = await tx.query("SELECT revision::text, snapshot_id, published_at FROM leaderboard_ingestion.snapshot_heads WHERE scope_key = $1", [key]);
      const prior = heads.rows[0];
      const currentRevision = prior ? String(prior.revision) : "0";
      if (currentRevision !== expectedRevision) throw new Error("snapshot_revision_conflict");
      const source = await readObjectReplay(tx, repositoryId, subjectId);
      if (source.sourceObservationCount === 0) throw new Error("snapshot_no_observations");
      const document = makeDocument(repositoryId, subjectId, definitionVersion, source);
      const snapshotId = digest(document);
      const unchanged = prior?.snapshot_id === snapshotId;
      if (!unchanged && BigInt(currentRevision) === maxRevision) throw new Error("snapshot_revision_exhausted");
      await tx.query(`INSERT INTO leaderboard_ingestion.snapshots (snapshot_id, scope_key, document)
        VALUES ($1, $2, $3::jsonb) ON CONFLICT (snapshot_id) DO NOTHING`, [snapshotId, key, canonical(document)]);
      const stored = await tx.query("SELECT * FROM leaderboard_ingestion.snapshots WHERE snapshot_id = $1", [snapshotId]);
      const snapshot = decode(stored.rows[0]!);
      if (unchanged) return { changed: false, revision: currentRevision,
        publishedAt: new Date(prior!.published_at as string).toISOString(), snapshot };
      const nextRevision = (BigInt(currentRevision) + 1n).toString();
      const published = await tx.query(`INSERT INTO leaderboard_ingestion.snapshot_heads (scope_key, revision, snapshot_id)
        VALUES ($1, $2, $3) ON CONFLICT (scope_key) DO UPDATE SET revision = EXCLUDED.revision,
        snapshot_id = EXCLUDED.snapshot_id, published_at = clock_timestamp() RETURNING published_at`, [key, nextRevision, snapshotId]);
      const publishedAt = published.rows[0]!.published_at;
      await tx.query(`INSERT INTO leaderboard_ingestion.snapshot_notices (scope_key, revision, snapshot_id, published_at)
        VALUES ($1, $2, $3, $4)`, [key, nextRevision, snapshotId, publishedAt]);
      return { changed: true, revision: nextRevision, publishedAt: new Date(publishedAt as string).toISOString(), snapshot };
    });
  }

  async latest(repositoryId: number, subjectId: string): Promise<SnapshotHead | null> {
    const result = await this.db.query(`SELECT snapshot.*, head.revision::text, head.published_at
      FROM leaderboard_ingestion.snapshot_heads AS head JOIN leaderboard_ingestion.snapshots AS snapshot
      ON head.scope_key = snapshot.scope_key AND head.snapshot_id = snapshot.snapshot_id
      WHERE head.scope_key = $1 AND EXISTS (SELECT 1 FROM leaderboard_ingestion.repository_access AS access
        WHERE access.repository_id = $2 AND access.state = 'public')
      AND NOT EXISTS (SELECT 1 FROM leaderboard_ingestion.object_suppressions WHERE repository_id = $2 AND subject_id = $3)`, [scopeKey(repositoryId, subjectId), repositoryId, subjectId]);
    const row = result.rows[0];
    return row ? { revision: revision(String(row.revision)), publishedAt: new Date(row.published_at as string).toISOString(), snapshot: decode(row) } : null;
  }

  async byId(snapshotId: string): Promise<StoredSnapshot | null> {
    if (typeof snapshotId !== "string" || !/^[a-f0-9]{64}$/.test(snapshotId)) throw new Error("invalid_snapshot_id");
    const result = await this.db.query(`SELECT snapshot.* FROM leaderboard_ingestion.snapshots AS snapshot WHERE snapshot_id = $1
      AND EXISTS (SELECT 1 FROM leaderboard_ingestion.repository_access AS access
      WHERE access.repository_id::text = snapshot.document->'scope'->>'repositoryId' AND access.state = 'public')
      AND NOT EXISTS (SELECT 1 FROM leaderboard_ingestion.object_suppressions AS removed
      WHERE removed.repository_id::text = snapshot.document->'scope'->>'repositoryId' AND removed.subject_id = snapshot.document->'scope'->>'subjectId')`, [snapshotId]);
    return result.rows[0] ? decode(result.rows[0]) : null;
  }

  /** Cursor is scoped revision, not a sequence allocated before unrelated transactions commit. */
  async notices(repositoryId: number, subjectId: string, afterRevision: string, limit = 50): Promise<SnapshotNotice[]> {
    const key = scopeKey(repositoryId, subjectId);
    revision(afterRevision);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_notice_limit");
    const result = await this.db.query(`SELECT notice.revision::text, notice.snapshot_id, notice.published_at
      FROM leaderboard_ingestion.snapshot_notices AS notice WHERE notice.scope_key = $1 AND notice.revision > $2
      AND EXISTS (SELECT 1 FROM leaderboard_ingestion.repository_access AS access WHERE access.repository_id = $4 AND access.state = 'public')
      AND NOT EXISTS (SELECT 1 FROM leaderboard_ingestion.object_suppressions WHERE repository_id = $4 AND subject_id = $5)
      ORDER BY notice.revision LIMIT $3`, [key, afterRevision, limit, repositoryId, subjectId]);
    return result.rows.map(row => ({ revision: revision(String(row.revision)), snapshotId: String(row.snapshot_id),
      publishedAt: new Date(row.published_at as string).toISOString() }));
  }
}
