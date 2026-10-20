import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCheckpointStore } from "../../../packages/github/dist/checkpoints.js";
import { GithubClientError } from "../../../packages/github/dist/client.js";
import { runGithubSourceCanary } from "../src/github-source-canary.mjs";

const origin = "https://api.github.com";
const repository = { id: 42, installationId: 73, slug: "synthetic-project/leaderboard" };
const repoPath = `/repos/${repository.slug}`;
const json = (body, headers = {}, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-resource": "core",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4999",
      ...headers,
    },
  });

async function fixture(t, count = 101) {
  const directory = await mkdtemp(join(tmpdir(), "synthetic-source-canary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const h = { directory, requests: [], opens: [], closes: [], writes: [], tokens: [], allowed: true, count };
  h.request = {
    runId: "synthetic-run",
    source: "synthetic-installation-73",
    repository: { ...repository },
    history: { number: 11, id: 1001 },
    reviews: { number: 12, id: 1002 },
    scanMode: "refresh",
    apiOrigin: origin,
    apiVersion: "2022-11-28",
    maxPages: 10,
  };
  h.host = {
    request: h.request,
    authorize: async () => true,
    assertAuthorized: () => h.allowed,
    async open({ phase, signal, request }) {
      h.opens.push(phase);
      await h.onOpen?.(phase);
      const root = new FileCheckpointStore(join(directory, phase === "reuse" && h.emptyReuse ? "empty" : "cache"));
      const checkpoints = {
        load: root.load.bind(root),
        save: root.save.bind(root),
        forRepository(id) {
          const scoped = root.forRepository(id);
          return {
            repositoryId: id,
            load: scoped.load.bind(scoped),
            assertActive: scoped.assertActive.bind(scoped),
            retire: scoped.retire.bind(scoped),
            async save(key, value) {
              await h.beforeSave?.(key, value);
              await scoped.save(key, value);
              h.writes.push({ key, value: structuredClone(value) });
            },
          };
        },
      };
      return {
        checkpoints,
        async token(source, options) {
          h.tokens.push({ source, aborted: options.signal?.aborted ?? false });
          await h.onToken?.(source, options);
          return "synthetic-private-token";
        },
        async fetch(raw, options) {
          assert.equal(options.method, "GET");
          assert.equal(options.redirect, "manual");
          assert.equal(options.headers.get("authorization"), "Bearer synthetic-private-token");
          assert.equal(options.headers.get("x-github-api-version"), request.apiVersion);
          const url = new URL(raw);
          h.requests.push({ phase, url: raw });
          const custom = await h.respond?.(url, options, phase);
          if (custom) return custom;
          if (url.pathname === repoPath) return json({ id: repository.id, full_name: repository.slug, private: false });
          if (url.pathname === `${repoPath}/issues/11`) return json({ id: 1001, number: 11 });
          if (url.pathname === `${repoPath}/pulls/12`)
            return json({ id: 1002, number: 12, base: { repo: { id: repository.id } } });
          const history = url.pathname === `${repoPath}/issues/11/events`;
          assert.ok(history || url.pathname === `${repoPath}/pulls/12/reviews`, raw);
          const page = Number(url.searchParams.get("page"));
          const start = (page - 1) * 100,
            end = Math.min(start + 100, h.count);
          const values = Array.from({ length: Math.max(0, end - start) }, (_, offset) => {
            const id = start + offset + 1 + (history ? 0 : 10000);
            return history
              ? {
                  id,
                  url: `${origin}${repoPath}/issues/events/${id}`,
                  actor: { id: 500 + id, email: "synthetic-email@example.test" },
                  event: "labeled",
                  created_at: "2026-01-01T00:00:00Z",
                  body: "SYNTHETIC_PRIVATE_BODY",
                }
              : {
                  id,
                  pull_request_url: `${origin}${repoPath}/pulls/12`,
                  user: { id: 500 + id },
                  state: "COMMENTED",
                  submitted_at: "2026-01-01T00:00:00Z",
                  body: "SYNTHETIC_PRIVATE_BODY",
                };
          });
          await h.onPage?.(values, { history, page, phase });
          const headers =
            start + 100 < h.count
              ? { link: `<${origin}${url.pathname}?per_page=100&page=${page + 1}>; rel="next"` }
              : {};
          return json(values, { ...headers, ...h.headers });
        },
        async close() {
          h.closes.push(phase);
          await h.onClose?.(phase);
        },
      };
    },
  };
  return h;
}

test("real REST Link scans exceed 100 identities and reopen exact retained results without collection HTTP", async (t) => {
  const h = await fixture(t);
  const result = await runGithubSourceCanary(h.host);
  assert.equal(result.state, "observed");
  assert.equal(result.installedCapability, "unverified");
  assert.equal(result.sourceEnabled, false);
  assert.deepEqual(h.opens, ["scan", "reuse"]);
  assert.deepEqual(h.closes, ["scan", "reuse"]);
  assert.deepEqual(
    result.passes[0].results.map((x) => [x.kind, x.records, x.selectedPages]),
    [
      ["issue_events", 101, 2],
      ["pull_reviews", 101, 2],
    ],
  );
  assert.ok(result.passes[1].results.every((x) => x.records === 101 && x.selectedPages === 0));
  assert.equal(h.requests.filter((x) => /\/(events|reviews)\?/.test(x.url)).length, 4);
  assert.equal(h.requests.filter((x) => x.phase === "reuse" && /\/(events|reviews)\?/.test(x.url)).length, 0);
  assert.deepEqual(
    result.observations.filter((x) => x.page !== null).map((x) => [x.endpoint, x.page, x.nextPage, x.status]),
    [
      ["issue_events", 1, 2, 200],
      ["issue_events", 2, null, 200],
      ["pull_reviews", 1, 2, 200],
      ["pull_reviews", 2, null, 200],
    ],
  );
  assert.ok(result.observations.every((x) => x.quota.remaining === 4999));
  const report = JSON.stringify(result);
  for (const forbidden of [
    "synthetic-private-token",
    "SYNTHETIC_PRIVATE_BODY",
    "synthetic-email@example.test",
    '"actorId"',
    '"source":',
  ])
    assert.ok(!report.includes(forbidden));
  assert.ok(result.passes[0].quotaAfter.resources.some((x) => x.resource === "core" && x.state === "observed"));
});

test("small complete samples remain insufficient and do not become installed capability", async (t) => {
  const h = await fixture(t, 20);
  const result = await runGithubSourceCanary(h.host);
  assert.equal(result.state, "insufficient_sample");
  assert.ok(result.passes[0].results.every((x) => x.records === 20 && x.selectedPages === 1));
  assert.equal(result.installedCapability, "unverified");
});

test("unknown actor, timestamp and action remain explicit counts instead of accepted attribution", async (t) => {
  const h = await fixture(t, 1);
  h.onPage = (values) =>
    Object.assign(values[0], {
      actor: null,
      user: null,
      created_at: "2026-02-30T00:00:00Z",
      submitted_at: null,
      event: null,
      state: null,
    });
  h.headers = { "x-ratelimit-resource": "unrecognized", "x-ratelimit-remaining": "", "x-ratelimit-used": "0" };
  const result = await runGithubSourceCanary(h.host);
  assert.ok(
    result.passes[0].results.every((x) => x.unknownActor === 1 && x.unknownTime === 1 && x.unknownAction === 1),
  );
  const selected = result.observations.filter((x) => x.page !== null);
  assert.ok(selected.every((x) => x.quota.resource === "unknown" && x.quota.remaining === null && x.quota.used === 0));
});

test("request and target inputs are detached before an awaited host authorization", async (t) => {
  const h = await fixture(t);
  let once = false;
  h.host.authorize = async () => {
    if (!once) {
      once = true;
      h.request.source = "unapproved-pool";
      h.request.repository.slug = "other/repository";
      h.request.history.number = 999;
      h.request.reviews.id = 888;
      h.request.maxPages = 1;
    }
    return true;
  };
  const result = await runGithubSourceCanary(h.host);
  assert.equal(result.state, "observed");
  assert.deepEqual(result.repository, repository);
  assert.ok(h.tokens.every((x) => x.source === "synthetic-installation-73"));
  assert.ok(h.requests.every((x) => new URL(x.url).pathname.startsWith(repoPath)));
});

test("invalid immutable scope and non-true host authorization cannot open a resource", async (t) => {
  const h = await fixture(t);
  for (const change of [
    { maxPages: 101 },
    { maxPages: 0 },
    { source: "Bearer synthetic-secret" },
    { apiOrigin: "https://api.github.com/path" },
    { scanMode: "automatic" },
    { history: { number: 11, id: "1001" } },
    { repository: { ...repository, id: 0 } },
    { repository: { ...repository, slug: "../leaderboard" } },
    { extra: true },
  ])
    await assert.rejects(
      runGithubSourceCanary({ ...h.host, request: { ...h.request, ...change } }),
      /source_canary_invalid_configuration/,
    );
  for (const authorization of [false, undefined, 1, "true"])
    await assert.rejects(
      runGithubSourceCanary({ ...h.host, authorize: async () => authorization }),
      /source_canary_authorization_required/,
    );
  assert.deepEqual(h.opens, []);
});

test("repository visibility and native target identity fail closed before collection", async (t) => {
  for (const failure of ["private", "repository", "subject", "review-repository"]) {
    const h = await fixture(t);
    h.respond = async (url) => {
      if (url.pathname === repoPath && ["private", "repository"].includes(failure))
        return json({
          id: failure === "repository" ? 43 : 42,
          full_name: repository.slug,
          private: failure === "private",
        });
      if (url.pathname === `${repoPath}/issues/11` && failure === "subject") return json({ id: 999, number: 11 });
      if (url.pathname === `${repoPath}/pulls/12` && failure === "review-repository")
        return json({ id: 1002, number: 12, base: { repo: { id: 99 } } });
    };
    await assert.rejects(
      runGithubSourceCanary(h.host),
      /source_canary_(public_repository|subject_identity)_unverified/,
    );
    assert.ok(
      h.requests.every((x) =>
        failure === "review-repository" ? !x.url.includes("/pulls/12/reviews") : !/\/(events|reviews)\?/.test(x.url),
      ),
    );
    assert.deepEqual(h.closes, ["scan"]);
  }
});

test("a Link cannot change repository, target, credentials or the fixed page query", async (t) => {
  for (const next of [
    `${origin}/repos/other/repo/issues/11/events?per_page=100&page=2`,
    `${origin}${repoPath}/issues/12/events?per_page=100&page=2`,
    `https://user:secret@api.github.com${repoPath}/issues/11/events?per_page=100&page=2`,
    `${origin}${repoPath}/issues/11/events?per_page=100&page=2&page=3`,
    `${origin}${repoPath}/issues/11/events?per_page=100&page=2&token=synthetic-secret`,
  ]) {
    const h = await fixture(t);
    h.headers = { link: `<${next}>; rel="next"` };
    await assert.rejects(runGithubSourceCanary(h.host), /source_canary_unsafe_route/);
    assert.equal(h.requests.filter((x) => /\/events\?/.test(x.url)).length, 1);
    assert.ok(!h.requests.some((x) => x.url === next));
  }
});

test("duplicate or cross-subject records reject before a canary completion receipt", async (t) => {
  for (const mode of ["duplicate", "event-repository", "review-subject"]) {
    const h = await fixture(t);
    h.onPage = (values, { history, page }) => {
      if (mode === "duplicate" && history && page === 2) values[0].id = 1;
      if (mode === "event-repository" && history)
        values[0].url = `${origin}/repos/other/repo/issues/events/${values[0].id}`;
      if (mode === "review-subject" && !history) values[0].pull_request_url = `${origin}${repoPath}/pulls/13`;
    };
    await assert.rejects(runGithubSourceCanary(h.host), /source_canary_(invalid_record|duplicate_identity)/);
    assert.deepEqual(h.closes, ["scan"]);
  }
});

test("page-bound failure preserves its committed prefix for explicit resume without a fresh-completeness claim", async (t) => {
  const h = await fixture(t);
  h.request.maxPages = 1;
  await assert.rejects(runGithubSourceCanary(h.host), /source_canary_failed/);
  const prefix = h.writes.filter((x) => x.key.startsWith("scan:"));
  assert.equal(prefix.length, 1);
  assert.equal(prefix[0].value.items.length, 100);
  assert.equal(prefix[0].value.complete, false);
  h.requests.length = 0;
  h.request.maxPages = 2;
  h.request.scanMode = "resume";
  const result = await runGithubSourceCanary(h.host);
  assert.equal(result.state, "insufficient_sample");
  assert.deepEqual(
    result.passes[0].results.map((x) => [x.records, x.selectedPages]),
    [
      [101, 1],
      [101, 2],
    ],
  );
  assert.ok(!h.requests.some((x) => x.url === `${origin}${repoPath}/issues/11/events?per_page=100&page=1`));
});

test("a failed second durable page is retried from the previous accepted cursor", async (t) => {
  const h = await fixture(t);
  let failOnce = true;
  h.beforeSave = async (key, value) => {
    if (failOnce && key.startsWith("scan:") && value.items.length === 101) {
      failOnce = false;
      throw Error("SYNTHETIC_PRIVATE_STORAGE_FAILURE");
    }
  };
  await assert.rejects(runGithubSourceCanary(h.host), { message: "source_canary_failed" });
  assert.equal(h.writes.filter((x) => x.key.startsWith("scan:")).at(-1).value.items.length, 100);
  h.request.scanMode = "resume";
  h.requests.length = 0;
  const result = await runGithubSourceCanary(h.host);
  assert.equal(result.passes[0].results[0].records, 101);
  assert.equal(result.passes[0].results[0].selectedPages, 1);
  assert.ok(!h.requests.some((x) => x.url === `${origin}${repoPath}/issues/11/events?per_page=100&page=1`));
});

test("reopen with a different empty store cannot impersonate retained reuse or contact a collection", async (t) => {
  const h = await fixture(t);
  h.emptyReuse = true;
  await assert.rejects(runGithubSourceCanary(h.host), /source_canary_retained_reuse_missing/);
  assert.ok(!h.requests.some((x) => x.phase === "reuse" && /\/(events|reviews)\?/.test(x.url)));
  assert.deepEqual(h.closes, ["scan", "reuse"]);
});

test("a changed retained observation or unexpected retained field cannot pass the reopen comparison", async (t) => {
  for (const mode of ["changed-actor", "extra-field"]) {
    const h = await fixture(t);
    h.onOpen = async (phase) => {
      if (phase !== "reuse") return;
      const saved = h.writes.find((x) => x.key.startsWith("scan:") && x.value.complete);
      const value = structuredClone(saved.value);
      if (mode === "changed-actor") value.items[0].actorId = 999999;
      else value.items[0].privateBody = "SYNTHETIC_RETAINED_PRIVATE_BODY";
      await new FileCheckpointStore(join(h.directory, "cache")).forRepository(repository.id).save(saved.key, value);
    };
    await assert.rejects(
      runGithubSourceCanary(h.host),
      /source_canary_(retained_result_changed|invalid_retained_result)/,
    );
    assert.ok(!h.requests.some((x) => x.phase === "reuse" && /\/(events|reviews)\?/.test(x.url)));
    assert.deepEqual(h.closes, ["scan", "reuse"]);
  }
});

test("a distinct run identity performs its own scan instead of borrowing a completed canary", async (t) => {
  const h = await fixture(t);
  const first = await runGithubSourceCanary(h.host);
  h.request.runId = "synthetic-second-run";
  h.request.scanMode = "resume";
  h.requests.length = 0;
  const second = await runGithubSourceCanary(h.host);
  assert.notEqual(first.binding, second.binding);
  assert.ok(second.passes[0].results.every((x) => x.selectedPages === 2));
  assert.equal(h.requests.filter((x) => /\/(events|reviews)\?/.test(x.url)).length, 4);
});

test("current visibility and authorization are rechecked through reopening and final resource close", async (t) => {
  for (const phase of ["reopen", "final-close"]) {
    const h = await fixture(t);
    if (phase === "reopen")
      h.respond = async (url, _options, current) =>
        current === "reuse" && url.pathname === repoPath
          ? json({ id: 42, full_name: repository.slug, private: true })
          : undefined;
    else
      h.onClose = async (current) => {
        if (current === "reuse") h.allowed = false;
      };
    await assert.rejects(
      runGithubSourceCanary(h.host),
      /source_canary_(public_repository_unverified|authorization_required)/,
    );
    assert.deepEqual(h.closes, ["scan", "reuse"]);
  }
});

test("cancellation during token preparation drains before close and prevents HTTP", async (t) => {
  const h = await fixture(t);
  const entered = Promise.withResolvers(),
    released = Promise.withResolvers(),
    controller = new AbortController();
  h.onToken = async () => {
    entered.resolve();
    await released.promise;
  };
  const pending = runGithubSourceCanary(h.host, { signal: controller.signal });
  await entered.promise;
  controller.abort();
  assert.deepEqual(h.closes, []);
  released.resolve();
  await assert.rejects(pending, /source_canary_(stopped|unsafe_request)/);
  assert.deepEqual(h.closes, ["scan"]);
  assert.deepEqual(h.requests, []);
});

test("authorization loss while a response is pending withholds pages and result", async (t) => {
  const h = await fixture(t);
  const entered = Promise.withResolvers(),
    released = Promise.withResolvers();
  h.respond = async (url) => {
    if (url.pathname.endsWith("/events")) {
      entered.resolve();
      await released.promise;
    }
  };
  const pending = runGithubSourceCanary(h.host);
  await entered.promise;
  h.allowed = false;
  released.resolve();
  await assert.rejects(pending, /source_canary_unsafe_request/);
  assert.ok(!h.writes.some((x) => x.key.startsWith("scan:")));
  assert.deepEqual(h.closes, ["scan"]);
});

test("source rate limits remain retained and block a subsequent attempt without token or HTTP dispatch", async (t) => {
  const h = await fixture(t);
  h.respond = async () => json({ message: "synthetic rate limit" }, { "retry-after": "60" }, 429);
  await assert.rejects(runGithubSourceCanary(h.host), /source_canary_rate_limited/);
  assert.equal(h.requests.length, 1);
  h.respond = undefined;
  h.requests.length = 0;
  h.tokens.length = 0;
  await assert.rejects(runGithubSourceCanary(h.host), /source_canary_source_paused/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.tokens.length, 0);
  h.request.source = "synthetic-other-installation";
  const result = await runGithubSourceCanary(h.host);
  assert.equal(result.state, "observed");
});

test("a provider cannot pass through a canary-looking secret exception", async (t) => {
  const h = await fixture(t);
  h.host.authorize = async () => {
    throw Error("source_canary_private_sentinel");
  };
  await assert.rejects(runGithubSourceCanary(h.host), { message: "source_canary_failed" });
  assert.equal(h.opens.length, 0);
});

test("throwing exception classification and altered prior errors retain only fixed canary categories", async (t) => {
  const h = await fixture(t);
  const getterError = new GithubClientError({ kind: "unknown_failure" }, "synthetic");
  Object.defineProperty(getterError, "outcome", {
    get() {
      throw Error("SYNTHETIC_PRIVATE_ERROR_GETTER");
    },
  });
  const proxyError = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw Error("SYNTHETIC_PRIVATE_ERROR_PROTOTYPE");
      },
    },
  );
  for (const error of [getterError, proxyError]) {
    h.host.authorize = async () => {
      throw error;
    };
    await assert.rejects(runGithubSourceCanary(h.host), { message: "source_canary_failed" });
  }
  let prior;
  try {
    await runGithubSourceCanary({});
  } catch (error) {
    prior = error;
  }
  prior.message = "SYNTHETIC_PRIVATE_ALTERED_ERROR";
  h.host.authorize = async () => {
    throw prior;
  };
  await assert.rejects(runGithubSourceCanary(h.host), { message: "source_canary_invalid_configuration" });
  assert.deepEqual(h.opens, []);
  assert.deepEqual(h.tokens, []);
  assert.deepEqual(h.requests, []);
});

for (const property of ["authorize", "assertAuthorized", "open"]) {
  test(`a throwing host ${property} getter cannot expose its private exception`, async (t) => {
    const h = await fixture(t);
    Object.defineProperty(h.host, property, {
      get() {
        throw Error("SYNTHETIC_PRIVATE_HOST_GETTER");
      },
    });
    await assert.rejects(runGithubSourceCanary(h.host), { message: "source_canary_failed" });
    assert.deepEqual(h.opens, []);
    assert.deepEqual(h.tokens, []);
    assert.deepEqual(h.requests, []);
  });
}

test("a throwing signal getter cannot escape the exported fixed-category boundary", async (t) => {
  const h = await fixture(t);
  const options = {
    get signal() {
      throw Error("SYNTHETIC_PRIVATE_SIGNAL_GETTER");
    },
  };
  await assert.rejects(runGithubSourceCanary(h.host, options), { message: "source_canary_failed" });
  assert.deepEqual(h.opens, []);
});

test("host authority remains valid after ordinary resource disposal and requires a synchronous true result", async (t) => {
  const h = await fixture(t);
  const closed = new Set();
  let checkedAfterClose = false;
  h.onClose = async (phase) => {
    closed.add(phase);
  };
  h.host.assertAuthorized = (request) => {
    assert.equal(request.repository.id, repository.id);
    assert.equal(request.repository.installationId, repository.installationId);
    if (closed.size === 2) checkedAfterClose = true;
    return h.allowed;
  };
  const result = await runGithubSourceCanary(h.host);
  assert.equal(result.state, "observed");
  assert.equal(checkedAfterClose, true);
  assert.equal(closed.size, 2);
  h.opens.length = 0;
  h.host.assertAuthorized = async () => true;
  await assert.rejects(runGithubSourceCanary(h.host), /source_canary_authorization_required/);
  assert.deepEqual(h.opens, []);
});

test("rejected asynchronous authority is denied without an unhandled private rejection", async (t) => {
  const h = await fixture(t);
  const program = new URL("../src/github-source-canary.mjs", import.meta.url).href;
  const source = `
    import assert from "node:assert/strict";
    import { setImmediate } from "node:timers/promises";
    import { runGithubSourceCanary } from ${JSON.stringify(program)};
    const unhandled = [];
    process.on("unhandledRejection", error => unhandled.push(error?.message));
    let authorizations = 0, opens = 0;
    const host = {
      request: ${JSON.stringify(h.request)},
      async assertAuthorized() { throw Error("SYNTHETIC_PRIVATE_ASYNC_ASSERT"); },
      async authorize() { authorizations++; return true; },
      async open() { opens++; throw Error("must not open"); },
    };
    await assert.rejects(runGithubSourceCanary(host), { message: "source_canary_authorization_required" });
    await setImmediate();
    assert.deepEqual(unhandled, []);
    assert.equal(authorizations, 0);
    assert.equal(opens, 0);
    let foreignEntries = 0;
    for (const decision of [
      { then() { foreignEntries++; } },
      { get then() { foreignEntries++; throw Error("SYNTHETIC_PRIVATE_THENABLE"); } },
    ]) {
      host.assertAuthorized = () => decision;
      await assert.rejects(runGithubSourceCanary(host), { message: "source_canary_authorization_required" });
      await setImmediate();
    }
    assert.equal(foreignEntries, 0);
    assert.deepEqual(unhandled, []);
    assert.equal(authorizations, 0);
    assert.equal(opens, 0);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("the CLI has no default host and exposes no provider path or exception text", async (t) => {
  const h = await fixture(t);
  const path = join(h.directory, "host.mjs"),
    alias = join(h.directory, "alias.mjs"),
    marker = join(h.directory, "entered");
  await writeFile(
    path,
    `import { writeFile } from 'node:fs/promises'; export default { request: ${JSON.stringify(h.request)}, assertAuthorized: () => true, authorize: async () => { await writeFile(${JSON.stringify(marker)}, 'entered'); throw Error('SYNTHETIC_PRIVATE_EXCEPTION'); }, open: async () => {} };`,
  );
  await symlink(path, alias);
  const program = new URL("../src/github-source-canary.mjs", import.meta.url).pathname;
  for (const args of [
    [],
    ["--host", "relative.mjs"],
    ["--host", "https://example.test/host.mjs"],
    ["--host", path],
    ["--host", alias],
  ]) {
    await rm(marker, { force: true });
    const result = spawnSync(process.execPath, [program, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "source_canary_failed");
    if (args[1] === path) assert.equal(await readFile(marker, "utf8"), "entered");
    else await assert.rejects(readFile(marker), { code: "ENOENT" });
  }
});
