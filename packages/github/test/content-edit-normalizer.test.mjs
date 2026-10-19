import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { GithubReadClient, GithubClientError } from "../dist/client.js";
import { FileCheckpointStore } from "../dist/checkpoints.js";
import { createGithubEvidenceNormalizer } from "../dist/normalizers.js";
import { githubContentEditRevision, readGithubContentEditMetadata } from "../dist/content-edit-history.js";
import { edit, model, repository, responseFor } from "../../../tests/fixtures/content-edit-metadata.mjs";

const neutralArrays = [
  "facts",
  "actors",
  "evidence",
  "observations",
  "lineage",
  "suppressArtifactIds",
  "participation",
  "assistance",
  "decisions",
];
const selectedParent = (item) => ({
  kind: item.__typename === "Issue" ? "issue" : "pull_request",
  id: item.id,
  number: item.number,
  url: item.url,
});
function neutral(result, reason) {
  for (const key of neutralArrays) assert.deepEqual(result[key], [], key + " remains neutral");
  assert.equal(result.isSynthetic, true);
  assert.deepEqual(result.reasons, [reason]);
  assert.equal(result.projectContext, undefined);
}

async function harness(t, state = model(), parent = state.issues[0]) {
  const directory = await mkdtemp(join(tmpdir(), "content-edit-normalizer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const h = { calls: [], enrichmentCalls: 0, authorized: true, transform: undefined, beforeReply: undefined };
  h.client = new GithubReadClient({
    checkpoints: new FileCheckpointStore(join(directory, "checkpoints")),
    token: async () => "synthetic-token",
    maxRetries: 0,
    fetch: async (url, options) => {
      assert.equal(String(url), "https://api.github.com/graphql");
      assert.equal(options.method, "POST");
      const request = JSON.parse(options.body);
      h.calls.push(structuredClone(request));
      const response = responseFor(state, request);
      await h.beforeReply?.(request);
      const output = h.transform?.(response, request) ?? response;
      return output instanceof Response
        ? output
        : new Response(JSON.stringify(output), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const metadata = await readGithubContentEditMetadata({
    client: h.client,
    source: "synthetic-content-edit-normalization",
    repository,
    scanId: "synthetic-original-collection",
    parent: selectedParent(parent),
  });
  h.input = {
    repository: { ...repository },
    family: "content_edits",
    factKey: "synthetic-content-edit-fact",
    observedAt: "2026-01-03T00:00:00.000Z",
    policyVersion: "synthetic-policy",
    fact: {
      subjectId: parent.id,
      sourceRevision: githubContentEditRevision(metadata, "synthetic-original-collection"),
      sourceUrl: parent.url,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "present",
      contentEditMetadata: metadata,
    },
  };
  h.normalize = createGithubEvidenceNormalizer({
    client: h.client,
    source: "synthetic-content-edit-normalization",
    allowedRepositoryIds: [repository.id],
    isSynthetic: true,
    assertAuthorized: () => {
      if (!h.authorized) throw new Error("synthetic metadata authority revoked");
    },
    enrich: async () => {
      h.enrichmentCalls++;
      return null;
    },
  });
  h.calls.length = 0;
  return h;
}

test("native content-edit metadata is rehydrated without metric, actor, relationship or suppression output", async (t) => {
  const h = await harness(t);
  const original = structuredClone(h.input);
  neutral(await h.normalize(h.input), "content_edit_metadata_only");
  assert.equal(h.enrichmentCalls, 0, "the reserved metadata branch precedes custom event enrichment");
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].query, /query GithubContentEditMetadata/);
  assert.doesNotMatch(h.calls[0].query, /\b(?:body|diff|author|login|email)\b/);
  assert.deepEqual(h.input, original);
});

test("empty, unavailable and redacted histories remain distinct neutral parent snapshots", async (t) => {
  for (const [label, records] of [
    ["empty", []],
    ["unavailable", null],
    [
      "redacted with unknown editor",
      [edit("UCE_SYNTHETIC_REDACTED", { editor: null, deletedAt: "2026-01-02T04:00:00Z", deletedBy: null })],
    ],
  ]) {
    await t.test(label, async (child) => {
      const state = model();
      state.histories.get(state.issues[0].id).records = records;
      const h = await harness(child, state);
      const retained = structuredClone(h.input.fact.contentEditMetadata);
      neutral(await h.normalize(h.input), "content_edit_metadata_only");
      assert.deepEqual(h.input.fact.contentEditMetadata, retained);
      assert.equal(h.input.fact.state, "present");
      assert.equal(h.enrichmentCalls, 0);
    });
  }
});

test("a PullRequest parent is native metadata and never an issue answer or review action", async (t) => {
  const state = model();
  state.histories.get(state.pullRequests[0].id).records = [edit("UCE_SYNTHETIC_PR")];
  const h = await harness(t, state, state.pullRequests[0]);
  neutral(await h.normalize(h.input), "content_edit_metadata_only");
  assert.equal(h.enrichmentCalls, 0);
  assert.match(h.calls[0].query, /pullRequest\(number:/);
  assert.doesNotMatch(h.calls[0].query, /\b(?:reviews|comments|author|body|diff)\b/);
});

test("wrong native, attribution, state and reserved-revision bindings fail before any hydration", async (t) => {
  const vectors = [
    [
      "subject",
      (x) => {
        x.fact.subjectId = "I_FOREIGN";
      },
      "content_edit_collected_binding_unverified",
    ],
    [
      "URL",
      (x) => {
        x.fact.sourceUrl = "https://github.com/Synthetic/ContentEdits/issues/99";
      },
      "content_edit_collected_binding_unverified",
    ],
    [
      "repository",
      (x) => {
        x.repository.slug = "Synthetic/Other";
      },
      "content_edit_collected_binding_unverified",
    ],
    [
      "wrong family",
      (x) => {
        x.family = "comments";
      },
      "content_edit_collected_binding_unverified",
    ],
    [
      "transition",
      (x) => {
        x.fact.evidence = "observed_transition";
      },
      "content_edit_collected_binding_unverified",
    ],
    [
      "actor",
      (x) => {
        x.fact.actorId = "7";
      },
      "content_edit_collected_binding_unverified",
    ],
    [
      "event time",
      (x) => {
        x.fact.occurredAt = "2026-01-02T03:04:06.100Z";
      },
      "content_edit_collected_binding_unverified",
    ],
    [
      "deleted parent",
      (x) => {
        x.fact.state = "deleted";
      },
      "content_edit_collected_binding_unverified",
    ],
    [
      "history alias",
      (x) => {
        x.fact.historySubjectId = x.fact.subjectId;
      },
      "content_edit_collected_binding_unverified",
    ],
    [
      "field alias",
      (x) => {
        x.fact.issueFieldId = "IF_SYNTHETIC";
      },
      "content_edit_collected_binding_unverified",
    ],
    [
      "Project alias",
      (x) => {
        x.fact.projectSubjectId = x.fact.subjectId;
      },
      "content_edit_collected_binding_unverified",
    ],
    [
      "missing metadata",
      (x) => {
        delete x.fact.contentEditMetadata;
      },
      "content_edit_collected_binding_unverified",
    ],
    [
      "extra raw field",
      (x) => {
        x.fact.contentEditMetadata.body = "synthetic unselected body";
      },
      "content_edit_collected_binding_unverified",
    ],
    [
      "wrong revision",
      (x) => {
        x.fact.sourceRevision = "gh-content-edit-v1:" + "0".repeat(64) + "." + "0".repeat(32);
      },
      "content_edit_revision_unverified",
    ],
    [
      "native revision alias",
      (x) => {
        x.fact.sourceRevision = "legacy-content-revision";
      },
      "content_edit_revision_unverified",
    ],
    [
      "malformed reserved marker",
      (x) => {
        x.fact.sourceRevision = "gh-content-edit-v1:invalid";
      },
      "content_edit_revision_unverified",
    ],
  ];
  const h = await harness(t);
  for (const [name, mutate, reason] of vectors) {
    await t.test(name, async () => {
      const input = structuredClone(h.input);
      mutate(input);
      neutral(await h.normalize(input), reason);
      assert.equal(h.calls.length, 0);
      assert.equal(h.enrichmentCalls, 0);
    });
  }
});

test("changed current editor or redaction metadata cannot validate an older collected revision", async (t) => {
  const state = model();
  const h = await harness(t, state);
  const original = structuredClone(h.input.fact);
  state.histories.get(state.issues[0].id).records[0].editor = { __typename: "Bot", id: "B_SYNTHETIC", databaseId: 9 };
  state.histories.get(state.issues[0].id).records[0].deletedAt = "2026-01-02T04:00:00Z";
  neutral(await h.normalize(h.input), "content_edit_revision_unverified");
  assert.equal(h.enrichmentCalls, 0);
  assert.deepEqual(h.input.fact, original, "the retained original metadata and revision remain immutable");
});

test("the normalizer captures the collected tuple before a pending metadata request", async (t) => {
  const h = await harness(t);
  const original = structuredClone(h.input);
  h.beforeReply = () => {
    h.input.repository.slug = "Synthetic/Other";
    h.input.fact.sourceRevision = "legacy-mutated";
    h.input.fact.contentEditMetadata.parent.id = "I_MUTATED";
    h.input.fact.contentEditMetadata.history.records.length = 0;
  };
  neutral(await h.normalize(h.input), "content_edit_metadata_only");
  assert.equal(h.calls[0].variables.number, original.fact.contentEditMetadata.parent.number);
  assert.equal(h.calls[0].variables.owner, "Synthetic");
  assert.equal(h.calls[0].variables.name, "ContentEdits");
  assert.equal(h.enrichmentCalls, 0);
});

test("GraphQL permission failure is not a successful empty metadata history", async (t) => {
  const h = await harness(t);
  h.transform = () => new Response("synthetic forbidden", { status: 403, headers: { "content-type": "text/plain" } });
  await assert.rejects(h.normalize(h.input), /permission_denied/);
  assert.equal(h.enrichmentCalls, 0);
});

test("live authority loss during metadata hydration rejects the pending neutral result", async (t) => {
  const h = await harness(t);
  h.beforeReply = () => {
    h.authorized = false;
  };
  await assert.rejects(h.normalize(h.input), (error) => {
    assert.ok(error instanceof GithubClientError);
    assert.deepEqual(error.outcome, { kind: "unsafe_request" });
    assert.equal(error.source, "synthetic-content-edit-normalization");
    assert.doesNotMatch(error.message, /synthetic metadata authority revoked/);
    return true;
  });
  assert.equal(h.enrichmentCalls, 0);
});

test("legacy custom content facts retain the original enrichment route and do not enter metadata GraphQL", async (t) => {
  const h = await harness(t);
  delete h.input.fact.contentEditMetadata;
  h.input.fact.sourceRevision = "legacy-custom-content";
  neutral(await h.normalize(h.input), "source_family_requires_exact_event_enrichment");
  assert.equal(h.enrichmentCalls, 1);
  assert.equal(h.calls.length, 0);
});
