import { createHash } from "node:crypto";
import { ControlError, exactKeys, requireThat } from "./store.mjs";
import { stableJSON } from "./configuration.mjs";
import { configurationOverlay } from "./overlay.mjs";

// Local implementation limits, not an approved production retention commitment.
export const comparisonLimitsV1 = Object.freeze({
  version: "private-policy-preview/v1",
  retentionMs: 7 * 86400_000,
  inputs: 8,
  previews: 32,
  approvedVersions: 256,
  candidateVersions: 256,
  concurrent: 4,
  inputBytes: 2 * 1024 * 1024,
  resultBytes: 2 * 1024 * 1024,
  facts: 10_000,
  actors: 2_000,
});
export const comparisonHash = (value) => createHash("sha256").update(stableJSON(value)).digest("hex");
const bytes = (value) => Buffer.byteLength(stableJSON(value));
const isHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const copy = (value) => structuredClone(value);
const policyKeys = [
  "metricId",
  "version",
  "definitionVersion",
  "unit",
  "aggregation",
  "dateBasis",
  "rankedStates",
  "roles",
  "groupBy",
  "groupingSeconds",
  "groupingPolicyVersion",
  "sources",
  "minimumSamples",
  "rank",
];
function checkedPolicy(policy, metrics) {
  exactKeys(policy, policyKeys);
  requireThat(bytes(policy) <= 8192, 413, "Policy too large");
  requireThat(typeof policy.rank === "boolean", 400, "Invalid candidate policy");
  for (const key of ["metricId", "version", "definitionVersion", "unit"])
    requireThat(
      typeof policy[key] === "string" &&
        policy[key].trim().length > 0 &&
        policy[key].length <= 100 &&
        !/[\u0000-\u001f\u007f]/.test(policy[key]),
      400,
      "Invalid candidate policy",
    );
  if (policy.groupingPolicyVersion !== undefined)
    requireThat(
      typeof policy.groupingPolicyVersion === "string" &&
        policy.groupingPolicyVersion.trim().length > 0 &&
        policy.groupingPolicyVersion.length <= 100 &&
        !/[\u0000-\u001f\u007f]/.test(policy.groupingPolicyVersion),
      400,
      "Invalid candidate grouping policy version",
    );
  for (const key of ["rankedStates", "roles", "sources"])
    requireThat(Array.isArray(policy[key]) && policy[key].length <= 20, 400, "Invalid candidate policy");
  try {
    metrics.validateMetricPolicy(policy);
  } catch {
    throw new ControlError(400, "Invalid candidate policy");
  }
  return copy(policy);
}
function verifyDocument(row) {
  requireThat(row, 404, "Preview input or result unavailable");
  let document;
  try {
    document = JSON.parse(row.document);
  } catch {
    throw new ControlError(409, "Private comparison integrity failure");
  }
  requireThat(comparisonHash(document) === row.digest, 409, "Private comparison integrity failure");
  return document;
}
function currentSession(state, session, now) {
  const active = state.sessions[session.sid];
  requireThat(
    active &&
      active.expires > now &&
      active.actorId === session.actorId &&
      active.roleVersion === session.roleVersion &&
      active.roles.includes("reviewer") &&
      session.roles.includes("reviewer"),
    401,
    "Reviewer session revoked",
  );
}
function currentConfiguration(state, record) {
  const overlay = configurationOverlay(state);
  requireThat(
    overlay.revision === record.authorization.controlsConfigurationRevision &&
      (overlay.allowedRepositoryIds === null ||
        record.input.repositoryIds.every((id) => overlay.allowedRepositoryIds.includes(id))),
    409,
    "Frozen input authorization changed",
  );
}
function changeCauses(comparison, input, beforePolicy, afterPolicy) {
  const changedFields = policyKeys.filter(
    (key) => key !== "version" && stableJSON(beforePolicy[key]) !== stableJSON(afterPolicy[key]),
  );
  const latest = new Map();
  for (const fact of input.facts) {
    if (
      fact.metricId !== beforePolicy.metricId ||
      Date.parse(fact.observedAt) > Date.parse(input.cutoff) ||
      (fact.revision > 0 && !fact.correctionReceipt?.trim())
    )
      continue;
    if (!latest.has(fact.id) || latest.get(fact.id).revision < fact.revision) latest.set(fact.id, fact);
  }
  const explain = (factId, aggregate, policy) => {
    const fact = latest.get(factId);
    const reasons = aggregate.audit.filter((entry) => entry.factIds.includes(factId)).map((entry) => entry.reason);
    if (fact && !policy.rankedStates.includes(fact.state) && !reasons.length) reasons.push("evidence_class_not_ranked");
    if (fact?.revision > 0 && fact.correctionReceipt) reasons.push("reviewed_correction");
    return {
      factId,
      reasons: [...new Set(reasons.length ? reasons : ["policy_unit_selection"])].sort(),
      revision: fact?.revision ?? null,
    };
  };
  return comparison.changes.map((change) => ({
    ...change,
    causes: {
      changedPolicyFields: changedFields,
      included: change.included.map((id) => explain(id, comparison.before, beforePolicy)),
      excluded: change.excluded.map((id) => explain(id, comparison.after, afterPolicy)),
      value: change.beforeValue !== change.afterValue ? "recalculated_on_identical_frozen_input" : null,
      rank: change.beforeRank !== change.afterRank ? "reordered_by_candidate_policy" : null,
    },
  }));
}

function projectAggregate(aggregate) {
  // Engine internals may grow; only the review fields below are retained here.
  const {
    metricId,
    policyVersion,
    policySignature,
    definitionVersion,
    unit,
    aggregation,
    publicEnabled,
    scope,
    datasetId,
    cutoff,
    backfillRevision,
    coverage,
  } = aggregate;
  return {
    metricId,
    policyVersion,
    policySignature,
    definitionVersion,
    unit,
    aggregation,
    publicEnabled,
    scope,
    datasetId,
    cutoff,
    backfillRevision,
    coverage,
    rows: aggregate.rows.map(
      ({
        actorId,
        login,
        value,
        state,
        pending,
        numerator,
        denominator,
        sampleCount,
        samples,
        p75,
        censored,
        missingReadiness,
        evidenceIds,
        evidence,
        rank,
        tied,
      }) => ({
        actorId,
        login,
        value,
        state,
        pending,
        numerator,
        denominator,
        sampleCount,
        samples,
        p75,
        censored,
        missingReadiness,
        evidenceIds,
        evidence,
        rank,
        tied,
      }),
    ),
    audit: aggregate.audit.map(({ actorId, factIds, reason }) => ({ actorId, factIds, reason })),
  };
}

/** Private SQLite tables are never part of controls_publication or public API documents. */
export class PolicyComparisonStore {
  constructor(store, metrics, { now = Date.now } = {}) {
    requireThat(store?.db && typeof metrics?.comparePolicies === "function", 500, "Comparison engine required");
    this.store = store;
    this.metrics = metrics;
    this.now = now;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS policy_preview_inputs (id TEXT PRIMARY KEY, document TEXT NOT NULL, digest TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS policy_previews (id TEXT PRIMARY KEY, input_id TEXT NOT NULL, document TEXT NOT NULL, digest TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS policy_preview_approved_versions (metric_id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(metric_id,version));
      CREATE TABLE IF NOT EXISTS policy_preview_candidate_versions (metric_id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(metric_id,version));
    `);
  }
  prune() {
    this.store.db.prepare("DELETE FROM policy_previews WHERE expires<=?").run(this.now());
    this.store.db.prepare("DELETE FROM policy_preview_inputs WHERE expires<=?").run(this.now());
    this.store.db
      .prepare("DELETE FROM policy_previews WHERE input_id NOT IN (SELECT id FROM policy_preview_inputs)")
      .run();
  }
  approvedPolicyHash(policy) {
    const hash = comparisonHash(policy);
    const saved = this.store.db
      .prepare("SELECT digest FROM policy_preview_approved_versions WHERE metric_id=? AND version=?")
      .get(policy.metricId, policy.version);
    requireThat(saved?.digest === hash, 409, "Frozen approved policy binding unavailable");
    return hash;
  }
  bindCandidate(policy) {
    const hash = comparisonHash(policy);
    const approved = this.store.db
      .prepare("SELECT digest FROM policy_preview_approved_versions WHERE metric_id=? AND version=?")
      .get(policy.metricId, policy.version);
    // A real approved binding takes precedence over an earlier unapproved
    // candidate's use of the same version string, including baseline inspection.
    if (approved) {
      requireThat(approved.digest === hash, 409, "Changed policy semantics require a new policy version");
      return hash;
    }
    const candidate = this.store.db
      .prepare("SELECT digest FROM policy_preview_candidate_versions WHERE metric_id=? AND version=?")
      .get(policy.metricId, policy.version);
    requireThat(!candidate || candidate.digest === hash, 409, "Changed policy semantics require a new policy version");
    if (!candidate) {
      requireThat(
        this.store.db.prepare("SELECT count(*) AS n FROM policy_preview_candidate_versions").get().n <
          comparisonLimitsV1.candidateVersions,
        503,
        "Candidate version registry capacity reached",
      );
      this.store.db
        .prepare("INSERT INTO policy_preview_candidate_versions VALUES(?,?,?)")
        .run(policy.metricId, policy.version, hash);
    }
    return hash;
  }
  captureBindings(policies) {
    // Optional capture cannot reserve or block a separately approved policy.
    // Preflight the entire batch before any binding is inserted.
    const missing = [];
    for (const policy of policies) {
      const hash = comparisonHash(policy);
      const approved = this.store.db
        .prepare("SELECT digest FROM policy_preview_approved_versions WHERE metric_id=? AND version=?")
        .get(policy.metricId, policy.version);
      if (approved && approved.digest !== hash) return "frozen_approved_version_conflict";
      if (!approved) missing.push([policy.metricId, policy.version, hash]);
    }
    if (
      this.store.db.prepare("SELECT count(*) AS n FROM policy_preview_approved_versions").get().n + missing.length >
      comparisonLimitsV1.approvedVersions
    )
      return "frozen_approved_version_capacity_reached";
    for (const binding of missing)
      this.store.db.prepare("INSERT INTO policy_preview_approved_versions VALUES(?,?,?)").run(...binding);
    return null;
  }
  // Called inside the publication's existing synchronous controls transaction.
  capture(state, { input, scope, policies, authorization, snapshot, aggregates }) {
    this.prune();
    requireThat(
      Array.isArray(input?.facts) && Array.isArray(input?.actors) && Array.isArray(policies),
      400,
      "Invalid frozen input",
    );
    requireThat(
      typeof snapshot?.snapshotId === "string" &&
        snapshot.snapshotId.length <= 128 &&
        Number.isSafeInteger(snapshot.revision) &&
        snapshot.revision > 0,
      400,
      "Snapshot binding required",
    );
    currentConfiguration(state, { input, authorization });
    if (
      input.facts.length > comparisonLimitsV1.facts ||
      input.actors.length > comparisonLimitsV1.actors ||
      policies.length > 98 ||
      bytes([input, scope, policies, authorization, snapshot]) > comparisonLimitsV1.inputBytes
    )
      return { state: "unavailable", reason: "frozen_input_budget_exceeded" };
    const document = {
      schemaVersion: comparisonLimitsV1.version,
      input: copy(input),
      scope: copy(scope),
      policies: policies.map((policy) => checkedPolicy(policy, this.metrics)),
      authorization: copy(authorization),
      snapshot: copy(snapshot),
      baseline: (aggregates ?? policies.map((policy) => this.metrics.aggregateMetric(input, policy, scope))).map(
        projectAggregate,
      ),
    };
    // Bind only corrections actually effective in the captured engine baseline.
    // A correction arriving after the frozen cutoff must still redact old input.
    document.authorization.corrections = input.facts
      .filter(
        (fact) =>
          fact.revision > 0 &&
          fact.correctionReceipt?.trim() &&
          fact.state === "excluded" &&
          Date.parse(fact.observedAt) <= Date.parse(input.cutoff) &&
          document.baseline.some(
            (aggregate) =>
              aggregate.metricId === fact.metricId &&
              aggregate.audit.some(
                (entry) => entry.reason === "excluded_by_policy_or_correction" && entry.factIds.includes(fact.id),
              ) &&
              !aggregate.rows.some((row) => row.evidenceIds.includes(fact.id)),
          ),
      )
      .map((fact) => ({ artifactId: fact.artifactId, hash: comparisonHash(fact) }));
    if (bytes(document) > comparisonLimitsV1.inputBytes)
      return { state: "unavailable", reason: "frozen_input_budget_exceeded" };
    const id = comparisonHash(document);
    const existing = this.store.db.prepare("SELECT id FROM policy_preview_inputs WHERE id=?").get(id);
    if (existing) return { state: "retained", inputId: id };
    if (this.store.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n >= comparisonLimitsV1.inputs)
      return { state: "unavailable", reason: "frozen_input_capacity_reached" };
    const unavailable = this.captureBindings(document.policies);
    if (unavailable) return { state: "unavailable", reason: unavailable };
    this.store.db
      .prepare("INSERT INTO policy_preview_inputs VALUES(?,?,?,?)")
      .run(id, stableJSON(document), id, this.now() + comparisonLimitsV1.retentionMs);
    return { state: "retained", inputId: id };
  }
  input(id) {
    requireThat(isHash(id), 400, "Invalid input identity");
    const row = this.store.db
      .prepare("SELECT * FROM policy_preview_inputs WHERE id=? AND expires>?")
      .get(id, this.now());
    const document = verifyDocument(row);
    requireThat(row.id === row.digest, 409, "Private comparison integrity failure");
    return { id, expires: row.expires, ...document };
  }
  metadata(record) {
    return {
      inputId: record.id,
      inputHash: comparisonHash(record.input),
      scopeHash: comparisonHash(record.scope),
      cutoff: record.input.cutoff,
      expiresAt: new Date(record.expires).toISOString(),
      schemaVersion: comparisonLimitsV1.version,
      snapshot: record.snapshot,
      baselineHash: comparisonHash(record.baseline),
      policies: record.policies.map((p) => ({
        metricId: p.metricId,
        version: p.version,
        policyHash: comparisonHash(p),
      })),
    };
  }
  result(id) {
    requireThat(isHash(id), 400, "Invalid comparison identity");
    const row = this.store.db.prepare("SELECT * FROM policy_previews WHERE id=? AND expires>?").get(id, this.now());
    const document = verifyDocument(row);
    requireThat(
      document.comparisonId === id && document.inputId === row.input_id,
      409,
      "Private comparison integrity failure",
    );
    return { document, resultHash: row.digest };
  }
  compare(record, candidate) {
    const before = record.policies.find((p) => p.metricId === candidate.metricId);
    requireThat(before, 400, "Metric absent from frozen input");
    const beforePolicyHash = this.approvedPolicyHash(before),
      afterPolicyHash = this.bindCandidate(candidate);
    const id = comparisonHash([record.id, beforePolicyHash, afterPolicyHash]);
    const existing = this.store.db.prepare("SELECT id FROM policy_previews WHERE id=?").get(id);
    if (existing) return this.result(id);
    requireThat(
      this.store.db.prepare("SELECT count(*) AS n FROM policy_previews").get().n < comparisonLimitsV1.previews,
      503,
      "Preview capacity reached",
    );
    let result;
    try {
      result = this.metrics.comparePolicies(copy(record.input), before, candidate, copy(record.scope));
    } catch {
      throw new ControlError(400, "Policy comparison cannot be computed");
    }
    const baseline = record.baseline.find((aggregate) => aggregate.metricId === before.metricId);
    requireThat(
      comparisonHash(projectAggregate(result.before)) === comparisonHash(baseline),
      409,
      "Frozen baseline engine result changed",
    );
    const document = {
      schemaVersion: comparisonLimitsV1.version,
      comparisonId: id,
      inputId: record.id,
      status: "candidate_preview",
      publicEnabled: false,
      activationSupported: false,
      approvalRequired: true,
      releaseNotesRequired: true,
      inputHash: comparisonHash(record.input),
      scopeHash: comparisonHash(record.scope),
      beforePolicyHash,
      afterPolicyHash,
      beforePolicy: before,
      candidatePolicy: candidate,
      datasetId: result.datasetId,
      cutoff: result.cutoff,
      snapshot: record.snapshot,
      baselineHash: comparisonHash(baseline),
      before: projectAggregate(result.before),
      after: projectAggregate(result.after),
      changes: changeCauses(result, record.input, before, candidate),
    };
    requireThat(bytes(document) <= comparisonLimitsV1.resultBytes, 413, "Comparison result budget exceeded");
    const resultHash = comparisonHash(document);
    this.store.db
      .prepare("INSERT INTO policy_previews VALUES(?,?,?,?,?)")
      .run(id, record.id, stableJSON(document), resultHash, record.expires);
    return { document, resultHash };
  }
  redact(saved, record, state, removedArtifactIds) {
    const hidden = new Set(
      record.input.actors
        .filter((a) => a.publicState !== "visible" || state.profiles[a.id]?.suppressed)
        .map((a) => a.id),
    );
    // Unknown actors can still occur in engine audit even when no actor record
    // resolved. Current privacy choices apply to those IDs as well.
    for (const [id, profile] of Object.entries(state.profiles)) if (profile.suppressed) hidden.add(id);
    const removed = new Set(removedArtifactIds);
    const hiddenFacts = new Set(
      record.input.facts
        .filter((f) => hidden.has(f.actorId) || hidden.has(f.subjectActorId) || removed.has(f.artifactId))
        .map((f) => f.id),
    );
    // Withhold entire affected rows: keeping their totals would disclose removed facts.
    for (const fact of record.input.facts) if (hiddenFacts.has(fact.id) && fact.actorId) hidden.add(fact.actorId);
    const document = copy(saved.document);
    let redacted = false;
    for (const aggregate of [document.before, document.after]) {
      const rows = aggregate.rows.filter((r) => !hidden.has(r.actorId));
      const audit = aggregate.audit.filter(
        (a) => !hidden.has(a.actorId) && !a.factIds.some((id) => hiddenFacts.has(id)),
      );
      redacted ||= rows.length !== aggregate.rows.length || audit.length !== aggregate.audit.length;
      aggregate.rows = rows;
      aggregate.audit = audit;
    }
    const changes = document.changes.filter(
      (c) => !hidden.has(c.actorId) && ![...c.included, ...c.excluded].some((id) => hiddenFacts.has(id)),
    );
    redacted ||= changes.length !== document.changes.length;
    document.changes = changes;
    if (redacted) {
      for (const aggregate of [document.before, document.after])
        for (const row of aggregate.rows) {
          row.rank = null;
          row.tied = false;
        }
      for (const change of changes) {
        change.beforeRank = null;
        change.afterRank = null;
        change.causes.rank = null;
      }
    }
    return {
      ...document,
      resultHash: saved.resultHash,
      responseHash: comparisonHash(document),
      redactionsApplied: redacted,
    };
  }
}

export function createPolicyComparisonManager({ comparisons, withAuthorizedInputs }) {
  requireThat(
    comparisons instanceof PolicyComparisonStore && typeof withAuthorizedInputs === "function",
    500,
    "Private comparison source guard required",
  );
  const store = comparisons.store;
  let active = 0;
  async function handle({ path, method, input, session, refreshSession, respond }) {
    requireThat(session.roles.includes("reviewer"), 403, "Reviewer role required");
    const prefix = "/controls/policy-comparisons";
    const read = /^\/controls\/policy-comparisons\/([a-f0-9]{64})$/.exec(path);
    requireThat(
      (path === prefix && method === "POST") ||
        (read && method === "GET") ||
        (path === prefix + "/inputs" && method === "GET"),
      404,
      "Not found",
    );
    store.transaction(() => comparisons.prune());
    async function guarded(records, work) {
      const currentState = store.read();
      for (const record of records) currentConfiguration(currentState, record);
      // Hold all source read locks until after the final synchronous controls
      // transaction and HTTP send. List requests cannot return earlier, revoked inputs.
      return withAuthorizedInputs(
        records.map((record) => record.authorization),
        async (removed, authority) => {
          requireThat(
            typeof authority?.refreshApproval === "function" && typeof authority?.isCurrent === "function",
            409,
            "Current preview authority fence unavailable",
          );
          const refreshed = await refreshSession();
          requireThat(refreshed.roles.includes("reviewer"), 403, "Reviewer role required");
          requireThat((await authority.refreshApproval()) === true, 409, "Frozen input authorization unavailable");
          function assertCurrent(state, current) {
            for (const record of current) currentConfiguration(state, record);
            const now = comparisons.now();
            requireThat(
              current.every((record) => record.expires > now),
              404,
              "Preview input or result unavailable",
            );
            currentSession(state, refreshed, now);
            // A synchronous combined authority fence closes both possible async
            // revocation windows. Promises and missing fences fail closed.
            const currentAuthority = authority.isCurrent(refreshed);
            if (currentAuthority && typeof currentAuthority.then === "function")
              void Promise.resolve(currentAuthority).catch(() => undefined);
            requireThat(currentAuthority === true, 409, "Preview authority changed");
          }
          let current;
          const data = store.transaction((state) => {
            current = records.map((record) => comparisons.input(record.id));
            assertCurrent(state, current);
            const data = work(current, state, removed);
            // Calculation and redaction are synchronous but can cross a deadline.
            // Recheck before commit so preview and candidate writes roll back.
            assertCurrent(state, current);
            return data;
          });
          const result = { status: 200, data };
          // Commit/serialization may also cross expiry. The HTTP responder calls
          // this again after serialization and immediately before writing headers.
          const beforeSend = () => assertCurrent(store.read(), current);
          beforeSend();
          respond?.(result, beforeSend);
          return result;
        },
      );
    }
    if (path === prefix + "/inputs") {
      const ids = store.db
        .prepare("SELECT id FROM policy_preview_inputs WHERE expires>? ORDER BY id")
        .all(comparisons.now());
      const records = ids.map(({ id }) => comparisons.input(id));
      return guarded(records, (current) => ({
        status: "candidate_preview",
        inputs: current.map((record) => comparisons.metadata(record)),
      }));
    }
    let candidate, record, saved;
    if (method === "POST") {
      exactKeys(input, ["inputId", "candidatePolicy"]);
      candidate = checkedPolicy(input.candidatePolicy, comparisons.metrics);
      record = comparisons.input(input.inputId);
    } else {
      saved = comparisons.result(read[1]);
      record = comparisons.input(saved.document.inputId);
    }
    return guarded([record], ([current], state, removed) => {
      const result = candidate ? comparisons.compare(current, candidate) : comparisons.result(read[1]);
      return comparisons.redact(result, current, state, removed);
    });
  }
  return async (request) => {
    requireThat(active < comparisonLimitsV1.concurrent, 503, "Preview concurrency limit reached");
    active++;
    try {
      return await handle(request);
    } finally {
      active--;
    }
  };
}
