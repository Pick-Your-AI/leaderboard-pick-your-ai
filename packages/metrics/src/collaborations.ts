import { achievementProofSchema, artifactSchema, compareSourceInstants, type Artifact } from "@pick-your-ai/contracts";
import {
  selectAcceptedCollaborationFacts,
  stableJSON,
  type AuditEntry,
  type FrozenInput,
  type MetricFact,
  type MetricPolicy,
  type MetricScope,
} from "./engine.js";

export interface CollaborationPolicy {
  version: "accepted-peer-pairs/v1";
  definitionVersion: string;
  sourcePolicies: readonly MetricPolicy[];
}

/** Original selected source identity and clocks; this projection grants no authority. */
export interface CollaborationProof {
  factId: string;
  canonicalKey: string;
  metricId: string;
  actorId: string;
  role: "author" | "coauthor" | "reviewer";
  occurredAt: string;
  acceptedAt: string;
  observedAt: string;
  revision: number;
}

export interface CollaborationPair {
  artifactId: string;
  repoId: string;
  artifactKind: Artifact["kind"];
  sourceUrl: string;
  relationship: "shared_authorship" | "author_review_pair";
  formedAt: string;
  subject: CollaborationProof;
  peer: CollaborationProof;
}

export interface CollaborationAggregate {
  metricId: "collaborations";
  policyVersion: CollaborationPolicy["version"];
  definitionVersion: string;
  policySignature: string;
  artifactSignature: string;
  scope: MetricScope;
  subjectActorId: string;
  datasetId: string;
  cutoff: string;
  backfillRevision: string;
  value: number | null;
  state: "partial" | "unknown";
  coverage: "incomplete";
  publicEnabled: false;
  rank: null;
  peers: { actorId: string; login: string | null; pairs: CollaborationPair[] }[];
  audit: AuditEntry[];
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const required = (value: unknown, label: string): void => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
};
function dense<T>(values: readonly T[], label: string): T[] {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const captured: T[] = [];
  for (let index = 0; index < values.length; index++) {
    if (!Object.hasOwn(values, index)) throw new Error(`${label} must be dense`);
    captured.push(values[index]!);
  }
  return captured;
}
const ordered = <T extends string>(values: readonly T[]) => [...new Set(values)].sort(compare);
const proof = (fact: MetricFact): CollaborationProof => ({
  factId: fact.id,
  canonicalKey: fact.canonicalKey!,
  metricId: fact.metricId,
  actorId: fact.actorId!,
  role: fact.role as CollaborationProof["role"],
  occurredAt: fact.occurredAt!,
  acceptedAt: fact.acceptedAt!,
  observedAt: fact.observedAt,
  revision: fact.revision,
});
const proofOrder = (a: CollaborationProof, b: CollaborationProof) =>
  compareSourceInstants(a.acceptedAt, b.acceptedAt) ||
  compare(a.factId, b.factId) ||
  compare(a.metricId, b.metricId) ||
  compare(a.canonicalKey, b.canonicalKey) ||
  compare(a.role, b.role) ||
  compare(stableJSON(a), stableJSON(b));
type Participant = { authored?: CollaborationProof; reviewed?: CollaborationProof };

/** Derive one subject's evidenced peers from already authorized frozen sources.
 * This private helper neither collects sources nor publishes a collaborator graph.
 */
export function aggregateCollaborations(
  input: FrozenInput,
  policy: CollaborationPolicy,
  requestedScope: MetricScope,
  subjectActorId: string,
  artifacts: readonly Artifact[],
): CollaborationAggregate {
  if (
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    Object.keys(policy).sort().join(",") !== "definitionVersion,sourcePolicies,version" ||
    policy.version !== "accepted-peer-pairs/v1"
  )
    throw new Error("Unsupported collaboration policy");
  required(policy.definitionVersion, "Definition version");
  required(subjectActorId, "Subject actor ID");
  const sourcePolicies = dense(policy.sourcePolicies, "Source policies").map((source) => ({
    ...source,
    roles: ordered(dense(source.roles, "Source policy roles")),
    sources: ordered(dense(source.sources, "Source policy sources")),
    rankedStates: dense(source.rankedStates, "Source policy evidence classes"),
  }));
  if (!sourcePolicies.length || new Set(sourcePolicies.map((source) => source.metricId)).size !== sourcePolicies.length)
    throw new Error("Select one explicit source policy per metric");
  if (sourcePolicies.some((source) => source.definitionVersion !== policy.definitionVersion))
    throw new Error("Source policies must use the selected definition version");
  // These are derived measures, not original accepted artifact/review sources.
  if (
    sourcePolicies.some((source) =>
      ["collaborations", "repositories", "workstreams", "first_contribution", "active_periods"].includes(
        source.metricId,
      ),
    )
  )
    throw new Error("Collaboration sources must be original accepted activities");
  sourcePolicies.sort((a, b) => compare(a.metricId, b.metricId));

  const manifest = new Map<string, Artifact>();
  const manifestSignatures = new Set<string>();
  for (const supplied of dense(artifacts, "Artifact manifest")) {
    const artifact = artifactSchema.parse(supplied);
    if (
      artifact.visibility === "public" &&
      !achievementProofSchema.shape.sourceUrl.safeParse(artifact.publicUrl).success
    )
      throw new Error("Collaboration artifacts require a safe public GitHub URL");
    const signature = stableJSON(artifact);
    manifestSignatures.add(signature);
    if (artifact.stableId === undefined) continue;
    const previous = manifest.get(artifact.stableId);
    if (previous !== undefined && stableJSON(previous) !== signature)
      throw new Error("Conflicting collaboration artifact identity");
    manifest.set(artifact.stableId, artifact);
  }

  const selected = sourcePolicies.map((source) => selectAcceptedCollaborationFacts(input, source, requestedScope));
  const scope = selected[0]!.scope;
  const audit = selected.flatMap((selection) => selection.audit);
  const actors = new Map(input.actors.map((actor) => [actor.id, actor]));
  const subjectActor = actors.get(subjectActorId);
  const eligibleSubject =
    subjectActor?.kind === "user" &&
    subjectActor.publicState === "visible" &&
    subjectActor.executionMode !== "automated";
  if (!eligibleSubject)
    audit.push({ factIds: [], actorId: subjectActorId, reason: "collaboration_subject_unavailable" });

  const participants = new Map<string, Map<string, Participant>>();
  for (const fact of selected.flatMap((selection) => selection.facts)) {
    const artifact = manifest.get(fact.artifactId!);
    let reason: string | null = null;
    if (!artifact) reason = "collaboration_artifact_missing";
    else if (artifact.repositoryId !== undefined && artifact.repositoryId !== fact.repoId)
      reason = "collaboration_artifact_repository_mismatch";
    else if (artifact.visibility !== "public" || artifact.kind === "unknown" || artifact.repositoryId === undefined)
      reason = "collaboration_artifact_unavailable";
    if (reason) {
      audit.push({ factIds: [fact.id], actorId: fact.actorId, reason });
      continue;
    }
    const people = participants.get(fact.artifactId!) ?? new Map<string, Participant>();
    const person = people.get(fact.actorId!) ?? {};
    const original = proof(fact);
    const slot = original.role === "reviewer" ? "reviewed" : "authored";
    const previous = person[slot];
    if (previous === undefined || proofOrder(original, previous) < 0) person[slot] = original;
    people.set(fact.actorId!, person);
    participants.set(fact.artifactId!, people);
  }

  const peerPairs = new Map<string, CollaborationPair[]>();
  if (eligibleSubject) {
    for (const [artifactId, people] of participants) {
      const subject = people.get(subjectActorId);
      if (!subject) continue;
      const artifact = manifest.get(artifactId)!;
      for (const [peerId, peer] of people) {
        if (peerId === subjectActorId) continue;
        const candidates: CollaborationPair[] = [];
        const add = (
          a: CollaborationProof | undefined,
          b: CollaborationProof | undefined,
          relationship: CollaborationPair["relationship"],
        ) => {
          if (!a || !b) return;
          candidates.push({
            artifactId,
            repoId: artifact.repositoryId!,
            artifactKind: artifact.kind,
            sourceUrl: artifact.publicUrl!,
            relationship,
            formedAt: compareSourceInstants(a.acceptedAt, b.acceptedAt) >= 0 ? a.acceptedAt : b.acceptedAt,
            subject: a,
            peer: b,
          });
        };
        add(subject.authored, peer.authored, "shared_authorship");
        add(subject.authored, peer.reviewed, "author_review_pair");
        add(subject.reviewed, peer.authored, "author_review_pair");
        candidates.sort(
          (a, b) =>
            compareSourceInstants(a.formedAt, b.formedAt) ||
            Number(a.relationship !== "shared_authorship") - Number(b.relationship !== "shared_authorship") ||
            compare(a.subject.factId, b.subject.factId) ||
            compare(a.peer.factId, b.peer.factId) ||
            compare(stableJSON(a), stableJSON(b)),
        );
        const pair = candidates[0];
        if (!pair) continue;
        if (
          (scope.from !== null && compareSourceInstants(pair.formedAt, scope.from) < 0) ||
          compareSourceInstants(pair.formedAt, scope.to) >= 0
        ) {
          audit.push({
            factIds: ordered([pair.subject.factId, pair.peer.factId]),
            actorId: subjectActorId,
            reason: "collaboration_pair_outside_window",
          });
          continue;
        }
        const pairs = peerPairs.get(peerId) ?? [];
        pairs.push(pair);
        peerPairs.set(peerId, pairs);
      }
    }
  }
  const peers = [...peerPairs]
    .sort(([a], [b]) => compare(a, b))
    .map(([actorId, pairs]) => ({
      actorId,
      login: actors.get(actorId)!.login,
      pairs: pairs.sort((a, b) => compare(a.repoId, b.repoId) || compare(a.artifactId, b.artifactId)),
    }));
  const auditMap = new Map(
    audit.map((entry) => {
      const record = { ...entry, factIds: ordered(entry.factIds) };
      return [stableJSON(record), record] as const;
    }),
  );
  return {
    metricId: "collaborations",
    policyVersion: policy.version,
    definitionVersion: policy.definitionVersion,
    policySignature: stableJSON({ ...policy, sourcePolicies }),
    artifactSignature: stableJSON([...manifestSignatures].sort(compare).map((entry) => JSON.parse(entry))),
    scope,
    subjectActorId,
    datasetId: input.datasetId,
    cutoff: input.cutoff,
    backfillRevision: input.backfillRevision,
    value: peers.length ? peers.length : null,
    state: peers.length ? "partial" : "unknown",
    coverage: "incomplete",
    publicEnabled: false,
    rank: null,
    peers,
    audit: [...auditMap].sort(([a], [b]) => compare(a, b)).map(([, entry]) => entry),
  };
}
