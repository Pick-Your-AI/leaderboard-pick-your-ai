import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  RepositoryRetirementStore,
  validateRepositoryRetirement,
  validateRepositoryErasureBatch,
} from "@pick-your-ai/ingestion";
import { validateRepositoryCheckpointRetirementBinding } from "@pick-your-ai/github";
import { stableJSON } from "@pick-your-ai/metrics";
import {
  PipelineDerivedRetirementStore,
  validateDerivedErasureBatch,
} from "../../apps/pipeline/src/derived-retirement.mjs";

const schema = "repository-retirement-driver/v1";
const hash = (value) => createHash("sha256").update(stableJSON(value)).digest("hex");
const fail = (code) => {
  throw new Error(code);
};
const check = (value, code = "retirement_driver_integrity_error") => {
  if (!value) fail(code);
};
const requestKeys = [
  "operationId",
  "repositoryId",
  "expectedGeneration",
  "policyVersion",
  "authorizationReceipt",
  "operatorId",
];
const checkpointKeys = ["operationId", "policyId", "authorizationId"];
const cursorKeys = [
  "schemaVersion",
  "operationHash",
  "checkpointHash",
  "phase",
  "mode",
  "lastBatchId",
  "scanAfter",
  "derivedBatchId",
];

// This new host API accepts data records. Existing component validators and
// callers retain their own behavior; no input getter runs during preflight.
function record(value, allowed, required = allowed) {
  check(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !types.isProxy(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    "invalid_retirement_driver_input",
  );
  const names = Reflect.ownKeys(value);
  check(
    names.length <= allowed.length &&
      names.every((key) => typeof key === "string" && allowed.includes(key)) &&
      required.every((key) => names.includes(key)),
    "invalid_retirement_driver_input",
  );
  const result = {};
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    check(descriptor && Object.hasOwn(descriptor, "value"), "invalid_retirement_driver_input");
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
  }
  return Object.freeze(result);
}

function batchId(operationHash, phase, predecessor = null) {
  return "rr1-" + (phase === "source" ? "s-" : "d-") + hash([schema, operationHash, phase, predecessor]);
}

function cursor(value, operationHash, checkpointHash) {
  if (value === undefined || value === null) return null;
  const next = record(value, cursorKeys);
  check(
    next.schemaVersion === schema &&
      next.operationHash === operationHash &&
      next.checkpointHash === checkpointHash &&
      ["derived", "source"].includes(next.phase) &&
      ["batch", "discover"].includes(next.mode) &&
      (next.phase === "derived" ? next.derivedBatchId === null : typeof next.derivedBatchId === "string") &&
      (next.mode === "discover" ? next.phase === "derived" && next.lastBatchId === null : next.scanAfter === null),
    "invalid_retirement_driver_cursor",
  );
  for (const key of ["lastBatchId", "scanAfter", "derivedBatchId"]) {
    check(next[key] === null || typeof next[key] === "string", "invalid_retirement_driver_cursor");
    if (next[key] !== null) validateDerivedErasureBatch(next[key], 1);
  }
  return next;
}

function checkpointReceipt(value, request, binding, preflight = false) {
  check(
    value?.schemaVersion ===
      (preflight ? "repository-checkpoint-retirement-preflight/v1" : "repository-checkpoint-retirement/v1") &&
      value.repositoryId === request.repositoryId &&
      checkpointKeys.every((key) => value[key] === binding[key]) &&
      (preflight
        ? ["active", "fenced"].includes(value.state)
        : value.checkpointPayloadsRemoved === true && value.legacyUnscopedPayloads === "outside_scope"),
    "retirement_checkpoint_receipt_invalid",
  );
  return value;
}

function sourceIdentity(receipt, request, limit) {
  check(
    receipt?.operationId === request.operationId &&
      typeof receipt.batchId === "string" &&
      ["erased", "blocked"].includes(receipt.status) &&
      Number.isSafeInteger(receipt.attempt) &&
      receipt.attempt > 0 &&
      Number.isSafeInteger(receipt.deletedSourceFacts) &&
      receipt.deletedSourceFacts >= 0 &&
      receipt.deletedSourceFacts <= limit &&
      typeof receipt.sourceFactsRemaining === "boolean" &&
      typeof receipt.completedAt === "string" &&
      Number.isFinite(Date.parse(receipt.completedAt)),
  );
  validateRepositoryErasureBatch(receipt.batchId, limit);
  return [
    receipt.batchId,
    hash([
      "collected-source-retirement-receipt/v1",
      request.operationId,
      request.repositoryId,
      receipt.batchId,
      limit,
      receipt.status,
      receipt.attempt,
      receipt.deletedSourceFacts,
      receipt.sourceFactsRemaining,
      receipt.completedAt,
    ]),
  ];
}

/**
 * Private, explicitly authorized permanent retirement of three owned components.
 * Each call adds at most one SQL/derived payload batch or one 64+1 metadata page.
 * Existing component scope scans and recursive checkpoint cleanup retain their
 * existing I/O characteristics. File checkpoint stores remain single-process.
 * Migrations, schedules, general Controls evidence and external stores are separate.
 */
export async function advanceRepositoryRetirement(input, dependencies) {
  const options = record(
    input,
    ["retirement", "checkpointBinding", "sourceLimit", "derivedLimit", "cursor"],
    ["retirement", "checkpointBinding"],
  );
  const request = validateRepositoryRetirement(record(options.retirement, requestKeys));
  const binding = Object.freeze(
    validateRepositoryCheckpointRetirementBinding(record(options.checkpointBinding, checkpointKeys)),
  );
  check(binding.operationId === request.operationId, "retirement_checkpoint_operation_conflict");
  const sourceLimit = Object.hasOwn(options, "sourceLimit") ? options.sourceLimit : 100;
  const derivedLimit = Object.hasOwn(options, "derivedLimit") ? options.derivedLimit : 100;
  const operationHash = hash(request);
  const checkpointHash = hash([request.repositoryId, binding]);
  validateRepositoryErasureBatch(batchId(operationHash, "source"), sourceLimit);
  validateDerivedErasureBatch(batchId(operationHash, "derived"), derivedLimit);
  const resume = cursor(options.cursor, operationHash, checkpointHash);
  const { db, controlsStore, scopedCheckpointStore, authorizeEnvelope } = dependencies ?? {};
  check(
    db &&
      typeof db.query === "function" &&
      typeof db.transaction === "function" &&
      controlsStore &&
      typeof controlsStore.transaction === "function" &&
      controlsStore.db &&
      scopedCheckpointStore?.repositoryId === request.repositoryId &&
      typeof scopedCheckpointStore.preflightRetirement === "function" &&
      typeof scopedCheckpointStore.retire === "function" &&
      typeof authorizeEnvelope === "function",
    "retirement_driver_capability_unavailable",
  );
  const envelope = Object.freeze({
    retirement: request,
    checkpoint: Object.freeze({ repositoryId: request.repositoryId, binding }),
    options: Object.freeze({ sourceLimit, derivedLimit, cursor: resume }),
  });
  const authorize = async () => {
    check((await authorizeEnvelope(envelope)) === true, "retirement_not_authorized");
  };
  const authorizeRequest = async (value) => {
    check(stableJSON(value) === stableJSON(request), "retirement_operation_conflict");
    await authorize();
    return true;
  };
  const collection = new RepositoryRetirementStore(db);
  const derived = new PipelineDerivedRetirementStore(db, controlsStore);
  const makeCursor = (phase, lastBatchId = null, derivedBatchId = null, mode = "batch", scanAfter = null) =>
    Object.freeze({
      schemaVersion: schema,
      operationHash,
      checkpointHash,
      phase,
      mode,
      lastBatchId,
      scanAfter,
      derivedBatchId,
    });

  // All supplied cursor references are checked without creating a fence. These
  // metadata checks establish input identity, never deletion completion.
  await authorize();
  checkpointReceipt(await scopedCheckpointStore.preflightRetirement(binding), request, binding, true);
  await authorize();
  const sourceBefore = await collection.readProgress(
    request,
    authorizeRequest,
    resume?.phase === "source" && resume.lastBatchId !== null ? resume.lastBatchId : undefined,
  );
  if (resume) {
    check(sourceBefore.fence !== null, "invalid_retirement_driver_cursor");
    if (resume.phase === "source" && resume.lastBatchId !== null)
      check(sourceBefore.batch !== null, "invalid_retirement_driver_cursor");
    for (const reference of new Set(
      [
        resume.derivedBatchId,
        resume.phase === "derived" ? resume.lastBatchId : null,
        resume.mode === "discover" ? resume.scanAfter : null,
      ].filter((value) => value !== null),
    )) {
      const found = await derived.readProgress(request, authorizeRequest, { batchId: reference });
      check(found.batch !== null, "invalid_retirement_driver_cursor");
      if (reference === resume.derivedBatchId)
        check(
          found.batch.receipt?.stage === "complete" && found.batch.receipt.status === "owned_scope_erased",
          "invalid_retirement_driver_cursor",
        );
    }
  }

  const fence = await collection.retire(request, authorizeRequest);
  check(
    fence.operationId === request.operationId &&
      fence.repositoryId === request.repositoryId &&
      fence.status === "collection_fenced" &&
      (!sourceBefore.fence || sourceBefore.fence.sourceGeneration === fence.sourceGeneration),
  );
  const admission = await derived.admit(request, authorizeRequest);
  check(
    admission.operationId === request.operationId &&
      admission.repositoryId === request.repositoryId &&
      admission.authorityHash === operationHash &&
      admission.sourceGeneration === fence.sourceGeneration &&
      admission.status === "derived_writes_fenced",
  );
  await authorize();
  const checkpoint = checkpointReceipt(await scopedCheckpointStore.retire(binding), request, binding);
  await authorize();
  const receipts = { collection: fence, admission, checkpoint };
  const finish = async (status, phase, next, extra = {}) => {
    await authorize();
    return {
      schemaVersion: schema,
      operationId: request.operationId,
      repositoryId: request.repositoryId,
      sourceGeneration: fence.sourceGeneration,
      status,
      phase,
      cursor: next,
      receipts,
      meaning:
        "Collected source facts, pipeline-owned derived rows and repository checkpoints only; " +
        "general Controls evidence, retained integrity proof, other source stores and backups are separate.",
      ...extra,
    };
  };

  const replayDerived = async (hint) => {
    const receipt = await derived.eraseBatch(request, hint.batchId, hint.limit, authorizeRequest);
    check(
      receipt.schemaVersion === "pipeline-derived-retirement/v1" &&
        receipt.operationId === request.operationId &&
        receipt.repositoryId === request.repositoryId &&
        receipt.batchId === hint.batchId &&
        receipt.manifestHash === hint.manifestHash &&
        (!hint.receipt || hash(receipt) === hint.receipt.hash),
    );
    return receipt;
  };
  const derivedResult = async (receipt) => {
    receipts.derived = receipt;
    if (receipt.status === "blocked")
      return finish("blocked", "derived", makeCursor("derived", receipt.batchId), {
        reason: receipt.retainedReason,
      });
    if (receipt.status === "owned_scope_erased") {
      check(receipt.stage === "complete");
      return finish("in_progress", "source", makeCursor("source", null, receipt.batchId));
    }
    check(receipt.status === "applied");
    return finish("in_progress", "derived", makeCursor("derived", receipt.batchId));
  };
  const runDerived = async (id) => {
    const found = await derived.readProgress(request, authorizeRequest, { batchId: id });
    if (found.batch) return derivedResult(await replayDerived(found.batch));
    try {
      const receipt = await derived.eraseBatch(request, id, derivedLimit, authorizeRequest);
      check(receipt.operationId === request.operationId && receipt.batchId === id);
      return derivedResult(receipt);
    } catch (error) {
      if (error?.message === "derived_batch_pending" || error?.message === "derived_scope_disposition_already_recorded")
        return finish("discovering", "derived", makeCursor("derived", null, null, "discover"));
      if (error?.message === "derived_batch_conflict") {
        // Only the proven first-writer limit race is retryable. A same-limit
        // document/hash/authority conflict remains the original integrity error.
        const winner = await derived.readProgress(request, authorizeRequest, { batchId: id });
        if (winner.batch && winner.batch.limit !== derivedLimit)
          return finish("retry", "derived", makeCursor("derived", id), { reason: "retained_batch_limit" });
      }
      throw error;
    }
  };

  if (!resume || resume.phase === "derived") {
    if (resume?.mode === "discover") {
      const page = await derived.readProgress(
        request,
        authorizeRequest,
        resume.scanAfter === null ? {} : { afterBatchId: resume.scanAfter },
      );
      const pending = page.entries.find((entry) => entry.receipt === null);
      const terminal = page.entries.find((entry) => ["owned_scope_erased", "blocked"].includes(entry.receipt?.status));
      const next = pending ?? terminal;
      if (next) return finish("in_progress", "derived", makeCursor("derived", next.batchId));
      if (page.nextCursor !== null)
        return finish("discovering", "derived", makeCursor("derived", null, null, "discover", page.nextCursor));
      const anchor = page.entries.at(-1)?.batchId ?? resume.scanAfter;
      return finish("in_progress", "derived", makeCursor("derived", anchor));
    }
    if (resume?.lastBatchId !== null && resume?.lastBatchId !== undefined) {
      const prior = await derived.readProgress(request, authorizeRequest, { batchId: resume.lastBatchId });
      check(prior.batch !== null, "invalid_retirement_driver_cursor");
      const receipt = await replayDerived(prior.batch);
      if (receipt.status !== "applied" || prior.batch.receipt === null) return derivedResult(receipt);
      return runDerived(batchId(operationHash, "derived", [receipt.batchId, hash(receipt)]));
    }
    return runDerived(batchId(operationHash, "derived"));
  }

  const derivedHint = await derived.readProgress(request, authorizeRequest, { batchId: resume.derivedBatchId });
  check(derivedHint.batch !== null, "invalid_retirement_driver_cursor");
  const derivedReceipt = await replayDerived(derivedHint.batch);
  check(
    derivedReceipt.status === "owned_scope_erased" && derivedReceipt.stage === "complete",
    "retirement_derived_scope_incomplete",
  );
  receipts.derived = derivedReceipt;

  const sourceResult = async (receipt, limit) => {
    sourceIdentity(receipt, request, limit);
    receipts.source = receipt;
    if (receipt.status === "blocked")
      return finish("blocked", "source", makeCursor("source", receipt.batchId, resume.derivedBatchId), {
        reason: receipt.blockedReason,
      });
    const current = await collection.readProgress(request, authorizeRequest, receipt.batchId);
    check(current.batch !== null && current.batch.limit === limit);
    if (!receipt.sourceFactsRemaining && current.pending === null) {
      check(current.batch.status === "erased" && current.batch.sourceFactsRemaining === false);
      return finish(
        "internal_components_erased",
        "complete",
        makeCursor("source", receipt.batchId, resume.derivedBatchId),
      );
    }
    return finish("in_progress", "source", makeCursor("source", receipt.batchId, resume.derivedBatchId));
  };
  const replaySource = async (hint) => {
    const receipt = await collection.eraseBatch(request, hint.batchId, hint.limit, authorizeRequest);
    check(receipt.batchId === hint.batchId);
    sourceIdentity(receipt, request, hint.limit);
    if (hint.status === "erased")
      check(
        receipt.status === hint.status &&
          receipt.attempt === hint.attempt &&
          receipt.deletedSourceFacts === hint.deletedSourceFacts &&
          receipt.sourceFactsRemaining === hint.sourceFactsRemaining &&
          receipt.completedAt === hint.completedAt,
      );
    return receipt;
  };
  const current = await collection.readProgress(
    request,
    authorizeRequest,
    resume.lastBatchId === null ? undefined : resume.lastBatchId,
  );
  const unfinished = current.pending;
  if (unfinished) return sourceResult(await replaySource(unfinished), unfinished.limit);
  if (current.terminal) return sourceResult(await replaySource(current.terminal), current.terminal.limit);
  let predecessor = null;
  if (resume.lastBatchId !== null) {
    check(current.batch !== null, "invalid_retirement_driver_cursor");
    const prior = await replaySource(current.batch);
    if (prior.status !== "erased") return sourceResult(prior, current.batch.limit);
    predecessor = sourceIdentity(prior, request, current.batch.limit);
  }
  const id = batchId(operationHash, "source", predecessor);
  const target = await collection.readProgress(request, authorizeRequest, id);
  if (target.pending) return sourceResult(await replaySource(target.pending), target.pending.limit);
  if (target.terminal) return sourceResult(await replaySource(target.terminal), target.terminal.limit);
  if (target.batch) return sourceResult(await replaySource(target.batch), target.batch.limit);
  try {
    return sourceResult(await collection.eraseBatch(request, id, sourceLimit, authorizeRequest), sourceLimit);
  } catch (error) {
    if (error?.message === "source_scope_already_erased")
      return finish("retry", "source", makeCursor("source", resume.lastBatchId, resume.derivedBatchId), {
        reason: "scope_receipt_available",
      });
    if (error?.message === "erasure_batch_conflict") {
      const winner = await collection.readProgress(request, authorizeRequest, id);
      if (winner.batch && winner.batch.limit !== sourceLimit)
        return finish("retry", "source", makeCursor("source", id, resume.derivedBatchId), {
          reason: "retained_batch_limit",
        });
    }
    throw error;
  }
}
