import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createGithubCollectionSource } from "../../../apps/pipeline/src/github-source.mjs";
import { createGithubEvidenceNormalizer, githubTimelineRevision } from "../dist/index.js";
import { syntheticRepositoryClient } from "./synthetic-client.mjs";

// All identities and observations are synthetic. The real planning-batch audit
// records source coordinates separately and never supplies production fixtures.
const repository = { id: 2, slug: "synthetic-owner/repository", installationId: 1, families: ["timelines"] };
const at = "2026-10-07T10:00:00Z";
const observedAt = "2026-10-08T10:00:00Z";
const actor = { id: 202, node_id: "U_synthetic_triager", login: "synthetic-triager", type: "User" };
const event = (action, patch = {}) => ({
  id: 901,
  event: action,
  created_at: at,
  actor,
  issue_type: { id: 90, name: "Synthetic task" },
  issue: {
    id: 20,
    node_id: "I_synthetic_20",
    number: 20,
    html_url: `https://github.com/${repository.slug}/issues/20`,
    issue_type: { id: 999, name: "Unrelated current type" },
    user: { id: 101, type: "User", login: "synthetic-author" },
  },
  ...patch,
});

async function collect(sourceEvent) {
  let hydrated = structuredClone(sourceEvent);
  const client = syntheticRepositoryClient(repository.id, {
    rest: async (_source, path) => {
      if (path === `/repos/${repository.slug}`)
        return { id: repository.id, private: false, full_name: repository.slug };
      assert.equal(path, `/repos/${repository.slug}/issues/events/${sourceEvent.id}`);
      return structuredClone(hydrated);
    },
    scanRest: async (scan) => scan.select([structuredClone(sourceEvent)]),
  });
  const source = createGithubCollectionSource({
    client,
    sourceId: "synthetic",
    repositories: [repository],
    isSynthetic: true,
  });
  const page = await source.readPage({
    repositoryId: repository.id,
    runId: "synthetic-triage",
    family: "timelines",
    cursor: null,
    limit: 100,
  });
  assert.equal(page.facts.length, 1);
  const input = {
    repository,
    family: "timelines",
    factKey: "synthetic-triage",
    observedAt,
    policyVersion: "synthetic/v1",
    fact: page.facts[0],
  };
  const normalize = createGithubEvidenceNormalizer({
    client,
    source: "synthetic",
    allowedRepositoryIds: [repository.id],
    isSynthetic: true,
  });
  return {
    input,
    run: () => normalize(input),
    hydrate: (replacement) => {
      hydrated = replacement;
    },
  };
}

test("native issue-type additions and removals survive collection and exact event hydration", async () => {
  for (const [native, canonical] of [
    ["issue_type_added", "issue_typed"],
    ["issue_type_removed", "issue_untyped"],
  ]) {
    const collected = await collect(event(native));
    assert.equal(collected.input.fact.actorId, "202");
    assert.equal(collected.input.fact.occurredAt, "2026-10-07T10:00:00.000Z");
    const out = await collected.run();
    assert.equal(out.facts.length, 1, native);
    const fact = out.facts[0];
    assert.equal(fact.metricId, "items_triaged");
    assert.equal(fact.actorId, "202");
    assert.equal(fact.subjectActorId, "101");
    assert.equal(fact.state, "observed");
    assert.equal(fact.rawState, `${canonical}:github:metadata:90`);
    assert.equal(fact.occurredAt, "2026-10-07T10:00:00.000Z");
    assert.equal(fact.acceptanceReceipt, null);
    assert.equal(out.observations[0].action, native, "the source observation retains GitHub's native action");
    assert.equal(out.evidence[0].evidenceMetadata.sourceAction, canonical);
    assert.deepEqual((await collected.run()).facts, out.facts, "re-hydration must retain the same canonical event");
  }
});

test("a changed issue-type target invalidates the collected revision before normalization", async () => {
  for (const action of ["issue_type_added", "issue_type_removed", "issue_typed", "issue_untyped"]) {
    for (const target of [
      { id: 91, name: "Synthetic task" },
      { node_id: "IT_synthetic_other" },
      { name: "Display only" },
      null,
    ]) {
      const original = event(action);
      const collected = await collect(original);
      const changed = { ...original, issue_type: target };
      assert.notEqual(githubTimelineRevision(changed), collected.input.fact.sourceRevision, action);
      collected.hydrate(changed);
      const out = await collected.run();
      assert.deepEqual(out.facts, []);
      assert.deepEqual(out.reasons, ["hydrated_source_revision_unverified"]);
    }
    const fallback = event(action, { issue_type: null, target_id: "IT_synthetic_explicit" });
    const collected = await collect(fallback);
    assert.equal((await collected.run()).facts[0].rawState.endsWith(":IT_synthetic_explicit"), true);
    collected.hydrate({ ...fallback, target_id: "IT_synthetic_changed" });
    assert.deepEqual(
      (await collected.run()).reasons,
      ["hydrated_source_revision_unverified"],
      "the explicit fallback identity is also revision-bound",
    );
  }
});

test("native type history with missing target identity remains unknown despite a current issue type", async () => {
  for (const action of ["issue_type_added", "issue_type_removed"]) {
    for (const target of [undefined, null, {}, { name: "Synthetic display name" }, { id: null }]) {
      const out = await (await collect(event(action, { issue_type: target }))).run();
      assert.equal(out.facts.length, 1, action);
      assert.equal(out.facts[0].state, "unknown");
      assert.equal(out.facts[0].rawState, undefined);
      assert.ok(out.reasons.includes("unknown_metadata_target_identity"));
      assert.equal(out.evidence[0].evidenceMetadata.sourceAction, "unknown");
    }
  }
});

test("adding native type support preserves existing non-type timeline revision identities", () => {
  const identity = (item) =>
    item && typeof item === "object" ? [item.id ?? null, item.node_id ?? null, item.name ?? null] : null;
  for (const action of [
    "labeled",
    "unlabeled",
    "assigned",
    "milestoned",
    "project_v2_item_status_changed",
    "transferred",
  ]) {
    const value = event(action, { label: { id: 80 }, assignee: { id: 81 }, milestone: { id: 82 } });
    const previous = createHash("sha256")
      .update(
        JSON.stringify([
          value.id,
          value.event,
          value.created_at,
          identity(value.actor),
          identity(value.label),
          identity(value.milestone),
          identity(value.assignee),
        ]),
      )
      .digest("hex");
    assert.equal(githubTimelineRevision(value), previous, action);
  }
});
