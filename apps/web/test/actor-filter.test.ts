import assert from "node:assert/strict";
import test from "node:test";
import { actorFilterSchema, matchesActorFilter, type Actor } from "@pick-your-ai/contracts";
import { metadata, parameters, portfolioParameters, selection, uiHref } from "../src/remote/client.ts";
import { proofHref } from "../src/remote/proof.ts";
import { cardHref, cardImageHref } from "../src/remote/recognition-client.ts";

test("account kind and known execution are independent, with no inferred manual or AI class", () => {
  const actor = (kind: Actor["kind"], executionMode: Actor["executionMode"] = "unknown") => ({ kind, executionMode });
  assert.equal(matchesActorFilter(actor("user"), "user"), true);
  assert.equal(matchesActorFilter(actor("user"), "automation"), false);
  assert.equal(matchesActorFilter(actor("user", "automated"), "user"), true);
  assert.equal(matchesActorFilter(actor("user", "automated"), "automation"), true);
  for (const kind of ["bot", "github_app", "service_account", "system"] as const) {
    assert.equal(matchesActorFilter(actor(kind), "user"), false);
    assert.equal(matchesActorFilter(actor(kind), "automation"), true);
  }
  assert.equal(matchesActorFilter(actor("unknown"), "automation"), false);
  assert.equal(matchesActorFilter(actor("unknown"), "all"), true);
  for (const value of ["manual", "human", "AI", "", undefined, null])
    assert.equal(actorFilterSchema.safeParse(value).success, false);
});

test("API, proof, sharing and navigation parameters retain actor selection and drop obsolete cursors", () => {
  const selected = selection("?actors=automation&snapshot=public-1&cursor=old.signature&repository=repo-1");
  assert.equal(selected.actors, "automation");
  for (const params of [parameters(selected), portfolioParameters(selected), portfolioParameters(selected, true)])
    assert.equal(params.get("actors"), "automation");
  for (const path of [
    "/contributors",
    "/contributors/bob",
    "/activity",
    "/contributions/e-bob",
    "/leaderboards/pr_opened",
  ]) {
    const url = new URL(uiHref(path, selected), "https://example.invalid");
    assert.equal(url.searchParams.get("actors"), "automation");
    assert.equal(url.searchParams.get("snapshot"), "public-1");
    assert.equal(url.searchParams.get("cursor"), null);
  }
  for (const href of [
    proofHref("/leaderboards/pr_opened", selected, "e-bob"),
    cardHref("/api/v1", selected, "public-1", "bob", "pr_opened"),
    cardImageHref("/api/v1", selected, "public-1", "bob", "pr_opened"),
  ])
    assert.equal(new URL(href, "https://example.invalid").searchParams.get("actors"), "automation");
  assert.equal(selection("").actors, "all");
  for (const value of ["?actors=", "?actors=user&actors=all", "?actors=human", "?actors=manual"])
    assert.throws(() => selection(value));
});

test("client rejects omitted, widened or invalid actor-selection response labels", () => {
  const value = {
    scope: { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null },
    head: { snapshotId: "public-1", revision: 1, publishedAt: "2026-10-18T00:00:00.000Z" },
    snapshotId: "public-1",
    revision: 1,
    generatedAt: "2026-10-18T00:00:00.000Z",
    metricDefinitionVersion: "candidate-0.1.0",
    computationVersion: "synthetic-only",
    policyVersion: "policy-1",
    coverage: [],
  };
  assert.equal(metadata(value, selection("")).actorFilter, "all");
  assert.equal(
    metadata({ ...value, actorFilter: "automation" }, selection("?actors=automation")).actorFilter,
    "automation",
  );
  for (const actorFilter of [undefined, "all", "user", "manual"])
    assert.throws(
      () => metadata({ ...value, actorFilter }, selection("?actors=automation")),
      /api_actor_filter_mismatch/,
    );
});
