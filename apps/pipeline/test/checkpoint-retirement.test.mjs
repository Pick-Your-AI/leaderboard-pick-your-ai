import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { harness, getBoard, components, ago, boardUrl } from "./harness.mjs";

test("the default collector and normalizer scope real checkpoints and deny retired source reprobes before HTTP", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "leaderboard-pipeline-retirement-"));
  const cache = join(directory, "cache");
  const requests = [];
  const repositories = [
    { id: 2, slug: "synthetic-org/synthetic-repo", actor: 101 },
    { id: 3, slug: "synthetic-org/synthetic-other", actor: 102 },
  ];
  const payloads = new Map(
    repositories.map((repository) => [
      repository.id,
      {
        id: 1000 + repository.id,
        node_id: `SYNTHETIC_ISSUE_${repository.id}`,
        title: `Synthetic repository ${repository.id} issue`,
        number: 1,
        html_url: `https://github.com/${repository.slug}/issues/1`,
        created_at: ago(2),
        updated_at: ago(1),
        user: {
          id: repository.actor,
          node_id: `U_SYNTHETIC_${repository.actor}`,
          login: `synthetic-actor-${repository.actor}`,
          type: "User",
        },
      },
    ]),
  );
  const checkpoints = new components.github.FileCheckpointStore(cache);
  const githubClient = new components.github.GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => "synthetic-test-token",
    checkpoints,
    maxRetries: 0,
    fetch: async (value) => {
      const url = new URL(value);
      requests.push(url.pathname);
      const repository = repositories.find(
        (candidate) =>
          url.pathname === `/repos/${candidate.slug}` || url.pathname.startsWith(`/repos/${candidate.slug}/`),
      );
      assert.ok(repository, "only the two exact approved synthetic sources are requested");
      let body;
      if (url.pathname === `/repos/${repository.slug}`)
        body = { id: repository.id, private: false, full_name: repository.slug, default_branch: "main" };
      else if (url.pathname === `/repos/${repository.slug}/issues`) body = [payloads.get(repository.id)];
      else if (url.pathname === `/repos/${repository.slug}/issues/1`) body = payloads.get(repository.id);
      else assert.fail(`Unexpected synthetic endpoint ${url.pathname}`);
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json", etag: `"synthetic-repository-${repository.id}"` },
      });
    },
  });
  const h = await harness(t, {
    githubClient,
    source: undefined,
    probeRepository: undefined,
    configure(config) {
      config.repositories.push({
        id: 3,
        installationId: 1,
        slug: repositories[1].slug,
        families: ["issues"],
        approvalReceipt: "synthetic-other-source-approval",
      });
    },
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await h.runtime.runOnce()).state, "published");
  const before = await getBoard(h.runtime);
  assert.deepEqual(
    before.rows.map((row) => [row.actorId, row.result.value]),
    [
      ["101", 1],
      ["102", 1],
    ],
  );
  assert.deepEqual(await readdir(cache), ["repositories-v1"], "no source payload uses legacy unscoped HTTP keys");
  const retained = new Map();
  for (const repository of repositories) {
    const namespace = join(cache, "repositories-v1", String(repository.id));
    const files = await readdir(namespace);
    const records = await Promise.all(
      files.map(async (file) => JSON.parse(await readFile(join(namespace, file), "utf8"))),
    );
    assert.ok(
      records.some((record) => record.body?.id === repository.id),
      "visibility probe is repository scoped",
    );
    assert.ok(
      records.some((record) => Array.isArray(record.body)),
      "collection HTTP cache is repository scoped",
    );
    assert.ok(
      records.some((record) => record.complete === true && record.items?.length === 1),
      "scan state is repository scoped",
    );
    assert.ok(
      records.some((record) => record.body?.node_id === payloads.get(repository.id).node_id),
      "normalizer hydration is repository scoped",
    );
    for (const file of files) retained.set(`${repository.id}/${file}`, await readFile(join(namespace, file)));
  }
  const receipt = await githubClient.retireRepositoryCheckpoints(2, {
    operationId: "synthetic-pipeline-retirement",
    policyId: "synthetic-policy-v1",
    authorizationId: "synthetic-host-approval",
  });
  assert.equal(receipt.checkpointPayloadsRemoved, true);
  assert.equal(receipt.legacyUnscopedPayloads, "outside_scope");
  await assert.rejects(readdir(join(cache, "repositories-v1", "2")), { code: "ENOENT" });
  const otherFiles = await readdir(join(cache, "repositories-v1", "3"));
  assert.equal(otherFiles.length, [...retained.keys()].filter((key) => key.startsWith("3/")).length);
  for (const file of otherFiles)
    assert.deepEqual(await readFile(join(cache, "repositories-v1", "3", file)), retained.get(`3/${file}`));
  const calls = requests.length;
  await assert.rejects(h.runtime.runOnce(), /public_source_not_verified/);
  assert.equal(requests.length, calls, "the default source probe consults the tombstone before another HTTP request");
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
  assert.equal((await h.runtime.app.inject(`${boardUrl}&snapshot=${before.snapshotId}`)).statusCode, 410);
  assert.ok((await h.runtime.receipts()).some((item) => item.kind === "source_unavailable"));
  assert.equal(
    (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts")).rows[0].n,
    2,
    "checkpoint retirement does not certify deletion of downstream SQL facts",
  );
});
