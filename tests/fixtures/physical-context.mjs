// Fictional stock-normalized source and trusted publication inputs. This fixture
// exercises the real public projector, not a GitHub grant or physical-byte audit.
import { createHash } from "node:crypto";
import { canonicalPublicScope, currentRankingPresentationPolicy } from "../../packages/contracts/dist/index.js";
import { normalizeGithubObservation } from "../../packages/github/dist/index.js";
import { createService } from "../../apps/service/dist/app.js";
import { physicalSource, physicalFiles } from "../../apps/pipeline/test/fixtures/physical-context.mjs";
import { materializeEvidenceMetadata } from "../../apps/pipeline/src/evidence-metadata.mjs";

export const physicalAt = "2026-10-08T12:00:00.000Z";
export const physicalSnapshotId = "synthetic-physical-context-snapshot";
export function physicalFixture({
  metricId = "pr_lines_added",
  sampleCount = 1,
  files = physicalFiles,
  scope = {},
  legacy = false,
} = {}) {
  const selectedScope = canonicalPublicScope({
    organization: "Pick-Your-AI",
    repository: null,
    workstream: null,
    start: null,
    end: null,
    ...scope,
  });
  const outputs = Array.from({ length: sampleCount }, (_, index) => {
    const { envelope } = physicalSource({ files });
    const pull = envelope.payload.pull_request;
    pull.id += index;
    pull.node_id += `_${index}`;
    pull.number += index;
    pull.html_url = `https://github.com/${envelope.repository.slug}/pull/${pull.number}`;
    envelope.integration.canonicalChangeId += `_${index}`;
    return normalizeGithubObservation(envelope);
  });
  const coverage = {
    schemaVersion: "leaderboard/v1",
    state: "partial",
    source: "github_rest",
    scopeId: "2",
    windowStart: "2026-10-01T00:00:00.000Z",
    windowEnd: physicalAt,
    knownStart: null,
    lastSuccessfulSync: physicalAt,
    sourceWatermark: physicalAt,
    missingPages: 1,
    permissionsMissing: [],
    sourceErrors: ["synthetic_history_not_certified"],
  };
  const methodology = [
    {
      metricId,
      policyVersion: "synthetic-physical-policy-v1",
      policySignature: createHash("sha256").update(metricId).digest("hex"),
      policyLink: null,
    },
  ];
  const selectedFacts = outputs.flatMap((output) => output.facts.filter((fact) => fact.metricId === metricId));
  const proofs = (metric) =>
    outputs.flatMap((output) =>
      output.facts
        .filter((fact) => fact.metricId === metric)
        .map((fact) => {
          const proof = output.evidence.find((entry) => entry.contribution.contributionId === fact.id);
          return { ...structuredClone(proof), ...materializeEvidenceMetadata(proof, fact) };
        }),
    );
  return {
    head: { snapshotId: physicalSnapshotId, revision: 1, publishedAt: physicalAt },
    controls: {
      version: "synthetic-physical-controls",
      suppressedActorIds: [],
      suppressedArtifactIds: [],
      revokedSnapshotIds: [],
    },
    selected: {
      approvedPublic: true,
      scope: selectedScope,
      snapshot: {
        schemaVersion: "leaderboard/v1",
        snapshotId: physicalSnapshotId,
        revision: 1,
        generatedAt: physicalAt,
        metricDefinitionVersion: "candidate-0.1.1",
        computationVersion: "synthetic-physical-only",
        coverage: [coverage],
        results: [],
      },
      actors: [
        {
          actorId: "101",
          state: "public",
          actor: {
            schemaVersion: "leaderboard/v1",
            identityState: "resolved",
            githubNodeId: "U_SYNTHETIC_PHYSICAL",
            login: "synthetic-author",
            kind: "user",
            executionMode: "unknown",
          },
        },
      ],
      rows: [
        {
          actorId: "101",
          result: {
            schemaVersion: "leaderboard/v1",
            metricId,
            state: "partial",
            value: selectedFacts.reduce((sum, fact) => sum + (fact.quantity ?? 1), 0),
            coverage,
          },
          evidenceIds: selectedFacts.map((fact) => fact.id),
        },
      ],
      evidence: proofs(metricId),
      ranking: [{ metricId, direction: "descending", rank: metricId !== "files_changed" }],
      methodology,
      ...(legacy
        ? {}
        : {
            rankingPresentationPolicy: structuredClone(currentRankingPresentationPolicy),
            physicalContexts: [
              {
                schemaVersion: "physical-context/v1",
                actorId: "101",
                metricId,
                policyVersion: methodology[0].policyVersion,
                policySignature: methodology[0].policySignature,
                state: "available",
                samples: outputs.map((output) => ({
                  receipt: structuredClone(output.physicalContext),
                  mergedEvidenceId: output.facts.find((fact) => fact.metricId === "pr_merged").id,
                })),
              },
            ],
            physicalEvidence: proofs("pr_merged"),
          }),
    },
  };
}
export function createPhysicalContextHarness(options = {}) {
  const input = physicalFixture(options);
  let unavailable = false;
  const app = createService({
    now: () => Date.parse(physicalAt),
    source: {
      async read(scope, pin, signal) {
        signal.throwIfAborted();
        if (unavailable) throw new Error("synthetic-private-source-failure");
        if (pin !== null && pin !== input.selected.snapshot.snapshotId) return null;
        return structuredClone(input);
      },
    },
  });
  return {
    input,
    app,
    fail(value = true) {
      unavailable = value;
    },
  };
}
