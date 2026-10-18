// Synthetic adapter for scope integration: real collection SQL, normalization, frozen inputs and engine.
import assert from "node:assert/strict";
import { harness, components, ago } from "./harness.mjs";

const slug = "synthetic-org/synthetic-repo";
export const projectIds = ["PVT_synthetic_A", "PVT_synthetic_B"];
const mapping = () => ({
  repositoryId: 2,
  version: "synthetic-project-mapping/v1",
  projects: projectIds.map((projectId) => ({
    projectId,
    fields: [{ fieldId: projectId + "_field", options: [{ optionId: "blue", workstreamId: "engineering" }] }],
  })),
});
const sourceDocument = (subject, revision, project = false) => ({
  subjectId: subject.node_id,
  ...(project ? { projectSubjectId: subject.node_id } : {}),
  sourceRevision: revision,
  sourceUrl: subject.html_url,
  evidence: "current_state",
  actorId: null,
  occurredAt: null,
  state: "open",
});

// The separate real-transport test covers provider hydration. This harness uses
// the actual collection SQL, normalization cache, frozen store, and metric engine
// with a trusted synthetic Project adapter whose captured revision is immutable.
export async function publicScopeHarness(
  t,
  { scopes, configure = () => {}, stableProjectRevisions = false, transformProjectOutput = (output) => output } = {},
) {
  const payloads = [1, 2].map((number) => ({
    id: 1000 + number,
    node_id: "SYNTHETIC_ISSUE_" + number,
    number,
    html_url: "https://github.com/" + slug + "/issues/" + number,
    created_at: ago(2),
    updated_at: ago(1),
    state: "open",
    user: { id: 101, node_id: "U_SYNTHETIC_A", login: "synthetic-alice", type: "User" },
  }));
  let memberships = [projectIds, []];
  const captured = new Map();
  let normalizedProjects = 0;
  const projectFact = (index, projects, runId) => {
    const subject = payloads[index];
    const snapshot = {
      schemaVersion: "github-project-subject-context/v1",
      repositoryId: 2,
      subjectId: subject.node_id,
      subjectKind: "issue",
      sourceUrl: subject.html_url,
      allowedProjectIds: projectIds,
      items: projects.map((projectId) => ({
        id: projectId + "_item_" + index,
        projectId,
        updatedAt: subject.updated_at,
        archived: false,
        fields: [{ fieldId: projectId + "_field", optionId: "blue" }],
      })),
    };
    const revision = components.github.githubSnapshotRevision(
      components.github.projectSubjectSnapshotRevision(snapshot),
      stableProjectRevisions ? "synthetic-stable-run" : runId,
    );
    captured.set(revision, structuredClone(snapshot));
    return sourceDocument(subject, revision, true);
  };
  const source = {
    async readPage(request) {
      const facts =
        request.family === "project_current"
          ? memberships.flatMap((projects, index) =>
              projects === null ? [] : [projectFact(index, projects, request.runId)],
            )
          : payloads.map((payload) => sourceDocument(payload, payload.updated_at));
      return { repositoryId: 2, visibility: "public", facts, nextCursor: null, expectedCount: facts.length };
    },
  };
  const normalizerFactory = (options) => {
    const configured = structuredClone(options.config.projectWorkstreamMappings[0]);
    const ordinary = components.github.createGithubEvidenceNormalizer({
      client: options.githubClient,
      source: options.sourceId,
      allowedRepositoryIds: [2],
      isSynthetic: true,
    });
    return async (input) => {
      if (input.family !== "project_current") return ordinary(input);
      normalizedProjects++;
      const snapshot = captured.get(input.fact.sourceRevision);
      assert.ok(snapshot, "only the captured synthetic source revision is available");
      const selectedMapping = { version: configured.version, projects: configured.projects };
      const output = {
        facts: [],
        actors: [],
        evidence: [],
        reasons: [],
        isSynthetic: true,
        projectContext: {
          schemaVersion: "github-current-project-context/v1",
          repositoryId: "2",
          subjectId: snapshot.subjectId,
          subjectKind: snapshot.subjectKind,
          sourceUrl: snapshot.sourceUrl,
          sourceRevision: input.fact.sourceRevision,
          observedAt: input.observedAt,
          mappingVersion: configured.version,
          context: {
            ...components.github.projectContextFromSnapshot(snapshot, selectedMapping),
            projectScope: projectIds,
          },
        },
      };
      return transformProjectOutput(output, input);
    };
  };
  const h = await harness(t, {
    source,
    payloads,
    normalizerFactory,
    configure(config) {
      config.repositories[0].families = ["issues", "project_current"];
      config.repositories[0].allowedProjectIds = projectIds;
      config.projectWorkstreamMappings = [mapping()];
      if (scopes) config.scopes = structuredClone(scopes);
      configure(config);
    },
  });
  const frozen = async (publication) =>
    (
      await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
        publication.snapshotId,
      ])
    ).rows[0];
  const collected = async (runId) => {
    await h.db.query(
      "INSERT INTO leaderboard_pipeline.source_modes(fact_key,data_mode) SELECT fact_key,'synthetic' FROM leaderboard_ingestion.source_facts WHERE first_run_id=$1 ON CONFLICT DO NOTHING",
      [runId],
    );
  };
  return {
    ...h,
    frozen,
    projectFact,
    collected,
    normalizerFactory,
    normalizedProjects: () => normalizedProjects,
    setMemberships(value) {
      memberships = value;
    },
  };
}
