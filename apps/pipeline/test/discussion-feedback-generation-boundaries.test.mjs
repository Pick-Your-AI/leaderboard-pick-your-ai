import assert from "node:assert/strict";
import test from "node:test";
import { discussionFeedbackContentVersion, publicScopeKey } from "@pick-your-ai/contracts";
import { discussionSourceNormalizationVersion, fieldChangeNormalizationVersion } from "@pick-your-ai/github";
import { createPublicationWindowIndex } from "../src/publication-window-index.mjs";
import { helpfulFeedbackHarness } from "./helpful-feedback-harness.mjs";
import { components, clock, publicScope } from "./harness.mjs";

const version = discussionFeedbackContentVersion;
const unavailable = /discussion_feedback_normalizer_version_unverified/;
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
const publication = (result) => {
  assert.equal(result.state, "published", JSON.stringify(result));
  assert.equal(result.publications.length, 1);
  return result.publications[0];
};
const provider = (after = async () => {}) => {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    runtimeOptions: {
      discussionSourceNormalizationVersion,
      discussionFeedbackNormalizationVersion: version,
      normalizerFactory(options) {
        const normalize = components.github.createGithubEvidenceNormalizer({
          client: options.githubClient,
          source: options.sourceId,
          allowedRepositoryIds: [2],
          isSynthetic: true,
          // The actual runtime separately validates this synthetic stored row.
          verifyDiscussionFeedbackSource: async () => true,
        });
        return async (input) => {
          calls++;
          const output = await normalize(input);
          await after(options, input, output);
          return output;
        };
      },
    },
  };
};
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
async function assertEmptyPublication(h) {
  assert.deepEqual(await cacheRows(h), []);
  assert.deepEqual(await snapshotRows(h), []);
  assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
}

test("enrolled feedback publishes an approved named period and retains private authority metadata", async (t) => {
  const h = await helpfulFeedbackHarness(t, {
    memoryDatabase: true,
    runtimeOptions: {
      discoveryAuthority: true,
      configure(config) {
        config.scopes = [{ ...publicScope, period: "30d" }];
      },
    },
  });
  const cutoff = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  const current = publication(await h.collect({ cutoff }));
  const state = h.controlsStore.read();
  const confirmation = state.pipelinePublications[current.snapshotId];
  assert.equal(confirmation.discussionFeedbackNormalizationVersion, version);
  assert.match(confirmation.discussionFeedbackAuthorityHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(state.pipelineHeads[confirmation.scopeKey], confirmation);
  const entries = Object.values(state.pipelineWindowIndex).flatMap((namespace) => Object.values(namespace.entries));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].period, "30d");
  assert.deepEqual(entries[0].confirmation, confirmation);
  const saved = (await snapshotRows(h))[0];
  const visible = await h.runtime.source.read(saved.document.scope, current.snapshotId, new AbortController().signal);
  assert.ok(visible.selected);
  assert.doesNotMatch(
    JSON.stringify(visible),
    /discussionFeedbackNormalizationVersion|discussionFeedbackAuthorityHash|discussionFeedbackEvidenceHash/,
  );
});

function indexFixture(extra = {}) {
  const scope = structuredClone(publicScope);
  const index = createPublicationWindowIndex({
    configurationVersion: "synthetic-feedback-window-v1",
    configurationHash: "a".repeat(64),
    dataMode: "synthetic",
    templates: [{ ...scope, period: "all" }],
    resolveMetricWindow: components.metrics.resolveMetricWindow,
  });
  const confirmation = {
    recognitionFingerprint: null,
    configurationVersion: "synthetic-feedback-window-v1",
    configurationHash: "a".repeat(64),
    controlsConfigurationRevision: 0,
    aggregateExplanationHash: "b".repeat(64),
    dataMode: "synthetic",
    scopeKey: publicScopeKey(scope),
    snapshotId: "synthetic-feedback-snapshot",
    revision: 1,
    ...extra,
  };
  const state = {
    pipelinePublications: { [confirmation.snapshotId]: structuredClone(confirmation) },
    pipelineHeads: { [confirmation.scopeKey]: structuredClone(confirmation) },
  };
  return { index, state, scope, confirmation };
}

test("window confirmation retains field generation and the feedback authority pair together", () => {
  const h = indexFixture({
    fieldChangeNormalizationVersion,
    discussionSourceNormalizationVersion,
    discussionFeedbackNormalizationVersion: version,
    discussionFeedbackAuthorityHash: "c".repeat(64),
  });
  assert.equal(h.index.record(h.state, h.scope, ["all"], h.confirmation), true);
  assert.deepEqual(h.index.read(h.state, h.scope).windows[0].confirmation, h.confirmation);
  const original = structuredClone(h.state.pipelineWindowIndex);
  assert.equal(h.index.record(h.state, h.scope, ["all"], h.confirmation), false);
  assert.deepEqual(h.state.pipelineWindowIndex, original);
  h.state.pipelineHeads[h.confirmation.scopeKey].discussionFeedbackAuthorityHash = "d".repeat(64);
  assert.equal(h.index.read(h.state, h.scope), null);
});

test("ordinary named-period confirmations preserve exact absence of feedback metadata", () => {
  const h = indexFixture({ fieldChangeNormalizationVersion });
  const original = JSON.stringify(h.confirmation);
  assert.equal(h.index.record(h.state, h.scope, ["all"], h.confirmation), true);
  assert.equal(JSON.stringify(h.index.read(h.state, h.scope).windows[0].confirmation), original);
});

for (const [label, metadata] of [
  ["version without authority", { discussionFeedbackNormalizationVersion: version }],
  ["authority without version", { discussionFeedbackAuthorityHash: "c".repeat(64) }],
  [
    "undefined version",
    { discussionFeedbackNormalizationVersion: undefined, discussionFeedbackAuthorityHash: "c".repeat(64) },
  ],
  [
    "undefined authority",
    { discussionFeedbackNormalizationVersion: version, discussionFeedbackAuthorityHash: undefined },
  ],
  [
    "wrong version",
    {
      discussionFeedbackNormalizationVersion: "discussion-feedback-content/v0",
      discussionFeedbackAuthorityHash: "c".repeat(64),
    },
  ],
  [
    "malformed authority",
    { discussionFeedbackNormalizationVersion: version, discussionFeedbackAuthorityHash: "C".repeat(64) },
  ],
  [
    "unknown companion",
    {
      discussionFeedbackNormalizationVersion: version,
      discussionFeedbackAuthorityHash: "c".repeat(64),
      discussionFeedbackPermission: true,
    },
  ],
]) {
  test(`feedback window metadata rejects ${label} without creating a private pointer`, () => {
    const h = indexFixture(metadata);
    const original = structuredClone(h.state);
    assert.throws(
      () => h.index.record(h.state, h.scope, ["all"], h.confirmation),
      /publication_window_index_integrity_error/,
    );
    assert.deepEqual(h.state, original);
  });
}

test("a captured replacement still requires feedback compatibility after its option is removed", async (t) => {
  const custom = provider();
  const h = await helpfulFeedbackHarness(t, { memoryDatabase: true, runtimeOptions: custom.runtimeOptions });
  delete h.options.normalizer;
  delete h.options.discussionFeedbackNormalizationVersion;
  await assert.rejects(h.collect(), unavailable);
  assert.equal(custom.calls, 0);
  await assertEmptyPublication(h);
});

test("a captured enrichment still requires feedback compatibility after its option is removed", async (t) => {
  const h = await helpfulFeedbackHarness(t, {
    memoryDatabase: true,
    runtimeOptions: {
      githubEnrich: async () => null,
      discussionSourceNormalizationVersion,
      discussionFeedbackNormalizationVersion: version,
    },
  });
  delete h.options.githubEnrich;
  delete h.options.discussionFeedbackNormalizationVersion;
  await assert.rejects(h.collect(), unavailable);
  await assertEmptyPublication(h);
});

test("feedback compatibility lost across the awaited replacement result cannot be persisted", async (t) => {
  const custom = provider(async (options) => {
    await Promise.resolve();
    delete options.normalizer;
    delete options.discussionFeedbackNormalizationVersion;
  });
  const h = await helpfulFeedbackHarness(t, { memoryDatabase: true, runtimeOptions: custom.runtimeOptions });
  await assert.rejects(h.collect(), unavailable);
  assert.equal(custom.calls, 1);
  await assertEmptyPublication(h);
});

test("feedback compatibility is checked after the awaited source lock and before cache insertion", async (t) => {
  let armed = false,
    changed = false;
  const custom = provider(async () => {
    armed = true;
  });
  const h = await helpfulFeedbackHarness(t, { memoryDatabase: true, runtimeOptions: custom.runtimeOptions });
  const transaction = h.db.transaction;
  h.db.transaction = (work) =>
    transaction((tx) =>
      work({
        query: async (sql, params) => {
          const value = await tx.query(sql, params);
          if (armed && sql.includes("leaderboard_ingestion.repository_access") && /FOR UPDATE/.test(sql)) {
            delete h.options.normalizer;
            delete h.options.discussionFeedbackNormalizationVersion;
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
  await assertEmptyPublication(h);
});

test("a retained feedback cache is withheld when compatibility disappears during dependency capture", async (t) => {
  const custom = provider();
  const h = await helpfulFeedbackHarness(t, { memoryDatabase: true, runtimeOptions: custom.runtimeOptions });
  const cutoff = clock();
  publication(await h.collect({ cutoff }));
  assert.equal(custom.calls, 1);
  const beforeCaches = await cacheRows(h),
    beforeSnapshots = await snapshotRows(h);
  let changed = false;
  afterTransaction(
    h,
    (sql) =>
      sql.includes("SELECT document_hash FROM leaderboard_pipeline.normalizations") && sql.includes("FOR UPDATE"),
    () => {
      delete h.options.normalizer;
      delete h.options.discussionFeedbackNormalizationVersion;
      changed = true;
    },
  );
  await assert.rejects(h.collect({ cutoff }), unavailable);
  assert.equal(changed, true);
  assert.equal(custom.calls, 1);
  assert.deepEqual(await cacheRows(h), beforeCaches);
  assert.deepEqual(await snapshotRows(h), beforeSnapshots);
});

test("SQL feedback publication cannot gain SQLite visibility after provider compatibility is lost", async (t) => {
  const custom = provider();
  const h = await helpfulFeedbackHarness(t, { memoryDatabase: true, runtimeOptions: custom.runtimeOptions });
  const cutoff = clock();
  let changed = false;
  afterTransaction(
    h,
    (sql) => /INSERT\s+INTO\s+leaderboard_pipeline\.snapshots/i.test(sql),
    () => {
      if (changed) return;
      delete h.options.normalizer;
      delete h.options.discussionFeedbackNormalizationVersion;
      changed = true;
    },
  );
  await assert.rejects(h.collect({ cutoff }), unavailable);
  assert.equal(changed, true);
  const saved = await snapshotRows(h);
  assert.equal(saved.length, 1);
  assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
  assert.deepEqual(h.controlsStore.read().pipelineHeads ?? {}, {});
  h.options.discussionFeedbackNormalizationVersion = version;
  const recovered = publication(await h.collect({ cutoff }));
  assert.equal(recovered.snapshotId, saved[0].snapshot_id);
  assert.deepEqual(await snapshotRows(h), saved);
  assert.equal(
    h.controlsStore.read().pipelinePublications[recovered.snapshotId].discussionFeedbackNormalizationVersion,
    version,
  );
});

test("adding an unused replacement option does not change the captured built-in feedback provider", async (t) => {
  const h = await helpfulFeedbackHarness(t, {
    memoryDatabase: true,
    runtimeOptions: { discussionSourceNormalizationVersion },
  });
  let unused = 0;
  h.options.normalizer = async () => {
    unused++;
    throw Error("unused replacement");
  };
  const current = publication(await h.collect());
  assert.equal(unused, 0);
  assert.equal(
    h.controlsStore.read().pipelinePublications[current.snapshotId].discussionFeedbackNormalizationVersion,
    version,
  );
});

test("an explicitly compatible replacement preserves actual feedback source metadata and publication", async (t) => {
  const custom = provider();
  const h = await helpfulFeedbackHarness(t, { memoryDatabase: true, runtimeOptions: custom.runtimeOptions });
  const current = publication(await h.collect());
  assert.equal(custom.calls, 1);
  const saved = await cacheRows(h);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].document.discussionFeedbackNormalizationVersion, version);
  assert.equal(saved[0].document.discussionFeedbackSources.length, 1);
  assert.equal(
    h.controlsStore.read().pipelinePublications[current.snapshotId].discussionFeedbackNormalizationVersion,
    version,
  );
});
