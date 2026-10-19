import {
  compareSourceInstants,
  participationHistoryPeriod,
  participationHistoryResponseByteLimit,
  publicParticipationHistorySchema,
  type MetricDefinition,
  type PublicParticipationHistory,
} from "@pick-your-ai/contracts";
import { stableJSON } from "@pick-your-ai/metrics";
import { metadata, parameters, publicLink, ReadFailure, type Metadata, type Selection } from "./client.ts";

export type HistoryParent = Pick<
  Metadata,
  "snapshotId" | "revision" | "generatedAt" | "policyVersion" | "metricDefinitionVersion" | "computationVersion"
>;
export interface ContributorHistory extends Metadata {
  actorId: string;
  profileCategory: string | null;
  history: PublicParticipationHistory;
}
function fail(): never {
  throw new ReadFailure(502, "invalid_participation_history_response");
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value) || value === "." || value === "..") fail();
  return value;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail();
  return value as Record<string, unknown>;
}

/** Preserve the full selected profile lens. Category is context only; timeline,
 * board-comparison, search and display parameters do not become history filters.
 */
export function participationHistoryParameters(selected: Selection, snapshotId: string) {
  identifier(snapshotId);
  if (selected.snapshot !== null && selected.snapshot !== snapshotId) fail();
  const params = parameters(selected, { snapshot: snapshotId, cursor: null });
  if (selected.category !== null) params.set("category", identifier(selected.category));
  return params;
}
export function participationHistoryPath(actorId: string) {
  return `contributors/${encodeURIComponent(identifier(actorId))}/participation-history`;
}
export function participationFirstProofPath(actorId: string, value: PublicParticipationHistory) {
  if (value.state !== "known" || !/^[a-f0-9]{64}$/.test(value.historyKey) || value.firstProof.proof.actorId !== actorId)
    fail();
  return `${participationHistoryPath(actorId)}/${value.historyKey}/evidence/${encodeURIComponent(identifier(value.firstProof.proof.contributionId))}`;
}

/** The server provider admits history. This reader verifies the public wire
 * bindings; receipt strings or a structurally valid result cannot authenticate sources.
 */
export function participationHistory(
  value: unknown,
  selected: Selection,
  actorId: string,
  parent: HistoryParent,
  definitions: readonly MetricDefinition[],
): ContributorHistory {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > participationHistoryResponseByteLimit) fail();
    const optional = selected.schemaVersion === undefined ? [] : ["snapshotSchemaVersion"];
    const data = exact(value, [
      "schemaVersion",
      ...optional,
      "snapshotId",
      "revision",
      "generatedAt",
      "metricDefinitionVersion",
      "computationVersion",
      "policyVersion",
      "head",
      "scope",
      "actorFilter",
      "coverage",
      "disabledMetrics",
      "methodology",
      "actorId",
      "profileCategory",
      "history",
    ]);
    exact(data.head, ["snapshotId", "revision", "publishedAt"]);
    const meta = metadata(data, selected);
    if (
      identifier(data.actorId) !== identifier(actorId) ||
      data.profileCategory !== selected.category ||
      (
        [
          "snapshotId",
          "revision",
          "generatedAt",
          "policyVersion",
          "metricDefinitionVersion",
          "computationVersion",
        ] as const
      ).some((key) => meta[key] !== parent[key]) ||
      meta.head.revision < meta.revision ||
      compareSourceInstants(meta.generatedAt, meta.head.publishedAt) > 0
    )
      fail();
    const registered = new Set(definitions.map((definition) => definition.id));
    if (data.profileCategory !== null && !registered.has(identifier(data.profileCategory))) fail();
    for (const item of data.methodology as unknown[]) {
      const entry = exact(item, ["metricId", "policyVersion", "policySignature", "policyLink"]);
      if (
        !registered.has(identifier(entry.metricId)) ||
        !/^[a-f0-9]{64}$/.test(String(entry.policySignature)) ||
        (entry.policyLink !== null &&
          (typeof entry.policyLink !== "string" || publicLink(entry.policyLink) !== entry.policyLink))
      )
        fail();
      identifier(entry.policyVersion);
    }
    for (const item of data.disabledMetrics as unknown[]) {
      const entry = exact(item, ["id", "reason", "policyVersion", "policyLink"]);
      if (
        !registered.has(identifier(entry.id)) ||
        typeof entry.reason !== "string" ||
        !/^[a-z0-9_:-]{1,100}$/.test(entry.reason) ||
        (entry.policyLink !== null &&
          (typeof entry.policyLink !== "string" || publicLink(entry.policyLink) !== entry.policyLink))
      )
        fail();
      identifier(entry.policyVersion);
    }
    if (
      new Set(meta.methodology.map((entry) => entry.metricId)).size !== meta.methodology.length ||
      new Set(meta.disabledMetrics.map((entry) => entry.id)).size !== meta.disabledMetrics.length
    )
      fail();
    const history = publicParticipationHistorySchema.parse(data.history);
    if (history.state === "known") {
      const proof = history.firstProof.proof;
      if (
        history.basis.scope.organization !== selected.organization ||
        proof.actorId !== actorId ||
        compareSourceInstants(history.basis.cutoff, meta.generatedAt) > 0 ||
        proof.metricIds.some((metric) => !registered.has(metric)) ||
        history.basis.policies.some((policy) => {
          const current = meta.methodology.find((entry) => entry.metricId === policy.metricId);
          return (
            !registered.has(policy.metricId) ||
            meta.disabledMetrics.some((entry) => entry.id === policy.metricId) ||
            (current !== undefined &&
              (current.policyVersion !== policy.version || current.policySignature !== policy.signature))
          );
        })
      )
        fail();
      const period = participationHistoryPeriod(selected.start, selected.end, history.basis.cutoff, proof.occurredAt);
      if (history.newcomer !== period.newcomer || history.periodReason !== period.periodReason) fail();
    }
    return { ...meta, actorId, profileCategory: data.profileCategory as string | null, history };
  } catch {
    return fail();
  }
}

export function participationFirstProof(
  value: unknown,
  selected: Selection,
  previous: ContributorHistory,
  definitions: readonly MetricDefinition[],
): ContributorHistory & { history: Extract<PublicParticipationHistory, { state: "known" }> } {
  const result = participationHistory(value, selected, previous.actorId, previous, definitions);
  if (
    previous.history.state !== "known" ||
    result.history.state !== "known" ||
    result.history.historyKey !== previous.history.historyKey ||
    stableJSON(result.history) !== stableJSON(previous.history)
  )
    fail();
  return result as ContributorHistory & { history: Extract<PublicParticipationHistory, { state: "known" }> };
}
