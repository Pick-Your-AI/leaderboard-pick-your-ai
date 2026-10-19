import { createHash } from "node:crypto";
import { sourceFamilies } from "@pick-your-ai/ingestion";

const maximumPairs = 1200;
const maximumLookback = 31 * 86400000;
const recentFamilies = new Set(["issues", "comments", "project_history", "relationships"]);
const digestPattern = /^[a-f0-9]{64}$/;
const tokenPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const runPattern = /^rc1:([a-f0-9]{64}):([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}):(\d{4}):(\d{4})$/;
const fail = (code) => {
  throw new Error(code);
};
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const pairKey = (repositoryId, family) => `${repositoryId}:${family}`;
const comparePairs = (a, b) =>
  a.repositoryId - b.repositoryId || (a.family < b.family ? -1 : a.family > b.family ? 1 : 0);

function time(value, code) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) fail(code);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail(code);
  return parsed;
}

function generation(value) {
  return typeof value === "string" && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

/** Absence keeps the legacy collector policy; an explicit malformed opt-in fails closed. */
export function validateReconciliationPolicy(value) {
  if (value === undefined) return null;
  if (
    !record(value) ||
    Object.keys(value).length !== 3 ||
    !["lookbackMs", "overlapMs", "fullAuditsPerCycle"].every((key) => Object.hasOwn(value, key)) ||
    !Number.isSafeInteger(value.lookbackMs) ||
    value.lookbackMs < 1000 ||
    value.lookbackMs > maximumLookback ||
    !Number.isSafeInteger(value.overlapMs) ||
    value.overlapMs < 1000 ||
    value.overlapMs > value.lookbackMs ||
    !Number.isSafeInteger(value.fullAuditsPerCycle) ||
    value.fullAuditsPerCycle < 1 ||
    value.fullAuditsPerCycle > maximumPairs
  )
    fail("reconciliation_policy_invalid");
  return { lookbackMs: value.lookbackMs, overlapMs: value.overlapMs, fullAuditsPerCycle: value.fullAuditsPerCycle };
}

export function reconciliationContextDigest(scan) {
  if (
    !record(scan) ||
    typeof scan.key !== "string" ||
    !digestPattern.test(scan.key) ||
    typeof scan.contextHash !== "string" ||
    !digestPattern.test(scan.contextHash)
  )
    fail("reconciliation_plan_identity_invalid");
  return createHash("sha256")
    .update(JSON.stringify(["reconciliation-plan/v1", scan.key, scan.contextHash]))
    .digest("hex");
}

export function reconciliationRunId(contextDigest, token, ordinal, total) {
  if (
    typeof contextDigest !== "string" ||
    !digestPattern.test(contextDigest) ||
    typeof token !== "string" ||
    !tokenPattern.test(token) ||
    !Number.isSafeInteger(total) ||
    total < 1 ||
    total > maximumPairs ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    ordinal >= total
  )
    fail("reconciliation_plan_identity_invalid");
  return `rc1:${contextDigest}:${token}:${String(ordinal).padStart(4, "0")}:${String(total).padStart(4, "0")}`;
}

/** Legacy collection IDs are not reinterpreted as scheduled plans. */
export function parseReconciliationRunId(value) {
  if (typeof value !== "string") fail("reconciliation_plan_identity_invalid");
  if (!value.startsWith("rc1:")) return null;
  const match = runPattern.exec(value);
  if (!match) fail("reconciliation_plan_identity_invalid");
  const [, contextDigest, token, ordinalText, totalText] = match;
  const ordinal = Number(ordinalText);
  const total = Number(totalText);
  if (total < 1 || total > maximumPairs || ordinal >= total) fail("reconciliation_plan_identity_invalid");
  return { contextDigest, token, ordinal, total };
}

function inputs(scan, repositories, suppliedPolicy) {
  const policy = validateReconciliationPolicy(suppliedPolicy);
  if (!policy) fail("reconciliation_policy_required");
  const contextDigest = reconciliationContextDigest(scan);
  if (typeof scan.token !== "string" || !tokenPattern.test(scan.token)) fail("reconciliation_plan_identity_invalid");
  const cutoff = time(scan.cutoff, "reconciliation_plan_time_invalid");
  // Collection requests use canonical four-digit UTC dates even near the epoch bounds.
  const lower = new Date(cutoff - policy.lookbackMs).toISOString();
  time(lower, "reconciliation_plan_time_invalid");
  if (
    !Array.isArray(repositories) ||
    repositories.length < 1 ||
    repositories.length > 100 ||
    !Array.isArray(scan.sources) ||
    scan.sources.length !== repositories.length
  )
    fail("reconciliation_plan_scope_invalid");
  const sources = new Map();
  for (const source of scan.sources) {
    if (
      !record(source) ||
      !Number.isSafeInteger(source.repositoryId) ||
      source.repositoryId < 1 ||
      !generation(source.generation) ||
      sources.has(source.repositoryId)
    )
      fail("reconciliation_plan_scope_invalid");
    sources.set(source.repositoryId, source.generation);
  }
  const seen = new Set();
  const pairs = [];
  for (const repository of repositories) {
    if (
      !record(repository) ||
      !Number.isSafeInteger(repository.id) ||
      repository.id < 1 ||
      seen.has(repository.id) ||
      !sources.has(repository.id) ||
      !Array.isArray(repository.families) ||
      repository.families.length < 1 ||
      repository.families.length > sourceFamilies.length ||
      new Set(repository.families).size !== repository.families.length ||
      repository.families.some((family) => !sourceFamilies.includes(family))
    )
      fail("reconciliation_plan_scope_invalid");
    seen.add(repository.id);
    for (const family of repository.families)
      pairs.push({ repositoryId: repository.id, family, generation: sources.get(repository.id) });
  }
  if (pairs.length > maximumPairs) fail("reconciliation_plan_scope_invalid");
  pairs.sort(comparePairs);
  return { contextDigest, cutoff, lower, pairs, policy };
}

/** Select from already verified, cutoff-bounded progress; selection itself proves no coverage. */
export function selectReconciliationPlan({ scan, repositories, policy: suppliedPolicy, progress }) {
  const { contextDigest, cutoff, pairs, policy } = inputs(scan, repositories, suppliedPolicy);
  if (!Array.isArray(progress) || progress.length !== pairs.length) fail("reconciliation_plan_progress_invalid");
  const wanted = new Map(pairs.map((pair) => [pairKey(pair.repositoryId, pair.family), pair]));
  const byPair = new Map();
  for (const row of progress) {
    if (!record(row)) fail("reconciliation_plan_progress_invalid");
    const key = pairKey(row.repositoryId, row.family);
    const pair = wanted.get(key);
    if (
      !pair ||
      row.repositoryId !== pair.repositoryId ||
      row.family !== pair.family ||
      row.generation !== pair.generation ||
      byPair.has(key)
    )
      fail("reconciliation_plan_progress_invalid");
    for (const field of ["lastFullAuditAt", "reconciledThrough", "lastSuccessfulSync"])
      if (row[field] !== null && time(row[field], "reconciliation_plan_progress_invalid") > cutoff)
        fail("reconciliation_plan_progress_invalid");
    byPair.set(key, row);
  }
  const audits = [...pairs]
    .sort((a, b) => {
      const aTime = byPair.get(pairKey(a.repositoryId, a.family)).lastFullAuditAt;
      const bTime = byPair.get(pairKey(b.repositoryId, b.family)).lastFullAuditAt;
      return (
        (aTime === bTime ? 0 : aTime === null ? -1 : bTime === null ? 1 : aTime < bTime ? -1 : 1) || comparePairs(a, b)
      );
    })
    .slice(0, policy.fullAuditsPerCycle);
  const selected = new Set(audits.map((pair) => pairKey(pair.repositoryId, pair.family)));
  const requests = audits.map(({ repositoryId, family }) => ({
    repositoryId,
    family,
    mode: "audit",
    since: null,
    until: scan.cutoff,
  }));
  for (const pair of pairs) {
    const key = pairKey(pair.repositoryId, pair.family);
    if (selected.has(key) || !recentFamilies.has(pair.family)) continue;
    const through = byPair.get(key).reconciledThrough;
    // A recent lookback does not bridge an earlier gap. The progress reader must
    // retain that gap until a later exact full audit supplies a new baseline.
    const since = new Date(
      Math.max(cutoff - policy.lookbackMs, through === null ? -Infinity : Date.parse(through) - policy.overlapMs),
    ).toISOString();
    requests.push({
      repositoryId: pair.repositoryId,
      family: pair.family,
      mode: "reconcile",
      since,
      until: scan.cutoff,
    });
  }
  return requests.map((request, ordinal) => ({
    runId: reconciliationRunId(contextDigest, scan.token, ordinal, requests.length),
    ...request,
  }));
}

async function retainedRows(tx, scan, contextDigest) {
  return (
    await tx.query(
      `SELECT run_id,repository_id::text AS repository_id,family,mode,since_at,until_at,
       access_generation::text AS access_generation,until_at=$2::timestamptz AS until_exact,
       (since_at IS NULL OR date_trunc('milliseconds',since_at)=since_at) AS since_exact
     FROM leaderboard_ingestion.collection_runs
     WHERE run_id LIKE $1 ORDER BY run_id LIMIT 1201 FOR SHARE`,
      [`rc1:${contextDigest}:${scan.token}:%`, scan.cutoff],
    )
  ).rows;
}

function storedTime(value) {
  if (!(value instanceof Date) && typeof value !== "string") fail("reconciliation_plan_integrity_error");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) fail("reconciliation_plan_integrity_error");
  const result = parsed.toISOString();
  time(result, "reconciliation_plan_integrity_error");
  return result;
}

function reload(rows, scan, data) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > maximumPairs)
    fail("reconciliation_plan_integrity_error");
  const { contextDigest, cutoff, lower, pairs, policy } = data;
  const wanted = new Map(pairs.map((pair) => [pairKey(pair.repositoryId, pair.family), pair]));
  const seenPairs = new Set();
  const ordinals = new Set();
  const plan = [];
  let audits = 0;
  for (const row of rows) {
    let identity;
    try {
      identity = parseReconciliationRunId(row.run_id);
    } catch {
      fail("reconciliation_plan_integrity_error");
    }
    const key = pairKey(row.repository_id, row.family);
    const pair = wanted.get(key);
    if (
      !identity ||
      identity.contextDigest !== contextDigest ||
      identity.token !== scan.token ||
      identity.total !== rows.length ||
      ordinals.has(identity.ordinal) ||
      !pair ||
      String(pair.repositoryId) !== row.repository_id ||
      row.family !== pair.family ||
      pair.generation !== row.access_generation ||
      seenPairs.has(key) ||
      row.until_exact !== true ||
      row.since_exact !== true
    )
      fail("reconciliation_plan_integrity_error");
    if (row.mode !== (identity.ordinal < Math.min(policy.fullAuditsPerCycle, pairs.length) ? "audit" : "reconcile"))
      fail("reconciliation_plan_integrity_error");
    ordinals.add(identity.ordinal);
    seenPairs.add(key);
    const until = storedTime(row.until_at);
    const since = row.since_at === null ? null : storedTime(row.since_at);
    if (until !== scan.cutoff) fail("reconciliation_plan_integrity_error");
    if (row.mode === "audit") {
      if (since !== null) fail("reconciliation_plan_integrity_error");
      audits += 1;
    } else if (
      row.mode !== "reconcile" ||
      !recentFamilies.has(pair.family) ||
      since === null ||
      since < lower ||
      Date.parse(since) > cutoff - policy.overlapMs
    )
      fail("reconciliation_plan_integrity_error");
    plan.push({
      ordinal: identity.ordinal,
      request: {
        runId: row.run_id,
        repositoryId: pair.repositoryId,
        family: pair.family,
        mode: row.mode,
        since,
        until,
      },
    });
  }
  if (
    audits !== Math.min(policy.fullAuditsPerCycle, pairs.length) ||
    pairs.some((pair) => recentFamilies.has(pair.family) && !seenPairs.has(pairKey(pair.repositoryId, pair.family)))
  )
    fail("reconciliation_plan_integrity_error");
  return plan.sort((a, b) => a.ordinal - b.ordinal).map(({ request }) => request);
}

/** Caller owns the scan-row/source locks and transaction. Never recompute an existing token. */
export async function prepareReconciliationPlan(
  tx,
  { scan, repositories, policy, fresh, startInTransaction, readProgress },
) {
  const data = inputs(scan, repositories, policy);
  if (typeof fresh !== "boolean" || typeof tx?.query !== "function") fail("reconciliation_plan_integrity_error");
  const existing = await retainedRows(tx, scan, data.contextDigest);
  if (!fresh) return reload(existing, scan, data);
  if (existing.length !== 0 || typeof startInTransaction !== "function" || typeof readProgress !== "function")
    fail("reconciliation_plan_integrity_error");
  const progress = await readProgress(tx, repositories, scan.cutoff, {
    contextDigest: data.contextDigest,
    untilCutoff: scan.cutoff,
  });
  const plan = selectReconciliationPlan({ scan, repositories, policy: data.policy, progress });
  for (const request of plan) await startInTransaction(tx, request);
  const saved = reload(await retainedRows(tx, scan, data.contextDigest), scan, data);
  if (JSON.stringify(saved) !== JSON.stringify(plan)) fail("reconciliation_plan_integrity_error");
  return saved;
}
