import test from "node:test";
import assert from "node:assert/strict";
import { issueTransferHarness } from "./issue-transfer-harness.mjs";

async function board(runtime, repository, context) {
  const query = new URLSearchParams({
    metric: "issues_opened",
    context,
    ...(repository === null ? {} : { repository: String(repository) }),
  });
  const response = await runtime.app.inject(`/api/v1/boards?${query}`);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
const counts = (board) => board.rows.map((row) => [row.actorId, row.result.value]).sort();

test("an actual opened webhook proves creation repository while current repository follows the protected transfer", async (t) => {
  const h = await issueTransferHarness(t, {
    explicitOpened: true,
    configure(config) {
      config.scopes = config.scopes.flatMap((scope) => [scope, { ...scope, context: "event" }]);
    },
  });
  const publication = await h.runtime.runOnce();
  assert.equal(publication.state, "published", JSON.stringify(publication));
  const eventOrg = await board(h.runtime, null, "event");
  const eventSource = await board(h.runtime, 2, "event");
  const eventTarget = await board(h.runtime, 3, "event");
  const currentOrg = await board(h.runtime, null, "current");
  const currentSource = await board(h.runtime, 2, "current");
  const currentTarget = await board(h.runtime, 3, "current");
  for (const value of [eventOrg, eventSource, currentOrg])
    assert.deepEqual(counts(value), [
      ["101", 1],
      ["303", 1],
    ]);
  assert.deepEqual(counts(eventTarget), []);
  assert.deepEqual(counts(currentSource), [["303", 1]]);
  assert.deepEqual(counts(currentTarget), [["101", 1]]);
  for (const [value, context, repository, url] of [
    [eventSource, "event", 2, h.fixture.sourceUrl],
    [currentTarget, "current", 3, h.fixture.targetUrl],
  ]) {
    const id = value.rows.find((row) => row.actorId === "101").evidenceIds[0];
    const response = await h.runtime.app.inject(
      `/api/v1/evidence/${id}?metric=issues_opened&context=${context}&repository=${repository}&snapshot=${value.snapshotId}`,
    );
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().artifact.publicUrl, url);
    assert.equal(response.json().occurredAt, h.fixture.bornAt);
  }
  const proofs = (await h.db.query("SELECT document FROM leaderboard_pipeline.normalizations")).rows.flatMap(
    (row) => row.document.issueCreationScopes ?? [],
  );
  assert.ok(proofs.length > 0);
  assert.ok(
    proofs.every(
      (proof) =>
        proof.repositoryId === "2" &&
        proof.occurredAt === h.fixture.bornAt &&
        proof.eventId === "synthetic-original-opened",
    ),
  );
});

test("REST creation timestamps and a transfer origin alone cannot assign creation to an event repository", async (t) => {
  const h = await issueTransferHarness(t, {
    configure(config) {
      config.scopes = config.scopes.map((scope) => ({ ...scope, context: "event" }));
    },
  });
  await assert.rejects(h.runtime.runOnce(), /issue_transfer_event_scope_unavailable/);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
  const documents = (await h.db.query("SELECT document FROM leaderboard_pipeline.normalizations")).rows.map(
    (row) => row.document,
  );
  assert.ok(documents.some((doc) => doc.issueTransfers?.length));
  assert.equal(documents.flatMap((doc) => doc.issueCreationScopes ?? []).length, 0);
});
