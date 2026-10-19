// Synthetic source, identities and approval context. No real contribution evidence.
export function privatePolicyFixture() {
  const cutoff = "2026-10-18T00:00:00.000Z";
  const policy = {
    metricId: "issues_opened",
    version: "synthetic-preview/v1",
    definitionVersion: "candidate-0.1.0",
    unit: "issues",
    aggregation: "count",
    dateBasis: "occurredAt",
    rankedStates: ["observed"],
    roles: ["reporter"],
    groupBy: "actor_artifact",
    sources: ["github_rest"],
    minimumSamples: 1,
    rank: true,
  };
  const facts = ["first", "second"].map((name) => ({
    id: `synthetic-${name}`,
    canonicalKey: `synthetic-action-${name}`,
    metricId: "issues_opened",
    actorId: "101",
    artifactId: "synthetic-artifact",
    repoId: "2",
    role: "reporter",
    state: "observed",
    occurredAt: "2026-10-05T00:00:00.000Z",
    acceptedAt: null,
    observedAt: "2026-10-06T00:00:00.000Z",
    revision: 0,
    correctionReceipt: null,
    acceptanceReceipt: null,
    acceptedBy: null,
    subjectActorId: null,
    eventContext: { projects: [], workstreams: [] },
    currentContext: { projects: [], workstreams: [] },
  }));
  return {
    input: {
      datasetId: "synthetic-preview",
      cutoff,
      backfillRevision: "synthetic-revision",
      repositoryIds: ["2"],
      actors: [{ id: "101", login: "synthetic-person", kind: "user", publicState: "visible" }],
      facts,
      coverage: [
        {
          schemaVersion: "leaderboard/v1",
          state: "complete",
          source: "github_rest",
          scopeId: "2",
          windowStart: "2026-10-01T00:00:00.000Z",
          windowEnd: cutoff,
          knownStart: "2026-10-01T00:00:00.000Z",
          lastSuccessfulSync: cutoff,
          sourceWatermark: cutoff,
          missingPages: 0,
          permissionsMissing: [],
          sourceErrors: [],
        },
      ],
    },
    scope: {
      timezone: "UTC",
      from: "2026-10-01T00:00:00.000Z",
      to: cutoff,
      repos: ["2"],
      projects: [],
      workstreams: [],
      roles: [],
      actors: "all",
      context: "event",
    },
    policies: [policy],
    snapshot: { snapshotId: "synthetic-snapshot", revision: 1 },
    authorization: {
      configurationHash: "synthetic-config",
      controlsConfigurationRevision: 0,
      dataMode: "synthetic",
      sources: [{ repositoryId: "2", generation: "0" }],
    },
  };
}

// Review-only extension of the original synthetic fixture. No public source data.
export function privatePolicyAuditFixture() {
  const fixture = privatePolicyFixture();
  const template = fixture.input.facts[0];
  function add(name, patch = {}) {
    const fact = {
      ...structuredClone(template),
      id: "synthetic-audit-" + name,
      canonicalKey: "synthetic-audit-action-" + name,
      artifactId: "synthetic-audit-artifact-" + name,
      ...patch,
    };
    fixture.input.facts.push(fact);
    return fact;
  }
  for (let index = 0; index < 41; index++)
    add("00-large-" + String(index).padStart(3, "0"), { artifactId: "synthetic-audit-large-group" });
  for (let index = 0; index < 26; index++) {
    const name = "10-unit-" + String(index).padStart(2, "0");
    add(name + "-a", { artifactId: "synthetic-audit-" + name });
    add(name + "-b", { artifactId: "synthetic-audit-" + name });
  }
  const corrected = add("corrected");
  fixture.input.facts.push({
    ...corrected,
    revision: 1,
    correctionReceipt: "synthetic-independent-correction-receipt",
    state: "excluded",
  });
  add("unreviewed", { revision: 1 });
  add("unknown-actor", { actorId: null, subjectActorId: "101" });
  add("self-acceptance", {
    state: "qualified",
    acceptedAt: "2026-10-06T00:00:00.000Z",
    acceptedBy: "101",
    acceptanceReceipt: "synthetic-self-acceptance",
  });
  const conflicting = add("conflicting");
  fixture.input.facts.push({ ...conflicting, occurredAt: "2026-10-07T00:00:00.000Z" });
  return fixture;
}
