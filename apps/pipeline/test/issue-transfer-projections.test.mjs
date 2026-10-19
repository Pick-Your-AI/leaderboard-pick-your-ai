import test from "node:test";
import assert from "node:assert/strict";
import fixture from "../../../tests/fixtures/issue-transfer-metadata.json" with { type: "json" };
import {
  transferComponents,
  selectIssueTransferSources,
  currentEndpoint,
  conserveIssueCreations,
  projectIssueCreationCorrections,
} from "../src/issue-transfers.mjs";

const edge = (change = {}) => ({ ...structuredClone(fixture), ...change });
const context = (project) => ({
  projects: [project],
  workstreams: [],
  workstreamsKnown: true,
  projectScope: [project],
});
function output(artifactId = fixture.sourceArtifactId, repoId = "2", changes = {}) {
  const fact = {
    id: `gh:fact-${artifactId}`,
    canonicalKey: `gh:unit-${artifactId}`,
    metricId: "issues_opened",
    actorId: "11",
    artifactId,
    repoId,
    role: "reporter",
    state: "observed",
    occurredAt: "2026-10-18T21:00:00.000Z",
    acceptedAt: null,
    observedAt: "2026-10-18T22:00:00.000Z",
    revision: 0,
    correctionReceipt: null,
    acceptanceReceipt: null,
    acceptedBy: null,
    subjectActorId: "11",
    eventContext: null,
    currentContext: null,
    ...changes,
  };
  const url =
    repoId === "2"
      ? fixture.sourceUrl
      : repoId === "3"
        ? fixture.targetUrl
        : "https://github.com/synthetic-org/synthetic-third/issues/7";
  return {
    facts: [fact],
    actors: [],
    selectedCurrentState: true,
    evidence: [
      {
        artifact: {
          schemaVersion: "leaderboard/v1",
          source: "github",
          kind: "issue",
          stableId: artifactId,
          repositoryId: repoId,
          publicUrl: url,
          visibility: "public",
        },
        contribution: {
          schemaVersion: "leaderboard/v1",
          contributionId: fact.id,
          canonicalEventId: fact.canonicalKey,
          artifactId,
          actorId: fact.actorId,
          roles: [fact.role],
          qualification: "eligible",
          metricIds: [fact.metricId],
          reasonCodes: ["raw_observed_only"],
        },
        occurredAt: fact.occurredAt,
        sourceRevision: `synthetic-${artifactId}`,
        sourceRevisionUrl: null,
        evidenceMetadata: {
          schemaVersion: "leaderboard-evidence/v1",
          artifactTitle: `Synthetic ${artifactId}`,
          sourceAction: "opened",
          sourceOccurredAt: fact.occurredAt,
          observedAt: fact.observedAt,
          activityState: "observed",
          acceptedAt: null,
          history: [],
        },
      },
    ],
  };
}
const proof = (item) => ({
  schemaVersion: "github-issue-creation-scope/v1",
  factId: item.facts[0].id,
  artifactId: item.facts[0].artifactId,
  repositoryId: item.facts[0].repoId,
  observationId: "gh:synthetic-open",
  sourceRevision: "synthetic-open-revision",
  observedAt: item.facts[0].observedAt,
  occurredAt: item.facts[0].occurredAt,
  eventId: "synthetic-open-event",
});
const facts = (result) => result.outputs.flatMap((item) => item.facts);
const project = (items, options = {}) =>
  conserveIssueCreations(items, { transfers: [edge()], repositoryIds: ["2", "3"], context: "current", ...options });

test("proven aliases conserve creation and leave both source documents immutable", () => {
  const items = [output(), output(fixture.targetArtifactId, "3")],
    before = structuredClone(items);
  const result = project(items);
  assert.equal(facts(result).length, 1);
  assert.equal(facts(result)[0].artifactId, fixture.targetArtifactId);
  assert.equal(facts(result)[0].repoId, "3");
  assert.equal(facts(result)[0].id, items[0].facts[0].id);
  assert.deepEqual(items, before);
  assert.equal(result.outputs.at(-1).evidence[0].artifact.publicUrl, fixture.targetUrl);
});
for (const id of [fixture.sourceArtifactId, "github:issue:17"])
  test(`equal provider ID ${id} across repositories is one identity without invented alias`, () => {
    const a = output(id, "2"),
      b = output(id, "3", { observedAt: "2026-10-19T02:00:00.000Z" });
    const result = project([a, b], { transfers: [] });
    assert.equal(facts(result).length, 1);
    assert.equal(facts(result)[0].repoId, "3");
    assert.equal(facts(project([a, b], { transfers: [], repositoryIds: ["2"] })).length, 0);
  });
test("unrelated issue creation and raw transfer facts are not consumed", () => {
  const unrelated = output("SYNTHETIC_UNRELATED", "2"),
    raw = output("SYNTHETIC_RAW_TRANSFER", "2", { metricId: "issue_transfers", role: "transferrer" });
  const result = project([output(), output(fixture.targetArtifactId, "3"), unrelated, raw]);
  assert.equal(facts(result).filter((fact) => fact.metricId === "issues_opened").length, 2);
  assert.deepEqual(
    facts(result).find((fact) => fact.metricId === "issue_transfers"),
    raw.facts[0],
  );
});
test("transfer-only input never creates authorship", () => {
  assert.deepEqual(facts(project([])), []);
});
test("an actual opened proof assigns only its birth repository and Project scope", () => {
  const a = output(undefined, "2", { eventContext: context("SYNTHETIC_PROJECT_A") }),
    b = output(fixture.targetArtifactId, "3", { eventContext: context("SYNTHETIC_PROJECT_B") });
  const result = project([a, b], { context: "event", creationScopes: [proof(a)] });
  assert.equal(facts(result)[0].repoId, "2");
  assert.deepEqual(facts(result)[0].eventContext, a.facts[0].eventContext);
  assert.deepEqual(facts(project([a, b], { context: "event", creationScopes: [proof(a)], repositoryIds: ["3"] })), []);
});
test("REST creation time and the first transfer source do not prove birth repository", () => {
  assert.throws(() => project([output()], { context: "event" }), /issue_transfer_event_scope_unavailable/);
});
test("contradictory actual opened repository proofs fail explicitly", () => {
  const a = output(),
    b = output(fixture.targetArtifactId, "3");
  assert.throws(
    () => project([a, b], { context: "event", creationScopes: [proof(a), proof(b)] }),
    /issue_transfer_creation_scope_conflict/,
  );
});
for (const change of [
  { actorId: "12" },
  { role: "assignee" },
  { state: "unknown" },
  { occurredAt: "2026-10-18T20:00:00.000Z" },
  { subjectActorId: "12" },
])
  test(`contradictory creation meaning ${Object.keys(change)[0]} is not silently deduplicated`, () => {
    assert.throws(
      () => project([output(), output(fixture.targetArtifactId, "3", change)]),
      /issue_transfer_creation_conflict/,
    );
  });
test("a transition dated before its creation is contradictory", () => {
  assert.throws(
    () => project([output()], { transfers: [edge({ occurredAt: "2026-10-18T20:00:00.000Z" })] }),
    /issue_transfer_creation_conflict/,
  );
});
test("missing destination view preserves an actual creation observation clock and unknown current Projects", () => {
  const a = output(undefined, "2", { currentContext: context("SYNTHETIC_SOURCE_PROJECT") });
  const result = project([a], { repositoryIds: ["3"] }),
    fact = facts(result)[0];
  assert.equal(fact.observedAt, a.facts[0].observedAt);
  assert.notEqual(fact.observedAt, fixture.observedAt);
  assert.equal(fact.currentContext, null);
  assert.equal(fact.eventContext, null);
  assert.equal(result.outputs.at(-1).evidence[0].evidenceMetadata.observedAt, fact.observedAt);
});
test("a current target view supplies its own Projects and actual title without changing raw identity", () => {
  const b = output(fixture.targetArtifactId, "3", { currentContext: context("SYNTHETIC_TARGET_PROJECT") });
  const result = project([output(), b]);
  assert.deepEqual(facts(result)[0].currentContext, b.facts[0].currentContext);
  assert.equal(
    result.outputs.at(-1).evidence[0].evidenceMetadata.artifactTitle,
    b.evidence[0].evidenceMetadata.artifactTitle,
  );
});
for (const changes of [
  { occurredAt: null },
  { occurredAt: "2026-10-18T23:00:00.000Z", sourceArtifactId: "SYNTHETIC_DISCONNECTED" },
])
  test(`unusable chronology without a current target view has an explicit missing-location failure ${changes.occurredAt}`, () => {
    const edges =
      changes.occurredAt === null
        ? [edge(changes)]
        : [
            edge(),
            edge({
              ...changes,
              targetArtifactId: fixture.sourceArtifactId,
              sourceRepositoryId: "4",
              targetRepositoryId: "2",
              sourceUrl: "https://github.com/synthetic-org/synthetic-third/issues/7",
              targetUrl: fixture.sourceUrl,
              eventId: "synthetic-second",
              observationId: "gh:synthetic-second",
            }),
          ];
    assert.throws(
      () => project([output()], { transfers: edges, repositoryIds: ["3"] }),
      /issue_transfer_current_scope_unavailable/,
    );
  });
test("a later selected current snapshot resolves missing chronology while a delayed opened event does not", () => {
  const later = output(fixture.targetArtifactId, "3", { observedAt: "2026-10-19T02:00:00.000Z" });
  assert.equal(facts(project([output(), later], { transfers: [edge({ occurredAt: null })] }))[0].repoId, "3");
  later.selectedCurrentState = false;
  assert.throws(
    () => project([output(), later], { transfers: [edge({ occurredAt: null })] }),
    /issue_transfer_current_scope_unavailable/,
  );
});
test("multi-hop, reverse return, and exact event replays have deterministic endpoints", () => {
  const second = edge({
    sourceArtifactId: fixture.targetArtifactId,
    targetArtifactId: "SYNTHETIC_ISSUE_C",
    sourceRepositoryId: "3",
    targetRepositoryId: "4",
    sourceUrl: fixture.targetUrl,
    targetUrl: "https://github.com/synthetic-org/synthetic-third/issues/7",
    occurredAt: "2026-10-18T23:30:00.000Z",
    eventId: "synthetic-second",
    observationId: "gh:synthetic-second",
  });
  const back = edge({
    sourceArtifactId: "SYNTHETIC_ISSUE_C",
    targetArtifactId: fixture.sourceArtifactId,
    sourceRepositoryId: "4",
    targetRepositoryId: "2",
    sourceUrl: second.targetUrl,
    targetUrl: fixture.sourceUrl,
    occurredAt: "2026-10-19T00:00:00.000Z",
    eventId: "synthetic-return",
    observationId: "gh:synthetic-return",
  });
  const expected = { artifactId: fixture.sourceArtifactId, repositoryId: "2", url: fixture.sourceUrl };
  assert.deepEqual(currentEndpoint([second, back, edge(), edge()]), expected);
  assert.deepEqual(currentEndpoint([back, edge(), second]), expected);
});
test("one immutable transfer event cannot bind different transitions, including disconnected identities", () => {
  for (const second of [
    edge({ targetArtifactId: "SYNTHETIC_OTHER" }),
    edge({ sourceArtifactId: "SYNTHETIC_OTHER_A", targetArtifactId: "SYNTHETIC_OTHER_B" }),
  ])
    assert.throws(() => transferComponents([edge(), second]), /issue_transfer_event_conflict/);
});
test("foreign source selection includes only proven issue and current Project context dependencies", () => {
  const wrapped = (document, repositoryId) => ({ document, repositoryId });
  const entries = [
    wrapped(output(), "2"),
    wrapped(output(fixture.targetArtifactId, "3"), "3"),
    wrapped({ facts: [], actors: [], evidence: [], projectContext: { subjectId: fixture.targetArtifactId } }, "3"),
    wrapped(output("SYNTHETIC_UNRELATED", "3"), "3"),
  ];
  assert.deepEqual(selectIssueTransferSources(entries, [edge()], ["2"]).normalized, entries.slice(0, 3));
});
test("canonical growth projects an immutable exclusion to the selected creation without rewriting its receipt", () => {
  const original = {
    ...output(fixture.targetArtifactId, "3").facts[0],
    state: "excluded",
    revision: 1,
    correctionReceipt: "synthetic-reviewed-receipt",
  };
  const before = structuredClone(original),
    current = facts(project([output(), output(fixture.targetArtifactId, "3")]))[0];
  const [overlay] = projectIssueCreationCorrections([original], [current], [edge()]);
  assert.equal(overlay.id, current.id);
  assert.equal(overlay.state, "excluded");
  assert.equal(overlay.correctionReceipt, original.correctionReceipt);
  assert.deepEqual(original, before);
  assert.deepEqual(
    projectIssueCreationCorrections([original], [output("SYNTHETIC_UNRELATED", "3").facts[0]], [edge()]),
    [original],
  );
});
test("equally timed current views of the same native endpoint cannot choose different URLs by input order", () => {
  const first = output(fixture.targetArtifactId, "3", { observedAt: "2026-10-19T02:00:00.000Z" });
  const second = structuredClone(first);
  second.evidence[0].artifact.publicUrl = "https://github.com/synthetic-org/synthetic-target/issues/10";
  for (const views of [
    [first, second],
    [second, first],
  ])
    assert.throws(() => project([output(), ...views]), /issue_transfer_current_scope_unavailable/);
});
test("latest explicit current Project context replaces older current and historical opened contexts", () => {
  const old = output(fixture.targetArtifactId, "3", { currentContext: context("SYNTHETIC_OLD_PROJECT") });
  const current = output(fixture.targetArtifactId, "3", {
    currentContext: context("SYNTHETIC_CURRENT_PROJECT"),
    observedAt: "2026-10-19T02:00:00.000Z",
  });
  const delayedOpen = output(fixture.targetArtifactId, "3", {
    currentContext: context("SYNTHETIC_DELAYED_OPEN_PROJECT"),
    observedAt: "2026-10-19T03:00:00.000Z",
  });
  delayedOpen.selectedCurrentState = false;
  const result = project([output(), old, current, delayedOpen]);
  assert.deepEqual(facts(result)[0].currentContext, current.facts[0].currentContext);
  assert.equal(facts(result)[0].observedAt, current.facts[0].observedAt);
});
