import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createPipeline } from "../src/runtime.mjs";
import { ago, boardUrl, components, getBoard, harness } from "./harness.mjs";

const oldSlug = "synthetic-org/synthetic-repo";
const newSlug = "synthetic-org/renamed-repo";
const configKey = (value) => components.metrics.stableJSON(value);

async function sourceRows(h) {
  return (
    await h.db.query(
      "SELECT fact_key,repository_id,family,subject_id,source_revision,document,first_run_id " +
        "FROM leaderboard_ingestion.source_facts ORDER BY fact_key",
    )
  ).rows;
}

async function normalizationRows(h) {
  return (
    await h.db.query(
      "SELECT fact_key,policy_signature,document,document_hash " +
        "FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature",
    )
  ).rows;
}

function quantities(board) {
  return board.rows.map((row) => ({
    actorId: row.actorId,
    metricId: row.result.metricId,
    value: row.result.value,
    evidenceIds: [...row.evidenceIds].sort(),
  }));
}

async function evidence(runtime, board) {
  const ids = [...new Set(board.rows.flatMap((row) => row.evidenceIds))].sort();
  assert.equal(ids.length, 5);
  const proofs = [];
  for (const contributionId of ids) {
    const response = await runtime.app.inject(
      "/api/v1/evidence/" + encodeURIComponent(contributionId) + "?snapshot=" + encodeURIComponent(board.snapshotId),
    );
    assert.equal(response.statusCode, 200, response.body);
    const value = response.json();
    assert.equal(value.contribution.contributionId, contributionId);
    assert.equal(value.artifact.repositoryId, "2");
    assert.equal(value.artifact.visibility, "public");
    assert.equal(typeof value.contribution.canonicalEventId, "string");
    proofs.push({
      contributionId,
      canonicalEventId: value.contribution.canonicalEventId,
      artifactId: value.artifact.stableId,
      actorId: value.contribution.actorId,
      repositoryId: value.artifact.repositoryId,
      occurredAt: value.occurredAt,
      publicUrl: value.artifact.publicUrl,
    });
  }
  return proofs;
}

function identities(proofs) {
  return proofs.map(({ publicUrl: _publicUrl, ...identity }) => identity);
}

async function setup(t) {
  const grants = new Set();
  const createdAt = ago(2);
  const updatedAt = ago(1);
  const payloads = Array.from({ length: 5 }, (_, index) => ({
    id: 1001 + index,
    node_id: "SYNTHETIC_RENAME_ISSUE_" + (index + 1),
    number: index + 1,
    title: "Synthetic retained issue " + (index + 1),
    state: "open",
    html_url: "https://github.com/" + oldSlug + "/issues/" + (index + 1),
    created_at: createdAt,
    updated_at: updatedAt,
    user: {
      id: 101 + index,
      node_id: "U_SYNTHETIC_RENAME_" + (index + 1),
      login: "synthetic-rename-" + (index + 1),
      type: "User",
    },
  }));
  const h = await harness(t, {
    payloads,
    source: undefined,
    probeRepository: undefined,
    configure(config) {
      grants.add(configKey(config));
    },
    verifyConfiguration: async (config) => grants.has(configKey(config)),
  });
  assert.equal((await h.runtime.runOnce()).state, "published");
  const board = await getBoard(h.runtime);
  assert.equal(board.rows.length, 5);
  assert.deepEqual(
    quantities(board).map((row) => row.actorId),
    ["101", "102", "103", "104", "105"],
  );
  assert.deepEqual(
    quantities(board).map((row) => row.value),
    [1, 1, 1, 1, 1],
  );
  const proofs = await evidence(h.runtime, board);
  const rows = await sourceRows(h);
  const normalizations = await normalizationRows(h);
  assert.equal(rows.length, 5);
  assert.equal(normalizations.length, 5);
  const access = (
    await h.db.query(
      "SELECT repository_id,installation_id,state,generation " +
        "FROM leaderboard_ingestion.repository_access ORDER BY repository_id",
    )
  ).rows;
  assert.equal(access.length, 1);
  assert.equal(String(access[0].repository_id), "2");
  assert.equal(String(access[0].installation_id), "1");
  assert.equal(access[0].state, "public");
  await h.runtime.stop();

  const config = structuredClone(h.config);
  config.version = "synthetic-renamed-configuration-v2";
  config.approvalReceipt = "synthetic-renamed-configuration-approval";
  config.repositories[0].slug = newSlug;
  config.repositories[0].approvalReceipt = "synthetic-renamed-source-approval";
  const calls = [];
  const location = { id: 2, fullName: newSlug, private: false };
  const makeClient = () =>
    new components.github.GithubReadClient({
      apiOrigin: "https://api.synthetic.invalid",
      token: async () => "synthetic-rename-token",
      checkpoints: new components.github.FileCheckpointStore(join(h.directory, "http-checkpoints")),
      maxRetries: 0,
      fetch: async (value) => {
        const url = new URL(value);
        calls.push(url.pathname);
        let body;
        if ([oldSlug, newSlug].some((slug) => url.pathname === "/repos/" + slug)) {
          // Returned current metadata cannot approve the former configured binding.
          body = { id: location.id, private: location.private, full_name: location.fullName, default_branch: "main" };
        } else {
          const current = payloads.map((payload) => ({
            ...payload,
            html_url: "https://github.com/" + newSlug + "/issues/" + payload.number,
          }));
          if (url.pathname === "/repos/" + newSlug + "/issues") body = current;
          else {
            const number = Number(url.pathname.match(/\/issues\/([1-9]\d*)$/)?.[1]);
            assert.equal(url.pathname, "/repos/" + newSlug + "/issues/" + number);
            body = current.find((payload) => payload.number === number);
          }
        }
        assert.ok(body, "The synthetic source only admits the expected repository and issue routes");
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      },
    });
  const runtimes = [];
  return {
    ...h,
    original: { board, proofs, rows, normalizations, access },
    config,
    calls,
    location,
    approve() {
      // This synthetic host action approves the complete new document, not its requested hash.
      grants.add(configKey(config));
    },
    async open(selected = config) {
      const runtime = await createPipeline({
        ...h.options,
        config: selected,
        githubClient: makeClient(),
        source: undefined,
        probeRepository: undefined,
      });
      runtimes.push(runtime);
      return runtime;
    },
    async close() {
      for (const runtime of runtimes) await runtime.stop();
    },
  };
}

test("an explicitly approved rename retains native identities and quantities through collection and reopen", async (t) => {
  const h = await setup(t);
  try {
    const original = h.original;
    const stale = await h.open(h.options.config);
    await assert.rejects(stale.runOnce(), /public_source_not_verified/);
    assert.deepEqual(h.calls, ["/repos/" + oldSlug]);
    assert.deepEqual(await sourceRows(h), original.rows);
    assert.deepEqual(await normalizationRows(h), original.normalizations);
    await stale.stop();

    const current = await h.open();
    const beforeApprovalCalls = h.calls.length;
    assert.deepEqual(await current.runOnce(), { state: "blocked", reason: "approved_configuration_required" });
    assert.equal(h.calls.length, beforeApprovalCalls);
    assert.deepEqual(await sourceRows(h), original.rows);
    assert.deepEqual(await normalizationRows(h), original.normalizations);

    h.approve();
    const afterApproval = h.calls.length;
    assert.equal((await current.runOnce()).state, "published");
    assert.ok(h.calls.length > afterApproval);
    assert.equal(
      h.calls.slice(afterApproval).every((path) => path.startsWith("/repos/" + newSlug)),
      true,
    );
    const renamed = await getBoard(current);
    assert.notEqual(renamed.snapshotId, original.board.snapshotId);
    assert.deepEqual(quantities(renamed), quantities(original.board));
    const renamedProofs = await evidence(current, renamed);
    assert.deepEqual(identities(renamedProofs), identities(original.proofs));
    assert.deepEqual(
      renamedProofs.map((proof) => proof.publicUrl),
      original.proofs.map((proof) => proof.publicUrl.replace(oldSlug, newSlug)),
    );

    const collected = await sourceRows(h);
    assert.equal(collected.length, 10);
    const oldKeys = new Set(original.rows.map((row) => row.fact_key));
    assert.deepEqual(
      collected.filter((row) => oldKeys.has(row.fact_key)),
      original.rows,
    );
    const refreshed = collected.filter((row) => !oldKeys.has(row.fact_key));
    assert.deepEqual(refreshed.map((row) => row.subject_id).sort(), original.rows.map((row) => row.subject_id).sort());
    assert.equal(
      refreshed.every(
        (row) =>
          String(row.repository_id) === "2" &&
          row.document.sourceUrl.startsWith("https://github.com/" + newSlug + "/issues/"),
      ),
      true,
    );
    const normalized = await normalizationRows(h);
    assert.equal(normalized.length, 10);
    assert.deepEqual(
      normalized.filter((row) => oldKeys.has(row.fact_key)),
      original.normalizations,
    );
    const access = (
      await h.db.query(
        "SELECT repository_id,installation_id,state,generation " +
          "FROM leaderboard_ingestion.repository_access ORDER BY repository_id",
      )
    ).rows;
    assert.equal(access.length, 1);
    assert.equal(String(access[0].repository_id), "2");
    assert.equal(String(access[0].installation_id), "1");
    assert.equal(access[0].state, "public");
    assert.ok(Number(access[0].generation) > Number(original.access[0].generation));

    await current.stop();
    await h.reopenDatabase();
    const reopened = await h.open();
    assert.deepEqual(quantities(await getBoard(reopened)), quantities(renamed));
    assert.equal((await reopened.runOnce()).state, "published");
    const replayed = await getBoard(reopened);
    assert.deepEqual(quantities(replayed), quantities(renamed));
    assert.deepEqual(await evidence(reopened, replayed), renamedProofs);
    assert.deepEqual(await sourceRows(h), collected);
    assert.deepEqual(await normalizationRows(h), normalized);
  } finally {
    await h.close();
  }
});

for (const [label, changed] of [
  ["a different native repository", { id: 3 }],
  ["a private repository", { private: true }],
]) {
  test("an approved renamed slug cannot authorize " + label, async (t) => {
    const h = await setup(t);
    try {
      h.approve();
      Object.assign(h.location, changed);
      const current = await h.open();
      await assert.rejects(current.runOnce(), /public_source_not_verified/);
      assert.deepEqual(h.calls, ["/repos/" + newSlug]);
      assert.deepEqual(await sourceRows(h), h.original.rows);
      assert.deepEqual(await normalizationRows(h), h.original.normalizations);
      assert.equal((await current.app.inject(boardUrl)).statusCode, 503);
      const access = (
        await h.db.query("SELECT state FROM leaderboard_ingestion.repository_access WHERE repository_id=2")
      ).rows;
      assert.deepEqual(access, [{ state: "unavailable" }]);
    } finally {
      await h.close();
    }
  });
}
