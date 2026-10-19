import assert from "node:assert/strict";
import test from "node:test";
import { GithubClientError } from "../../../packages/github/dist/client.js";
import { createGithubCollectionSource } from "../src/github-source.mjs";

// Synthetic transport gates exercise the real collector. No GitHub request or
// source authorization is created by these invocation-isolation regressions.
const repository = {
  id: 2,
  installationId: 1,
  slug: "synthetic-owner/repository",
  families: ["issues"],
  allowedProjectIds: ["PVT_synthetic"],
};
const request = (patch = {}) => ({
  repositoryId: repository.id,
  runId: "synthetic-original",
  family: "issues",
  cursor: null,
  limit: 1,
  ...patch,
});
const issue = (number) => ({
  id: number,
  node_id: `I_synthetic_${number}`,
  number,
  html_url: `https://github.com/${repository.slug}/issues/${number}`,
  updated_at: "2026-10-05T00:00:00Z",
  state: "open",
});
const review = (number) => ({
  id: number,
  node_id: `R_synthetic_${number}`,
  html_url: `https://github.com/${repository.slug}/pull/${number}#pullrequestreview-${number}`,
  submitted_at: "2026-10-05T00:00:00Z",
  state: "APPROVED",
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness({ repositories = [repository], probe, scan, graphql, assertAuthorized, onUnavailable } = {}) {
  const calls = [];
  const client = {
    forRepository(repositoryId) {
      assert.ok(repositories.some((item) => item.id === repositoryId));
      return client;
    },
    async rest(_source, path) {
      calls.push({ kind: "probe", path });
      await probe?.();
      const selected = repositories.find((item) => path === `/repos/${item.slug}`);
      assert.ok(selected, path);
      return { id: selected.id, private: false, full_name: selected.slug };
    },
    async scanRest(options) {
      calls.push({ kind: "scan", key: options.key, url: options.url });
      const values = scan ? await scan(options) : [issue(1), issue(2)];
      return options.select(values);
    },
    async graphql(...args) {
      assert.ok(graphql, "Unexpected GraphQL read");
      return graphql(...args);
    },
    async scanGraphql() {
      assert.fail("Unexpected GraphQL scan");
    },
  };
  return {
    calls,
    source: createGithubCollectionSource({
      client,
      sourceId: "synthetic",
      repositories,
      isSynthetic: true,
      ...(assertAuthorized ? { assertAuthorized } : {}),
      ...(onUnavailable ? { onUnavailable } : {}),
    }),
  };
}

test("an issue-only invocation cannot become review collection while its visibility probe waits", async () => {
  const gate = deferred();
  const input = request();
  const h = harness({
    probe: () => gate.promise,
    scan: (options) =>
      options.url.includes("/pulls?") ? [{ number: 7 }] : options.url.includes("/reviews?") ? [review(7)] : [issue(1)],
  });
  const pending = h.source.readPage(input);
  input.family = "reviews";
  input.runId = "synthetic-reused";
  gate.resolve();
  const page = await pending;
  assert.deepEqual(
    h.calls.filter((call) => call.kind === "scan"),
    [
      {
        kind: "scan",
        key: "pipeline:2:synthetic-original:issues",
        url: `/repos/${repository.slug}/issues?state=all&sort=created&direction=asc&per_page=100`,
      },
    ],
  );
  assert.equal(page.facts[0].subjectId, "I_synthetic_1");
  assert.equal(input.family, "reviews", "The collector must not restore or mutate the caller's object");
});

test("issue filtering and page bounds retain their original values while the source scan waits", async () => {
  const entered = deferred();
  const gate = deferred();
  const input = request();
  const values = [issue(1), { ...issue(99), pull_request: { url: "synthetic-pr-marker" } }, issue(2)];
  const original = structuredClone(values);
  const h = harness({
    async scan() {
      entered.resolve();
      await gate.promise;
      return values;
    },
  });
  const pending = h.source.readPage(input);
  await entered.promise;
  Object.assign(input, { family: "comments", cursor: "1", limit: 50, runId: "synthetic-reused" });
  gate.resolve();
  const page = await pending;
  assert.deepEqual(
    page.facts.map((fact) => fact.subjectId),
    ["I_synthetic_1"],
  );
  assert.equal(page.expectedCount, 2, "The REST issues endpoint's PR row must remain excluded");
  assert.equal(page.nextCursor, "1");
  assert.deepEqual(values, original);
});

test("the initial cursor stays fixed across the visibility await", async () => {
  const gate = deferred();
  const input = request({ cursor: "1" });
  const h = harness({ probe: () => gate.promise });
  const pending = h.source.readPage(input);
  input.cursor = null;
  gate.resolve();
  const page = await pending;
  assert.deepEqual(
    page.facts.map((fact) => fact.subjectId),
    ["I_synthetic_2"],
  );
  assert.equal(page.nextCursor, null);
});

test("review fanout and all source revisions retain the original scan identity", async () => {
  const entered = deferred();
  const gate = deferred();
  const input = request({ family: "reviews", limit: 2 });
  const repositories = [{ ...repository, families: ["reviews"] }];
  const values = (options) =>
    options.url.includes("/pulls?")
      ? [{ number: 1 }, { number: 2 }]
      : [review(options.url.includes("/pulls/1/") ? 1 : 2)];
  const baseline = await harness({ repositories, scan: values }).source.readPage({ ...input });
  const h = harness({
    repositories,
    async scan(options) {
      if (options.url.includes("/pulls/1/")) {
        entered.resolve();
        await gate.promise;
      }
      return values(options);
    },
  });
  const pending = h.source.readPage(input);
  await entered.promise;
  input.runId = "synthetic-reused";
  gate.resolve();
  assert.deepEqual(await pending, baseline);
  assert.deepEqual(
    h.calls.filter((call) => call.kind === "scan").map((call) => call.key),
    [
      "pipeline:2:synthetic-original:review-pulls",
      "pipeline:2:synthetic-original:reviews:1",
      "pipeline:2:synthetic-original:reviews:2",
    ],
  );
});

for (const changedFamily of ["issues", "project_current"]) {
  test(`Project permission loss invalidates the original repository after reuse as ${changedFamily}`, async () => {
    const entered = deferred();
    const gate = deferred();
    const input = request({ family: "project_current" });
    const originalRepository = { ...repository, families: ["project_current"] };
    const otherRepository = { ...repository, id: 3, slug: "synthetic-owner/other" };
    const unavailable = [];
    const failure = new GithubClientError({ kind: "permission_denied", retryable: false }, "synthetic");
    const h = harness({
      repositories: [originalRepository, otherRepository],
      graphql: async (_source, query, variables) => {
        assert.ok(query.includes("... on ProjectV2 { id public }"));
        assert.deepEqual(variables, { id: "PVT_synthetic" });
        return { node: { id: "PVT_synthetic", public: true } };
      },
      async scan() {
        entered.resolve();
        await gate.promise;
        throw failure;
      },
      onUnavailable: (item, reason) => unavailable.push([item.id, reason]),
    });
    const pending = h.source.readPage(input);
    const rejected = assert.rejects(pending, (error) => error === failure);
    await entered.promise;
    Object.assign(input, { repositoryId: 3, family: changedFamily });
    gate.resolve();
    await rejected;
    assert.deepEqual(unavailable, [[2, "project_scope_unavailable"]]);
  });
}

test("captured request inputs do not freeze the live authorization callback", async () => {
  const gate = deferred();
  let authorized = true;
  const h = harness({
    probe: () => gate.promise,
    assertAuthorized() {
      if (!authorized) throw Error("synthetic-authorization-revoked");
    },
  });
  const pending = h.source.readPage(request());
  const rejected = assert.rejects(pending, /synthetic-authorization-revoked/);
  authorized = false;
  gate.resolve();
  await rejected;
  assert.equal(h.calls.filter((call) => call.kind === "scan").length, 0);
});
