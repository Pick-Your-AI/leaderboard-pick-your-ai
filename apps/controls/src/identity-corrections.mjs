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
const binding = proposalSchema.shape.assignments.element.omit({ evidenceIds: true });
const originalBinding = binding.omit({ resultActorId: true });
const verified = { verified: z.literal(true), revoked: z.literal(false) };
const authoritySchema = z
  .object({
    schemaVersion: z.literal("leaderboard-private-identity-authority/v1"),
    revision: revision.refine((value) => value > 0),
    validUntil: instant,
    decision: decisionSchema,
    currentProposal: proposalSchema,
    currentDecisionId: reference,
    priorDecisions: z.array(decisionSchema).max(64),
    identities: z
      .array(z.object({ identity: verifiedGithubIdentitySchema, expiresAt: instant, ...verified }).strict())
      .max(130),
    proofs: z
      .array(
        z
          .object({
            proof: proposalSchema.shape.proofs.element,
            attributions: z.array(binding).max(256),
            ...verified,
          })
          .strict(),
      )
      .max(256),
    sources: z.array(z.object({ binding: originalBinding, ...verified }).strict()).max(256),
    authorization: z
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
      .strict(),
    reason: z.object({ receiptId: reference, decisionId: reference, proposalSha256: digest, ...verified }).strict(),
  })
  .strict();
const receiptSchema = z
  .object({
    schemaVersion: z.literal("leaderboard-private-identity-application/v1"),
    decisionId: reference,
    correctionId: reference,
    proposalRevision: proposalSchema.shape.revision,
    proposalSha256: digest,
    authorityRevision: authoritySchema.shape.revision,
    beforeRevision: revision,
    afterRevision: revision,
    appliedAt: instant,
    authorizationReceiptId: reference,
    reasonReceiptId: reference,
    outcome: z.literal("applied_private"),
  })
  .strict();

function parse(schema, value, message = "Invalid protected identity authority") {
  const result = schema.safeParse(value);
  requireThat(result.success, 409, message);
  return result.data;
}
function same(actual, expected, message) {
  requireThat(isDeepStrictEqual(actual, expected), 409, message);
}
function proposalDigest(proposal) {
  return createHash("sha256").update(encodeVerifiedIdentityCorrectionProposal(proposal)).digest("hex");
}
function uniqueMap(items, key, message) {
  const map = new Map(items.map((item) => [key(item), item]));
  requireThat(map.size === items.length, 409, message);
  return map;
}
function assignmentBinding(assignment) {
  const { evidenceIds: _evidenceIds, ...value } = assignment;
  return value;
}
function sourceBinding(assignment) {
  const { resultActorId: _resultActorId, ...value } = assignmentBinding(assignment);
  return value;
}
function historyReference(decision) {
  return { decisionId: decision.decisionId, reviewer: decision.reviewer };
}
function currentAt(value, at) {
  requireThat(compareSourceInstants(value, at) > 0, 409, "Identity authority or evidence expired");
}

function validateAuthority(authority, decisionId, at) {
  const { decision, authorization, reason, priorDecisions } = authority;
  const proposal = decision.proposal;
  requireThat(
    decision.decisionId === decisionId && authority.currentDecisionId === decisionId,
    409,
    "Decision changed",
  );
  requireThat(decision.outcome === "accepted", 409, "Only accepted identity decisions can be applied");
  requireThat(compareSourceInstants(decision.reviewedAt, at) <= 0, 409, "Decision is not current");
  currentAt(authority.validUntil, at);
  same(authority.currentProposal, proposal, "Proposal revision or content changed");
  same(proposalDigest(proposal), decision.proposalSha256, "Proposal digest mismatch");

  // The configured reader must resolve the whole retained lineage, not the
  // references presented by a requester. Every earlier decision binds its prefix.
  uniqueMap(priorDecisions, (item) => item.decisionId, "Duplicate prior decision");
  uniqueMap(priorDecisions, (item) => item.reviewer.actorId, "Duplicate prior reviewer");
  uniqueMap(priorDecisions, (item) => item.reviewer.githubNodeId, "Conflicting prior reviewer");
  const history = [];
  for (const prior of priorDecisions) {
    requireThat(
      prior.decisionId !== decisionId &&
        prior.proposal.correctionId === proposal.correctionId &&
        prior.proposal.revision <= proposal.revision &&
        compareSourceInstants(prior.reviewedAt, decision.reviewedAt) < 0 &&
        (!history.length ||
          compareSourceInstants(priorDecisions[history.length - 1].reviewedAt, prior.reviewedAt) <= 0),
      409,
      "Invalid retained review lineage",
    );
    same(prior.priorReviews, history, "Incomplete retained review history");
    same(proposalDigest(prior.proposal), prior.proposalSha256, "Prior proposal digest mismatch");
    history.push(historyReference(prior));
  }
  same(decision.priorReviews, history, "Incomplete retained review history");

  const expectedIdentities = new Map(
    [
      proposal.requester,
      ...proposal.sourceActors,
      ...proposal.resultActors,
      decision.reviewer,
      ...history.map((r) => r.reviewer),
    ].map((identity) => [identity.actorId, identity]),
  );
  const identities = uniqueMap(authority.identities, (item) => item.identity.actorId, "Duplicate verified identity");
  uniqueMap(authority.identities, (item) => item.identity.githubNodeId, "Conflicting verified identity");
  same([...identities.keys()].sort(), [...expectedIdentities.keys()].sort(), "Verified identity scope mismatch");
  for (const [id, expected] of expectedIdentities) {
    const record = identities.get(id);
    same(record.identity, expected, "Verified provider identity changed");
    currentAt(record.expiresAt, at);
  }

  const proofs = uniqueMap(authority.proofs, (item) => item.proof.evidenceId, "Duplicate protected proof");
  same(
    [...proofs.keys()].sort(),
    proposal.proofs.map((item) => item.evidenceId).sort(),
    "Protected proof scope mismatch",
  );
  for (const proof of proposal.proofs) {
    const record = proofs.get(proof.evidenceId);
    same(record.proof, proof, "Protected proof binding changed");
    if (proof.expiresAt !== null) currentAt(proof.expiresAt, at);
    const expected = proposal.assignments.filter((item) => proof.contributionIds.includes(item.contributionId));
    const attributions = uniqueMap(record.attributions, (item) => item.contributionId, "Duplicate proof attribution");
    same(
      [...attributions.keys()].sort(),
      expected.map((item) => item.contributionId).sort(),
      "Proof attribution scope mismatch",
    );
    for (const assignment of expected) {
      same(attributions.get(assignment.contributionId), assignmentBinding(assignment), "Proof source binding changed");
    }
  }
  const sources = uniqueMap(authority.sources, (item) => item.binding.contributionId, "Duplicate source attribution");
  same(
    [...sources.keys()].sort(),
    proposal.assignments.map((item) => item.contributionId).sort(),
    "Source scope mismatch",
  );
  for (const assignment of proposal.assignments) {
    same(
      sources.get(assignment.contributionId).binding,
      sourceBinding(assignment),
      "Retained source attribution changed",
    );
  }

  same(
    {
      receiptId: authorization.receiptId,
      decisionId: authorization.decisionId,
      proposalSha256: authorization.proposalSha256,
      reviewer: authorization.reviewer,
      policyVersion: authorization.policyVersion,
      kind: authorization.kind,
    },
    {
      receiptId: decision.authorizationReceiptId,
      decisionId,
      proposalSha256: decision.proposalSha256,
      reviewer: decision.reviewer,
      policyVersion: proposal.policyVersion,
      kind: proposal.kind,
    },
    "Protected authorization scope mismatch",
  );
  requireThat(
    compareSourceInstants(authorization.grantedAt, decision.reviewedAt) <= 0,
    409,
    "Authorization postdates review",
  );
  currentAt(authorization.expiresAt, at);
  same(
    { receiptId: reason.receiptId, decisionId: reason.decisionId, proposalSha256: reason.proposalSha256 },
    { receiptId: decision.reasonReceiptId, decisionId, proposalSha256: decision.proposalSha256 },
    "Protected reason receipt mismatch",
  );
}

function overlayFor(decision, receipt) {
  const proposal = decision.proposal;
  return {
    schemaVersion: "leaderboard-private-identity-overlay/v1",
    decisionId: decision.decisionId,
    correctionId: proposal.correctionId,
    proposalRevision: proposal.revision,
    proposalSha256: decision.proposalSha256,
    attributionRevision: receipt.afterRevision,
    kind: proposal.kind,
    authorityBasis: proposal.authorityBasis,
    sourceActors: proposal.sourceActors,
    resultActors: proposal.resultActors,
    assignments: proposal.assignments,
  };
}

/**
 * Explicitly configured private consumer; never connected to the HTTP server.
 * readAuthority must read canonical protected records through the supplied
 * DatabaseSync connection in this transaction. A cache/remote database cannot
 * satisfy that contract. No asynchronous or external side effect belongs here.
 */
export function createVerifiedIdentityCorrectionConsumer({
  store,
  readAuthority,
  now = () => new Date().toISOString(),
}) {
  requireThat(store instanceof ControlStore, 500, "A private ControlStore is required");
  requireThat(
    typeof readAuthority === "function" && !types.isAsyncFunction(readAuthority),
    500,
    "A synchronous protected authority reader is required",
  );
  requireThat(typeof now === "function" && !types.isAsyncFunction(now), 500, "A synchronous clock is required");
  const database = store.db;
  store.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS identity_correction_revision (
        id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0)
      );
      INSERT OR IGNORE INTO identity_correction_revision VALUES(1,0);
      CREATE TABLE IF NOT EXISTS identity_correction_overlays (
        decision_id TEXT PRIMARY KEY, attribution_revision INTEGER NOT NULL UNIQUE, document TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS identity_correction_receipts (
        decision_id TEXT PRIMARY KEY, decision_document TEXT NOT NULL, authorization_document TEXT NOT NULL, document TEXT NOT NULL
      );
    `);
  });
  function read(decisionId) {
    const result = readAuthority({ database, decisionId });
    if (types.isPromise(result)) {
      // Observe a native rejection without invoking foreign thenable callbacks.
      void Promise.prototype.then.call(
        result,
        () => undefined,
        () => undefined,
      );
      throw new ControlError(500, "Protected authority reads must be synchronous");
    }
    return parse(authoritySchema, result);
  }
  function readClock() {
    const result = now();
    if (types.isPromise(result)) {
      // Observe native rejections before rejecting the synchronous clock value.
      void Promise.prototype.then.call(
        result,
        () => undefined,
        () => undefined,
      );
      throw new ControlError(409, "Invalid identity application clock");
    }
    return parse(instant, result, "Invalid identity application clock");
  }
  return Object.freeze({
    apply(decisionId) {
      requireThat(
        arguments.length === 1 && reference.safeParse(decisionId).success,
        400,
        "An exact decision ID is required",
      );
      let authority;
      let startedAt;
      const result = store.transaction(
        () => {
          startedAt = readClock();
          authority = read(decisionId);
          validateAuthority(authority, decisionId, startedAt);
          const { decision, authorization } = authority;
          // The authority reader cannot omit or rewrite an application already
          // retained by this store, even if its new decision repeats that omission.
          const known = database
            .prepare(
              "SELECT decision_document FROM identity_correction_receipts WHERE json_extract(decision_document, '$.proposal.correctionId')=? AND decision_id<>?",
            )
            .all(decision.proposal.correctionId, decisionId);
          for (const row of known) {
            const prior = parse(decisionSchema, JSON.parse(row.decision_document));
            same(
              authority.priorDecisions.find((item) => item.decisionId === prior.decisionId),
              prior,
              "Applied decision is absent or changed in retained history",
            );
          }
          const currentRevision = parse(
            revision,
            database.prepare("SELECT revision FROM identity_correction_revision WHERE id=1").get()?.revision,
            "Invalid private attribution revision",
          );
          const previous = database
            .prepare(
              "SELECT decision_document, authorization_document, document FROM identity_correction_receipts WHERE decision_id=?",
            )
            .get(decisionId);
          if (previous) {
            same(
              parse(decisionSchema, JSON.parse(previous.decision_document)),
              decision,
              "Decision ID was already used for different content",
            );
            same(
              parse(authoritySchema.shape.authorization, JSON.parse(previous.authorization_document)),
              authorization,
              "Retained authorization receipt changed",
            );
            const receipt = parse(receiptSchema, JSON.parse(previous.document), "Invalid retained application receipt");
            requireThat(
              receipt.beforeRevision === authorization.attributionRevision,
              409,
              "Retained identity receipt revision mismatch",
            );
            requireThat(
              compareSourceInstants(receipt.appliedAt, decision.reviewedAt) >= 0 &&
                compareSourceInstants(receipt.appliedAt, startedAt) <= 0,
              409,
              "Retained identity receipt application time mismatch",
            );
            const overlay = database
              .prepare("SELECT attribution_revision, document FROM identity_correction_overlays WHERE decision_id=?")
              .get(decisionId);
            requireThat(
              receipt.afterRevision === receipt.beforeRevision + 1 &&
                receipt.afterRevision <= currentRevision &&
                overlay?.attribution_revision === receipt.afterRevision,
              409,
              "Incomplete retained identity application",
            );
            same(JSON.parse(overlay.document), overlayFor(decision, receipt), "Retained identity overlay changed");
            same(
              {
                decisionId: receipt.decisionId,
                correctionId: receipt.correctionId,
                proposalRevision: receipt.proposalRevision,
                proposalSha256: receipt.proposalSha256,
                authorizationReceiptId: receipt.authorizationReceiptId,
                reasonReceiptId: receipt.reasonReceiptId,
              },
              {
                decisionId,
                correctionId: decision.proposal.correctionId,
                proposalRevision: decision.proposal.revision,
                proposalSha256: decision.proposalSha256,
                authorizationReceiptId: decision.authorizationReceiptId,
                reasonReceiptId: decision.reasonReceiptId,
              },
              "Retained identity receipt changed",
            );
            return receipt;
          }
          requireThat(
            authorization.attributionRevision === currentRevision && currentRevision < Number.MAX_SAFE_INTEGER,
            409,
            "Attribution changed; a new review is required",
          );
          for (const assignment of decision.proposal.assignments) {
            const superseded = database
              .prepare(
                "SELECT 1 FROM identity_correction_overlays o, json_each(o.document, '$.assignments') a WHERE json_extract(a.value, '$.contributionId')=? LIMIT 1",
              )
              .get(assignment.contributionId);
            requireThat(!superseded, 409, "Original attribution has already been superseded");
          }
          const receipt = {
            schemaVersion: "leaderboard-private-identity-application/v1",
            decisionId,
            correctionId: decision.proposal.correctionId,
            proposalRevision: decision.proposal.revision,
            proposalSha256: decision.proposalSha256,
            authorityRevision: authority.revision,
            beforeRevision: currentRevision,
            afterRevision: currentRevision + 1,
            appliedAt: startedAt,
            authorizationReceiptId: decision.authorizationReceiptId,
            reasonReceiptId: decision.reasonReceiptId,
            outcome: "applied_private",
          };
          database
            .prepare("INSERT INTO identity_correction_overlays VALUES(?,?,?)")
            .run(decisionId, receipt.afterRevision, JSON.stringify(overlayFor(decision, receipt)));
          database
            .prepare("INSERT INTO identity_correction_receipts VALUES(?,?,?,?)")
            .run(decisionId, JSON.stringify(decision), JSON.stringify(authorization), JSON.stringify(receipt));
          const changed = database
            .prepare("UPDATE identity_correction_revision SET revision=? WHERE id=1 AND revision=?")
            .run(receipt.afterRevision, currentRevision);
          requireThat(changed.changes === 1, 409, "Private attribution revision changed");
          return receipt;
        },
        {
          beforeCommit() {
            const current = read(decisionId);
            same(current, authority, "Protected identity authority changed during application");
            const at = readClock();
            requireThat(compareSourceInstants(at, startedAt) >= 0, 409, "Identity application clock moved backwards");
            validateAuthority(current, decisionId, at);
          },
        },
      );
      return structuredClone(result);
    },
  });
}
