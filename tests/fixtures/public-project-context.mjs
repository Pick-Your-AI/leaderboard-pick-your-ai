// Synthetic public-provider inputs, never a native membership or permission receipt.
// Native collection/SQL authority is exercised separately in the pipeline tests.
import { readFixture, at } from "./pending-metric.mjs";

export function projectContext(proof, options = {}) {
  return {
    schemaVersion: "public-project-context/v1",
    binding: {
      repositoryId: proof.artifact.repositoryId,
      artifactId: proof.artifact.stableId,
      contributionId: proof.contribution.contributionId,
    },
    basis: "event",
    state: "known",
    projects: ["PVT_A", "PVT_B"],
    projectScope: ["PVT_A", "PVT_B"],
    observedAt: at,
    ...options,
  };
}

export function projectFixture({ count = null, projects = ["PVT_A", "PVT_B"], pad = "" } = {}) {
  const input = readFixture();
  if (count !== null) {
    const template = input.selected.evidence[0];
    input.selected.evidence = Array.from({ length: count }, (_, index) => {
      const proof = structuredClone(template);
      const id = `synthetic-project-${String(index).padStart(3, "0")}`;
      proof.artifact.stableId = `artifact-${id}${pad}`;
      proof.artifact.publicUrl = `https://github.com/synthetic-org/synthetic-repo/pull/${index + 1}`;
      proof.contribution.contributionId = id;
      proof.contribution.canonicalEventId = id;
      proof.contribution.artifactId = proof.artifact.stableId;
      return proof;
    });
    input.selected.actors = input.selected.actors.slice(0, 1);
    input.selected.rows = input.selected.rows.slice(0, 1);
    input.selected.rows[0].result.value = count;
    input.selected.rows[0].evidenceIds = input.selected.evidence.map((proof) => proof.contribution.contributionId);
    input.selected.rows[0].pending = {
      schemaVersion: "leaderboard-pending/v1",
      state: "unknown",
      valueClass: "qualified",
      count: null,
      evidenceIds: [],
    };
    input.selected.pendingEvidence = [];
    input.selected.diagnostics = [];
  }
  for (const proof of [...input.selected.evidence, ...input.selected.pendingEvidence])
    proof.projectContext = projectContext(proof, { projects, projectScope: projects });
  input.selected.portfolioEvidence = input.selected.evidence.map((proof) => ({
    ...structuredClone(proof),
    activityState: "unknown",
    observedAt: null,
  }));
  return input;
}
