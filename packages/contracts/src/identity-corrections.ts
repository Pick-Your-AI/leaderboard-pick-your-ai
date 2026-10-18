import { z } from "zod";
import { contributionRoleSchema } from "./v1/schemas.js";
import { compareSourceInstants } from "./v1/source-time.js";

/** Private review records; parsing is not proof verification or permission to apply a correction. */
export const verifiedIdentityCorrectionVersion = "leaderboard-verified-identity-correction/v1" as const;

const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const instant = z.string().datetime({ offset: true });
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const verifiedGithubIdentitySchema = z
  .object({
    actorId: z.string().regex(/^[1-9][0-9]{0,15}$/),
    githubDatabaseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    githubNodeId: z.string().min(1).max(255).regex(/^\S+$/),
    providerKind: z.enum(["user", "bot", "github_app", "organization"]),
  })
  .strict()
  .refine((identity) => identity.actorId === String(identity.githubDatabaseId), {
    message: "The serving actor ID must match the verified GitHub database ID",
    path: ["actorId"],
  });

type Identity = z.infer<typeof verifiedGithubIdentitySchema>;

function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function consistentIdentities(identities: Identity[]): boolean {
  const byActor = new Map<string, Identity>();
  const byNode = new Map<string, Identity>();
  for (const identity of identities) {
    for (const previous of [byActor.get(identity.actorId), byNode.get(identity.githubNodeId)]) {
      if (
        previous &&
        (previous.actorId !== identity.actorId ||
          previous.githubNodeId !== identity.githubNodeId ||
          previous.providerKind !== identity.providerKind)
      )
        return false;
    }
    byActor.set(identity.actorId, identity);
    byNode.set(identity.githubNodeId, identity);
  }
  return true;
}

const identities = z
  .array(verifiedGithubIdentitySchema)
  .min(1)
  .max(32)
  .refine((items) => unique(items.map((item) => item.actorId)), "Duplicate actor identity");
const references = z.array(reference).max(256).refine(unique, "Duplicate reference");

const proofSchema = z
  .object({
    evidenceId: reference,
    kind: z.enum(["account_control", "consent", "source_attribution"]),
    subjectActorIds: references.refine((items) => items.length > 0, "An evidence subject is required"),
    contributionIds: references,
    recordedAt: instant,
    expiresAt: instant.nullable(),
  })
  .strict();

const assignmentSchema = z
  .object({
    contributionId: reference,
    sourceEventId: reference,
    sourceRevision: reference,
    sourceAttributionSha256: digest,
    role: contributionRoleSchema,
    sourceActorId: reference,
    resultActorId: reference,
    evidenceIds: references.refine((items) => items.length > 0, "Source attribution evidence is required"),
  })
  .strict();

/** A complete proposed scope. Evidence IDs resolve only in the protected authority store. */
export const verifiedIdentityCorrectionProposalSchema = z
  .object({
    schemaVersion: z.literal(verifiedIdentityCorrectionVersion),
    correctionId: reference,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    kind: z.enum(["link", "merge", "split"]),
    authorityBasis: z.enum(["verified_account_control", "reviewed_source_attribution"]),
    requester: verifiedGithubIdentitySchema,
    preparedAt: instant,
    policyVersion: reference,
    sourceActors: identities,
    resultActors: identities,
    assignments: z.array(assignmentSchema).max(256),
    proofs: z.array(proofSchema).min(1).max(256),
  })
  .strict()
  .superRefine((proposal, context) => {
    const fail = (message: string, path: (string | number)[] = []) =>
      context.addIssue({ code: "custom", message, path });
    const actors = [...proposal.sourceActors, ...proposal.resultActors];
    const sourceIds = new Set(proposal.sourceActors.map((actor) => actor.actorId));
    const resultIds = new Set(proposal.resultActors.map((actor) => actor.actorId));
    const affectedIds = new Set(actors.map((actor) => actor.actorId));
    if (!consistentIdentities([proposal.requester, ...actors])) fail("Conflicting stable provider identities");
    if (!unique(proposal.assignments.map((assignment) => assignment.contributionId))) {
      fail("A contribution may be assigned only once", ["assignments"]);
    }
    if (!unique(proposal.proofs.map((proof) => proof.evidenceId))) fail("Duplicate evidence ID", ["proofs"]);
    const proofs = new Map(proposal.proofs.map((proof) => [proof.evidenceId, proof]));
    const contributionIds = new Set(proposal.assignments.map((assignment) => assignment.contributionId));
    for (const [index, proof] of proposal.proofs.entries()) {
      if (proof.subjectActorIds.some((id) => !affectedIds.has(id))) fail("Unknown evidence subject", ["proofs", index]);
      if (compareSourceInstants(proof.recordedAt, proposal.preparedAt) > 0)
        fail("Evidence postdates the proposal", ["proofs", index]);
      if (proof.expiresAt && compareSourceInstants(proof.expiresAt, proposal.preparedAt) <= 0)
        fail("Evidence is expired at proposal time", ["proofs", index]);
      if (proof.kind === "source_attribution") {
        if (!proof.contributionIds.length || proof.contributionIds.some((id) => !contributionIds.has(id))) {
          fail("Attribution evidence must identify exact proposed contributions", ["proofs", index]);
        }
      } else if (proof.contributionIds.length) {
        fail("Account evidence cannot substitute for contribution attribution", ["proofs", index]);
      }
      if (proof.kind === "account_control" && proof.expiresAt === null) {
        fail("Account-control verification must have a bounded validity period", ["proofs", index]);
      }
    }
    if (proposal.kind === "link") {
      if (
        proposal.authorityBasis !== "verified_account_control" ||
        sourceIds.size < 2 ||
        sourceIds.size !== resultIds.size ||
        [...sourceIds].some((id) => !resultIds.has(id)) ||
        proposal.assignments.length
      ) {
        fail("A link requires verified control of at least two preserved accounts and cannot move contributions");
      }
    } else {
      if (!proposal.assignments.length) fail("A merge or split requires exact contribution assignments");
      if (
        proposal.kind === "merge" &&
        (sourceIds.size < 2 || resultIds.size !== 1 || !sourceIds.has(proposal.resultActors[0]!.actorId))
      ) {
        fail("A merge requires multiple source accounts and one existing source account as its target");
      }
      if (proposal.kind === "split" && (sourceIds.size !== 1 || resultIds.size < 2)) {
        fail("A split requires one source account and multiple resulting accounts");
      }
      for (const id of sourceIds) {
        if (!resultIds.has(id) && !proposal.assignments.some((assignment) => assignment.sourceActorId === id))
          fail("An unused source account is outside the correction scope");
      }
      for (const id of resultIds) {
        if (!sourceIds.has(id) && !proposal.assignments.some((assignment) => assignment.resultActorId === id))
          fail("An unused target account is outside the correction scope");
      }
    }
    for (const [index, assignment] of proposal.assignments.entries()) {
      if (
        !sourceIds.has(assignment.sourceActorId) ||
        !resultIds.has(assignment.resultActorId) ||
        assignment.sourceActorId === assignment.resultActorId
      ) {
        fail("An assignment must move one scoped contribution between distinct affected accounts", [
          "assignments",
          index,
        ]);
      }
      if (assignment.evidenceIds.some((id) => !proofs.has(id)))
        fail("Unknown assignment evidence", ["assignments", index]);
      if (
        !assignment.evidenceIds.some((id) => {
          const proof = proofs.get(id);
          return (
            proof?.kind === "source_attribution" &&
            proof.contributionIds.includes(assignment.contributionId) &&
            proof.subjectActorIds.includes(assignment.sourceActorId) &&
            proof.subjectActorIds.includes(assignment.resultActorId)
          );
        })
      )
        fail("Each assignment requires attribution evidence covering its original and resulting actor", [
          "assignments",
          index,
        ]);
    }
    if (proposal.authorityBasis === "verified_account_control") {
      for (const id of affectedIds) {
        for (const kind of ["account_control", "consent"] as const) {
          if (!proposal.proofs.some((proof) => proof.kind === kind && proof.subjectActorIds.includes(id))) {
            fail(`Every affected account requires ${kind} evidence`, ["proofs"]);
          }
        }
      }
    }
  });

const priorReviewSchema = z.object({ decisionId: reference, reviewer: verifiedGithubIdentitySchema }).strict();

/** An append-only decision; actual authority, proof contents and history must be resolved before use. */
export const verifiedIdentityCorrectionDecisionSchema = z
  .object({
    schemaVersion: z.literal(verifiedIdentityCorrectionVersion),
    decisionId: reference,
    proposal: verifiedIdentityCorrectionProposalSchema,
    proposalSha256: digest,
    outcome: z.enum(["accepted", "rejected", "needs_information", "reversed"]),
    reviewer: verifiedGithubIdentitySchema,
    authorizationReceiptId: reference,
    reasonReceiptId: reference,
    reviewedAt: instant,
    priorReviews: z.array(priorReviewSchema).max(64),
    reversesDecisionId: reference.nullable(),
  })
  .strict()
  .superRefine((decision, context) => {
    const fail = (message: string) => context.addIssue({ code: "custom", message });
    const proposal = decision.proposal;
    const involved = [
      proposal.requester,
      ...proposal.sourceActors,
      ...proposal.resultActors,
      ...decision.priorReviews.map((review) => review.reviewer),
    ];
    if (!consistentIdentities([...involved, decision.reviewer]))
      fail("Conflicting stable provider identities in review history");
    if (
      involved.some(
        (identity) =>
          identity.actorId === decision.reviewer.actorId || identity.githubNodeId === decision.reviewer.githubNodeId,
      )
    ) {
      fail("The reviewer must be independent of the requester, affected accounts and every previous reviewer");
    }
    if (
      !unique(decision.priorReviews.map((review) => review.decisionId)) ||
      decision.priorReviews.some((review) => review.decisionId === decision.decisionId)
    ) {
      fail("Review history must contain unique earlier decisions");
    }
    if (compareSourceInstants(decision.reviewedAt, proposal.preparedAt) < 0) fail("Review cannot predate its proposal");
    if (
      decision.outcome === "accepted" &&
      proposal.proofs.some(
        (proof) => proof.expiresAt !== null && compareSourceInstants(proof.expiresAt, decision.reviewedAt) <= 0,
      )
    ) {
      fail("Acceptance requires evidence still valid at review time");
    }
    if (decision.outcome === "reversed") {
      if (
        !decision.reversesDecisionId ||
        !decision.priorReviews.some((review) => review.decisionId === decision.reversesDecisionId)
      )
        fail("Reversal must reference an earlier reviewed decision");
    } else if (decision.reversesDecisionId !== null) {
      fail("Only a reversal may name a reversed decision");
    }
  });

export type VerifiedGithubIdentity = z.infer<typeof verifiedGithubIdentitySchema>;
export type VerifiedIdentityCorrectionProposal = z.infer<typeof verifiedIdentityCorrectionProposalSchema>;
export type VerifiedIdentityCorrectionDecision = z.infer<typeof verifiedIdentityCorrectionDecisionSchema>;
