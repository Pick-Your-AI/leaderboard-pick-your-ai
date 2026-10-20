import { isDeepStrictEqual } from "node:util";
import { localizationReviewNormalizationVersion } from "@pick-your-ai/github";

const fail = () => {
  throw new Error("localization_review_source_unverified");
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const closed = (value, keys) => object(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const identifier = (value) => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const revision = (value) => typeof value === "string" && value.length === 40 && /^[a-f0-9]+$/.test(value);
const hashValue = (value) => typeof value === "string" && value.length === 64 && /^[a-f0-9]+$/.test(value);
const instant = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const commonKeys = [
  "schemaVersion",
  "repositoryId",
  "artifactId",
  "publicUrl",
  "sourceRevision",
  "headRevision",
  "observedAt",
];
const mergeKeys = [...commonKeys, "pullRequestId", "mergeRevision", "mergedAt", "authorId", "policyVersion", "units"];
const reviewKeys = [...commonKeys, "reviewerId", "authorId", "reviewId", "reviewNodeId", "submittedAt"];

function sourceScope(proof, row) {
  return (
    proof.schemaVersion === localizationReviewNormalizationVersion &&
    proof.repositoryId === String(row.repository_id) &&
    proof.sourceRevision === row.document.sourceRevision &&
    proof.observedAt === new Date(row.observed_at).toISOString() &&
    revision(proof.headRevision) &&
    typeof proof.artifactId === "string" &&
    typeof proof.publicUrl === "string" &&
    identifier(proof.authorId)
  );
}
function user(document, id) {
  return document.actors.some(
    (actor) => actor.id === id && actor.kind === "user" && String(actor.githubDatabaseId) === id,
  );
}
function authorUnit(document, proof, unit) {
  const facts = document.facts.filter((fact) => fact.id === unit.factId);
  const evidence = document.evidence.filter((entry) => entry.contribution.contributionId === unit.factId);
  if (facts.length !== 1 || evidence.length !== 1) return null;
  const fact = facts[0];
  const entry = evidence[0];
  const verified =
    fact.metricId === "localization" &&
    fact.role === "author" &&
    fact.state === "observed" &&
    fact.actorId === proof.authorId &&
    fact.subjectActorId === proof.authorId &&
    fact.artifactId === proof.artifactId &&
    fact.repoId === proof.repositoryId &&
    fact.occurredAt === proof.mergedAt &&
    fact.observedAt === proof.observedAt &&
    fact.rawState === "merged_locale_participation:" + unit.locale + ":" + unit.category &&
    entry.artifact.stableId === proof.artifactId &&
    entry.artifact.repositoryId === proof.repositoryId &&
    entry.artifact.kind === "pull_request" &&
    entry.artifact.publicUrl === proof.publicUrl &&
    entry.sourceRevision === proof.mergeRevision &&
    entry.sourceRevisionUrl === proof.publicUrl.replace(/\/pull\/[1-9][0-9]*$/, "/commit/" + proof.mergeRevision) &&
    entry.occurredAt === proof.mergedAt &&
    entry.contribution.actorId === proof.authorId &&
    isDeepStrictEqual(entry.contribution.roles, ["author"]) &&
    isDeepStrictEqual(entry.contribution.metricIds, ["localization"]) &&
    [
      "documentation_path_policy:" + proof.policyVersion,
      "locale:" + unit.locale,
      "localization_category:" + unit.category,
    ].every((reason) => entry.contribution.reasonCodes.includes(reason));
  return verified ? { fact, evidence: entry } : null;
}

/** Store only closed private source proof. A provider cannot directly submit the
 * derived reviewer locale fact, even by copying a valid author normalization.
 */
export function privateLocalizationReviewMetadata(output, row, enabled) {
  const merge = output.localizationMergeSource;
  const review = output.localizationReviewSource;
  if (!enabled) {
    if (merge !== undefined || review !== undefined) fail();
    return {};
  }
  const selected = ["pull_requests", "reviews"].includes(row.family);
  if (
    output.facts.some((fact) => fact.metricId === "localization" && fact.role === "reviewer") ||
    (!selected && (merge !== undefined || review !== undefined))
  )
    fail();
  if (!selected) return {};
  if (merge !== undefined) {
    if (
      row.family !== "pull_requests" ||
      !closed(merge, mergeKeys) ||
      !sourceScope(merge, row) ||
      !Number.isSafeInteger(merge.pullRequestId) ||
      merge.pullRequestId < 1 ||
      ![merge.artifactId, String(merge.pullRequestId)].includes(row.document.subjectId) ||
      row.document.sourceUrl !== merge.publicUrl ||
      !revision(merge.mergeRevision) ||
      !instant(merge.mergedAt) ||
      merge.mergedAt > merge.observedAt ||
      !user(output, merge.authorId) ||
      typeof merge.policyVersion !== "string" ||
      !Array.isArray(merge.units) ||
      merge.units.length < 1 ||
      merge.units.length > 32 ||
      new Set(merge.units.map((unit) => JSON.stringify([unit?.locale, unit?.category]))).size !== merge.units.length ||
      merge.units.some(
        (unit) =>
          !closed(unit, ["factId", "locale", "category"]) ||
          typeof unit.locale !== "string" ||
          typeof unit.category !== "string" ||
          !authorUnit(output, merge, unit),
      )
    )
      fail();
  }
  if (review !== undefined) {
    if (
      row.family !== "reviews" ||
      !closed(review, reviewKeys) ||
      !sourceScope(review, row) ||
      !identifier(review.reviewerId) ||
      review.reviewerId === review.authorId ||
      !identifier(review.reviewId) ||
      (review.reviewNodeId !== null && typeof review.reviewNodeId !== "string") ||
      ![review.reviewId, review.reviewNodeId].includes(row.document.subjectId) ||
      row.document.sourceUrl !== review.publicUrl + "#pullrequestreview-" + review.reviewId ||
      !instant(review.submittedAt) ||
      review.submittedAt > review.observedAt ||
      !user(output, review.reviewerId) ||
      !user(output, review.authorId) ||
      !output.facts.some(
        (fact) =>
          fact.metricId === "review_rounds" &&
          fact.role === "reviewer" &&
          fact.state === "observed" &&
          fact.actorId === review.reviewerId &&
          fact.subjectActorId === review.authorId &&
          fact.artifactId === review.artifactId &&
          fact.repoId === review.repositoryId &&
          fact.occurredAt === review.submittedAt &&
          fact.observedAt === review.observedAt &&
          fact.rawState === "submitted_head:" + review.headRevision,
      )
    )
      fail();
  }
  return {
    localizationReviewNormalizationVersion,
    ...(merge === undefined ? {} : { localizationMergeSource: structuredClone(merge) }),
    ...(review === undefined ? {} : { localizationReviewSource: structuredClone(review) }),
  };
}

const empty = () => ({
  facts: [],
  actors: [],
  evidence: [],
  capture: { schemaVersion: localizationReviewNormalizationVersion, bindings: [] },
});

/** The caller supplies selected current sources from one frozen observation
 * cutoff. Native scan identity is required only when selecting a new review;
 * a retained capture later restores those exact immutable source/hash pairs.
 */
export function materializeLocalizationReviews(entries, policies, digest) {
  const output = empty();
  const merges = new Map();
  const units = new Set();
  for (const entry of entries) {
    const proof = entry.document.localizationMergeSource;
    if (!proof || !entry.selectedCurrentState || entry.relationshipPairFactHashes !== undefined) continue;
    const policy = policies.find((item) => String(item.repositoryId) === proof.repositoryId);
    if (
      entry.family !== "pull_requests" ||
      entry.document.localizationReviewNormalizationVersion !== localizationReviewNormalizationVersion ||
      !policy ||
      policy.version !== proof.policyVersion ||
      proof.units.some(
        (unit) =>
          !policy.localizationPaths?.some((item) => item.locale === unit.locale && item.category === unit.category),
      )
    )
      fail();
    const key = JSON.stringify([proof.repositoryId, proof.artifactId]);
    if (merges.has(key)) fail();
    merges.set(key, entry);
  }
  for (const entry of entries) {
    const review = entry.document.localizationReviewSource;
    if (
      !review ||
      !entry.selectedCurrentState ||
      !entry.reviewSequenceObserved ||
      entry.relationshipPairFactHashes !== undefined
    )
      continue;
    if (
      entry.family !== "reviews" ||
      entry.document.localizationReviewNormalizationVersion !== localizationReviewNormalizationVersion
    )
      fail();
    const mergeEntry = merges.get(JSON.stringify([review.repositoryId, review.artifactId]));
    if (!mergeEntry) continue;
    const merge = mergeEntry.document.localizationMergeSource;
    if (
      review.headRevision !== merge.headRevision ||
      review.publicUrl !== merge.publicUrl ||
      review.authorId !== merge.authorId ||
      review.submittedAt > merge.mergedAt
    )
      continue;
    for (const unit of merge.units) {
      const original = authorUnit(mergeEntry.document, merge, unit);
      if (!original) fail();
      const unitKey = [review.repositoryId, review.artifactId, review.reviewerId, unit.locale, unit.category];
      const key = JSON.stringify(unitKey);
      if (units.has(key)) fail();
      units.add(key);
      const canonicalKey = "gh:" + digest([localizationReviewNormalizationVersion, ...unitKey, review.reviewId]);
      const id = "gh:" + digest(["fact", canonicalKey]);
      const observedAt = [merge.observedAt, review.observedAt].sort().at(-1);
      output.facts.push({
        id,
        canonicalKey,
        metricId: "localization",
        actorId: review.reviewerId,
        artifactId: merge.artifactId,
        repoId: merge.repositoryId,
        role: "reviewer",
        state: "observed",
        occurredAt: merge.mergedAt,
        acceptedAt: null,
        observedAt,
        revision: 0,
        correctionReceipt: null,
        acceptanceReceipt: null,
        acceptedBy: null,
        subjectActorId: merge.authorId,
        eventContext: structuredClone(original.fact.eventContext),
        currentContext: structuredClone(original.fact.currentContext),
        rawState: "merged_locale_review_participation:" + unit.locale + ":" + unit.category,
      });
      output.evidence.push({
        artifact: structuredClone(original.evidence.artifact),
        contribution: {
          schemaVersion: "leaderboard/v1",
          contributionId: id,
          canonicalEventId: canonicalKey,
          artifactId: merge.artifactId,
          actorId: review.reviewerId,
          roles: ["reviewer"],
          qualification: "eligible",
          metricIds: ["localization"],
          reasonCodes: [
            "raw_observed_only",
            "documentation_path_policy:" + merge.policyVersion,
            "locale:" + unit.locale,
            "localization_category:" + unit.category,
          ],
        },
        occurredAt: merge.mergedAt,
        sourceRevision: merge.mergeRevision,
        sourceRevisionUrl: original.evidence.sourceRevisionUrl,
      });
      output.capture.bindings.push({
        factId: id,
        merge: { factKey: mergeEntry.source.factKey, documentHash: digest(mergeEntry.document) },
        review: { factKey: entry.source.factKey, documentHash: digest(entry.document) },
      });
    }
  }
  output.capture.bindings.sort((left, right) => left.factId.localeCompare(right.factId));
  return output;
}

/** Called only after the existing locked, bounded normalization read and hash
 * checks. Both original dependencies must still be available; no author record,
 * receipt actor, or newly hydrated review can repair a missing captured source.
 */
export function assertLocalizationReviewCapture(capture, rows, policies, digest) {
  if (
    !closed(capture, ["schemaVersion", "bindings"]) ||
    capture.schemaVersion !== localizationReviewNormalizationVersion ||
    !Array.isArray(capture.bindings) ||
    capture.bindings.length > rows.length * 32 ||
    new Set(capture.bindings.map((entry) => entry?.factId)).size !== capture.bindings.length
  )
    fail();
  const selected = new Map();
  for (const binding of capture.bindings) {
    if (!closed(binding, ["factId", "merge", "review"]) || typeof binding.factId !== "string") fail();
    for (const [role, family] of [
      ["merge", "pull_requests"],
      ["review", "reviews"],
    ]) {
      const source = binding[role];
      if (!closed(source, ["factKey", "documentHash"]) || !hashValue(source.factKey) || !hashValue(source.documentHash))
        fail();
      const matches = rows.filter(
        (row) => row.fact_key === source.factKey && row.document_hash === source.documentHash,
      );
      if (!matches.length || matches.some((row) => row.family !== family)) fail();
      const row = matches[0];
      if (row.document.localizationReviewNormalizationVersion !== localizationReviewNormalizationVersion) fail();
      selected.set(source.factKey, {
        document: row.document,
        family,
        source: { factKey: source.factKey },
        selectedCurrentState: true,
        reviewSequenceObserved: true,
      });
    }
  }
  const restored = materializeLocalizationReviews([...selected.values()], policies, digest);
  if (!isDeepStrictEqual(restored.capture, capture)) fail();
  return restored;
}
