import assert from "node:assert/strict";
import test from "node:test";
import { createGithubCollectionSource } from "../src/github-source.mjs";
import { syntheticCheckpointStore } from "../../../packages/github/test/synthetic-client.mjs";
import { ago, clock, components, harness } from "./harness.mjs";

const discussionBoardUrl = "/api/v1/boards?metric=discussion_answers";
const slug = "synthetic-org/synthetic-repo";
const actor = (id) => ({ id: `U_SYNTHETIC_${id}`, databaseId: id, login: `synthetic-${id}`, __typename: "User" });

/** Synthetic HTTP only: the actual client, collector, normalizer, SQL publication,
 * SQLite controls and public service remain in the path. The memory checkpoint
 * and in-memory PGlite do not assert durable reopen or real source approval.
 * This policy is explicitly approved by the test host, not the public registry. */
async function discussionHarness(t, runtimeOptions = {}) {
  const enabled = true,
    empty = false;
  const state = {
    enabled,
    privateRepository: false,
    rows: empty
      ? []
      : [
          {
            id: "D_SYNTHETIC_CAPABILITY",
            url: `https://github.com/${slug}/discussions/4`,
            createdAt: ago(3),
            updatedAt: ago(1),
            author: actor(101),
            answerChosenAt: ago(1),
            answerChosenBy: actor(202),
            answer: { id: "DC_SYNTHETIC_CAPABILITY", createdAt: ago(2), isAnswer: true, author: actor(303) },
          },
        ],
    collections: 0,
    hydrations: 0,
  };
  const githubClient = new components.github.GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => "synthetic-discussion-capability-token",
    checkpoints: syntheticCheckpointStore(),
    maxRetries: 0,
    fetch: async (value, options) => {
      const url = new URL(value);
      assert.equal(url.origin, "https://api.synthetic.invalid");
      let body;
      if (url.pathname === `/repos/${slug}`) {
        body = { id: 2, private: state.privateRepository, full_name: slug, default_branch: "main" };
      } else {
        assert.equal(url.pathname, "/graphql");
        const { query, variables } = JSON.parse(options.body);
        assert.equal(variables.owner, "synthetic-org");
        assert.equal(variables.name, "synthetic-repo");
        const repository = {
          databaseId: 2,
          isPrivate: state.privateRepository,
          hasDiscussionsEnabled: state.enabled,
        };
        if (/\bdiscussions\(/.test(query)) {
          state.collections++;
          assert.equal(variables.after, null);
          repository.discussions = {
            nodes: structuredClone(state.rows),
            pageInfo: { hasNextPage: false, endCursor: null },
          };
        } else {
          state.hydrations++;
          assert.match(query, /\bdiscussion\(/);
          assert.match(query, /answer\s*\{[^}]*\bcreatedAt\b/);
          repository.discussion = structuredClone(state.rows[0] ?? null);
        }
        body = { data: { repository } };
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const source = createGithubCollectionSource({
    client: githubClient,
    sourceId: "installation:1",
    repositories: [{ id: 2, installationId: 1, slug, families: ["discussions"] }],
    isSynthetic: true,
  });
  const h = await harness(t, {
    memoryDatabase: true,
    githubClient,
    source,
    probeRepository: source.probeRepository,
    configure(config) {
      config.repositories[0].families = ["discussions"];
      const policy = {
        ...config.policies[0].policy,
        metricId: "discussion_answers",
        unit: components.metrics.getMetricDefinition("discussion_answers").definition.unit,
        roles: ["author"],
        sources: ["github_graphql"],
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-policy" },
      ];
    },
    ...runtimeOptions,
  });
  return {
    ...h,
    state,
    collect: (options = {}) => h.runtime.runOnce({ cutoff: clock(), ...options }),
  };
}

const version = components.github.discussionSourceNormalizationVersion;
const unavailable = /discussion_normalizer_version_unverified/;
const cacheRows = async (h) =>
  (
    await h.db.query(
      "SELECT fact_key,policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature",
    )
  ).rows;
const snapshotRows = async (h) =>
  (
    await h.db.query(
      "SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id",
    )
  ).rows;
function publication(result) {
  assert.equal(result.state, "published", JSON.stringify(result));
  assert.equal(result.publications.length, 1);
  return result.publications[0];
}
function replacement(after = async () => {}) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    runtimeOptions: {
      discussionSourceNormalizationVersion: version,
      normalizerFactory(options) {
        const normalize = components.github.createGithubEvidenceNormalizer({
          client: options.githubClient,
          source: options.sourceId,
          allowedRepositoryIds: [2],
          isSynthetic: true,
        });
        return async (input) => {
          calls++;
          const output = await normalize(input);
          assert.ok(output.facts.some((fact) => fact.metricId === "discussion_answers" && fact.actorId === "303"));
          await after(options, input, output);
          return output;
        };
      },
    },
  };
}
function loseCompatibility(h) {
  delete h.options.normalizer;
  delete h.options.githubEnrich;
  delete h.options.discussionSourceNormalizationVersion;
}
function afterTransaction(h, predicate, after) {
  const transaction = h.db.transaction;
  h.db.transaction = async (work) => {
    let matched = false;
    const result = await transaction((tx) =>
      work({
        query: async (sql, params) => {
          const value = await tx.query(sql, params);
          matched ||= predicate(sql);
          return value;
        },
      }),
    );
    if (matched) after();
    return result;
  };
}
async function noVisibility(h) {
  assert.deepEqual(await snapshotRows(h), []);
  assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
  assert.deepEqual(h.controlsStore.read().pipelineHeads ?? {}, {});
}
async function visibleAnswer(h) {
  const response = await h.runtime.app.inject(discussionBoardUrl);
  assert.equal(response.statusCode, 200, response.body);
  const rows = response.json().rows;
  assert.deepEqual(
    rows.filter((row) => row.result.value > 0).map((row) => [row.actorId, row.result.value]),
    [["303", 1]],
  );
}

test("plain Discussion retains the selected replacement when its option and declaration disappear", async (t) => {
  const custom = replacement();
  const h = await discussionHarness(t, custom.runtimeOptions);
  loseCompatibility(h);
  await assert.rejects(h.collect(), unavailable);
  assert.equal(custom.calls, 0);
  assert.deepEqual(await cacheRows(h), []);
  await noVisibility(h);
});

test("plain Discussion retains the selected enrichment when its option and declaration disappear", async (t) => {
  let calls = 0;
  const h = await discussionHarness(t, {
    discussionSourceNormalizationVersion: version,
    githubEnrich: async () => {
      calls++;
      return null;
    },
  });
  loseCompatibility(h);
  await assert.rejects(h.collect(), unavailable);
  assert.equal(calls, 0);
  assert.deepEqual(await cacheRows(h), []);
  await noVisibility(h);
});

test("unused later replacement and enrichment options cannot change the captured built-in Discussion provider", async (t) => {
  const h = await discussionHarness(t);
  let unused = 0;
  h.options.normalizer = h.options.githubEnrich = async () => {
    unused++;
    throw Error("unused provider");
  };
  const current = publication(await h.collect());
  assert.equal(unused, 0);
  assert.equal(
    h.controlsStore.read().pipelinePublications[current.snapshotId].discussionSourceNormalizationVersion,
    version,
  );
  await visibleAnswer(h);
});

test("a compatible retained Discussion replacement publishes actual answer evidence after option removal", async (t) => {
  const custom = replacement();
  const h = await discussionHarness(t, custom.runtimeOptions);
  delete h.options.normalizer;
  const current = publication(await h.collect());
  assert.equal(custom.calls, 1);
  const saved = await cacheRows(h);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].document.discussionSourceNormalizationVersion, version);
  assert.equal(saved[0].document.discussionFeedbackSources, undefined);
  assert.equal(
    h.controlsStore.read().pipelinePublications[current.snapshotId].discussionFeedbackNormalizationVersion,
    undefined,
  );
  await visibleAnswer(h);
});

test("selected Discussion enrichment stays compatible independently of the plain built-in fallback", async (t) => {
  let calls = 0;
  const h = await discussionHarness(t, {
    discussionSourceNormalizationVersion: version,
    githubEnrich: async () => {
      calls++;
      return null;
    },
  });
  delete h.options.githubEnrich;
  publication(await h.collect());
  assert.equal(calls, 1);
  await visibleAnswer(h);
});

test("Discussion compatibility is rechecked after the candidate-cache query before provider use", async (t) => {
  const custom = replacement();
  const h = await discussionHarness(t, custom.runtimeOptions);
  const query = h.db.query;
  let changed = false;
  h.db.query = async (sql, params) => {
    const value = await query(sql, params);
    if (!changed && sql.includes("FROM leaderboard_pipeline.normalizations") && sql.includes("policy_signature=ANY")) {
      loseCompatibility(h);
      changed = true;
    }
    return value;
  };
  await assert.rejects(h.collect(), unavailable);
  assert.equal(changed, true);
  assert.equal(custom.calls, 0);
  assert.deepEqual(await cacheRows(h), []);
  await noVisibility(h);
});

test("Discussion compatibility lost across the awaited real provider result cannot be persisted", async (t) => {
  const custom = replacement(async (options) => {
    await Promise.resolve();
    delete options.normalizer;
    delete options.discussionSourceNormalizationVersion;
  });
  const h = await discussionHarness(t, custom.runtimeOptions);
  await assert.rejects(h.collect(), unavailable);
  assert.equal(custom.calls, 1);
  assert.deepEqual(await cacheRows(h), []);
  await noVisibility(h);
});

test("Discussion compatibility is rechecked after the source lock before cache insertion", async (t) => {
  let armed = false,
    changed = false;
  const custom = replacement(async () => {
    armed = true;
  });
  const h = await discussionHarness(t, custom.runtimeOptions);
  const transaction = h.db.transaction;
  h.db.transaction = (work) =>
    transaction((tx) =>
      work({
        query: async (sql, params) => {
          const value = await tx.query(sql, params);
          if (armed && sql.includes("leaderboard_ingestion.repository_access") && /FOR UPDATE/.test(sql)) {
            loseCompatibility(h);
            armed = false;
            changed = true;
          }
          return value;
        },
      }),
    );
  await assert.rejects(h.collect(), unavailable);
  assert.equal(changed, true);
  assert.equal(custom.calls, 1);
  assert.deepEqual(await cacheRows(h), []);
  await noVisibility(h);
});

test("a committed Discussion cache is withheld after transaction exit and recovers without rehydration", async (t) => {
  const custom = replacement();
  const h = await discussionHarness(t, custom.runtimeOptions);
  const cutoff = clock();
  let changed = false;
  afterTransaction(
    h,
    (sql) => /INSERT\s+INTO\s+leaderboard_pipeline\.normalizations/i.test(sql),
    () => {
      if (changed) return;
      loseCompatibility(h);
      changed = true;
    },
  );
  await assert.rejects(h.collect({ cutoff }), unavailable);
  assert.equal(changed, true);
  assert.equal(custom.calls, 1);
  const saved = await cacheRows(h);
  assert.equal(saved.length, 1);
  await noVisibility(h);
  h.options.discussionSourceNormalizationVersion = version;
  publication(await h.collect({ cutoff }));
  assert.equal(custom.calls, 1);
  assert.deepEqual(await cacheRows(h), saved);
  await visibleAnswer(h);
});

test("retained Discussion cache dependency capture cannot outlive the provider declaration", async (t) => {
  const custom = replacement();
  const h = await discussionHarness(t, custom.runtimeOptions);
  const cutoff = clock();
  publication(await h.collect({ cutoff }));
  const caches = await cacheRows(h),
    snapshots = await snapshotRows(h);
  const confirmations = structuredClone(h.controlsStore.read().pipelinePublications);
  let changed = false;
  afterTransaction(
    h,
    (sql) =>
      sql.includes("SELECT document_hash FROM leaderboard_pipeline.normalizations") && sql.includes("FOR UPDATE"),
    () => {
      if (changed) return;
      loseCompatibility(h);
      changed = true;
    },
  );
  await assert.rejects(h.collect({ cutoff }), unavailable);
  assert.equal(changed, true);
  assert.equal(custom.calls, 1);
  assert.deepEqual(await cacheRows(h), caches);
  assert.deepEqual(await snapshotRows(h), snapshots);
  assert.deepEqual(h.controlsStore.read().pipelinePublications, confirmations);
  h.options.discussionSourceNormalizationVersion = version;
  publication(await h.collect({ cutoff }));
  assert.equal(custom.calls, 1);
  assert.deepEqual(await snapshotRows(h), snapshots);
});

test("committed Discussion SQL cannot gain SQLite visibility after lost compatibility and recovers exact bytes", async (t) => {
  const custom = replacement();
  const h = await discussionHarness(t, custom.runtimeOptions);
  const cutoff = clock();
  let changed = false;
  afterTransaction(
    h,
    (sql) => /INSERT\s+INTO\s+leaderboard_pipeline\.snapshots/i.test(sql),
    () => {
      if (changed) return;
      loseCompatibility(h);
      changed = true;
    },
  );
  await assert.rejects(h.collect({ cutoff }), unavailable);
  assert.equal(changed, true);
  const saved = await snapshotRows(h);
  assert.equal(saved.length, 1);
  assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
  assert.deepEqual(h.controlsStore.read().pipelineHeads ?? {}, {});
  h.options.discussionSourceNormalizationVersion = version;
  const current = publication(await h.collect({ cutoff }));
  assert.equal(current.snapshotId, saved[0].snapshot_id);
  assert.deepEqual(await snapshotRows(h), saved);
  assert.equal(custom.calls, 1);
  await visibleAnswer(h);
});

test("Discussion compatibility is checked inside the final synchronous visibility transaction", async (t) => {
  const custom = replacement();
  const h = await discussionHarness(t, custom.runtimeOptions);
  let armed = false,
    changed = false;
  afterTransaction(
    h,
    (sql) => /INSERT\s+INTO\s+leaderboard_pipeline\.snapshots/i.test(sql),
    () => {
      armed = true;
    },
  );
  const transaction = h.controlsStore.transaction.bind(h.controlsStore);
  h.controlsStore.transaction = (work) =>
    transaction((state) => {
      if (armed && !changed) {
        loseCompatibility(h);
        changed = true;
      }
      return work(state);
    });
  const cutoff = clock();
  await assert.rejects(h.collect({ cutoff }), unavailable);
  assert.equal(changed, true);
  const saved = await snapshotRows(h);
  assert.equal(saved.length, 1);
  assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
  assert.deepEqual(h.controlsStore.read().pipelineHeads ?? {}, {});
  h.options.discussionSourceNormalizationVersion = version;
  assert.equal(publication(await h.collect({ cutoff })).snapshotId, saved[0].snapshot_id);
  assert.deepEqual(await snapshotRows(h), saved);
});

test("a Discussion declaration is not required for an unrelated issue-only provider", async (t) => {
  const h = await harness(t, {
    memoryDatabase: true,
    normalizerFactory(options) {
      return components.github.createGithubEvidenceNormalizer({
        client: options.githubClient,
        source: options.sourceId,
        allowedRepositoryIds: [2],
        isSynthetic: true,
      });
    },
  });
  delete h.options.normalizer;
  publication(await h.runtime.runOnce({ cutoff: clock() }));
  const saved = await cacheRows(h);
  assert.equal(saved.length, 2);
  assert.ok(saved.every((row) => row.document.discussionSourceNormalizationVersion === undefined));
});

test("selected Discussion enrichment cannot lose compatibility while the built-in provider awaits it", async (t) => {
  let h,
    calls = 0;
  h = await discussionHarness(t, {
    discussionSourceNormalizationVersion: version,
    githubEnrich: async () => {
      calls++;
      await Promise.resolve();
      loseCompatibility(h);
      return null;
    },
  });
  await assert.rejects(h.collect(), unavailable);
  assert.equal(calls, 1);
  assert.equal(h.state.hydrations, 1);
  assert.deepEqual(await cacheRows(h), []);
  await noVisibility(h);
});

test("retained Discussion cache cannot capture dependencies after compatibility is lost under its lock", async (t) => {
  const custom = replacement();
  const h = await discussionHarness(t, custom.runtimeOptions);
  const cutoff = clock();
  publication(await h.collect({ cutoff }));
  const beforeCaches = await cacheRows(h),
    beforeSnapshots = await snapshotRows(h);
  const transaction = h.db.transaction;
  let changed = false,
    dependencyWrites = 0;
  h.db.transaction = (work) =>
    transaction((tx) =>
      work({
        query: async (sql, params) => {
          if (changed && /INSERT\s+INTO\s+leaderboard_pipeline\.source_artifacts/i.test(sql)) dependencyWrites++;
          const result = await tx.query(sql, params);
          if (
            !changed &&
            sql.includes("SELECT document_hash FROM leaderboard_pipeline.normalizations") &&
            sql.includes("FOR UPDATE")
          ) {
            loseCompatibility(h);
            changed = true;
          }
          return result;
        },
      }),
    );
  await assert.rejects(h.collect({ cutoff }), unavailable);
  assert.equal(changed, true);
  assert.equal(dependencyWrites, 0);
  assert.equal(custom.calls, 1);
  assert.deepEqual(await cacheRows(h), beforeCaches);
  assert.deepEqual(await snapshotRows(h), beforeSnapshots);
});

test("Discussion compatibility lost during the publication head query rolls back new SQL visibility", async (t) => {
  const custom = replacement();
  const h = await discussionHarness(t, custom.runtimeOptions);
  const transaction = h.db.transaction;
  let changed = false;
  h.db.transaction = (work) =>
    transaction((tx) =>
      work({
        query: async (sql, params) => {
          const result = await tx.query(sql, params);
          if (!changed && sql.includes("SELECT snapshot_id,revision FROM leaderboard_pipeline.heads")) {
            loseCompatibility(h);
            changed = true;
          }
          return result;
        },
      }),
    );
  await assert.rejects(h.collect(), unavailable);
  assert.equal(changed, true);
  assert.equal(custom.calls, 1);
  assert.equal((await cacheRows(h)).length, 1);
  await noVisibility(h);
});

test("already confirmed Discussion public and frozen private reads retain their immutable authority", async (t) => {
  const custom = replacement();
  const h = await discussionHarness(t, { ...custom.runtimeOptions, authorizePolicyPreview: async () => true });
  const cutoff = clock();
  const current = publication(await h.collect({ cutoff }));
  const request = {
    snapshotId: current.snapshotId,
    policy: { ...h.config.policies[0].policy, version: "synthetic-discussion-preview", rank: false },
    operatorId: "201",
  };
  const preview = await h.runtime.previewPolicy(request);
  const saved = await snapshotRows(h),
    caches = await cacheRows(h);
  loseCompatibility(h);
  await visibleAnswer(h);
  assert.deepEqual(await h.runtime.previewPolicy(request), preview);
  assert.equal(custom.calls, 1);
  assert.deepEqual(await snapshotRows(h), saved);
  assert.deepEqual(await cacheRows(h), caches);
  await assert.rejects(h.collect({ cutoff }), unavailable);
});
