import assert from "node:assert/strict";
import test from "node:test";
import { harness, getBoard, components } from "./harness.mjs";

for (const visibility of ["private", "unapproved"]) {
  test(
    "a " + visibility + " transfer without a usable source URL withdraws already published and pinned evidence",
    async (t) => {
      let withdraw = false;
      const h = await harness(t, {
        normalizerFactory(options) {
          const ordinary = components.github.createGithubEvidenceNormalizer({
            client: options.githubClient,
            source: "installation:1",
            allowedRepositoryIds: [2],
            isSynthetic: true,
          });
          return async (input) => {
            if (!withdraw || input.fact.subjectId !== "SYNTHETIC_ISSUE_1") return ordinary(input);
            return components.github.normalizeGithubObservation({
              repository: { ...input.repository, visibility: "public" },
              proof: {
                verified: true,
                source: "github_webhook",
                revision: input.fact.sourceRevision,
                eventId: "synthetic-transfer-withdrawal",
                isSynthetic: true,
              },
              family: "relationship",
              action: "transferred",
              occurredAt: null,
              observedAt: input.observedAt,
              payload: {
                issue: {
                  node_id: input.fact.subjectId,
                  ...(visibility === "unapproved" ? { html_url: "https://example.invalid/unusable" } : {}),
                },
                destination: {
                  visibility: visibility === "private" ? "private" : "public",
                  allowed: false,
                },
              },
            });
          };
        },
      });
      assert.equal((await h.runtime.runOnce()).state, "published");
      const original = await getBoard(h.runtime);
      const evidenceId = original.rows.find((row) => row.actorId === "101").evidenceIds[0];
      h.duplicate();
      withdraw = true;
      assert.equal((await h.runtime.runOnce()).state, "published");
      const current = await getBoard(h.runtime);
      const pinned = await getBoard(h.runtime, "&snapshot=" + original.snapshotId);
      const evidence = await h.runtime.app.inject(
        "/api/v1/evidence/" + evidenceId + "?snapshot=" + original.snapshotId,
      );
      const json = await h.runtime.app.inject(
        "/api/v1/exports?metric=issues_opened&format=json&snapshot=" + original.snapshotId,
      );
      const csv = await h.runtime.app.inject(
        "/api/v1/exports?metric=issues_opened&format=csv&snapshot=" + original.snapshotId,
      );
      const suppressed = await h.db.query(
        "SELECT subject_id FROM leaderboard_ingestion.object_suppressions WHERE repository_id=2 ORDER BY subject_id",
      );
      assert.deepEqual(
        {
          suppressed: suppressed.rows.map((row) => row.subject_id),
          current: current.rows.map((row) => row.actorId),
          pinned: pinned.rows.map((row) => row.actorId),
          evidenceStatus: evidence.statusCode,
          jsonStatus: json.statusCode,
          csvStatus: csv.statusCode,
          jsonExposesWithdrawnEvidence: json.body.includes(evidenceId) || json.body.includes("synthetic-alice"),
          csvExposesWithdrawnEvidence: csv.body.includes(evidenceId) || csv.body.includes("synthetic-alice"),
        },
        {
          suppressed: ["SYNTHETIC_ISSUE_1"],
          current: ["102"],
          pinned: ["102"],
          evidenceStatus: 404,
          jsonStatus: 200,
          csvStatus: 200,
          jsonExposesWithdrawnEvidence: false,
          csvExposesWithdrawnEvidence: false,
        },
      );
    },
  );
}
