import { createHash } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import { z } from "zod";
import {
  compareSourceInstants,
  encodeVerifiedIdentityCorrectionProposal,
  verifiedGithubIdentitySchema,
  verifiedIdentityCorrectionDecisionSchema as decisionSchema,
  verifiedIdentityCorrectionProposalSchema as proposalSchema,
} from "@pick-your-ai/contracts";
import { ControlError, ControlStore, requireThat } from "./store.mjs";

const reference = decisionSchema.shape.decisionId;
const instant = decisionSchema.shape.reviewedAt;
const digest = decisionSchema.shape.proposalSha256;
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveRevision = revision.refine((value) => value > 0);
const verified = { verified: z.literal(true), revoked: z.literal(false) };
const acceptedAuthorizationSchema = z
  .object({
    receiptId: reference,
    scope: z.literal("private_identity_correction"),
    decisionId: reference,
    proposalSha256: digest,
    reviewer: verifiedGithubIdentitySchema,
    policyVersion: reference,
    kind: proposalSchema.shape.kind,
    attributionRevision: revision,
    grantedAt: instant,
    expiresAt: instant,
    revoked: z.literal(false),
  })
  .strict();
const applicationReceiptSchema = z
  .object({
    schemaVersion: z.literal("leaderboard-private-identity-application/v1"),
    decisionId: reference,
    correctionId: reference,
    proposalRevision: proposalSchema.shape.revision,
    proposalSha256: digest,
    authorityRevision: positiveRevision,
    beforeRevision: revision,
    afterRevision: positiveRevision,
    appliedAt: instant,
    authorizationReceiptId: reference,
    reasonReceiptId: reference,
    outcome: z.literal("applied_private"),
  })
  .strict();
const overlaySchema = z
  .object({
    schemaVersion: z.literal("leaderboard-private-identity-overlay/v1"),
    decisionId: reference,
    correctionId: reference,
    proposalRevision: proposalSchema.shape.revision,
    proposalSha256: digest,
    attributionRevision: positiveRevision,
    kind: proposalSchema.shape.kind,
    authorityBasis: proposalSchema.shape.authorityBasis,
    sourceActors: proposalSchema.shape.sourceActors,
    resultActors: proposalSchema.shape.resultActors,
    assignments: proposalSchema.shape.assignments,
  })
  .strict();
const targetSchema = z
  .object({
    decision: decisionSchema,
    authorization: acceptedAuthorizationSchema,
    receipt: applicationReceiptSchema,
    overlay: overlaySchema,
  })
  .strict();
const observationsSchema = z
  .object({
    actors: z
      .array(
        z
          .object({
            actorId: z.string().regex(/^[1-9][0-9]{0,15}$/),
            suppression: z.enum(["clear", "suppressed", "unavailable"]),
            deletion: z.enum(["retained", "deleted", "unavailable"]),
            consent: z.enum(["current", "withdrawn", "expired", "not_applicable", "unavailable"]),
          })
          .strict(),
      )
      .max(64),
    sources: z
      .array(
        z
          .object({
            contributionId: reference,
            validity: z.enum(["current", "changed", "revoked", "deleted", "unavailable"]),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
const authorizationSchema = z
  .object({
    receiptId: reference,
    scope: z.literal("private_identity_cancellation"),
    decisionId: reference,
    reversesDecisionId: reference,
    targetApplicationSha256: digest,
    proposalSha256: digest,
    reviewer: verifiedGithubIdentitySchema,
    policyVersion: reference,
    kind: proposalSchema.shape.kind,
    attributionRevision: revision,
    grantedAt: instant,
    expiresAt: instant,
    revoked: z.literal(false),
  })
  .strict();
const authoritySchema = z
  .object({
    schemaVersion: z.literal("leaderboard-private-identity-reversal-authority/v1"),
    revision: positiveRevision,
    validUntil: instant,
    decision: decisionSchema,
    currentDecisionId: reference,
    priorDecisions: z.array(decisionSchema).max(64),
    reviewer: z.object({ identity: verifiedGithubIdentitySchema, expiresAt: instant, ...verified }).strict(),
    authorization: authorizationSchema,
    reason: z.object({ receiptId: reference, decisionId: reference, proposalSha256: digest, ...verified }).strict(),
    observations: observationsSchema,
  })
  .strict();
const receiptSchema = z
  .object({
    schemaVersion: z.literal("leaderboard-private-identity-cancellation/v1"),
    decisionId: reference,
    reversesDecisionId: reference,
    correctionId: reference,
    proposalSha256: digest,
    targetApplicationSha256: digest,
    authorityRevision: positiveRevision,
    beforeRevision: revision,
    afterRevision: positiveRevision,
    appliedAt: instant,
    authorizationReceiptId: reference,
    reasonReceiptId: reference,
    outcome: z.literal("cancelled_private"),
    restoration: z.literal("withheld"),
    observations: observationsSchema,
  })
  .strict();

function parse(schema, value, message = "Invalid protected identity reversal") {
  const parsed = schema.safeParse(value);
  requireThat(parsed.success, 409, message);
  return parsed.data;
}
function document(schema, value, message) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ControlError(409, message);
  }
  return parse(schema, parsed, message);
}
function same(actual, expected, message) {
  requireThat(isDeepStrictEqual(actual, expected), 409, message);
}
function future(value, at) {
  requireThat(compareSourceInstants(value, at) > 0, 409, "Identity reversal authority expired");
}
function proposalDigest(value) {
  return createHash("sha256").update(encodeVerifiedIdentityCorrectionProposal(value)).digest("hex");
}
function expectedOverlay(decision, receipt) {
  const p = decision.proposal;
  return {
    schemaVersion: "leaderboard-private-identity-overlay/v1",
    decisionId: decision.decisionId,
    correctionId: p.correctionId,
    proposalRevision: p.revision,
    proposalSha256: decision.proposalSha256,
    attributionRevision: receipt.afterRevision,
    kind: p.kind,
    authorityBasis: p.authorityBasis,
    sourceActors: p.sourceActors,
    resultActors: p.resultActors,
    assignments: p.assignments,
  };
}
function validateTarget(target) {
  const { decision, authorization: a, receipt: r, overlay } = target;
  const p = decision.proposal;
  requireThat(decision.outcome === "accepted", 409, "Reversal target was not accepted");
  same(proposalDigest(p), decision.proposalSha256, "Target proposal digest mismatch");
  same(
    [a.receiptId, a.decisionId, a.proposalSha256, a.reviewer, a.policyVersion, a.kind],
    [
      decision.authorizationReceiptId,
      decision.decisionId,
      decision.proposalSha256,
      decision.reviewer,
      p.policyVersion,
      p.kind,
    ],
    "Target authorization binding changed",
  );
  same(
    [r.decisionId, r.correctionId, r.proposalRevision, r.proposalSha256, r.authorizationReceiptId, r.reasonReceiptId],
    [
      decision.decisionId,
      p.correctionId,
      p.revision,
      decision.proposalSha256,
      decision.authorizationReceiptId,
      decision.reasonReceiptId,
    ],
    "Target application receipt changed",
  );
  requireThat(
    r.beforeRevision === a.attributionRevision &&
      r.beforeRevision < Number.MAX_SAFE_INTEGER &&
      r.afterRevision === r.beforeRevision + 1,
    409,
    "Target application revision mismatch",
  );
  requireThat(
    compareSourceInstants(a.grantedAt, decision.reviewedAt) <= 0 &&
      compareSourceInstants(decision.reviewedAt, r.appliedAt) <= 0 &&
      compareSourceInstants(r.appliedAt, a.expiresAt) < 0 &&
      p.proofs.every((proof) => proof.expiresAt === null || compareSourceInstants(r.appliedAt, proof.expiresAt) < 0),
    409,
    "Target application chronology changed",
  );
  same(overlay, expectedOverlay(decision, r), "Target overlay changed");
}
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
      .join(",") +
    "}"
  );
}

export const privateIdentityApplicationBindingVersion = "leaderboard-private-identity-application-binding/v1";

/** Content binding only: this does not establish authority or apply any decision. */
export function digestPrivateIdentityCorrectionApplication(input) {
  const target = parse(targetSchema, input, "Invalid retained identity target");
  validateTarget(target);
  return createHash("sha256")
    .update(privateIdentityApplicationBindingVersion + "\n" + canonical(target), "utf8")
    .digest("hex");
}

function readTarget(database, decisionId) {
  const row = database
    .prepare(
      "SELECT r.decision_document,r.authorization_document,r.document,o.attribution_revision,o.document AS overlay FROM identity_correction_receipts r JOIN identity_correction_overlays o ON o.decision_id=r.decision_id WHERE r.decision_id=?",
    )
    .get(decisionId);
  requireThat(row, 409, "Accepted identity application is unavailable");
  const target = {
    decision: document(decisionSchema, row.decision_document, "Invalid retained target decision"),
    authorization: document(
      acceptedAuthorizationSchema,
      row.authorization_document,
      "Invalid retained target authorization",
    ),
    receipt: document(applicationReceiptSchema, row.document, "Invalid retained target receipt"),
    overlay: document(overlaySchema, row.overlay, "Invalid retained target overlay"),
  };
  validateTarget(target);
  requireThat(
    target.decision.decisionId === decisionId && row.attribution_revision === target.receipt.afterRevision,
    409,
    "Target storage identity changed",
  );
  return target;
}
function historyReference(decision) {
  return { decisionId: decision.decisionId, reviewer: decision.reviewer };
}
function validateHistory(authority, target, database) {
  const { decision, priorDecisions } = authority;
  const history = [];
  const ids = new Set();
  const actors = new Map();
  const nodes = new Map();
  const reviewers = new Set();
  const reviewerNodes = new Set();
  for (const item of [...priorDecisions, decision]) {
    requireThat(
      !ids.has(item.decisionId) && item.proposal.correctionId === decision.proposal.correctionId,
      409,
      "Invalid identity reversal lineage",
    );
    ids.add(item.decisionId);
    same(item.priorReviews, history, "Incomplete identity reversal history");
    same(proposalDigest(item.proposal), item.proposalSha256, "Historical proposal digest mismatch");
    if (history.length) {
      const earlier = priorDecisions[history.length - 1];
      requireThat(
        compareSourceInstants(earlier.reviewedAt, item.reviewedAt) <= 0,
        409,
        "Review history is out of order",
      );
    }
    if (item !== decision)
      requireThat(compareSourceInstants(item.reviewedAt, decision.reviewedAt) < 0, 409, "Prior review is not earlier");
    requireThat(
      !reviewers.has(item.reviewer.actorId) && !reviewerNodes.has(item.reviewer.githubNodeId),
      409,
      "Repeated reversal reviewer",
    );
    reviewers.add(item.reviewer.actorId);
    reviewerNodes.add(item.reviewer.githubNodeId);
    for (const identity of [
      item.proposal.requester,
      ...item.proposal.sourceActors,
      ...item.proposal.resultActors,
      item.reviewer,
    ]) {
      for (const previous of [actors.get(identity.actorId), nodes.get(identity.githubNodeId)]) {
        if (previous) same(previous, identity, "Conflicting retained provider identity");
      }
      actors.set(identity.actorId, identity);
      nodes.set(identity.githubNodeId, identity);
    }
    if (item.outcome === "reversed") {
      const accepted = priorDecisions.find((prior) => prior.decisionId === item.reversesDecisionId);
      requireThat(
        accepted?.outcome === "accepted" && history.some((r) => r.decisionId === accepted.decisionId),
        409,
        "Reversal history lacks an accepted target",
      );
    }
    history.push(historyReference(item));
  }
  same(
    priorDecisions.find((item) => item.decisionId === target.decision.decisionId),
    target.decision,
    "Retained accepted target is absent or changed",
  );
  const retained = database
    .prepare(
      "SELECT decision_id,decision_document FROM identity_correction_receipts WHERE json_extract(decision_document, '$.proposal.correctionId')=? AND decision_id<>?",
    )
    .all(decision.proposal.correctionId, decision.decisionId);
  for (const row of retained) {
    const known = document(decisionSchema, row.decision_document, "Invalid retained identity history");
    requireThat(known.decisionId === row.decision_id, 409, "Retained identity history key changed");
    same(
      priorDecisions.find((item) => item.decisionId === known.decisionId),
      known,
      "Applied decision is absent or changed in retained history",
    );
  }
}
function validateObservations(observations, proposal) {
  const expectedActors = [
    ...new Set([...proposal.sourceActors, ...proposal.resultActors].map((v) => v.actorId)),
  ].sort();
  const actorIds = observations.actors.map((v) => v.actorId);
  same([...actorIds].sort(), expectedActors, "Identity observation scope mismatch");
  requireThat(new Set(actorIds).size === actorIds.length, 409, "Duplicate identity observation");
  const sourceIds = observations.sources.map((v) => v.contributionId);
  same(
    [...sourceIds].sort(),
    proposal.assignments.map((v) => v.contributionId).sort(),
    "Source observation scope mismatch",
  );
  requireThat(new Set(sourceIds).size === sourceIds.length, 409, "Duplicate source observation");
  for (const actor of observations.actors) {
    requireThat(
      actor.consent !== "not_applicable" ||
        !proposal.proofs.some((p) => p.kind === "consent" && p.subjectActorIds.includes(actor.actorId)),
      409,
      "Scoped consent cannot be omitted",
    );
  }
}
function validateAuthority(authority, decisionId, at, target, database) {
  const { decision: d, authorization: a, reason } = authority;
  requireThat(
    d.decisionId === decisionId && authority.currentDecisionId === decisionId,
    409,
    "Reversal decision changed",
  );
  requireThat(
    d.outcome === "reversed" && d.reversesDecisionId === target.decision.decisionId,
    409,
    "Only a reversal of the retained acceptance can cancel",
  );
  same(d.proposal, target.decision.proposal, "Reversal changed the historical target proposal");
  requireThat(
    compareSourceInstants(target.receipt.appliedAt, d.reviewedAt) <= 0 && compareSourceInstants(d.reviewedAt, at) <= 0,
    409,
    "Invalid identity reversal chronology",
  );
  future(authority.validUntil, at);
  same(authority.reviewer.identity, d.reviewer, "Current reversal reviewer changed");
  future(authority.reviewer.expiresAt, at);
  same(
    [
      a.receiptId,
      a.decisionId,
      a.reversesDecisionId,
      a.targetApplicationSha256,
      a.proposalSha256,
      a.reviewer,
      a.policyVersion,
      a.kind,
    ],
    [
      d.authorizationReceiptId,
      decisionId,
      target.decision.decisionId,
      digestPrivateIdentityCorrectionApplication(target),
      d.proposalSha256,
      d.reviewer,
      d.proposal.policyVersion,
      d.proposal.kind,
    ],
    "Identity cancellation authorization mismatch",
  );
  requireThat(
    compareSourceInstants(target.receipt.appliedAt, a.grantedAt) <= 0 &&
      compareSourceInstants(a.grantedAt, d.reviewedAt) <= 0 &&
      target.receipt.afterRevision <= a.attributionRevision,
    409,
    "Cancellation authorization predates its target or postdates review",
  );
  future(a.expiresAt, at);
  same(
    [reason.receiptId, reason.decisionId, reason.proposalSha256],
    [d.reasonReceiptId, decisionId, d.proposalSha256],
    "Identity cancellation reason mismatch",
  );
  validateHistory(authority, target, database);
  validateObservations(authority.observations, d.proposal);
}
function cancellationDocument(receipt) {
  return {
    schemaVersion: "leaderboard-private-identity-cancellation-state/v1",
    decisionId: receipt.decisionId,
    reversesDecisionId: receipt.reversesDecisionId,
    correctionId: receipt.correctionId,
    targetApplicationSha256: receipt.targetApplicationSha256,
    attributionRevision: receipt.afterRevision,
    restoration: "withheld",
    observations: receipt.observations,
    observedAt: receipt.appliedAt,
    authorityRevision: receipt.authorityRevision,
  };
}
function readRevision(database) {
  return parse(
    revision,
    database.prepare("SELECT revision FROM identity_correction_revision WHERE id=1").get()?.revision,
    "Invalid private attribution revision",
  );
}
function durableCancellation(database, authority, target, at, currentRevision) {
  const d = authority.decision;
  const row = database
    .prepare(
      "SELECT decision_document,authorization_document,document FROM identity_correction_receipts WHERE decision_id=?",
    )
    .get(d.decisionId);
  requireThat(row, 409, "Cancellation receipt is unavailable");
  same(
    document(decisionSchema, row.decision_document, "Invalid retained reversal decision"),
    d,
    "Reversal decision ID was reused",
  );
  same(
    document(authorizationSchema, row.authorization_document, "Invalid retained reversal authorization"),
    authority.authorization,
    "Retained cancellation authorization changed",
  );
  const receipt = document(receiptSchema, row.document, "Invalid retained cancellation receipt");
  same(
    [
      receipt.decisionId,
      receipt.reversesDecisionId,
      receipt.correctionId,
      receipt.proposalSha256,
      receipt.targetApplicationSha256,
      receipt.authorizationReceiptId,
      receipt.reasonReceiptId,
    ],
    [
      d.decisionId,
      target.decision.decisionId,
      d.proposal.correctionId,
      d.proposalSha256,
      authority.authorization.targetApplicationSha256,
      d.authorizationReceiptId,
      d.reasonReceiptId,
    ],
    "Retained cancellation receipt changed",
  );
  requireThat(
    receipt.beforeRevision === authority.authorization.attributionRevision &&
      receipt.beforeRevision < Number.MAX_SAFE_INTEGER &&
      receipt.afterRevision === receipt.beforeRevision + 1 &&
      receipt.afterRevision <= currentRevision &&
      target.receipt.afterRevision <= receipt.beforeRevision &&
      compareSourceInstants(d.reviewedAt, receipt.appliedAt) <= 0 &&
      compareSourceInstants(receipt.appliedAt, at) <= 0,
    409,
    "Retained cancellation revision or chronology changed",
  );
  validateObservations(receipt.observations, d.proposal);
  const cancellation = database
    .prepare(
      "SELECT decision_id,attribution_revision,document FROM identity_correction_cancellations WHERE target_decision_id=?",
    )
    .get(target.decision.decisionId);
  requireThat(
    cancellation?.decision_id === d.decisionId && cancellation.attribution_revision === receipt.afterRevision,
    409,
    "Incomplete retained identity cancellation",
  );
  same(
    document(z.unknown(), cancellation.document, "Invalid retained cancellation state"),
    cancellationDocument(receipt),
    "Retained cancellation state changed",
  );
  return receipt;
}

/** Explicit private host configuration. There is no HTTP or public restoration path. */
export function createVerifiedIdentityCorrectionReversalConsumer({
  store,
  readAuthority,
  now = () => new Date().toISOString(),
}) {
  requireThat(store instanceof ControlStore, 500, "A private ControlStore is required");
  requireThat(
    typeof readAuthority === "function" && !types.isAsyncFunction(readAuthority),
    500,
    "A synchronous protected reversal reader is required",
  );
  requireThat(typeof now === "function" && !types.isAsyncFunction(now), 500, "A synchronous clock is required");
  const database = store.db;
  // The accepted component owns its three tables. This optional successor does
  // not silently initialize or replace the original application's schema.
  try {
    database.prepare("SELECT revision FROM identity_correction_revision WHERE id=1").get();
    database
      .prepare("SELECT decision_id,attribution_revision,document FROM identity_correction_overlays LIMIT 0")
      .all();
    database
      .prepare(
        "SELECT decision_id,decision_document,authorization_document,document FROM identity_correction_receipts LIMIT 0",
      )
      .all();
  } catch {
    throw new ControlError(500, "Initialize the private accepted-decision store first");
  }
  store.transaction(() =>
    database.exec(
      "CREATE TABLE IF NOT EXISTS identity_correction_cancellations (target_decision_id TEXT PRIMARY KEY, decision_id TEXT NOT NULL UNIQUE, attribution_revision INTEGER NOT NULL UNIQUE, document TEXT NOT NULL)",
    ),
  );
  function synchronous(value, message) {
    if (types.isPromise(value)) {
      void Promise.prototype.then.call(
        value,
        () => undefined,
        () => undefined,
      );
      throw new ControlError(409, message);
    }
    return value;
  }
  function invoke(callback, args, message) {
    try {
      return synchronous(callback(...args), message);
    } catch (error) {
      // A native Promise thrown by a configured callback still needs its
      // rejection observed. Never assimilate a foreign thenable.
      synchronous(error, message);
      throw error;
    }
  }
  function read(decisionId) {
    return parse(
      authoritySchema,
      invoke(readAuthority, [{ database, decisionId }], "Protected reversal reads must be synchronous"),
    );
  }
  function clock() {
    return parse(instant, invoke(now, [], "Invalid identity reversal clock"), "Invalid identity reversal clock");
  }
  return Object.freeze({
    reverse(decisionId) {
      requireThat(
        arguments.length === 1 && reference.safeParse(decisionId).success,
        400,
        "An exact reversal decision ID is required",
      );
      let initial;
      let target;
      let startedAt;
      let finalRevision;
      let expectedReceipt;
      const result = store.transaction(
        () => {
          startedAt = clock();
          initial = read(decisionId);
          requireThat(
            initial.decision.outcome === "reversed" && initial.decision.reversesDecisionId,
            409,
            "Only a reversed decision can cancel",
          );
          target = readTarget(database, initial.decision.reversesDecisionId);
          const currentRevision = readRevision(database);
          requireThat(
            target.receipt.afterRevision <= currentRevision,
            409,
            "Target revision is ahead of private state",
          );
          validateAuthority(initial, decisionId, startedAt, target, database);
          const previous = database
            .prepare("SELECT 1 FROM identity_correction_receipts WHERE decision_id=?")
            .get(decisionId);
          if (previous) {
            finalRevision = currentRevision;
            const retained = durableCancellation(database, initial, target, startedAt, currentRevision);
            expectedReceipt = structuredClone(retained);
            return retained;
          }
          requireThat(
            !database
              .prepare("SELECT 1 FROM identity_correction_cancellations WHERE target_decision_id=?")
              .get(target.decision.decisionId),
            409,
            "Accepted identity application is already cancelled",
          );
          requireThat(
            initial.authorization.attributionRevision === currentRevision && currentRevision < Number.MAX_SAFE_INTEGER,
            409,
            "Attribution changed; a new cancellation review is required",
          );
          const d = initial.decision;
          const receipt = {
            schemaVersion: "leaderboard-private-identity-cancellation/v1",
            decisionId,
            reversesDecisionId: target.decision.decisionId,
            correctionId: d.proposal.correctionId,
            proposalSha256: d.proposalSha256,
            targetApplicationSha256: initial.authorization.targetApplicationSha256,
            authorityRevision: initial.revision,
            beforeRevision: currentRevision,
            afterRevision: currentRevision + 1,
            appliedAt: startedAt,
            authorizationReceiptId: d.authorizationReceiptId,
            reasonReceiptId: d.reasonReceiptId,
            outcome: "cancelled_private",
            restoration: "withheld",
            observations: initial.observations,
          };
          database
            .prepare("INSERT INTO identity_correction_cancellations VALUES(?,?,?,?)")
            .run(
              target.decision.decisionId,
              decisionId,
              receipt.afterRevision,
              JSON.stringify(cancellationDocument(receipt)),
            );
          database
            .prepare("INSERT INTO identity_correction_receipts VALUES(?,?,?,?)")
            .run(decisionId, JSON.stringify(d), JSON.stringify(initial.authorization), JSON.stringify(receipt));
          const changed = database
            .prepare("UPDATE identity_correction_revision SET revision=? WHERE id=1 AND revision=?")
            .run(receipt.afterRevision, currentRevision);
          requireThat(changed.changes === 1, 409, "Private attribution revision changed");
          finalRevision = receipt.afterRevision;
          expectedReceipt = structuredClone(receipt);
          return receipt;
        },
        {
          beforeCommit() {
            const current = read(decisionId);
            const at = clock();
            requireThat(compareSourceInstants(at, startedAt) >= 0, 409, "Identity reversal clock moved backwards");
            same(current, initial, "Protected cancellation authority changed");
            const retainedTarget = readTarget(database, target.decision.decisionId);
            same(retainedTarget, target, "Retained cancellation target changed");
            requireThat(readRevision(database) === finalRevision, 409, "Private cancellation revision changed");
            validateAuthority(current, decisionId, at, retainedTarget, database);
            same(
              durableCancellation(database, current, retainedTarget, at, finalRevision),
              expectedReceipt,
              "Retained cancellation changed before commit",
            );
          },
        },
      );
      return structuredClone(result);
    },
  });
}
