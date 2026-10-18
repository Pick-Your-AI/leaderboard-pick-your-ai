import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createPipeline, loadPipelineComponents, migratePipeline } from "../src/index.mjs";

const checkout = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const roots = process.env.PIPELINE_COMPONENT_ROOTS ? JSON.parse(process.env.PIPELINE_COMPONENT_ROOTS) : {};
const ingestionRoot = roots.ingestion ?? checkout;
const require = createRequire(join(ingestionRoot, "packages/ingestion/package.json"));
const { PGlite } = require("@electric-sql/pglite");
const components = await loadPipelineComponents(roots);
const scope = { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null };

test("mutable review and Discussion snapshots replace current credit while pinned publications retain their evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "leaderboard-mutable-source-"));
  const engine = new PGlite(join(directory, "postgres"));
  const db = {
    query: (sql, params) => engine.query(sql, params),
    transaction: (work) => engine.transaction((tx) => work({ query: (sql, params) => tx.query(sql, params) })),
  };
  let runtime, controlsStore;
  t.after(async () => {
    await runtime?.stop();
    controlsStore?.close();
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  });
  for (const name of [
    "001_ingestion.up.sql",
    "002_snapshots.up.sql",
    "003_collection.up.sql",
    "004_outbox_dispatch.up.sql",
    "007_operator_replay_results.up.sql",
  ])
    await engine.exec(await readFile(join(ingestionRoot, "packages/ingestion/sql", name), "utf8"));
  await migratePipeline(db);
  controlsStore = new components.controls.ControlStore(join(directory, "controls.sqlite"));
  const slug = "synthetic-org/synthetic-mutable-repo";
  const at = new Date(Date.now() - 86400000).toISOString();
  const actor = (id) => ({ id, node_id: `U_SYNTHETIC_${id}`, login: `synthetic-${id}`, type: "User" });
  const graphqlActor = (id) => ({
    id: `U_SYNTHETIC_${id}`,
    databaseId: id,
    __typename: "User",
    login: `synthetic-${id}`,
  });
  const pull = {
    id: 10,
    node_id: "PR_SYNTHETIC_10",
    number: 10,
    html_url: `https://github.com/${slug}/pull/10`,
    user: actor(101),
    created_at: at,
    updated_at: at,
    state: "open",
    head: { sha: "a".repeat(40) },
  };
  let review = {
    id: 51,
    node_id: "R_SYNTHETIC_51",
    html_url: `${pull.html_url}#pullrequestreview-51`,
    user: actor(303),
    state: "APPROVED",
    submitted_at: at,
    commit_id: "a".repeat(40),
    body: "Synthetic review only",
  };
  let discussion = {
    id: "D_SYNTHETIC_4",
    url: `https://github.com/${slug}/discussions/4`,
    createdAt: at,
    updatedAt: at,
    author: graphqlActor(101),
    answerChosenAt: at,
    answerChosenBy: graphqlActor(202),
    answer: { id: "DC_SYNTHETIC_5", isAnswer: true, author: graphqlActor(404) },
  };
  const graphqlPaths = [];
  const githubClient = new components.github.GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => "synthetic-test-token",
    maxRetries: 0,
    checkpoints: new components.github.FileCheckpointStore(join(directory, "http-checkpoints")),
    fetch: async (value, options) => {
      const url = new URL(value);
      let body;
      if (url.pathname === "/graphql") {
        const request = JSON.parse(options.body);
        graphqlPaths.push(request.query);
        if (request.query.includes("discussion(number:"))
          assert.match(
            request.query,
            /author\s*\{[^}]*\bid\b/,
            "hydration must request actor node IDs shared with REST",
          );
        body = {
          data: {
            repository: {
              databaseId: 2,
              isPrivate: false,
              hasDiscussionsEnabled: true,
              ...(request.query.includes("discussions(first:")
                ? { discussions: { nodes: [discussion], pageInfo: { hasNextPage: false, endCursor: null } } }
                : { discussion }),
            },
          },
        };
      } else if (url.pathname === `/repos/${slug}`)
        body = { id: 2, private: false, full_name: slug, default_branch: "main" };
      else if (url.pathname === `/repos/${slug}/pulls`) body = [pull];
      else if (url.pathname === `/repos/${slug}/pulls/10`) body = pull;
      else if (url.pathname === `/repos/${slug}/pulls/10/reviews`) body = [review];
      else if (url.pathname === `/repos/${slug}/pulls/10/reviews/51`) body = review;
      return new Response(JSON.stringify(body ?? { message: "synthetic missing route" }), {
        status: body ? 200 : 404,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const policies = [
    ["prs_reviewed", "reviewer"],
    ["discussion_answers", "author"],
  ].map(([metricId, role]) => {
    const policy = {
      metricId,
      version: "synthetic-mutable-policy-v1",
      definitionVersion: components.metrics.metricRegistryV1.policy_version,
      unit: components.metrics.getMetricDefinition(metricId).definition.unit,
      aggregation: "count",
      dateBasis: "occurredAt",
      rankedStates: ["observed"],
      roles: [role],
      groupBy: "actor_artifact",
      sources: ["github_rest", "github_graphql"],
      minimumSamples: 1,
      rank: true,
    };
    return { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-policy-approval" };
  });
  const config = {
    version: "synthetic-mutable-configuration-v1",
    organization: "Pick-Your-AI",
    approvalReceipt: "synthetic-config-approval",
    repositories: [
      {
        id: 2,
        installationId: 1,
        slug,
        families: ["reviews", "discussions"],
        approvalReceipt: "synthetic-source-approval",
      },
    ],
    policies,
    scopes: [scope],
  };
  runtime = await createPipeline({
    components,
    db,
    controlsStore,
    githubClient,
    sourceId: "installation:1",
    config,
    dataMode: "synthetic",
    cursorSecret: "synthetic-mutable-cursor-secret-at-least-32-characters",
    verifyConfiguration: async () => true,
  });
  const board = async (metric, snapshot = null) => {
    const response = await runtime.app.inject(
      `/api/v1/boards?metric=${metric}${snapshot ? `&snapshot=${snapshot}` : ""}`,
    );
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const positiveRows = (value) =>
    value.rows.filter((row) => row.result.value > 0).map((row) => [row.actorId, row.result.value]);
  const run = async () => {
    const outcome = await runtime.runOnce({ cutoff: new Date().toISOString() });
    assert.equal(outcome.state, "published", JSON.stringify(outcome));
    return outcome.publications[0].snapshotId;
  };
  const first = await run();
  assert.deepEqual(positiveRows(await board("prs_reviewed")), [["303", 1]]);
  assert.deepEqual(positiveRows(await board("discussion_answers")), [["404", 1]]);
  const firstRead = await runtime.source.read(scope, first, new AbortController().signal);
  const initialAnswer = firstRead.selected.portfolioEvidence.find((entry) =>
    entry.contribution.metricIds.includes("discussion_answers"),
  );
  assert.equal(initialAnswer.contribution.actorId, "404");
  assert.equal(initialAnswer.evidenceMetadata.activityState, "observed");
  assert.equal(initialAnswer.evidenceMetadata.acceptedAt, null);
  assert.equal(initialAnswer.evidenceMetadata.sourceOccurredAt, at);
  assert.equal(initialAnswer.evidenceMetadata.artifactTitle, null);

  // Neither REST submitted_at nor GraphQL updatedAt changes on these mutations.
  review = { ...review, state: "DISMISSED" };
  discussion = { ...discussion, answer: null, answerChosenAt: null, answerChosenBy: null };
  const second = await run();
  assert.notEqual(first, second);
  assert.deepEqual(positiveRows(await board("prs_reviewed")), []);
  assert.deepEqual(positiveRows(await board("discussion_answers")), []);
  assert.deepEqual(positiveRows(await board("prs_reviewed", first)), [["303", 1]]);
  assert.deepEqual(positiveRows(await board("discussion_answers", first)), [["404", 1]]);

  review = { ...review, state: "APPROVED" };
  const third = await run();
  assert.notEqual(third, second);
  assert.deepEqual(positiveRows(await board("prs_reviewed")), [["303", 1]]);
  assert.deepEqual(positiveRows(await board("discussion_answers")), []);
  assert.deepEqual(positiveRows(await board("prs_reviewed", second)), []);
  const sourceRows = (
    await db.query("SELECT family,source_revision FROM leaderboard_ingestion.source_facts ORDER BY observed_at")
  ).rows;
  const reviews = sourceRows.filter((row) => row.family === "reviews");
  assert.equal(reviews.length, 3);
  assert.equal(new Set(reviews.map((row) => row.source_revision)).size, 3);
  assert.equal(reviews[0].source_revision.split(".")[0], reviews[2].source_revision.split(".")[0]);
  assert.ok(graphqlPaths.some((query) => query.includes("discussions(first:")));
  assert.ok(graphqlPaths.some((query) => query.includes("discussion(number:")));
  const normalized = (await db.query("SELECT document FROM leaderboard_pipeline.normalizations")).rows.flatMap(
    (row) => row.document.facts,
  );
  const answerFacts = normalized.filter((fact) => fact.metricId === "discussion_answers");
  assert.equal(answerFacts.length, 1);
  assert.equal(answerFacts[0].actorId, "404");
  assert.equal(answerFacts[0].acceptedBy, "202");
  assert.equal(answerFacts[0].state, "observed");
});
