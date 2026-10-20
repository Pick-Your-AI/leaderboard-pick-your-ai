import { parseReconciliationRunId, reconciliationContextDigest } from "./reconciliation-plan.mjs";

export const githubContentEditsInventoryVersion = "github-content-edits/metadata-v1";
const legacyRun = /^[a-f0-9]{64}$/;
const versionedRun = /^gce1:([a-f0-9]{64})$/;
const fail = () => {
  throw new Error("invalid_content_edit_inventory_request");
};
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function capture(request) {
  if (!record(request)) fail();
  const selected = Object.freeze({
    runId: request.runId,
    repositoryId: request.repositoryId,
    family: request.family,
    mode: request.mode,
    since: request.since,
    until: request.until,
  });
  if (
    typeof selected.runId !== "string" ||
    !Number.isSafeInteger(selected.repositoryId) ||
    selected.repositoryId < 1 ||
    selected.family !== "content_edits" ||
    !["audit", "backfill"].includes(selected.mode) ||
    selected.since !== null ||
    typeof selected.until !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(selected.until) ||
    !Number.isFinite(Date.parse(selected.until)) ||
    new Date(selected.until).toISOString() !== selected.until
  )
    fail();
  return selected;
}

function isVersioned(runId) {
  const match = versionedRun.exec(runId);
  return match !== null && match[0] === runId;
}
const key = (request) => `${request.repositoryId}:${request.runId}`;
const same = (left, right) =>
  ["runId", "repositoryId", "family", "mode", "since", "until"].every((field) => left[field] === right[field]);

/** Compose outside the unchanged comments context; disabled/custom sources retain their original context object. */
export function githubContentEditsContext(parts, enabled) {
  if (!Array.isArray(parts) || typeof enabled !== "boolean") throw new Error("invalid_content_edit_inventory_context");
  return enabled ? [...parts, githubContentEditsInventoryVersion] : parts;
}

/** Preserve a retained legacy tuple before allocating a new metadata namespace. */
export async function startGithubContentEditRun(db, collection, request, assertAuthorized) {
  const captured = capture(request);
  if (captured.runId.length !== 64 || !legacyRun.test(captured.runId) || typeof assertAuthorized !== "function") fail();
  const nextId = "gce1:" + captured.runId;
  return db.transaction(async (tx) => {
    assertAuthorized();
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [nextId]);
    assertAuthorized();
    // Retained identities are immutable. Do not take a run-row update lock before
    // CollectionStore.startInTransaction acquires the repository's shared gate.
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
    await collection.startInTransaction(tx, selected);
    assertAuthorized();
    return selected;
  });
}

/**
 * Private per-operation admission, to be seeded only from the actual saved
 * collection selection or materialized current plan. This is a format/capability
 * selector, not a replacement for the repository and host authorization fences.
 */
export function createGithubContentEditAdmission() {
  let admitted = new Map();
  return Object.freeze({
    clear() {
      admitted.clear();
    },
    recordSelected(request) {
      const selected = capture(request);
      if (selected.runId.length === 64 && legacyRun.test(selected.runId)) return false;
      if (!isVersioned(selected.runId)) fail();
      const prior = admitted.get(key(selected));
      if (prior && !same(prior, selected)) fail();
      admitted.set(key(selected), selected);
      return true;
    },
    setPlanned(scan, requests) {
      // Failure also clears a prior operation's transient capabilities.
      admitted.clear();
      if (!record(scan) || !Array.isArray(scan.sources) || !Array.isArray(requests) || requests.length > 1200) fail();
      const contextDigest = reconciliationContextDigest(scan);
      const next = new Map();
      for (const request of requests) {
        if (!record(request)) fail();
        if (request.family !== "content_edits") continue;
        const selected = capture(request);
        const identity = parseReconciliationRunId(selected.runId);
        if (
          !identity ||
          identity.contextDigest !== contextDigest ||
          identity.token !== scan.token ||
          identity.total !== requests.length ||
          selected.until !== scan.cutoff ||
          selected.mode !== "audit" ||
          !scan.sources.some((source) => source.repositoryId === selected.repositoryId) ||
          next.has(key(selected))
        )
          fail();
        next.set(key(selected), selected);
      }
      admitted = next;
    },
    allows(request) {
      if (!record(request) || request.family !== "content_edits") return false;
      const selected = capture(request);
      const prior = admitted.get(key(selected));
      return prior !== undefined && same(prior, selected);
    },
  });
}
