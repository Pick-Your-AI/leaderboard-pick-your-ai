import { pinnedSha } from "@pick-your-ai/github";

// Serialization changes must invalidate normalization caches, including documents
// produced before these private fields were retained. This is not a metric policy.
export const normalizationDocumentVersion = "pipeline-private-attribution/v1";

const fail = () => {
  throw new Error("invalid_private_attribution");
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_=.:-]{1,200}$/.test(value);
const label = (value) => {
  if (typeof value !== "string" || !value.trim() || value.length > 100 || /[\p{Cc}\p{Cf}<>@]/u.test(value)) fail();
  return value.trim();
};
const bounded = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) fail();
  return value;
};

/** Private artifact metadata only: never an actor, execution claim or credit. */
export function privateAttribution(output, source) {
  const artifacts = new Set([source.subject_id, ...output.evidence.map((entry) => entry.artifact.artifactId)]);
  // The provider uses these stable IDs when GitHub omits a node ID. Preserve
  // metadata even for a commit that has no verified integration/metric fact.
  const kind = { issues: "issue", pull_requests: "pull_request", commits: "commit", releases: "release" }[
    source.family
  ];
  if (kind && /^[1-9]\d*$/.test(source.subject_id)) artifacts.add(`github:${kind}:${source.subject_id}`);
  if (kind === "commit" && pinnedSha(source.subject_id))
    artifacts.add(`github:commit:${source.repository_id}:${source.subject_id}`);
  const actors = new Set(output.actors.map((actor) => actor.id));
  const boundArtifact = (entry) => {
    if (!object(entry) || !identifier(entry.artifactId) || !artifacts.has(entry.artifactId)) fail();
    return entry.artifactId;
  };
  return {
    assistance: bounded(output.assistance).map((entry) => ({
      artifactId: boundArtifact(entry),
      model: label(entry.model),
      version: entry.version === null ? null : label(entry.version),
    })),
    participation: bounded(output.participation).map((entry) => {
      const artifactId = boundArtifact(entry);
      if (
        typeof entry.actorId !== "string" ||
        !/^[1-9]\d{0,19}$/.test(entry.actorId) ||
        !actors.has(entry.actorId) ||
        !["author", "committer", "coauthor"].includes(entry.role) ||
        ![artifactId, `${artifactId}:merged`].includes(entry.conservedUnit)
      )
        fail();
      return { artifactId, actorId: entry.actorId, role: entry.role, conservedUnit: entry.conservedUnit };
    }),
  };
}
