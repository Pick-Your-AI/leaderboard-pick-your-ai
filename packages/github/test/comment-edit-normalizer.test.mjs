import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { GithubReadClient, GithubClientError } from "../dist/client.js";
import { FileCheckpointStore } from "../dist/checkpoints.js";
import { createGithubEvidenceNormalizer } from "../dist/normalizers.js";
import {
  githubCommentEditRevision,
  parseGithubCommentEditMetadata,
  readGithubCommentEditMetadata,
} from "../dist/comment-edit-history.js";
import { parseCommentEditMetadata, collectionContentEditMetadata } from "../../ingestion/dist/content-edit-metadata.js";
import {
  commentKinds,
  commentEntry,
  commentModel,
  commentTarget,
  commentResponse,
  edit,
  repository,
} from "../../../tests/fixtures/comment-edit-metadata.mjs";

const source = "synthetic-comment-edit-normalization";
const clone = (value) => structuredClone(value);
const neutralKeys = [
  "facts",
  "actors",
  "evidence",
  "observations",
  "lineage",
  "issueTransfers",
  "issueCreationScopes",
  "suppressArtifactIds",
  "participation",
  "assistance",
  "decisions",
];
function neutral(result, reason) {
  for (const key of neutralKeys) assert.deepEqual(result[key], [], key + " remains neutral");
  assert.equal(result.isSynthetic, true);
  assert.deepEqual(result.reasons, [reason]);
  assert.equal(result.projectContext, undefined);
  assert.equal(result.discussionFeedbackSources, undefined);
  assert.equal(result.releaseInclusionSources, undefined);
}
function noFallback(h) {
  assert.equal(h.enrichmentCalls, 0);
  assert.equal(h.revisionCalls, 0);
  assert.equal(h.acceptanceCalls, 0);
}

async function harness(t, state = commentModel()) {
  const directory = await mkdtemp(join(tmpdir(), "comment-edit-normalizer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const h = {
    state,
    calls: [],
    authorized: true,
    enrichmentCalls: 0,
    revisionCalls: 0,
    acceptanceCalls: 0,
    beforeToken: undefined,
    beforeReply: undefined,
    afterLoad: undefined,
    transform: undefined,
  };
  h.guard = () => {
    if (!h.authorized) throw new Error("synthetic comment metadata authority revoked");
  };
  const store = new FileCheckpointStore(join(directory, "checkpoints"));
  h.client = new GithubReadClient({
    checkpoints: {
      load: (key) => store.load(key),
      save: (key, value) => store.save(key, value),
      forRepository(id) {
        const scoped = store.forRepository(id);
        return {
          ...scoped,
          async load(key) {
            const value = await scoped.load(key);
            await h.afterLoad?.(value);
            return value;
          },
        };
      },
    },
    token: async () => {
      await h.beforeToken?.();
      return "synthetic-token";
    },
    maxRetries: 0,
    fetch: async (url, options) => {
      assert.equal(String(url), "https://api.github.com/graphql");
      assert.equal(options.method, "POST");
      const request = JSON.parse(options.body);
      assert.match(request.query, /query GithubCommentEditMetadata\b/);
      h.calls.push(clone(request));
      const response = commentResponse(state, request);
      await h.beforeReply?.(request);
      const selected = (await h.transform?.(response, request)) ?? response;
      return selected instanceof Response
        ? selected
        : new Response(JSON.stringify(selected), { headers: { "content-type": "application/json" } });
    },
  });
  const metadata = await readGithubCommentEditMetadata({
    client: h.client,
    source,
    repository: clone(repository),
    target: state.selected,
    scanId: "synthetic-comment-collected",
    assertAuthorized: h.guard,
  });
  h.input = {
    repository: clone(repository),
    family: "content_edits",
    factKey: "synthetic-comment-fact-a",
    observedAt: "2026-01-03T00:00:00.000Z",
    policyVersion: "synthetic-policy",
    fact: {
      subjectId: metadata.target.id,
      sourceRevision: githubCommentEditRevision(metadata, "synthetic-comment-collected"),
      sourceUrl: metadata.target.url,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "present",
      contentEditMetadata: metadata,
    },
  };
  h.options = {
    client: h.client,
    source,
    allowedRepositoryIds: [repository.id],
    isSynthetic: true,
    assertAuthorized: h.guard,
    enrich: async () => {
      h.enrichmentCalls++;
      return null;
    },
    verifyRevision: async () => {
      h.revisionCalls++;
      return true;
    },
  };
  h.create = (extra = {}) => createGithubEvidenceNormalizer({ ...h.options, ...extra });
  h.normalize = h.create();
  h.calls.length = 0;
  return h;
}

test("all four published comment targets hydrate their own native identity and return only neutral metadata", async (t) => {
  for (const kind of commentKinds)
    await t.test(kind, async (t) => {
      const h = await harness(t, commentModel(kind));
      const original = clone(h.input);
      const normalize = h.create({
        acceptance: async () => {
          h.acceptanceCalls++;
          return [];
        },
      });
      neutral(await normalize(h.input), "content_edit_metadata_only");
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].variables.id, original.fact.subjectId);
      assert.notEqual(h.calls[0].variables.id, original.fact.contentEditMetadata.target.parent.id);
      assert.doesNotMatch(h.calls[0].query, /\b(?:body|bodyHTML|bodyText|diff|diffHunk|title|login|email|author)\b/);
      assert.deepEqual(h.input, original);
      noFallback(h);
    });
});

test("empty, unavailable and redacted comment histories keep distinct present observations without actors or credit", async (t) => {
  for (const [name, records] of [
    ["available empty", []],
    ["unavailable", null],
    [
      "unknown actor and independent redaction",
      [
        edit("UCE_SYNTHETIC_REDACTED", {
          editor: null,
          deletedAt: "2026-01-02T04:00:00Z",
          deletedBy: { __typename: "Organization" },
        }),
      ],
    ],
  ])
    await t.test(name, async (t) => {
      const state = commentModel("pull_request_review_comment");
      state.entries.get(state.selected.id).records = records;
      const h = await harness(t, state),
        retained = clone(h.input.fact.contentEditMetadata);
      neutral(await h.normalize(h.input), "content_edit_metadata_only");
      assert.deepEqual(h.input.fact.contentEditMetadata, retained);
      assert.equal(h.input.fact.state, "present");
      if (records === null) assert.equal(retained.history.availability, "unavailable");
      else assert.equal(retained.history.retainedTotalCount, records.length);
      noFallback(h);
    });
});

test("repository, target, family, neutral attribution and closed raw metadata gate hydration", async (t) => {
  const h = await harness(t);
  const vectors = [
    ["repository not allowed", (x) => (x.repository.id = 3), "repository_not_authorized_for_normalization"],
    ["repository slug", (x) => (x.repository.slug = "Synthetic/Other")],
    ["metadata repository ID", (x) => (x.fact.contentEditMetadata.repository.id = 3)],
    ["target identity", (x) => (x.fact.subjectId = "COMMENT_FOREIGN")],
    ["parent substituted for target", (x) => (x.fact.subjectId = x.fact.contentEditMetadata.target.parent.id)],
    ["target URL", (x) => (x.fact.sourceUrl += "?synthetic=1")],
    ["parent URL substituted", (x) => (x.fact.sourceUrl = x.fact.contentEditMetadata.target.parent.url)],
    ["wrong family", (x) => (x.family = "comments")],
    ["transition attribution", (x) => (x.fact.evidence = "observed_transition")],
    ["actor attribution", (x) => (x.fact.actorId = "7")],
    ["event time attribution", (x) => (x.fact.occurredAt = "2026-01-02T03:04:05.000Z")],
    ["deleted state", (x) => (x.fact.state = "deleted")],
    ["extra outer body", (x) => (x.fact.body = "synthetic raw body")],
    ["field-history alias", (x) => (x.fact.issueFieldId = "IF_SYNTHETIC")],
    ["extra metadata body", (x) => (x.fact.contentEditMetadata.body = "synthetic raw body")],
    ["extra target body", (x) => (x.fact.contentEditMetadata.target.body = "synthetic raw body")],
    ["extra publication author", (x) => (x.fact.contentEditMetadata.publication.author = "synthetic")],
    ["extra edit diff", (x) => (x.fact.contentEditMetadata.history.records[0].diff = "synthetic raw diff")],
    ["missing publication", (x) => delete x.fact.contentEditMetadata.publication],
    ["unpublished collected comment", (x) => (x.fact.contentEditMetadata.publication.publishedAt = null)],
    ["inconsistent unavailable history", (x) => (x.fact.contentEditMetadata.history.availability = "unavailable")],
    ["mismatched retained count", (x) => x.fact.contentEditMetadata.history.retainedTotalCount++],
    ["unknown metadata format", (x) => (x.fact.contentEditMetadata.version = "github-comment-edit-metadata/v2")],
  ];
  for (const [name, mutate, reason = "content_edit_collected_binding_unverified"] of vectors)
    await t.test(name, async () => {
      const input = clone(h.input);
      mutate(input);
      neutral(await h.normalize(input), reason);
      assert.equal(h.calls.length, 0);
      noFallback(h);
    });
});

test("comment revision and reserved namespace aliases cannot fall back to event enrichment", async (t) => {
  const h = await harness(t);
  for (const [name, mutate, reason] of [
    ["missing DTO", (x) => delete x.fact.contentEditMetadata, "content_edit_collected_binding_unverified"],
    ["null DTO", (x) => (x.fact.contentEditMetadata = null), "content_edit_collected_binding_unverified"],
    [
      "changed semantic digest",
      (x) => (x.fact.sourceRevision = "gh-content-edit-comment-v1:" + "0".repeat(64) + "." + "1".repeat(32)),
      "content_edit_revision_unverified",
    ],
    [
      "parent revision namespace",
      (x) => (x.fact.sourceRevision = x.fact.sourceRevision.replace("-comment-v1:", "-v1:")),
      "content_edit_revision_unverified",
    ],
    [
      "unsupported comment namespace",
      (x) => (x.fact.sourceRevision = x.fact.sourceRevision.replace("comment-v1:", "comment-v2:")),
      "content_edit_revision_unverified",
    ],
    [
      "nonreserved revision with DTO",
      (x) => (x.fact.sourceRevision = "legacy-opaque-edit"),
      "content_edit_revision_unverified",
    ],
    ["trailing revision newline", (x) => (x.fact.sourceRevision += "\n"), "content_edit_revision_unverified"],
    [
      "unknown reserved prefix without DTO",
      (x) => {
        delete x.fact.contentEditMetadata;
        x.fact.sourceRevision = "gh-content-edit-unknown:synthetic";
      },
      "content_edit_collected_binding_unverified",
    ],
  ])
    await t.test(name, async () => {
      const input = clone(h.input);
      mutate(input);
      neutral(await h.normalize(input), reason);
      assert.equal(h.calls.length, 0);
      noFallback(h);
    });
});

test("changed current publication, submitted state, creation marker or history cannot validate the collected revision", async (t) => {
  for (const [name, mutate] of [
    ["publication time", (entry) => (entry.native.publishedAt = "2026-01-04T00:00:00Z")],
    ["submitted review state", (entry) => (entry.native.state = "DISMISSED")],
    ["submission time", (entry) => (entry.native.submittedAt = "2026-01-04T00:00:00Z")],
    ["creation inclusion", (entry) => (entry.native.includesCreatedEdit = false)],
    ["editor", (entry) => (entry.records[0].editor = { __typename: "Bot", id: "B_SYNTHETIC", databaseId: 19 })],
    [
      "redaction",
      (entry) => {
        entry.records[0].deletedAt = "2026-01-02T04:00:00Z";
        entry.records[0].deletedBy = null;
      },
    ],
    ["empty retained history", (entry) => (entry.records = [])],
    ["unavailable retained history", (entry) => (entry.records = null)],
  ])
    await t.test(name, async (t) => {
      const h = await harness(t, commentModel("pull_request_review")),
        original = clone(h.input);
      mutate(h.state.entries.get(h.state.selected.id));
      neutral(await h.normalize(h.input), "content_edit_revision_unverified");
      assert.equal(h.calls.length, 1);
      assert.deepEqual(h.input, original);
      noFallback(h);
    });
});

test("foreign, private, mismatched or no-longer-published native targets reject the pending result", async (t) => {
  for (const [
    name,
    mutate,
    pattern = /github_comment_edit_(?:target|repository|publication)_unverified|invalid_timestamp/,
  ] of [
    ["wrong native type", (node) => (node.__typename = "IssueComment")],
    ["wrong target ID", (node) => (node.id += "_OTHER")],
    ["wrong target URL", (node) => (node.url += "?synthetic=1")],
    ["private target", (node) => (node.repository.isPrivate = true)],
    ["foreign native repository", (node) => (node.repository.databaseId = 3)],
    ["foreign parent ID", (node) => (node.pullRequest.id += "_OTHER")],
    [
      "foreign parent number",
      (node) => node.pullRequest.number++,
      /^TypeError: github_content_edit_parent_unverified$/,
    ],
    [
      "foreign parent URL",
      (node) => (node.pullRequest.url += "/other"),
      /^TypeError: github_content_edit_parent_unverified$/,
    ],
    ["private parent", (node) => (node.pullRequest.repository.isPrivate = true)],
    [
      "pending inline",
      (node) => {
        node.state = "PENDING";
        node.publishedAt = null;
      },
    ],
  ])
    await t.test(name, async (t) => {
      const h = await harness(t, commentModel("pull_request_review_comment"));
      h.transform = (response) => {
        mutate(response.data.node);
        return response;
      };
      await assert.rejects(h.normalize(h.input), pattern);
      assert.equal(h.calls.length, 1);
      noFallback(h);
    });
});

test("new comment normalization requires a current synchronous void authorization guard", async (t) => {
  const h = await harness(t);
  for (const [name, guard] of [
    ["missing", undefined],
    ["nonfunction", true],
    ["boolean return", () => true],
    ["fulfilled Promise", async () => {}],
    ["rejected Promise", () => Promise.reject(new Error("synthetic async guard"))],
  ])
    await t.test(name, async () => {
      await assert.rejects(
        h.create({ assertAuthorized: guard })(h.input),
        /authorization_(?:required|must_be_synchronous)/,
      );
      assert.equal(h.calls.length, 0);
      noFallback(h);
    });
  h.authorized = false;
  await assert.rejects(h.normalize(h.input), /authorization_unavailable/);
  assert.equal(h.calls.length, 0);
  noFallback(h);
});

test("authorization withdrawal during token, native response or completed-cache loading cannot return neutral success", async (t) => {
  for (const name of ["token wait", "native response", "cached page"])
    await t.test(name, async (t) => {
      const h = await harness(t);
      if (name === "token wait") h.beforeToken = () => (h.authorized = false);
      else if (name === "native response") h.beforeReply = () => (h.authorized = false);
      else {
        neutral(await h.normalize(h.input), "content_edit_metadata_only");
        h.calls.length = 0;
        h.afterLoad = () => (h.authorized = false);
      }
      await assert.rejects(h.normalize(h.input), (error) => {
        assert.ok(error instanceof GithubClientError);
        assert.deepEqual(error.outcome, { kind: "unsafe_request" });
        assert.equal(error.source, source);
        assert.doesNotMatch(error.message, /synthetic comment metadata authority revoked/);
        return true;
      });
      assert.equal(h.calls.length, name === "native response" ? 1 : 0);
      noFallback(h);
    });
});

test("caller tuple mutation after the first asynchronous boundary cannot rebind target, repository or revision", async (t) => {
  const h = await harness(t),
    original = clone(h.input);
  h.beforeToken = () => {
    h.input.repository.id = 99;
    h.input.repository.slug = "Synthetic/Other";
    h.input.family = "comments";
    h.input.factKey = "mutated-fact-key";
    h.input.fact.subjectId = "COMMENT_MUTATED";
    h.input.fact.sourceUrl = "https://example.invalid/";
    h.input.fact.sourceRevision = "legacy-mutated";
    h.input.fact.actorId = "99";
    h.input.fact.contentEditMetadata.target.parent.id = "PR_MUTATED";
    h.input.fact.contentEditMetadata.history.records.length = 0;
  };
  neutral(await h.normalize(h.input), "content_edit_metadata_only");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].variables.id, original.fact.subjectId);
  noFallback(h);
  h.beforeToken = undefined;
  neutral(await h.normalize(original), "content_edit_metadata_only");
  assert.equal(h.calls.length, 1, "the captured original fact key, not the mutated key, owns the completed cache");
});

test("captured authorization cannot be replaced while a native read is pending", async (t) => {
  const h = await harness(t);
  const options = { ...h.options },
    normalize = createGithubEvidenceNormalizer(options);
  h.beforeReply = () => {
    options.assertAuthorized = () => {};
    h.authorized = false;
  };
  await assert.rejects(
    normalize(h.input),
    (error) => error instanceof GithubClientError && error.outcome.kind === "unsafe_request",
  );
  assert.equal(h.calls.length, 1);
  noFallback(h);
});

test("exact fact-key and source namespaces control cached hydration without provider reads leaking across identities", async (t) => {
  const h = await harness(t);
  neutral(await h.normalize(h.input), "content_edit_metadata_only");
  neutral(await h.normalize(clone(h.input)), "content_edit_metadata_only");
  assert.equal(h.calls.length, 1);
  const otherFact = clone(h.input);
  otherFact.factKey = "synthetic-comment-fact-b";
  neutral(await h.normalize(otherFact), "content_edit_metadata_only");
  assert.equal(h.calls.length, 2);
  neutral(await h.create({ source: "another-synthetic-normalizer" })(h.input), "content_edit_metadata_only");
  assert.equal(h.calls.length, 3);
  noFallback(h);
});

test("permission failure or partial GraphQL data is not an empty successful comment history", async (t) => {
  for (const [name, transform, pattern] of [
    ["403", () => new Response("synthetic forbidden", { status: 403 }), /permission_denied/],
    [
      "GraphQL errors",
      (response) => ({ ...response, errors: [{ message: "synthetic partial" }] }),
      /graphql|invalid_response/,
    ],
    ["missing native node", () => ({ data: { node: null } }), /target_unverified/],
  ])
    await t.test(name, async (t) => {
      const h = await harness(t);
      h.transform = transform;
      await assert.rejects(h.normalize(h.input), pattern);
      assert.equal(h.calls.length, 1);
      noFallback(h);
    });
});

test("native comment canonical bytes and semantic digest match the independent ingestion DTO", async (t) => {
  const specimens = commentKinds.map((kind) => commentModel(kind));
  const redacted = commentModel();
  redacted.entries.get(redacted.selected.id).records = [
    edit("UCE_Z", { editor: null, deletedAt: "2026-01-02T04:00:00Z", deletedBy: null }),
    edit("UCE_A", {
      editor: { __typename: "Organization" },
      deletedBy: { __typename: "Bot", id: "B_SYNTHETIC", databaseId: null },
    }),
  ];
  specimens.push(redacted);
  for (const records of [
    null,
    [],
    Array.from({ length: 100 }, (_, i) => edit("UCE_" + String(99 - i).padStart(3, "0"))),
  ]) {
    const state = commentModel("pull_request_review_comment");
    state.entries.get(state.selected.id).records = records;
    specimens.push(state);
  }
  const target = commentTarget("pull_request_review_comment", "99999999999999999999");
  const opaque = commentEntry(target);
  specimens.push({ selected: target, entries: new Map([[target.id, opaque]]) });
  for (const [index, state] of specimens.entries())
    await t.test("canonical specimen " + index, async (t) => {
      const h = await harness(t, state),
        collected = h.input.fact.contentEditMetadata;
      const reader = parseGithubCommentEditMetadata(collected),
        ingestion = parseCommentEditMetadata(collected);
      assert.deepEqual(ingestion, reader);
      assert.equal(JSON.stringify(ingestion), JSON.stringify(reader));
      assert.equal(
        createHash("sha256").update(JSON.stringify(ingestion)).digest("hex"),
        h.input.fact.sourceRevision.split(":")[1].split(".")[0],
      );
      assert.deepEqual(collectionContentEditMetadata(h.input.fact, "content_edits", repository.id), reader);
      assert.notEqual(ingestion, collected);
      assert.notEqual(ingestion.target, collected.target);
      neutral(await h.normalize(h.input), "content_edit_metadata_only");
      noFallback(h);
      if (index === specimens.length - 1) assert.ok(ingestion.target.url.endsWith("#discussion_r99999999999999999999"));
    });
});

test("legacy content without a reserved metadata marker retains its explicit enrichment boundary", async (t) => {
  const h = await harness(t);
  delete h.input.fact.contentEditMetadata;
  h.input.fact.sourceRevision = "legacy-opaque-content";
  neutral(await h.normalize(h.input), "source_family_requires_exact_event_enrichment");
  assert.equal(h.enrichmentCalls, 1);
  assert.equal(h.revisionCalls, 0);
  assert.equal(h.calls.length, 0);
});
