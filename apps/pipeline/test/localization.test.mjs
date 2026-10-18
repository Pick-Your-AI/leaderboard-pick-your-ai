import assert from "node:assert/strict";
import test from "node:test";
import { components, harness, publicScope } from "./harness.mjs";

test("localization keeps raw portfolio separate from exact independently accepted locale units and current suppression", async (t) => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const ago = (days) => new Date(now - days * 86_400_000).toISOString();
  const before = "b".repeat(40),
    after = "c".repeat(40),
    mergedAt = ago(1);
  const mergeWindow = { ...publicScope, start: ago(1.5), end: ago(0.75) };
  const reviewWindow = { ...publicScope, start: mergeWindow.end, end: ago(0.25) };
  const payload = {
    id: 1001,
    node_id: "SYNTHETIC_PR_LOCALE",
    number: 1,
    html_url: "https://github.com/synthetic-org/synthetic-repo/pull/1",
    created_at: ago(2),
    updated_at: mergedAt,
    merged_at: mergedAt,
    closed_at: mergedAt,
    state: "closed",
    merged: true,
    draft: false,
    merge_commit_sha: after,
    base: { ref: "main" },
    user: { id: 101, node_id: "U_SYNTHETIC_A", login: "synthetic-alice", type: "User" },
  };
  const h = await harness(t, {
    payloads: [payload],
    configure(config) {
      config.repositories[0].families = ["pull_requests"];
      config.documentationPolicies = [
        {
          repositoryId: 2,
          version: "synthetic-locales-v1",
          documentationPaths: ["docs/"],
          researchPaths: [],
          generatedPaths: ["docs/fr/generated/"],
          importedPaths: [],
          localizationPaths: [
            { locale: "fr", category: "documentation", paths: ["docs/fr/"] },
            { locale: "de", category: "documentation", paths: ["docs/de/"] },
          ],
        },
      ];
      const policy = {
        ...config.policies[0].policy,
        metricId: "localization",
        unit: components.metrics.getMetricDefinition("localization").definition.unit,
        rankedStates: ["qualified"],
        dateBasis: "occurredAt",
        roles: ["author"],
        groupBy: "canonical",
        rank: false,
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-localization-policy" },
      ];
      config.recognitionBindings = [
        {
          category: "other",
          scope: "repository:2:locale:fr:documentation",
          policyVersion: policy.version,
          metricId: "localization",
          sourceMetricId: "localization",
          repositoryId: "2",
          reviewerIds: ["202"],
          localization: { locale: "fr", category: "documentation", policyVersion: "synthetic-locales-v1" },
        },
      ];
      config.scopes = [publicScope, mergeWindow, reviewWindow];
    },
    enrichmentFactory(client, slug) {
      return async (input) => ({
        repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
        proof: { verified: true, source: "github_rest", revision: input.fact.sourceRevision, isSynthetic: true },
        family: "pull_request",
        observedAt: input.observedAt,
        payload: { pull_request: await client.rest("installation:1", `/repos/${slug}/pulls/1`) },
        integration: {
          before,
          after,
          targetBranch: "main",
          defaultBranch: "main",
          canonicalChangeId: "synthetic-locales-merge",
          commitShas: [after],
          diff: {
            before,
            after,
            complete: true,
            files: [
              { path: "docs/fr/first.md", additions: 1, deletions: 0 },
              { path: "docs/fr/second.md", additions: 1000, deletions: 0 },
              { path: "docs/de/first.md", additions: 0, deletions: 2 },
              { path: "docs/fr/generated/api.md", additions: 10000, deletions: 0 },
            ],
          },
        },
      });
    },
  });
  const publication = await h.runtime.runOnce();
  assert.equal(publication.state, "published");
  const snapshotId = publication.publications[0].snapshotId;
  const response = await h.runtime.app.inject(`/api/v1/boards?metric=localization&snapshot=${snapshotId}`);
  assert.equal(response.statusCode, 200, response.body);
  const board = response.json();
  assert.ok(
    board.rows.every((row) => row.result.value === undefined || row.result.value === null || row.result.value === 0),
  );
  const read = await h.runtime.source.read(publicScope, snapshotId, new AbortController().signal);
  const observed = read.selected.portfolioEvidence.filter((entry) =>
    entry.contribution.metricIds.includes("localization"),
  );
  assert.equal(observed.length, 2);
  assert.ok(observed.every((entry) => entry.activityState === "observed"));
  for (const {
    contribution: { contributionId: id },
  } of observed) {
    const detail = await h.runtime.app.inject(`/api/v1/evidence/${id}?snapshot=${snapshotId}`);
    assert.equal(detail.statusCode, 200, detail.body);
    const proof = detail.json();
    assert.equal(proof.sourceRevision, after);
    assert.equal(proof.evidenceMetadata.acceptedAt, null);
    assert.ok(proof.contribution.reasonCodes.some((reason) => /^locale:(fr|de)$/.test(reason)));
  }
  const decision = {
    id: "synthetic-private-locale-approval",
    actor: "202",
    action: "accepted",
    at: Date.parse(ago(0.5)),
    policyVersion: h.options.config.policies[0].policy.version,
  };
  h.controlsStore.transaction((state) => {
    state.requests.locale = {
      id: "locale",
      kind: "evidence",
      status: "accepted",
      owner: "101",
      category: "other",
      scope: "repository:2:locale:fr:documentation",
      policyVersion: decision.policyVersion,
      locator: payload.html_url,
      collaborators: {},
      history: [decision],
    };
    state.audit.push(decision);
  });
  const accepted = (await h.runtime.runOnce()).publications[0];
  const acceptedResponse = await h.runtime.app.inject(
    `/api/v1/boards?metric=localization&snapshot=${accepted.snapshotId}`,
  );
  assert.equal(acceptedResponse.statusCode, 200, acceptedResponse.body);
  const acceptedBoard = acceptedResponse.json();
  assert.equal(acceptedBoard.rows.length, 1);
  assert.equal(acceptedBoard.rows[0].result.value, 1);
  assert.equal(acceptedBoard.rows[0].rank, null);
  assert.equal(acceptedBoard.rows[0].evidenceIds.length, 1);
  const acceptedProof = await h.runtime.app.inject(
    `/api/v1/evidence/${acceptedBoard.rows[0].evidenceIds[0]}?snapshot=${accepted.snapshotId}`,
  );
  assert.equal(acceptedProof.statusCode, 200, acceptedProof.body);
  assert.equal(acceptedProof.json().evidenceMetadata.acceptedAt, new Date(decision.at).toISOString());
  assert.ok(acceptedProof.json().contribution.reasonCodes.includes("locale:fr"));
  assert.equal(acceptedProof.json().sourceRevision, after);
  assert.equal(acceptedProof.json().occurredAt, mergedAt);
  assert.doesNotMatch(acceptedProof.body, /synthetic-private-locale-approval/);
  const mergedPeriod = await h.runtime.app.inject(
    `/api/v1/boards?metric=localization&start=${mergeWindow.start}&end=${mergeWindow.end}`,
  );
  assert.equal(mergedPeriod.statusCode, 200, mergedPeriod.body);
  assert.equal(mergedPeriod.json().rows[0].result.value, 1);
  const reviewedPeriod = await h.runtime.app.inject(
    `/api/v1/boards?metric=localization&start=${reviewWindow.start}&end=${reviewWindow.end}`,
  );
  assert.equal(reviewedPeriod.statusCode, 200, reviewedPeriod.body);
  assert.deepEqual(reviewedPeriod.json().rows, []);
  await h.runtime.runOnce();
  assert.equal((await h.runtime.app.inject("/api/v1/boards?metric=localization")).json().rows[0].result.value, 1);
  h.controlsStore.transaction((state) => {
    state.requests.locale.status = "withdrawn";
  });
  assert.equal(await h.runtime.source.read(publicScope, accepted.snapshotId, new AbortController().signal), null);
  const withdrawn = (await h.runtime.runOnce()).publications[0];
  assert.ok(
    (await h.runtime.app.inject("/api/v1/boards?metric=localization"))
      .json()
      .rows.every((row) => row.result.value === undefined || row.result.value === null || row.result.value === 0),
  );
  h.setPrivate(true);
  await assert.rejects(h.runtime.runOnce(), /public_source_not_verified/);
  assert.equal(
    (await h.runtime.app.inject(`/api/v1/boards?metric=localization&snapshot=${withdrawn.snapshotId}`)).statusCode,
    410,
  );
  assert.equal((await h.runtime.app.inject("/api/v1/boards?metric=localization")).statusCode, 503);
  assert.equal(await h.runtime.source.read(publicScope, snapshotId, new AbortController().signal), null);
});
