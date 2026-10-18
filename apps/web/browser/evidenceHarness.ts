import type { Page } from "@playwright/test";

// These are synthetic service-provider inputs, never production data.
const at = "2026-10-17T12:00:00.000Z";
const baseScope = { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null };
function snapshot(id = "api-1", revision = 1) {
  const coverage = {
    schemaVersion: "leaderboard/v1",
    state: "complete",
    source: "github_rest",
    scopeId: "synthetic-api-scope",
    windowStart: "2026-10-01T00:00:00.000Z",
    windowEnd: "2026-11-01T00:00:00.000Z",
    knownStart: null,
    lastSuccessfulSync: at,
    sourceWatermark: at,
    missingPages: 0,
    permissionsMissing: [],
    sourceErrors: [],
  };
  const actors = ["a", "b", "c"].map((letter) => ({
    actorId: `api-${letter}`,
    state: "public",
    actor: {
      schemaVersion: "leaderboard/v1",
      identityState: "resolved",
      githubNodeId: `synthetic-node-${letter}`,
      login: `synthetic-api-${letter}`,
      displayName: `Synthetic API ${letter.toUpperCase()}`,
      kind: "user",
      executionMode: "unknown",
    },
  }));
  const evidence = actors.map(({ actorId }, index) => ({
    artifact: {
      schemaVersion: "leaderboard/v1",
      source: "github",
      kind: "pull_request",
      stableId: `api-pr-${index}`,
      repositoryId: "repo-1",
      publicUrl: `https://github.com/synthetic-api/example/pull/${index + 1}`,
      visibility: "public",
    },
    contribution: {
      schemaVersion: "leaderboard/v1",
      contributionId: `e-${actorId}`,
      canonicalEventId: `event-${actorId}`,
      artifactId: `api-pr-${index}`,
      actorId,
      roles: ["author"],
      qualification: "eligible",
      metricIds: ["pr_opened", "documentation"],
      reasonCodes: ["public_accepted_source"],
    },
    occurredAt: at,
    sourceRevision: "synthetic-rev",
    sourceRevisionUrl: "https://github.com/synthetic-api/example/commit/abcdef",
  }));
  return {
    head: { snapshotId: id, revision, publishedAt: at },
    controls: {
      version: "privacy-1",
      suppressedActorIds: [] as string[],
      suppressedArtifactIds: [],
      revokedSnapshotIds: [] as string[],
    },
    selected: {
      approvedPublic: true,
      scope: { ...baseScope },
      snapshot: {
        schemaVersion: "leaderboard/v1",
        snapshotId: id,
        revision,
        generatedAt: at,
        metricDefinitionVersion: "candidate-0.1.0",
        computationVersion: "synthetic-http-browser-only",
        coverage: [coverage],
        results: [],
      },
      actors,
      evidence,
      portfolioEvidence: evidence.map((entry) => ({ ...entry, activityState: "observed", observedAt: at })),
      rows: ["pr_opened", "documentation"].flatMap((metricId) =>
        actors.map(({ actorId }, index) => ({
          actorId,
          result: { schemaVersion: "leaderboard/v1", metricId, state: "measured", value: index < 2 ? 2 : 1, coverage },
          evidenceIds: [`e-${actorId}`],
        })),
      ),
      ranking: [
        { metricId: "pr_opened", direction: "descending", rank: true },
        { metricId: "documentation", direction: "descending", rank: false },
      ],
      diagnostics: ["pr_opened", "documentation"].flatMap((metricId) =>
        actors.map(({ actorId }, index) => ({
          metricId,
          actorId,
          numerator: index < 2 ? 2 : 1,
          denominator: null,
          sampleCount: index < 2 ? 2 : 1,
          censored: 0,
          missingReadiness: 0,
          p75: null,
        })),
      ),
      methodology: [
        {
          metricId: "pr_opened",
          policyVersion: "approved-policy-1",
          policySignature: "a".repeat(64),
          policyLink: "https://github.com/synthetic-api/example/blob/main/policy.md",
        },
      ],
    },
  };
}
export async function evidenceService(page: Page) {
  // Dynamic path avoids coupling the web TypeScript project to server source.
  // CI builds all packages before browser tests. Requests use the actual Fastify
  // handler, contract projection, query checks and signed cursor implementation.
  const serverModule = new URL("../../service/dist/app.js", import.meta.url).href;
  const { createService } = await import(serverModule);
  let current = snapshot();
  const snapshots = new Map([[current.head.snapshotId, current]]);
  let unavailable = false;
  const app = createService({
    now: () => Date.parse(at),
    cursorSecret: "synthetic-browser-cursor-secret-0001",
    source: {
      async read(scope: typeof baseScope, pin: string | null) {
        if (unavailable) throw Error("SENSITIVE_SYNTHETIC_PROVIDER_FAILURE");
        const chosen = pin ? snapshots.get(pin) : current;
        if (!chosen) return null;
        const result = structuredClone(chosen);
        result.selected.scope = { ...scope };
        result.head = structuredClone(current.head);
        result.controls = structuredClone(current.controls);
        return result;
      },
    },
  });
  const calls: URL[] = [];
  let evidenceGate: Promise<void> | null = null;
  let releaseEvidence = () => {};
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    const response = await app.inject({ method: "GET", url: url.pathname + url.search });
    if (url.pathname.includes("/evidence/") && evidenceGate) await evidenceGate;
    await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
  });
  return {
    calls,
    holdEvidenceReads() {
      evidenceGate = new Promise<void>((resolve) => {
        releaseEvidence = resolve;
      });
    },
    releaseEvidenceReads() {
      releaseEvidence();
      evidenceGate = null;
    },
    suppressArtifact() {
      current.controls.version = "artifact-privacy-2";
      (current.controls.suppressedArtifactIds as string[]) = ["api-pr-0"];
    },
    unknownAndHostile() {
      current.selected.portfolioEvidence = [];
      current.selected.evidence[0]!.contribution.reasonCodes = [
        '<img src=x onerror="window.proofInjected=true">',
        "generated_content_excluded",
        "imported_history_unknown",
        "revert_status_unknown",
      ];
      Object.assign(current.selected.evidence[0]!, { occurredAt: null, sourceRevision: null, sourceRevisionUrl: null });
    },
    unavailableSource() {
      for (const list of [current.selected.evidence, current.selected.portfolioEvidence]) {
        Object.assign(list[0]!.artifact, { visibility: "unavailable", publicUrl: undefined });
      }
    },
    close: () => {
      releaseEvidence();
      return app.close();
    },
    next() {
      current = snapshot("api-2", 2);
      current.selected.rows[0]!.result.value = 10;
      snapshots.set("api-2", current);
    },
    suppress() {
      current.controls.version = "privacy-2";
      current.controls.suppressedActorIds = ["api-a"];
    },
    revoke() {
      current.controls.version = "privacy-3";
      current.controls.revokedSnapshotIds = ["api-1"];
    },
    fail() {
      unavailable = true;
    },
  };
}
