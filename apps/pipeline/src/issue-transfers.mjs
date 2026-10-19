import {
  issueTransferClosure,
  validateIssueTransfers,
  validateIssueCreationScopes,
  issueArtifactId,
} from "./issue-transfer-privacy.mjs";
import { issueTransferDigest } from "./issue-transfer-store.mjs";

const fail = (code) => {
  throw new Error(code);
};
const endpointKey = (endpoint) => JSON.stringify([endpoint.artifactId, endpoint.repositoryId, endpoint.url]);
const sourceEndpoint = (entry) => ({
  artifactId: entry.sourceArtifactId,
  repositoryId: entry.sourceRepositoryId,
  url: entry.sourceUrl,
});
const targetEndpoint = (entry) => ({
  artifactId: entry.targetArtifactId,
  repositoryId: entry.targetRepositoryId,
  url: entry.targetUrl,
});
const same = (a, b) => issueTransferDigest(a) === issueTransferDigest(b);

/** Components join only equal provider IDs or typed transfer endpoints. */
export function transferComponents(value, artifactIds = []) {
  const transfers = validateIssueTransfers(value);
  transitions(transfers);
  const seeds = new Set([
    ...artifactIds,
    ...transfers.flatMap((entry) => [entry.sourceArtifactId, entry.targetArtifactId]),
  ]);
  if ([...seeds].some((id) => !issueArtifactId(id))) fail("invalid_issue_transfer_binding");
  const components = [];
  while (seeds.size) {
    const id = [...seeds].sort()[0];
    const component = issueTransferClosure(transfers, { artifactIds: [id] });
    for (const included of component.artifactIds) seeds.delete(included);
    components.push({ ...component, id: component.artifactIds[0] });
  }
  return components;
}

/** Choose source documents only after the current and retained private graph is
 * known. Unselected actor metadata and unrelated facts do not enter a view. */
export function selectIssueTransferSources(normalized, transfers, repositoryIds) {
  const selectedIds = new Set(repositoryIds.map(String));
  const initial = normalized.filter((entry) => selectedIds.has(entry.repositoryId));
  const closure = issueTransferClosure(transfers, {
    repositoryIds: [...selectedIds],
    artifactIds: initial
      .flatMap((entry) => entry.document.facts.map((fact) => fact.artifactId))
      .filter(issueArtifactId),
  });
  const aliases = new Set(closure.artifactIds);
  return {
    closure,
    normalized: normalized.filter(
      (entry) =>
        selectedIds.has(entry.repositoryId) ||
        aliases.has(entry.document.projectContext?.subjectId) ||
        entry.document.facts.some((fact) => fact.metricId === "issues_opened" && aliases.has(fact.artifactId)),
    ),
  };
}

/** Replays of the same transition are one observation of one change. Different
 * bindings for a supplied immutable event ID are a conflict, never a tie-break. */
function transitions(transfers) {
  const byEvent = new Map(),
    unique = new Map();
  for (const entry of transfers) {
    const transition = { source: sourceEndpoint(entry), target: targetEndpoint(entry), occurredAt: entry.occurredAt };
    if (entry.eventId !== null) {
      const before = byEvent.get(entry.eventId);
      if (before && !same(before, transition)) fail("issue_transfer_event_conflict");
      byEvent.set(entry.eventId, transition);
    }
    unique.set(issueTransferDigest(transition), transition);
  }
  return [...unique.values()].sort(
    (a, b) =>
      (a.occurredAt ?? "").localeCompare(b.occurredAt ?? "") ||
      endpointKey(a.source).localeCompare(endpointKey(b.source)),
  );
}

/** The last endpoint follows a continuous, unambiguous transition chronology.
 * An independently observed later current view may supply a missing endpoint;
 * an earlier source snapshot cannot guess a later destination. */
export function currentEndpoint(transfers, views = []) {
  const entries = transitions(validateIssueTransfers(transfers));
  let endpoint = null,
    usable = entries.length > 0,
    lastTime = null;
  for (const entry of entries) {
    if (
      entry.occurredAt === null ||
      entry.occurredAt === lastTime ||
      (endpoint && endpointKey(endpoint) !== endpointKey(entry.source))
    )
      usable = false;
    endpoint = entry.target;
    lastTime = entry.occurredAt;
  }
  const lastTransferObservation =
    transfers
      .map((entry) => entry.observedAt)
      .sort()
      .at(-1) ?? null;
  const currentViews = views.filter((view) => view.selectedCurrentState === true);
  const latestTime =
    currentViews
      .map((view) => view.fact.observedAt)
      .sort()
      .at(-1) ?? null;
  const latestViews = currentViews.filter((view) => view.fact.observedAt === latestTime);
  const distinct = new Map();
  const coordinates = new Map();
  for (const view of latestViews) {
    const coordinate = JSON.stringify([view.fact.artifactId, view.fact.repoId]);
    const endpoint = {
      artifactId: view.fact.artifactId,
      repositoryId: view.fact.repoId,
      url: view.evidence.artifact.publicUrl,
    };
    if (coordinates.has(coordinate) && coordinates.get(coordinate) !== endpoint.url) return null;
    coordinates.set(coordinate, endpoint.url);
    distinct.set(endpointKey(endpoint), endpoint);
  }
  if (latestTime !== null && (lastTransferObservation === null || latestTime > lastTransferObservation)) {
    if (distinct.size === 1) return [...distinct.values()][0];
    if (!usable) return null;
    // Several equally fresh repository representations are compatible only if
    // the exact dated endpoint is among them. They confer no additional birth.
    if (!distinct.has(endpointKey(endpoint))) return null;
  }
  if (usable) return endpoint;
  if (entries.length === 0 && distinct.size === 1) return [...distinct.values()][0];
  return null;
}

const creationMeaning = (fact) => {
  const { id, canonicalKey, artifactId, repoId, eventContext, currentContext, observedAt, ...meaning } = fact;
  return meaning;
};
const contextsAgree = (views, field) => {
  const contexts = views.map((view) => view.fact[field]);
  if (!contexts.length) return null;
  if (!contexts.every((context) => same(context, contexts[0]))) fail("issue_transfer_context_conflict");
  return structuredClone(contexts[0]);
};

/** One derived creation view per proven identity. The original source facts
 * and evidence are never edited. Event scope requires an actual opened proof;
 * current scope needs a proven current endpoint. Projection clocks remain an
 * actual creation observation, not a later transfer's observation time. */
export function conserveIssueCreations(
  outputs,
  { transfers = [], creationScopes = [], repositoryIds, context = "event" },
) {
  transfers = validateIssueTransfers(transfers);
  creationScopes = validateIssueCreationScopes(creationScopes);
  const selected = new Set(repositoryIds.map(String));
  const views = [];
  for (const output of outputs)
    for (const fact of output.facts) {
      if (fact.metricId !== "issues_opened") continue;
      const evidence = output.evidence.find(
        (entry) =>
          entry.contribution.contributionId === fact.id &&
          entry.artifact.stableId === fact.artifactId &&
          entry.artifact.repositoryId === fact.repoId,
      );
      if (!evidence) fail("issue_transfer_creation_evidence_missing");
      views.push({ fact, evidence, selectedCurrentState: output.selectedCurrentState === true });
    }
  const components = transferComponents(
    transfers,
    views.map((view) => view.fact.artifactId),
  );
  const replaced = new Set(),
    projections = [];
  for (const component of components) {
    const aliases = new Set(component.artifactIds);
    const members = views.filter((view) => aliases.has(view.fact.artifactId));
    if (!members.length) continue;
    const coordinates = new Set(members.map((view) => JSON.stringify([view.fact.artifactId, view.fact.repoId])));
    if (!component.transfers.length && coordinates.size === 1) continue;
    const expected = creationMeaning(members[0].fact);
    if (!members.every((view) => same(creationMeaning(view.fact), expected))) fail("issue_transfer_creation_conflict");
    if (
      component.transfers.some(
        (entry) =>
          entry.occurredAt !== null &&
          members[0].fact.occurredAt !== null &&
          entry.occurredAt < members[0].fact.occurredAt,
      )
    )
      fail("issue_transfer_creation_conflict");
    // The canonical raw ID remains a valid correction target even when its
    // display locator is the other endpoint. Later growth is handled by the
    // correction projection, never by rewriting a stored correction receipt.
    const canonical = [...members].sort(
      (a, b) =>
        a.fact.id.localeCompare(b.fact.id) ||
        a.fact.observedAt.localeCompare(b.fact.observedAt) ||
        a.fact.repoId.localeCompare(b.fact.repoId),
    )[0];
    let endpoint, matching;
    if (context === "event") {
      const proofs = creationScopes.filter(
        (scope) =>
          aliases.has(scope.artifactId) &&
          members.some(
            (view) =>
              view.fact.id === scope.factId &&
              view.fact.artifactId === scope.artifactId &&
              view.fact.repoId === scope.repositoryId &&
              view.fact.occurredAt === scope.occurredAt,
          ),
      );
      const endpoints = new Map(proofs.map((proof) => [JSON.stringify([proof.artifactId, proof.repositoryId]), proof]));
      if (endpoints.size !== 1)
        fail(endpoints.size ? "issue_transfer_creation_scope_conflict" : "issue_transfer_event_scope_unavailable");
      const proof = [...endpoints.values()][0];
      matching = members.filter((view) =>
        proofs.some(
          (proof) =>
            view.fact.id === proof.factId &&
            view.fact.artifactId === proof.artifactId &&
            view.fact.repoId === proof.repositoryId &&
            view.fact.observedAt === proof.observedAt,
        ),
      );
      if (!matching.length || new Set(matching.map((view) => view.evidence.artifact.publicUrl)).size !== 1)
        fail("issue_transfer_creation_scope_conflict");
      const exemplar = matching[0];
      endpoint = {
        artifactId: proof.artifactId,
        repositoryId: proof.repositoryId,
        url: exemplar.evidence.artifact.publicUrl,
      };
    } else {
      endpoint = currentEndpoint(component.transfers, members);
      if (!endpoint) fail("issue_transfer_current_scope_unavailable");
      const candidates = members.filter(
        (view) =>
          view.selectedCurrentState &&
          view.fact.artifactId === endpoint.artifactId &&
          view.fact.repoId === endpoint.repositoryId &&
          view.evidence.artifact.publicUrl === endpoint.url,
      );
      const latest = candidates
        .map((view) => view.fact.observedAt)
        .sort()
        .at(-1);
      matching = candidates.filter((view) => view.fact.observedAt === latest);
    }
    for (const view of members) replaced.add(view.fact);
    if (!selected.has(endpoint.repositoryId)) continue;
    const ordered = [...matching].sort((a, b) => a.fact.observedAt.localeCompare(b.fact.observedAt));
    const selectedView = ordered[0] ?? canonical;
    const fact = structuredClone(canonical.fact);
    fact.repoId = endpoint.repositoryId;
    fact.artifactId = endpoint.artifactId;
    fact.observedAt = selectedView.fact.observedAt;
    // Membership is a separately evidenced scope. Missing destination context
    // remains unknown; a source Project is not inherited through a transfer.
    fact.currentContext = context === "current" ? contextsAgree(matching, "currentContext") : null;
    fact.eventContext = context === "event" ? contextsAgree(matching, "eventContext") : null;
    const evidence = structuredClone(selectedView.evidence);
    evidence.artifact = {
      ...evidence.artifact,
      stableId: endpoint.artifactId,
      repositoryId: endpoint.repositoryId,
      publicUrl: endpoint.url,
    };
    evidence.contribution = {
      ...evidence.contribution,
      contributionId: fact.id,
      canonicalEventId: fact.canonicalKey,
      artifactId: fact.artifactId,
    };
    evidence.occurredAt = fact.occurredAt;
    if (evidence.evidenceMetadata) evidence.evidenceMetadata.observedAt = fact.observedAt;
    projections.push({ fact, evidence });
  }
  return {
    components,
    outputs: [
      ...outputs.map((output) => ({
        ...output,
        facts: output.facts.filter((fact) => !replaced.has(fact)),
        evidence: output.evidence.filter(
          (entry) => !output.facts.some((fact) => replaced.has(fact) && fact.id === entry.contribution.contributionId),
        ),
      })),
      ...(projections.length
        ? [
            {
              facts: projections.map((entry) => entry.fact),
              evidence: projections.map((entry) => entry.evidence),
              actors: [],
            },
          ]
        : []),
    ],
  };
}

/** Alias growth can select a different canonical raw ID. Apply an immutable
 * legacy exclusion to the matching current creation only; never edit its row. */
export function projectIssueCreationCorrections(corrections, facts, transfers) {
  const components = transferComponents(
    transfers,
    facts.filter((fact) => fact.metricId === "issues_opened").map((fact) => fact.artifactId),
  );
  const byId = new Map(
    components.flatMap((component) => component.artifactIds.map((id) => [id, new Set(component.artifactIds)])),
  );
  return corrections.map((correction) => {
    if (correction.metricId !== "issues_opened" || correction.state !== "excluded") return correction;
    const aliases = byId.get(correction.artifactId);
    const targets = facts.filter(
      (fact) =>
        fact.metricId === "issues_opened" &&
        (fact.artifactId === correction.artifactId || aliases?.has(fact.artifactId)) &&
        fact.actorId === correction.actorId &&
        fact.role === correction.role &&
        fact.occurredAt === correction.occurredAt,
    );
    if (targets.length > 1) fail("issue_transfer_correction_conflict");
    if (!targets.length) return correction;
    const target = targets[0];
    return {
      ...correction,
      id: target.id,
      canonicalKey: target.canonicalKey,
      artifactId: target.artifactId,
      repoId: target.repoId,
      eventContext: target.eventContext,
      currentContext: target.currentContext,
    };
  });
}
