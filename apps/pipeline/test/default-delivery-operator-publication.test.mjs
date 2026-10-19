import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { AggregateExplanationStore } from "../src/aggregate-explanations.mjs";
import { ago, components } from "./harness.mjs";
import { operatorAllow, operatorHarness, publishedOperatorReplay, queueOperatorReplay } from "./operator-harness.mjs";
import { retainLegacyDelivery, restart, version } from "./default-delivery-fixtures.mjs";

const fixture = JSON.parse(
  await readFile(new URL("../../../packages/github/test/fixtures/engineering.json", import.meta.url), "utf8"),
);
const slug = "synthetic-org/synthetic-repo";
const before = "b".repeat(40);
const after = "c".repeat(40);
const versionFields = ["defaultDeliveryNormalizationVersion", "reviewSourceNormalizationVersion"];
const readReplay = (runtime, receipt, observe) =>
  runtime.operations.readReplayResult(2, receipt.id, operatorAllow, observe);
const assertWithheld = (value) => {
  assert.equal(value.status, "unavailable");
  assert.equal(value.reason, "publication_verification_unavailable");
  assert.deepEqual(value.publications, []);
  assert.equal(value.publicationDelaySeconds, null);
};

// The queued delivery retains the actual operator helper's issue identity and
// URL. A separate review source can supply the existing review version in the
// same real SQL/SQLite publication. Neither version is injected into an output.
async function versionedReplay(t, mode) {
  const at = ago(2);
  const issue = {
    id: 1001,
    node_id: "SYNTHETIC_ISSUE_1",
    number: 1,
    html_url: `https://github.com/${slug}/issues/1`,
    user: fixture.author,
    created_at: at,
    updated_at: at,
    state: "open",
  };
  const review = {
    id: 51,
    node_id: "PRR_SYNTHETIC_OPERATOR_51",
    user: { id: 303, node_id: "U_SYNTHETIC_REVIEWER", login: "synthetic-reviewer", type: "User" },
    state: "COMMENTED",
    commit_id: after,
    submitted_at: at,
    created_at: at,
    html_url: `https://github.com/${slug}/pull/10#pullrequestreview-51`,
    pull_request_url: `https://api.github.com/repos/${slug}/pulls/10`,
  };
  const hasDiscussion = ["discussion", "discussion-default", "all"].includes(mode);
  const hasDelivery = !["review", "discussion"].includes(mode);
  const hasReview = ["review", "both", "all"].includes(mode);
  const discussion = {
    id: "D_SYNTHETIC_OPERATOR_TIME",
    url: `https://github.com/${slug}/discussions/4`,
    createdAt: ago(4),
    updatedAt: at,
    author: {
      id: "U_SYNTHETIC_DISCUSSION_404",
      databaseId: 404,
      login: "synthetic-discussion-author",
      __typename: "User",
    },
    answerChosenAt: at,
    answerChosenBy: null,
    answer: {
      id: "DC_SYNTHETIC_OPERATOR_TIME",
      createdAt: ago(3),
      isAnswer: true,
      author: { id: "U_SYNTHETIC_ANSWER_505", databaseId: 505, login: "synthetic-answer-author", __typename: "User" },
    },
  };
  const h = await operatorHarness(t, {
    webhookDispatch: true,
    // A caller-supplied review envelope must declare the existing review contract.
    ...(hasReview ? { reviewSourceNormalizationVersion: components.github.reviewSourceNormalizationVersion } : {}),
    ...(hasDiscussion
      ? { discussionSourceNormalizationVersion: components.github.discussionSourceNormalizationVersion }
      : {}),
    payloads: [issue],
    source: {
      async readPage(request) {
        assert.ok(
          request.family === "issues" ||
            (hasReview && request.family === "reviews") ||
            (hasDiscussion && request.family === "discussions"),
        );
        const item = request.family === "issues" ? issue : request.family === "reviews" ? review : discussion;
        return {
          repositoryId: 2,
          visibility: "public",
          isSynthetic: true,
          nextCursor: null,
          expectedCount: 1,
          facts: [
            {
              subjectId: item.node_id ?? item.id,
              sourceRevision:
                request.family === "issues"
                  ? item.updated_at
                  : request.family === "reviews"
                    ? components.github.githubReviewRevision(item)
                    : components.github.githubDiscussionRevision(item),
              sourceUrl: item.html_url ?? item.url,
              evidence: "current_state",
              actorId: null,
              occurredAt: null,
              state: "present",
            },
          ],
        };
      },
    },
    githubEnrich: async (input) => {
      if (input.family === "discussions") {
        assert.equal(input.fact.subjectId, discussion.id);
        return {
          repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
          proof: {
            verified: true,
            source: "github_graphql",
            revision: input.fact.sourceRevision,
            eventId: "synthetic-operator-discussion",
            isSynthetic: true,
          },
          family: "discussion",
          occurredAt: at,
          observedAt: input.observedAt,
          payload: structuredClone(discussion),
          discussionAnswerSelection: { verified: true },
          ...(hasDelivery
            ? {
                integration: {
                  before,
                  after,
                  canonicalChangeId: "synthetic-operator-discussion-delivery",
                  defaultBranch: "main",
                  targetBranch: "main",
                  commitShas: [after],
                  diff: {
                    before,
                    after,
                    complete: true,
                    files: [{ path: "src/change.ts", additions: 7, deletions: 2 }],
                  },
                },
              }
            : {}),
        };
      }
      const isReview = input.family === "reviews";
      assert.equal(input.fact.subjectId, isReview ? review.node_id : issue.node_id);
      return {
        repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
        proof: {
          verified: true,
          source: "github_rest",
          revision: input.fact.sourceRevision,
          eventId: `synthetic-operator-${isReview ? "review" : "issue"}`,
          isSynthetic: true,
        },
        family: isReview ? "review" : "issue",
        action: isReview ? "submitted" : "opened",
        occurredAt: at,
        observedAt: input.observedAt,
        payload: {
          repository: { ...fixture.repository, full_name: slug },
          sender: fixture.merger,
          ...(isReview
            ? {
                pull_request: {
                  ...structuredClone(fixture.pull_request),
                  number: 10,
                  html_url: `https://github.com/${slug}/pull/10`,
                  user: fixture.author,
                  merged_by: fixture.merger,
                  merge_commit_sha: after,
                  base: { ref: "main" },
                },
                review: structuredClone(review),
              }
            : { issue: structuredClone(issue) }),
        },
        ...(isReview
          ? { reviewParticipation: { verified: true, firstSubmittedAt: at, roundFirstSubmittedAt: at } }
          : {}),
        ...(!isReview && hasDelivery && !hasDiscussion
          ? {
              integration: {
                before,
                after,
                canonicalChangeId: "synthetic-operator-default-delivery",
                defaultBranch: "main",
                targetBranch: "main",
                commitShas: [after],
                diff: { before, after, complete: true, files: [{ path: "src/change.ts", additions: 7, deletions: 2 }] },
              },
            }
          : {}),
      };
    },
    configure(config) {
      config.repositories[0].families = [
        "issues",
        ...(hasReview ? ["reviews"] : []),
        ...(hasDiscussion ? ["discussions"] : []),
      ];
      const issuePolicy = config.policies[0];
      const original = issuePolicy.policy;
      config.policies = [
        ...(hasDelivery ? ["pr_lines_changed"] : []),
        ...(hasReview ? ["review_feedback"] : []),
        ...(hasDiscussion ? ["discussion_answers"] : []),
      ].map((metricId) => {
        const policy = {
          ...original,
          metricId,
          unit: components.metrics.getMetricDefinition(metricId).definition.unit,
          aggregation: metricId === "pr_lines_changed" ? "sum" : "count",
          roles: [metricId === "review_feedback" ? "reviewer" : "author"],
          ...(metricId === "discussion_answers" ? { sources: ["github_graphql"] } : {}),
          rank: false,
        };
        return { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-policy" };
      });
      // The actual issues-only dispatcher requires this original approved policy.
      config.policies.push(issuePolicy);
    },
  });
  const receipt = await queueOperatorReplay(h);
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  const rows = (
    await h.db.query("SELECT snapshot_id,revision,document,document_hash FROM leaderboard_pipeline.snapshots")
  ).rows;
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(comparisonHash(row.document), row.document_hash);
  const inputs = h.controlsStore.db.prepare("SELECT id FROM policy_preview_inputs").all();
  assert.equal(inputs.length, 1);
  const publication = {
    snapshotId: row.snapshot_id,
    revision: Number(row.revision),
    comparisonInput: { inputId: inputs[0].id },
  };
  const confirmation = h.controlsStore.read().pipelinePublications[publication.snapshotId];
  assert.equal(confirmation.defaultDeliveryNormalizationVersion, hasDelivery ? version : undefined);
  assert.equal(
    confirmation.reviewSourceNormalizationVersion,
    hasReview ? components.github.reviewSourceNormalizationVersion : undefined,
  );
  assert.equal(
    confirmation.discussionSourceNormalizationVersion,
    hasDiscussion ? components.github.discussionSourceNormalizationVersion : undefined,
  );
  for (const field of [...versionFields, "discussionSourceNormalizationVersion"])
    assert.equal(Object.hasOwn(row.document, field), false);
  const explanation = new AggregateExplanationStore(h.controlsStore).read(publication.snapshotId);
  assert.ok(
    explanation.document.references.some(
      (ref) =>
        ref.metricId === (hasDelivery ? "pr_lines_changed" : hasReview ? "review_feedback" : "discussion_answers"),
    ),
  );
  return { h: { ...h, sourceFamily: "issues" }, receipt, publication, document: row.document, confirmation };
}

for (const mode of ["default", "review", "both"]) {
  test(`operator replay reconstructs ${mode} versioned content through the real retained-input guard`, async (t) => {
    const { h, receipt, publication } = await versionedReplay(t, mode);
    const value = await readReplay(h.runtime, receipt);
    assert.equal(value.status, "published", value.reason);
    assert.equal(value.reason, "verified_publication");
    assert.deepEqual(
      value.publications.map((entry) => [entry.snapshotId, entry.revision]),
      [[publication.snapshotId, publication.revision]],
    );
    assert.doesNotMatch(
      JSON.stringify(value),
      /defaultDeliveryNormalizationVersion|reviewSourceNormalizationVersion|normalizationHashes|normalizationSources/,
    );
    const health = await h.runtime.operations.readHealth(2, operatorAllow);
    assert.equal(health.publication.state, "verified");
    assert.deepEqual(health.publication.publications, value.publications);
    await restart(h, async (runtime) => {
      const recovered = await readReplay(runtime, receipt);
      assert.equal(recovered.status, "published");
      assert.deepEqual(recovered.publications, value.publications);
    });
  });
}

test("a current confirmation marker cannot authorize integrity-valid retained legacy delivery for the operator", async (t) => {
  const { h, receipt, publication, document, confirmation } = await versionedReplay(t, "both");
  assert.equal((await readReplay(h.runtime, receipt)).status, "published");
  const legacy = await retainLegacyDelivery(h, publication, "exact");
  assert.equal(legacy.document.defaultDeliveryNormalizationVersion, undefined);
  assert.equal(comparisonHash(legacy.document), legacy.documentHash);
  assert.ok(legacy.document.facts.some((fact) => fact.metricId === "pr_lines_changed"));
  h.controlsStore.transaction((state) => {
    for (const saved of [state.pipelinePublications[publication.snapshotId], ...Object.values(state.pipelineHeads)]) {
      if (saved.snapshotId === publication.snapshotId) saved.defaultDeliveryNormalizationVersion = version;
    }
  });
  const current = h.controlsStore.read().pipelinePublications[publication.snapshotId];
  for (const field of versionFields) assert.equal(current[field], confirmation[field]);
  const retained = (
    await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [
      publication.snapshotId,
    ])
  ).rows[0];
  assert.deepEqual(retained.document, document);
  assert.equal(comparisonHash(retained.document), retained.document_hash);
  assert.equal(
    new AggregateExplanationStore(h.controlsStore).read(publication.snapshotId).digest,
    current.aggregateExplanationHash,
  );
  await restart(h, async (runtime) => {
    let observed = 0;
    const value = await readReplay(runtime, receipt, (data, beforeSend) => {
      beforeSend();
      assertWithheld(data);
      observed++;
    });
    assert.equal(observed, 1);
    assertWithheld(value);
    assert.equal((await runtime.operations.readHealth(2, operatorAllow)).publication.state, "unavailable");
  });
});

test("adding a version marker cannot retarget a real unversioned operator publication content hash", async (t) => {
  const { h, receipt } = await publishedOperatorReplay(t);
  const initial = await readReplay(h.runtime, receipt);
  assert.equal(initial.status, "published");
  const id = initial.publications[0].snapshotId;
  for (const field of versionFields) {
    const original = structuredClone(h.controlsStore.read().pipelinePublications[id]);
    assert.equal(original[field], undefined);
    h.controlsStore.transaction((state) => {
      state.pipelinePublications[id][field] =
        field === "defaultDeliveryNormalizationVersion" ? version : components.github.reviewSourceNormalizationVersion;
    });
    assertWithheld(await readReplay(h.runtime, receipt));
    h.controlsStore.transaction((state) => {
      state.pipelinePublications[id] = original;
    });
    assert.equal((await readReplay(h.runtime, receipt)).status, "published");
  }
});

test("the final operator response fence retains the exact presence of both content-version fields", async (t) => {
  const { h, receipt, publication } = await versionedReplay(t, "both");
  assert.equal((await readReplay(h.runtime, receipt)).status, "published");
  for (const field of versionFields) {
    const original = structuredClone(h.controlsStore.read().pipelinePublications[publication.snapshotId]);
    let observations = 0,
      sent = 0;
    await assert.rejects(
      () =>
        readReplay(h.runtime, receipt, async (data, beforeSend) => {
          observations++;
          assert.equal(data.status, "published");
          beforeSend();
          await Promise.resolve();
          h.controlsStore.transaction((state) => {
            delete state.pipelinePublications[publication.snapshotId][field];
          });
          beforeSend();
          sent++;
        }),
      /operation_publication_changed/,
    );
    assert.equal(observations, 1, "the actual verified result reached its awaited observer");
    assert.equal(sent, 0, "the response's synchronous authority fence withheld changed version metadata");
    h.controlsStore.transaction((state) => {
      state.pipelinePublications[publication.snapshotId] = original;
    });
    assert.equal((await readReplay(h.runtime, receipt)).status, "published");
  }
});

test("operator native returns recheck version metadata after asynchronous transaction completion", async (t) => {
  const { h, receipt, publication } = await versionedReplay(t, "both");
  const read = {
    replay: () => readReplay(h.runtime, receipt),
    health: () => h.runtime.operations.readHealth(2, operatorAllow),
  };
  assert.equal((await read.replay()).status, "published");
  assert.equal((await read.health()).publication.state, "verified");
  for (const kind of ["replay", "health"])
    for (const field of versionFields) {
      await t.test(`${kind} retains ${field} at its final native return`, async () => {
        const transaction = h.db.transaction;
        const original = structuredClone(h.controlsStore.read().pipelinePublications[publication.snapshotId]);
        let completions = 0;
        h.db.transaction = async (work) => {
          const result = await transaction(work);
          await Promise.resolve();
          completions++;
          h.controlsStore.transaction((state) => {
            delete state.pipelinePublications[publication.snapshotId][field];
          });
          return result;
        };
        try {
          await assert.rejects(
            read[kind],
            kind === "replay" ? /operation_publication_changed/ : /operation_health_changed/,
          );
          assert.equal(completions, 1, "the real SQL transaction completed before the captured metadata changed");
        } finally {
          h.db.transaction = transaction;
          h.controlsStore.transaction((state) => {
            state.pipelinePublications[publication.snapshotId] = original;
          });
        }
        assert.equal((await read.replay()).status, "published");
        assert.equal((await read.health()).publication.state, "verified");
      });
    }
});

test("health response rechecks version metadata after its awaited observer", async (t) => {
  const { h, publication } = await versionedReplay(t, "both");
  assert.equal((await h.runtime.operations.readHealth(2, operatorAllow)).publication.state, "verified");
  for (const field of versionFields) {
    await t.test(`health retains ${field} after observation`, async () => {
      const original = structuredClone(h.controlsStore.read().pipelinePublications[publication.snapshotId]);
      let observations = 0;
      try {
        await assert.rejects(
          () =>
            h.runtime.operations.readHealth(2, operatorAllow, async (data, beforeSend) => {
              observations++;
              assert.equal(data.publication.state, "verified");
              beforeSend();
              await Promise.resolve();
              h.controlsStore.transaction((state) => {
                delete state.pipelinePublications[publication.snapshotId][field];
              });
            }),
          /operation_health_changed/,
        );
        assert.equal(observations, 1, "the actual verified health result reached its awaited observer");
      } finally {
        h.controlsStore.transaction((state) => {
          state.pipelinePublications[publication.snapshotId] = original;
        });
      }
      assert.equal((await h.runtime.operations.readHealth(2, operatorAllow)).publication.state, "verified");
    });
  }
});

for (const mode of ["discussion", "discussion-default", "all"]) {
  test(`operator replay preserves ${mode} source versions through publication and real database reopen`, async (t) => {
    const { h, receipt, publication } = await versionedReplay(t, mode);
    const value = await readReplay(h.runtime, receipt);
    assert.equal(value.status, "published", value.reason);
    assert.equal(value.reason, "verified_publication");
    assert.deepEqual(
      value.publications.map((entry) => [entry.snapshotId, entry.revision]),
      [[publication.snapshotId, publication.revision]],
    );
    assert.doesNotMatch(
      JSON.stringify(value),
      /discussionSourceNormalizationVersion|defaultDeliveryNormalizationVersion|reviewSourceNormalizationVersion|normalizationHashes|normalizationSources/,
    );
    const normalizations = (
      await h.db.query(
        `SELECT n.* FROM leaderboard_pipeline.normalizations n JOIN leaderboard_ingestion.source_facts f USING(fact_key) WHERE f.family='discussions'`,
      )
    ).rows;
    assert.equal(normalizations.length, 1);
    assert.equal(
      normalizations[0].document.discussionSourceNormalizationVersion,
      components.github.discussionSourceNormalizationVersion,
    );
    if (mode !== "discussion") {
      assert.equal(normalizations[0].document.defaultDeliveryNormalizationVersion, version);
      assert.ok(
        normalizations[0].document.facts.some((fact) => fact.metricId === "pr_lines_changed"),
        "the same Discussion normalization carries the actual enriched delivery evidence",
      );
    }
    assert.equal((await h.runtime.operations.readHealth(2, operatorAllow)).publication.state, "verified");
    await restart(h, async (runtime) => {
      assert.equal((await readReplay(runtime, receipt)).status, "published");
      assert.equal((await runtime.operations.readHealth(2, operatorAllow)).publication.state, "verified");
    });
  });
}

test("adding a Discussion marker cannot retarget an unversioned operator content identity", async (t) => {
  const { h, receipt } = await publishedOperatorReplay(t);
  const initial = await readReplay(h.runtime, receipt);
  assert.equal(initial.status, "published");
  const id = initial.publications[0].snapshotId;
  assert.equal(h.controlsStore.read().pipelinePublications[id].discussionSourceNormalizationVersion, undefined);
  h.controlsStore.transaction((state) => {
    state.pipelinePublications[id].discussionSourceNormalizationVersion =
      components.github.discussionSourceNormalizationVersion;
  });
  assertWithheld(await readReplay(h.runtime, receipt));
});

for (const kind of ["replay", "health"])
  for (const boundary of ["observer", "transaction"]) {
    test(`operator ${kind} retains Discussion version absence after the real ${boundary} boundary`, async (t) => {
      const { h, receipt } = await publishedOperatorReplay(t);
      const initial = await readReplay(h.runtime, receipt);
      assert.equal(initial.status, "published");
      const id = initial.publications[0].snapshotId;
      const original = structuredClone(h.controlsStore.read().pipelinePublications[id]);
      const mutate = () =>
        h.controlsStore.transaction((state) => {
          state.pipelinePublications[id].discussionSourceNormalizationVersion =
            components.github.discussionSourceNormalizationVersion;
        });
      let calls = 0;
      const observe =
        boundary === "observer"
          ? async (_data, beforeSend) => {
              beforeSend();
              await Promise.resolve();
              calls++;
              mutate();
            }
          : undefined;
      const transaction = h.db.transaction;
      if (boundary === "transaction")
        h.db.transaction = async (work) => {
          const value = await transaction(work);
          await Promise.resolve();
          calls++;
          mutate();
          return value;
        };
      try {
        await assert.rejects(
          () =>
            kind === "replay"
              ? readReplay(h.runtime, receipt, observe)
              : h.runtime.operations.readHealth(2, operatorAllow, observe),
          kind === "replay" ? /operation_publication_changed/ : /operation_health_changed/,
        );
        assert.equal(calls, 1);
      } finally {
        h.db.transaction = transaction;
        h.controlsStore.transaction((state) => {
          state.pipelinePublications[id] = original;
        });
      }
      assert.equal((await readReplay(h.runtime, receipt)).status, "published");
      assert.equal((await h.runtime.operations.readHealth(2, operatorAllow)).publication.state, "verified");
    });
  }
