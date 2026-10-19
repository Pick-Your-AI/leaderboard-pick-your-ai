import assert from "node:assert/strict";
import test from "node:test";
import {
  createGithubEvidenceNormalizer,
  githubRestSnapshotFingerprint,
  githubRestSnapshotRevision,
  githubRestSnapshotSemanticRevision,
  verifyGithubRestSnapshotRevision,
} from "../dist/index.js";
import { syntheticRepositoryClient } from "./synthetic-client.mjs";

const at = "2026-10-01T00:00:00.000Z";
const observedAt = "2026-10-02T00:00:00.000Z";
const slug = "synthetic-owner/repository";
const repository = { id: 2, private: false, default_branch: "main" };
const user = { id: 101, node_id: "U_SYNTHETIC_A", login: "synthetic-alice", type: "User" };
const payloads = {
  issues: {
    id: 20,
    node_id: "I_synthetic_20",
    number: 20,
    html_url: `https://github.com/${slug}/issues/20`,
    title: "Synthetic issue",
    body: "Synthetic original body",
    state: "open",
    created_at: at,
    updated_at: at,
    user,
  },
  pull_requests: {
    id: 30,
    node_id: "PR_synthetic_30",
    number: 30,
    html_url: `https://github.com/${slug}/pull/30`,
    title: "Synthetic pull request",
    body: "Synthetic original body",
    state: "open",
    draft: false,
    created_at: at,
    updated_at: at,
    merged_at: null,
    closed_at: null,
    head: { sha: "a".repeat(40), ref: "synthetic-feature", repo: { id: 2, node_id: "R_SYNTHETIC" } },
    base: { sha: "b".repeat(40), ref: "main", repo: { id: 2, node_id: "R_SYNTHETIC" } },
    user,
  },
  comments: {
    id: 40,
    node_id: "IC_synthetic_40",
    html_url: `https://github.com/${slug}/issues/20#issuecomment-40`,
    issue_url: `https://api.github.com/repos/${slug}/issues/20`,
    body: "Synthetic original body",
    created_at: at,
    updated_at: at,
    user,
  },
  releases: {
    id: 50,
    node_id: "RE_synthetic_50",
    html_url: `https://github.com/${slug}/releases/tag/synthetic-v1`,
    name: "Synthetic release",
    body: "Synthetic original body",
    tag_name: "synthetic-v1",
    target_commitish: "main",
    draft: false,
    prerelease: false,
    created_at: at,
    updated_at: at,
    published_at: at,
    author: user,
  },
};

function normalizer(family, revision, options = {}) {
  let current = structuredClone(payloads[family]);
  let calls = 0;
  const normalize = createGithubEvidenceNormalizer({
    client: syntheticRepositoryClient(2, {
      rest: async (_source, endpoint) => {
        calls += 1;
        return endpoint === `/repos/${slug}` ? repository : current;
      },
    }),
    source: "synthetic",
    allowedRepositoryIds: [2],
    isSynthetic: true,
    ...options,
  });
  const input = {
    repository: { id: 2, slug },
    family,
    factKey: "synthetic-collected-snapshot",
    observedAt,
    policyVersion: "synthetic/v1",
    fact: {
      subjectId: String(current.id),
      sourceRevision: revision,
      sourceUrl: current.html_url,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "present",
    },
  };
  return {
    run: (patch = {}) => normalize({ ...input, ...patch }),
    current: (value) => {
      current = value;
    },
    calls: () => calls,
  };
}

for (const [family, original] of Object.entries(payloads)) {
  test(`${family}: a matching content observation hydrates, but a same-clock body edit does not`, async () => {
    const revision = githubRestSnapshotRevision(family, original, "synthetic-scan-1");
    const h = normalizer(family, revision);
    const matched = await h.run();
    assert.equal(matched.observations.length, 1, JSON.stringify(matched.reasons));
    assert.ok(!matched.reasons.includes("hydrated_source_revision_unverified"));
    const changed = { ...structuredClone(original), body: "Synthetic changed body" };
    assert.equal(changed.updated_at, original.updated_at);
    h.current(changed);
    const stale = await h.run();
    assert.equal(stale.observations.length, 0);
    assert.equal(stale.facts.length, 0);
    assert.deepEqual(stale.reasons, ["hydrated_source_revision_unverified"]);
    h.current(structuredClone(original));
    assert.equal((await h.run()).observations.length, 1, "restoring the exact source restores verification");
  });
}

test("REST content identity includes title, state, actor identity and PR branch pins without a clock change", () => {
  for (const [family, changes] of [
    [
      "issues",
      [{ title: "Synthetic renamed" }, { state: "closed" }, { user: { ...user, login: "synthetic-renamed" } }],
    ],
    [
      "pull_requests",
      [{ draft: true }, { merged_at: at }, { head: { ...payloads.pull_requests.head, sha: "c".repeat(40) } }],
    ],
    ["comments", [{ user: { ...user, id: 202 } }]],
    ["releases", [{ prerelease: true }, { tag_name: "synthetic-v2" }, { author: { ...user, type: "Bot" } }]],
  ]) {
    const original = payloads[family];
    const fingerprint = githubRestSnapshotFingerprint(family, original);
    for (const change of changes) {
      const changed = { ...structuredClone(original), ...change };
      assert.equal(changed.updated_at, original.updated_at);
      assert.notEqual(githubRestSnapshotFingerprint(family, changed), fingerprint, `${family}: ${Object.keys(change)}`);
    }
  }
});

test("list/get-only metadata and set order do not create a new content identity", () => {
  const list = {
    ...structuredClone(payloads.pull_requests),
    labels: [
      { id: 2, node_id: "L_SYNTHETIC_2", name: "synthetic-two" },
      { id: 1, node_id: "L_SYNTHETIC_1", name: "synthetic-one" },
    ],
    assignees: [user, { ...user, id: 202, node_id: "U_SYNTHETIC_B", login: "synthetic-bob" }],
  };
  const get = {
    ...structuredClone(list),
    merged: false,
    merged_by: null,
    mergeable: null,
    additions: 12,
    deletions: 4,
    changed_files: 2,
    body_html: "<p>synthetic rendering</p>",
  };
  get.labels.reverse();
  get.assignees.reverse();
  get.base.repo.description = "Synthetic repository detail unrelated to the collected branch pin";
  assert.equal(
    githubRestSnapshotFingerprint("pull_requests", list),
    githubRestSnapshotFingerprint("pull_requests", get),
  );
  const reordered = Object.fromEntries(Object.entries(list).reverse());
  assert.equal(
    githubRestSnapshotFingerprint("pull_requests", list),
    githubRestSnapshotFingerprint("pull_requests", reordered),
  );
});

test("missing, null and changed release assets stay explicit while download counts do not become edits", () => {
  const missing = structuredClone(payloads.releases);
  const empty = { ...missing, body: null };
  delete missing.body;
  assert.notEqual(githubRestSnapshotFingerprint("releases", missing), githubRestSnapshotFingerprint("releases", empty));
  const release = {
    ...payloads.releases,
    assets: [{ id: 10, name: "synthetic.txt", size: 10, digest: "synthetic-digest", download_count: 1 }],
  };
  const moreDownloads = { ...release, assets: [{ ...release.assets[0], download_count: 100 }] };
  assert.equal(
    githubRestSnapshotFingerprint("releases", release),
    githubRestSnapshotFingerprint("releases", moreDownloads),
  );
  const replaced = { ...release, assets: [{ ...release.assets[0], digest: "synthetic-replacement" }] };
  assert.notEqual(
    githubRestSnapshotFingerprint("releases", release),
    githubRestSnapshotFingerprint("releases", replaced),
  );
});

test("per-scan observations preserve A to B to A and expose only fixed-size hashes", () => {
  const a = payloads.issues;
  const b = { ...a, body: "Synthetic alternative" };
  const observations = [a, b, a].map((payload, index) =>
    githubRestSnapshotRevision("issues", payload, `synthetic-${index}`),
  );
  assert.equal(new Set(observations).size, 3);
  assert.equal(
    githubRestSnapshotSemanticRevision(observations[0]),
    githubRestSnapshotSemanticRevision(observations[2]),
  );
  assert.notEqual(
    githubRestSnapshotSemanticRevision(observations[0]),
    githubRestSnapshotSemanticRevision(observations[1]),
  );
  assert.equal(githubRestSnapshotRevision("issues", a, "synthetic-0"), observations[0]);
  for (const revision of observations) {
    assert.equal(revision.length, 108);
    assert.match(revision, /^[A-Za-z0-9_=.:\-]{1,128}$/);
    assert.ok(!revision.includes(a.body));
    assert.ok(!revision.includes(user.login));
  }
  assert.notEqual(githubRestSnapshotFingerprint("issues", a), githubRestSnapshotFingerprint("comments", a));
});

test("reserved malformed revisions cannot use a matching timestamp or permissive custom verifier", async () => {
  const valid = githubRestSnapshotRevision("issues", payloads.issues, "synthetic-scan");
  for (const revision of [
    "gh-rest-v1:",
    valid.slice(0, -1),
    valid.replace("v1:", "v2:"),
    valid.toUpperCase().replace("GH-REST-", "gh-rest-"),
    `${valid}x`,
  ]) {
    const h = normalizer("issues", revision, { verifyRevision: async () => true });
    const out = await h.run();
    assert.deepEqual(out.reasons, ["hydrated_source_revision_unverified"]);
    assert.equal(out.observations.length, 0);
    assert.equal(h.calls(), 0, "malformed reserved identities fail before hydration");
    assert.equal(githubRestSnapshotSemanticRevision(revision), null);
  }
  const wrongFamily = normalizer("issues", valid);
  assert.equal((await wrongFamily.run({ family: "reviews" })).observations.length, 0);
  const veto = normalizer("issues", valid, { verifyRevision: async () => false });
  assert.deepEqual((await veto.run()).reasons, ["hydrated_source_revision_unverified"]);
  const changed = normalizer("issues", valid, { verifyRevision: async () => true });
  changed.current({ ...payloads.issues, title: "Synthetic changed despite custom approval" });
  assert.deepEqual((await changed.run()).reasons, ["hydrated_source_revision_unverified"]);
});

test("legacy timestamp revisions remain readable and new fingerprints never infer an editor", async () => {
  const legacy = normalizer("issues", at);
  assert.equal((await legacy.run()).facts.filter((fact) => fact.metricId === "issues_opened").length, 1);
  const noActor = { ...payloads.issues, user: null, state: "closed" };
  const h = normalizer("issues", githubRestSnapshotRevision("issues", noActor, "synthetic-unknown"));
  h.current(noActor);
  const out = await h.run();
  assert.ok(out.facts.length > 0);
  assert.ok(out.facts.every((fact) => fact.actorId === null));
  assert.ok(out.facts.every((fact) => fact.metricId !== "issue_closure_stewardship"));
  assert.ok(!out.actors.some((actor) => actor.login === user.login));
});

test("invalid selected field shapes fail closed without disclosing source text", () => {
  for (const patch of [
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { body: { private: "synthetic secret" } },
    { labels: [false] },
    { user: { id: Infinity } },
    { title: undefined },
  ]) {
    const payload = { ...payloads.issues, ...patch };
    assert.throws(() => githubRestSnapshotFingerprint("issues", payload), /^TypeError: invalid_github_rest_snapshot$/);
    assert.equal(
      verifyGithubRestSnapshotRevision(
        "issues",
        payload,
        githubRestSnapshotRevision("issues", payloads.issues, "synthetic-valid"),
      ),
      false,
    );
  }
  assert.throws(() => githubRestSnapshotRevision("issues", payloads.issues, ""), /invalid_github_rest_snapshot/);
  assert.throws(() => githubRestSnapshotFingerprint("commits", payloads.issues), /invalid_github_rest_snapshot/);
});
