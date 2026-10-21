import { createHash } from "node:crypto";
import { compareSourceInstants, publicEvidenceMetadataSchema } from "@pick-your-ai/contracts";
import { applyCurrentProjectContexts } from "./project-context.mjs";
import { parseDecisionProjection, pullRequestDecidedProjectionVersion } from "./pull-request-decision-history.mjs";

const fail = () => {
  throw new Error("decision_history_projection_binding_changed");
};
const canonical = (value) =>
  value && typeof value === "object"
    ? Array.isArray(value)
      ? value.map(canonical)
      : Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
    : value;
const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const sameTime = (left, right) => compareSourceInstants(left, right) === 0;

/** The caller supplies rows admitted by readDecisionGenerations, never a host
 * receipt callback or an inferred current REST state. Ordinary normalization
 * supplies the separately validated public artifact and numeric author binding.
 */
export function projectDecidedPullRequests(decision, normalizations, asOf) {
  if (!decision || compareSourceInstants(asOf, decision.capture.asOf) > 0) fail();
  const bySource = new Map();
  for (const row of normalizations) {
    const key = row.source?.factKey ?? row.fact_key;
    const previous = bySource.get(key);
    if (previous && digest(previous) !== digest(row.document)) fail();
    bySource.set(key, row.document);
  }
  const facts = [];
  const evidence = [];
  const units = new Set();
  let unavailable = 0;
  for (const entry of decision.selections) {
    const { selection, source } = entry;
    if (selection.status === "unavailable") {
      unavailable++;
      continue;
    }
    if (selection.status === "not_yet_created") continue;
    if (
      selection.status !== "selected" ||
      selection.asOf !== asOf ||
      selection.cutoffMode !== "exclusive" ||
      units.has(selection.unitKey)
    )
      fail();
    units.add(selection.unitKey);
    const document = bySource.get(entry.factKey);
    const opened = document?.facts.filter(
      (fact) =>
        fact.metricId === "pr_opened" &&
        fact.repoId === String(entry.repositoryId) &&
        fact.artifactId === source.subjectId &&
        fact.role === "author",
    );
    // Missing source authors or an unavailable ordinary normalizer do not turn
    // a complete native timeline into a credited pending/decided unit.
    if (source.author === null || !opened?.length) {
      unavailable++;
      continue;
    }
    if (opened.length !== 1) fail();
    const original = opened[0];
    const actorId = String(source.author.databaseId);
    const actor = document.actors.find((value) => value.id === actorId);
    const proof = document.evidence.find((value) => value.contribution.contributionId === original.id);
    if (
      selection.authorId !== source.author.id ||
      original.actorId !== actorId ||
      original.subjectActorId !== actorId ||
      original.state !== "observed" ||
      original.revision !== 0 ||
      original.occurredAt === null ||
      !sameTime(original.occurredAt, source.createdAt) ||
      !actor ||
      actor.githubDatabaseId !== source.author.databaseId ||
      actor.githubNodeId !== source.author.id ||
      !proof ||
      proof.artifact.stableId !== source.subjectId ||
      proof.artifact.repositoryId !== String(entry.repositoryId) ||
      proof.artifact.kind !== "pull_request" ||
      proof.artifact.visibility !== "public" ||
      proof.artifact.publicUrl !== source.sourceUrl ||
      proof.contribution.actorId !== actorId ||
      proof.sourceRevision !== source.sourceRevision
    )
      fail();
    const pending = selection.outcome === "pending";
    if (
      !["merged", "closed_unmerged", "pending"].includes(selection.outcome) ||
      (pending ? selection.decisionAt !== null : selection.decisionAt === null) ||
      (!pending && compareSourceInstants(selection.decisionAt, asOf) >= 0)
    )
      fail();
    const canonicalKey = digest([pullRequestDecidedProjectionVersion, selection.unitKey, actorId]);
    const fact = {
      id: digest([canonicalKey, asOf, selection.proofDigest]),
      canonicalKey,
      metricId: "pr_accepted_rate",
      actorId,
      artifactId: source.subjectId,
      repoId: String(entry.repositoryId),
      role: "author",
      state: pending ? "pending" : "observed",
      occurredAt: pending ? source.createdAt : selection.decisionAt,
      acceptedAt: selection.decisionAt,
      observedAt: source.observedAt,
      revision: 0,
      correctionReceipt: null,
      acceptanceReceipt: null,
      acceptedBy: null,
      subjectActorId: actorId,
      // Current membership is not proof of membership at the decision event.
      eventContext: null,
      currentContext: structuredClone(original.currentContext),
      outcome: selection.outcome,
      decisionAsOf: asOf,
    };
    facts.push(fact);
    evidence.push({
      artifact: structuredClone(proof.artifact),
      contribution: {
        ...structuredClone(proof.contribution),
        contributionId: fact.id,
        canonicalEventId: canonicalKey,
        roles: ["author"],
        qualification: "eligible",
        metricIds: ["pr_accepted_rate"],
        reasonCodes: ["raw_observed_only"],
      },
      occurredAt: fact.occurredAt,
      sourceRevision: source.sourceRevision,
      sourceRevisionUrl: null,
      evidenceMetadata: publicEvidenceMetadataSchema.parse({
        schemaVersion: "leaderboard-evidence/v1",
        artifactTitle: proof.evidenceMetadata?.artifactTitle ?? null,
        sourceAction: pending ? "unknown" : "pull_request_" + selection.outcome,
        sourceOccurredAt: fact.occurredAt,
        observedAt: fact.observedAt,
        activityState: fact.state,
        acceptedAt: null,
        // A compact outcome does not publish or certify the private timeline.
        history: { coverage: "not_supplied", records: [] },
      }),
    });
  }
  return {
    facts: applyCurrentProjectContexts(
      facts,
      normalizations.map((row) => row.document),
    ),
    evidence,
    unavailable,
  };
}

export function decisionProjectionBinding(capture, asOf, facts) {
  return parseDecisionProjection(
    {
      schemaVersion: pullRequestDecidedProjectionVersion,
      asOf,
      captureHash: digest(capture),
      factHashes: facts
        .filter((fact) => fact.decisionAsOf !== undefined && fact.revision === 0)
        .map(digest)
        .sort(),
    },
    capture,
  );
}

/** Frozen base facts must reproduce the original native selection. Source
 * suppression can omit a unit; it cannot replace one with a different outcome.
 * Existing reviewed correction revisions keep their independent admission.
 */
export function assertDecisionProjection(input, decision, normalizations, projection) {
  const binding = parseDecisionProjection(projection, decision.capture);
  const expected = projectDecidedPullRequests(decision, normalizations, binding.asOf);
  const hashes = new Set(expected.facts.map(digest));
  const repositories = new Set(decision.capture.runs.map((run) => String(run.repositoryId)));
  const facts = input.facts.filter(
    (fact) => fact.metricId === "pr_accepted_rate" && repositories.has(fact.repoId) && fact.revision === 0,
  );
  if (
    facts.some((fact) => fact.decisionAsOf !== binding.asOf || !hashes.has(digest(fact))) ||
    JSON.stringify(facts.map(digest).sort()) !== JSON.stringify(binding.factHashes)
  )
    fail();
}
