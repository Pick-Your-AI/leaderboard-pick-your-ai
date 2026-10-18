import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGithubObservation, applyRecognitionReceipt } from "../../../packages/github/dist/index.js";
import { publicEvidenceMetadataSchema } from "../../../packages/contracts/dist/index.js";
import { createService } from "../../service/dist/app.js";
import { materializeEvidenceMetadata, selectEvidenceMetadata } from "../src/evidence-metadata.mjs";
const created = "2026-10-01T10:00:00.000Z",
  collected = "2026-10-03T10:00:00.000Z";
const history = {
  coverage: "partial",
  records: [
    { kind: "correction", occurredAt: null, publicUrl: "https://github.com/synthetic/example/issues/1#issuecomment-2" },
  ],
};
function normalized(title = "Current <script> literal title", observedAt = collected) {
  return normalizeGithubObservation({
    repository: { id: 2, slug: "synthetic/example", visibility: "public" },
    proof: { verified: true, source: "github_rest", revision: "r1", isSynthetic: true },
    family: "issue",
    action: "snapshot",
    observedAt,
    publicHistory: { approvedPublic: true, history },
    payload: {
      id: 1,
      title,
      created_at: created,
      html_url: "https://github.com/synthetic/example/issues/1",
      user: { id: 101, type: "User", login: "synthetic-alice" },
    },
  });
}
function publication(output) {
  const coverage = {
    schemaVersion: "leaderboard/v1",
    state: "partial",
    source: "github_rest",
    scopeId: "2",
    windowStart: null,
    windowEnd: null,
    knownStart: null,
    lastSuccessfulSync: collected,
    sourceWatermark: collected,
    missingPages: 0,
    permissionsMissing: [],
    sourceErrors: [],
  };
  const evidence = output.evidence.map((entry) => ({
    ...entry,
    ...materializeEvidenceMetadata(
      entry,
      output.facts.find((fact) => fact.id === entry.contribution.contributionId),
    ),
  }));
  return {
    head: { snapshotId: "snapshot-1", revision: 1, publishedAt: collected },
    controls: { version: "controls-1", suppressedActorIds: [], suppressedArtifactIds: [], revokedSnapshotIds: [] },
    selected: {
      approvedPublic: true,
      scope: { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null },
      snapshot: {
        schemaVersion: "leaderboard/v1",
        snapshotId: "snapshot-1",
        revision: 1,
        generatedAt: collected,
        metricDefinitionVersion: "candidate-0.1.0",
        computationVersion: "synthetic-v1",
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
            githubDatabaseId: 101,
            login: "synthetic-alice",
            kind: "user",
            executionMode: "unknown",
          },
        },
      ],
      evidence,
      portfolioEvidence: evidence.map((entry) => ({
        ...entry,
        activityState: entry.evidenceMetadata.activityState,
        observedAt: entry.evidenceMetadata.observedAt,
      })),
      rows: [
        {
          actorId: "101",
          result: { schemaVersion: "leaderboard/v1", metricId: "issues_opened", state: "partial", value: 1, coverage },
          evidenceIds: [evidence[0].contribution.contributionId],
        },
      ],
      ranking: [{ metricId: "issues_opened", direction: "descending" }],
    },
  };
}

test("actual source normalization and materialization reach identical anonymous evidence and activity detail under privacy controls", async (t) => {
  const output = normalized(),
    data = publication(output);
  const app = createService({ source: { read: async () => structuredClone(data) } });
  t.after(() => app.close());
  const id = output.facts[0].id;
  const detail = await app.inject(`/api/v1/evidence/${id}?snapshot=snapshot-1`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().evidenceMetadata.sourceAction, "artifact_created");
  assert.equal(detail.json().evidenceMetadata.artifactTitle.value, "Current <script> literal title");
  assert.equal(detail.json().evidenceMetadata.acceptedAt, null);
  const feed = (await app.inject("/api/v1/activity?snapshot=snapshot-1")).json();
  const group = await app.inject(`/api/v1/activity/${feed.groups[0].groupId}?snapshot=snapshot-1`);
  assert.equal(group.statusCode, 200, group.body);
  assert.deepEqual(group.json().proofs[0].evidenceMetadata, detail.json().evidenceMetadata);
  data.controls.suppressedArtifactIds.push(output.facts[0].artifactId);
  assert.equal((await app.inject(`/api/v1/evidence/${id}?snapshot=snapshot-1`)).statusCode, 404);
  assert.equal((await app.inject(`/api/v1/activity/${feed.groups[0].groupId}?snapshot=snapshot-1`)).statusCode, 404);
});

test("materialization never publishes an observed ratio decision clock as acceptance or accepts a private receipt-free claim", () => {
  const output = normalized(),
    fact = output.facts[0],
    entry = output.evidence[0];
  const raw = materializeEvidenceMetadata(entry, {
    ...fact,
    acceptedAt: created,
    outcome: "closed_unmerged",
    metricId: "pr_accepted_rate",
  });
  assert.equal(raw.evidenceMetadata.acceptedAt, null);
  assert.equal(raw.evidenceMetadata.activityState, "observed");
  for (const patch of [{ acceptanceReceipt: null }, { acceptedBy: "101" }, { acceptedAt: null }]) {
    assert.throws(
      () =>
        materializeEvidenceMetadata(entry, {
          ...fact,
          state: "qualified",
          acceptedAt: collected,
          acceptedBy: "202",
          acceptanceReceipt: "private-receipt",
          ...patch,
        }),
      /public_acceptance_requires_independent_receipt/,
    );
  }
  const accepted = applyRecognitionReceipt(
    output,
    {
      verified: true,
      id: "private-receipt",
      metricId: "issues_opened",
      actorId: "101",
      reviewerId: "202",
      acceptedAt: collected,
      decision: "accepted",
      targetFactId: fact.id,
      evidenceIds: ["private-evidence"],
    },
    ["202"],
  );
  const projected = materializeEvidenceMetadata(accepted.evidence.at(-1), accepted.facts.at(-1));
  assert.equal(projected.evidenceMetadata.acceptedAt, collected);
  assert.equal(projected.evidenceMetadata.sourceOccurredAt, created);
  assert.doesNotMatch(JSON.stringify(projected), /private-receipt|private-evidence|acceptedBy/);
});

test("recollection selects a bounded as-collected label deterministically without manufacturing title or correction history", () => {
  const old = normalized("Old label").evidence[0],
    newer = normalized("New label", "2026-10-04T10:00:00.000Z").evidence[0];
  assert.deepEqual(selectEvidenceMetadata(old, newer), newer);
  assert.deepEqual(selectEvidenceMetadata(newer, old), newer);
  assert.equal(selectEvidenceMetadata(old, newer).evidenceMetadata.history.records.length, 1);
  const projected = materializeEvidenceMetadata(selectEvidenceMetadata(old, newer), normalized("Old label").facts[0]);
  assert.equal(projected.evidenceMetadata.artifactTitle.value, "New label");
  assert.equal(projected.evidenceMetadata.artifactTitle.collectedAt, "2026-10-04T10:00:00.000Z");
  assert.equal(projected.evidenceMetadata.observedAt, collected);

  const conflict = structuredClone(newer);
  conflict.evidenceMetadata.sourceAction = "issue_closed";
  assert.throws(() => selectEvidenceMetadata(old, conflict), /conflicting_evidence_metadata/);
});

test("strict public contract and provider reject private fields, fabricated history coverage, malformed clocks and contradictory acceptance", async (t) => {
  const data = publication(normalized()),
    original = structuredClone(data.selected.evidence[0].evidenceMetadata);
  const app = createService({ source: { read: async () => structuredClone(data) } });
  t.after(() => app.close());
  const id = data.selected.evidence[0].contribution.contributionId;
  for (const patch of [
    { privateReceipt: "secret" },
    { acceptedAt: collected },
    { sourceAction: "closed" },
    { observedAt: "2026-02-30T00:00:00.000Z" },
    { history: { coverage: "complete", records: [] } },
    { history: { coverage: "partial", records: [{ ...history.records[0], body: "private narrative" }] } },
    { artifactTitle: { value: "x".repeat(201), basis: "as_collected", collectedAt: collected } },
    { artifactTitle: { value: "x", basis: "event_time", collectedAt: collected } },
  ]) {
    data.selected.evidence[0].evidenceMetadata = { ...original, ...patch };
    assert.equal(publicEvidenceMetadataSchema.safeParse(data.selected.evidence[0].evidenceMetadata).success, false);
    const response = await app.inject(`/api/v1/evidence/${id}`);
    assert.equal(response.statusCode, 503, response.body);
    assert.doesNotMatch(response.body, /private narrative|secret/);
  }
  data.selected.evidence[0].evidenceMetadata = original;
  const portfolioMetadata = structuredClone(data.selected.portfolioEvidence[0].evidenceMetadata);
  data.selected.portfolioEvidence[0].evidenceMetadata.artifactTitle.value = "Contradictory label";
  assert.equal((await app.inject(`/api/v1/evidence/${id}`)).statusCode, 503);
  data.selected.portfolioEvidence[0].evidenceMetadata = portfolioMetadata;
  data.selected.portfolioEvidence[0].activityState = "accepted";
  assert.equal((await app.inject(`/api/v1/evidence/${id}`)).statusCode, 503);
});

test("public metadata bounds history cardinality and serialized bytes without claiming complete empty history", () => {
  const metadata = normalized().evidence[0].evidenceMetadata;
  const record = { kind: "correction", occurredAt: null, publicUrl: "https://github.com/synthetic/example/issues/1" };
  for (const badHistory of [
    { coverage: "partial", records: [] },
    { coverage: "not_supplied", records: [record] },
    { coverage: "partial", records: Array.from({ length: 21 }, () => record) },
    {
      coverage: "partial",
      records: Array.from({ length: 20 }, () => ({
        ...record,
        publicUrl: "https://github.com/synthetic/example/" + "x".repeat(1000),
      })),
    },
  ])
    assert.equal(publicEvidenceMetadataSchema.safeParse({ ...metadata, history: badHistory }).success, false);
});

test("pending evidence and activity routes reject mixed present/absent metadata in either projection order while preserving wholly legacy copies", async (t) => {
  const data = publication(normalized());
  const id = data.selected.evidence[0].contribution.contributionId;
  for (const list of [data.selected.evidence, data.selected.portfolioEvidence])
    for (const entry of list) {
      entry.evidenceMetadata.activityState = "pending";
      if ("activityState" in entry) entry.activityState = "pending";
    }
  data.selected.pendingEvidence = structuredClone(data.selected.portfolioEvidence);
  data.selected.rows[0].pending = {
    schemaVersion: "leaderboard-pending/v1",
    state: "partial",
    valueClass: "qualified",
    count: 1,
    evidenceIds: [id],
  };
  const savedMetadata = structuredClone(data.selected.evidence[0].evidenceMetadata);
  const lists = ["evidence", "portfolioEvidence", "pendingEvidence"];
  const app = createService({ source: { read: async () => structuredClone(data) } });
  t.after(() => app.close());
  const evidenceRoute = `/api/v1/evidence/${id}?snapshot=snapshot-1`;
  const feedRoute = "/api/v1/activity?snapshot=snapshot-1";
  const feed = await app.inject(feedRoute);
  assert.equal(feed.statusCode, 200, feed.body);
  const activityRoute = `/api/v1/activity/${feed.json().groups[0].groupId}?snapshot=snapshot-1`;
  const detail = await app.inject(evidenceRoute),
    activity = await app.inject(activityRoute);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(activity.statusCode, 200, activity.body);
  assert.deepEqual(detail.json().evidenceMetadata, activity.json().proofs[0].evidenceMetadata);

  // Projection order is evidence, portfolio, pending; exercise missing→present,
  // present→missing, and the pending-first detail route's independent preference.
  for (const absent of [["pendingEvidence"], ["evidence"], ["evidence", "portfolioEvidence"], ["portfolioEvidence"]]) {
    for (const list of lists)
      for (const entry of data.selected[list]) {
        if (absent.includes(list)) delete entry.evidenceMetadata;
        else entry.evidenceMetadata = structuredClone(savedMetadata);
      }
    for (const route of [evidenceRoute, activityRoute, feedRoute]) {
      const response = await app.inject(route);
      assert.equal(response.statusCode, 503, `${absent.join(",")}: ${response.body}`);
      assert.doesNotMatch(response.body, /Current .* literal title|issuecomment-2/);
    }
  }
  for (const list of lists) for (const entry of data.selected[list]) delete entry.evidenceMetadata;
  const legacyDetail = await app.inject(evidenceRoute),
    legacyActivity = await app.inject(activityRoute);
  assert.equal(legacyDetail.statusCode, 200, legacyDetail.body);
  assert.equal(legacyActivity.statusCode, 200, legacyActivity.body);
  assert.equal(legacyDetail.json().evidenceMetadata, undefined);
  assert.equal(legacyActivity.json().proofs[0].evidenceMetadata, undefined);
  assert.equal((await app.inject(feedRoute)).statusCode, 200);
});
