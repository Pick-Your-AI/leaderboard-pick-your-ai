import { parseReconciliationRunId } from "./reconciliation-plan.mjs";

export const githubCommentsInventoryVersion = "github-comments-inventory/v2";
const legacyRun = /^[a-f0-9]{64}$/;
const versionedRun = /^gc2:([a-f0-9]{64})$/;

/** Only the selected default comments adapter changes the meaning of coverage. */
export function githubCommentsContext(parts, enabled) {
  if (!Array.isArray(parts) || typeof enabled !== "boolean") throw new Error("invalid_comments_inventory_context");
  return enabled ? [...parts, githubCommentsInventoryVersion] : parts;
}

/** Inventory selection is captured in the durable run identity, never today's policy. */
export function expandedGithubCommentsRun(runId) {
  if (typeof runId !== "string") throw new Error("invalid_comments_inventory_run");
  if (runId.startsWith("gc2:")) {
    const match = versionedRun.exec(runId);
    if (!match || match[0] !== runId) throw new Error("invalid_comments_inventory_run");
    return true;
  }
  if (parseReconciliationRunId(runId)) return true;
  if (!legacyRun.test(runId) || runId.length !== 64) throw new Error("invalid_comments_inventory_run");
  return false;
}

/**
 * Keep an existing old operation literal, including completed and failed rows.
 * New runs use a distinct namespace. A materialized new choice wins on every
 * retry even if an old-format writer later creates its own legacy row.
 */
export async function startGithubCommentsRun(db, collection, request, assertAuthorized) {
  if (
    request.family !== "comments" ||
    typeof request.runId !== "string" ||
    request.runId.length !== 64 ||
    !legacyRun.test(request.runId)
  )
    throw new Error("invalid_comments_inventory_run");
  const captured = Object.freeze({
    runId: request.runId,
    repositoryId: request.repositoryId,
    family: request.family,
    mode: request.mode,
    since: request.since,
    until: request.until,
  });
  const nextId = "gc2:" + captured.runId;
  return db.transaction(async (tx) => {
    assertAuthorized();
    // This lock coordinates upgraded callers selecting the same logical run.
    // It does not claim that an unmodified old binary participates in this lock.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [nextId]);
    assertAuthorized();
    // Do not lock run rows before the repository gate: collection commits take
    // that gate first. Retained identities plus the logical lock pin this choice.
    const retained = (
      await tx.query("SELECT run_id FROM leaderboard_ingestion.collection_runs WHERE run_id=ANY($1::text[])", [
        [captured.runId, nextId],
      ])
    ).rows;
    const selected = Object.freeze({
      ...captured,
      runId: retained.some((row) => row.run_id === nextId)
        ? nextId
        : retained.some((row) => row.run_id === captured.runId)
          ? captured.runId
          : nextId,
    });
    // The existing start guard validates the complete retained tuple and source
    // admission. Conflicting/failed old runs are never bypassed with a new ID.
    await collection.startInTransaction(tx, selected);
    assertAuthorized();
    return selected;
  });
}
