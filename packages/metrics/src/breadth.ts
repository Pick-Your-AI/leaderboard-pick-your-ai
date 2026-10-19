import { compareSourceInstants, sourceEventSchema } from "@pick-your-ai/contracts";
import {
  selectAcceptedActivityFacts,
  stableJSON,
  type AuditEntry,
  type FrozenInput,
  type MetricFact,
  type MetricPolicy,
  type MetricScope,
} from "./engine.js";
import { getMetricDefinition } from "./v1/index.js";

export interface ActivityBreadthPolicy {
  version: string;
  definitionVersion: string;
  /** Explicit already qualified source policies; no universal activity policy is inferred. */
  sourcePolicies: readonly MetricPolicy[];
}

/** Protected, source-verified lineage captured with the same frozen input.
 * This marker is not authentication; a caller must not construct it from public
 * payload text, repository names, fork flags or a guessed shared commit.
 */
export interface ActivityBreadthLineage {
  verified: true;
  relation: "squash_of" | "cherry_pick_of" | "mirror_of" | "imported_from" | "reverted_by" | "transferred_to";
  sourceIds: readonly string[];
  targetId: string;
  evidenceIds: readonly string[];
  observedAt: string;
}

export interface ActivityBreadthRow {
  actorId: string;
  login: string | null;
  value: number | null;
  state: "measured" | "partial" | "zero" | "unknown";
  /** Internal attribution: each distinct unit retains every selected source proof. */
  units: Array<{ id: string; evidenceIds: string[] }>;
  evidenceIds: string[];
  /** Unknown or incompletely mapped event contexts never become an invented ID or zero. */
  unknownEvidenceIds: string[];
  rank: null;
}

export interface ActivityBreadthAggregate {
  metricId: "repositories" | "workstreams";
  unit: string;
  policyVersion: string;
  policySignature: string;
  definitionVersion: string;
  sourcePolicySignatures: string[];
  /** Private replay binding for supplied lineage; not a public source projection. */
  lineageSignature: string;
  evidenceClass: "qualified" | "reviewed";
  datasetId: string;
  cutoff: string;
  backfillRevision: string;
  scope: MetricScope;
  coverage: "complete" | "incomplete";
  publicEnabled: false;
  rows: ActivityBreadthRow[];
  /** Internal only: audit can identify suppressed or otherwise excluded source facts. */
  audit: AuditEntry[];
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const unique = (values: readonly string[]) => [...new Set(values)].sort(compare);
const required = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
function ownIdentifiers(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const identifiers: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return null;
    const id: unknown = value[index];
    if (!required(id) || seen.has(id)) return null;
    identifiers.push(id);
    seen.add(id);
  }
  return identifiers;
}
const relations = new Set([
  "squash_of",
  "cherry_pick_of",
  "mirror_of",
  "imported_from",
  "reverted_by",
  "transferred_to",
]);

/** Derive descriptive breadth from actual accepted source units, never metric-ID relabeling.
 * The caller supplies authenticated, currently authorized source facts and the
 * complete retained lineage for this capture, as it does for engine receipts.
 * No public projection, cache, policy activation or contributor pair is created.
 */
export function aggregateActivityBreadth(
  input: FrozenInput,
  policy: ActivityBreadthPolicy,
  requestedScope: MetricScope,
  lineage: readonly ActivityBreadthLineage[],
): { repositories: ActivityBreadthAggregate; workstreams: ActivityBreadthAggregate } {
  if (
    !required(policy.version) ||
    !required(policy.definitionVersion) ||
    !Array.isArray(policy.sourcePolicies) ||
    !policy.sourcePolicies.length ||
    new Set(policy.sourcePolicies.map((source) => source.metricId)).size !== policy.sourcePolicies.length ||
    policy.sourcePolicies.some((source) => source.definitionVersion !== policy.definitionVersion) ||
    new Set(policy.sourcePolicies.map((source) => source.rankedStates[0])).size !== 1
  )
    throw new Error("Breadth requires unique source policies with one definition and accepted evidence class");
  const sourcePolicies = [...policy.sourcePolicies].sort((a, b) => compare(a.metricId, b.metricId));
  const selections = sourcePolicies.map((source) => selectAcceptedActivityFacts(input, source, requestedScope));
  const scope = selections[0]!.scope;
  if (!Array.isArray(lineage)) throw new Error("Explicit frozen lineage is required for activity breadth");
  const copies = new Set<string>();
  const retainedLineage: ActivityBreadthLineage[] = [];
  for (const link of lineage) {
    if (!link || link.verified !== true || !relations.has(link.relation) || !required(link.targetId))
      throw new Error("Source-verified lineage identity, evidence and observation time are required");
    const sourceIds = ownIdentifiers(link.sourceIds);
    const evidenceIds = ownIdentifiers(link.evidenceIds);
    if (
      sourceIds === null ||
      sourceIds.includes(link.targetId) ||
      evidenceIds === null ||
      !sourceEventSchema.shape.observedAt.safeParse(link.observedAt).success
    )
      throw new Error("Source-verified lineage identity, evidence and observation time are required");
    if (compareSourceInstants(link.observedAt, input.cutoff) > 0) continue;
    retainedLineage.push({ ...link, sourceIds: unique(sourceIds), evidenceIds: unique(evidenceIds) });
    // Sources retain their original attribution. Only the explicit copy target
    // is excluded; an independent cherry-pick, revert or transfer is not a mirror.
    if (link.relation === "mirror_of" || link.relation === "imported_from") copies.add(link.targetId);
  }
  const audit = selections.flatMap((selection) => selection.audit);
  const byActor = new Map<string, MetricFact[]>();
  const seenFacts = new Set<string>();
  for (const fact of selections.flatMap((selection) => selection.facts)) {
    if (seenFacts.has(fact.id)) throw new Error("Accepted source fact identity conflicts across policies");
    seenFacts.add(fact.id);
    const bucket = byActor.get(fact.actorId!) ?? [];
    if (copies.has(fact.artifactId!)) {
      audit.push({ factIds: [fact.id], actorId: fact.actorId, reason: "mirrored_or_imported_copy" });
    } else bucket.push(fact);
    byActor.set(fact.actorId!, bucket);
  }
  const sourceComplete = selections.every((selection) => selection.complete);
  const actorById = new Map(input.actors.map((actor) => [actor.id, actor]));
  const sourcePolicySignatures = sourcePolicies.map(stableJSON);
  const signature = stableJSON({ ...policy, sourcePolicies });
  const lineageSignature = stableJSON(unique(retainedLineage.map(stableJSON)));
  const build = (metricId: "repositories" | "workstreams"): ActivityBreadthAggregate => {
    const rows: ActivityBreadthRow[] = [];
    let complete = sourceComplete;
    for (const [actorId, facts] of byActor) {
      const actor = actorById.get(actorId)!;
      const units = new Map<string, Set<string>>();
      const unknown: string[] = [];
      for (const fact of facts) {
        const context = fact.eventContext;
        const ids = metricId === "repositories" ? [fact.repoId] : (context?.workstreams ?? []);
        if (metricId === "workstreams" && (!context || context.workstreamsKnown !== true)) unknown.push(fact.id);
        for (const id of ids) {
          const evidenceIds = units.get(id) ?? new Set<string>();
          evidenceIds.add(fact.id);
          units.set(id, evidenceIds);
        }
      }
      const known = sourceComplete && unknown.length === 0;
      if (unknown.length) complete = false;
      rows.push({
        actorId,
        login: actor.publicState === "deleted" ? null : actor.login,
        value: units.size > 0 || known ? units.size : null,
        state: units.size > 0 ? (known ? "measured" : "partial") : known ? "zero" : "unknown",
        units: [...units]
          .sort(([a], [b]) => compare(a, b))
          .map(([id, evidenceIds]) => ({ id, evidenceIds: unique([...evidenceIds]) })),
        evidenceIds: unique(facts.map((fact) => fact.id)),
        unknownEvidenceIds: unique(unknown),
        rank: null,
      });
    }
    rows.sort((a, b) => compare(a.login ?? a.actorId, b.login ?? b.actorId) || compare(a.actorId, b.actorId));
    return {
      metricId,
      unit: getMetricDefinition(metricId)!.definition.unit,
      policyVersion: policy.version,
      policySignature: signature,
      definitionVersion: policy.definitionVersion,
      sourcePolicySignatures,
      lineageSignature,
      evidenceClass: sourcePolicies[0]!.rankedStates[0] as "qualified" | "reviewed",
      datasetId: input.datasetId,
      cutoff: input.cutoff,
      backfillRevision: input.backfillRevision,
      scope,
      coverage: complete ? "complete" : "incomplete",
      publicEnabled: false,
      rows,
      audit: [...audit].sort((a, b) => compare(stableJSON(a), stableJSON(b))),
    };
  };
  return { repositories: build("repositories"), workstreams: build("workstreams") };
}
