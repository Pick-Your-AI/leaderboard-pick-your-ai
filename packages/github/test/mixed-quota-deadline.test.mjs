import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { classifyGithubFailure, FileCheckpointStore, GithubReadClient } from "../dist/index.js";

const START = Date.parse("2026-01-01T00:00:00.000Z");
const ORIGIN = "https://api.synthetic.invalid";
const SOURCE = "installation:limited";
const OTHER = "installation:other";
const REPOSITORY_ID = 17;
const QUERY =
  "query Items($first:Int!, $after:String) { repository { items(first:$first, after:$after) { nodes pageInfo { hasNextPage endCursor } } } }";
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Synthetic quota control did not settle: ${label}`)), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function savedPause(directory) {
  const records = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isFile() && item.name.endsWith(".json"))
      records.push(JSON.parse(await readFile(join(directory, item.name), "utf8")));
  }
  const pauses = records.filter((value) => Object.keys(value).sort().join(",") === "until,version");
  assert.equal(pauses.length, 1, "the exhausted operation retained one durable pool pause");
  assert.equal(pauses[0].version, 1);
  return pauses[0].until;
}

for (const transport of ["REST", "GraphQL"]) {
  for (const status of [403, 429]) {
    for (const [ordering, retrySeconds, resetSeconds] of [
      ["later primary reset", 12, 120],
      ["later Retry-After", 180, 120],
    ]) {
      test(
        `${transport} HTTP ${status} resumes a persisted scan after the ${ordering}`,
        { timeout: 10000 },
        async (t) => {
          const directory = await mkdtemp(join(tmpdir(), "github-mixed-deadline-"));
          t.after(async () => {
            assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
            assert.match(basename(directory), /^github-mixed-deadline-/);
            await rm(directory, { recursive: true, force: true });
          });
          let now = START;
          const calls = [];
          const headers = {
            "retry-after": String(retrySeconds),
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String((START + resetSeconds * 1000) / 1000),
          };
          const page = (url, request) =>
            transport === "REST"
              ? new URL(url).searchParams.get("page")
              : JSON.parse(request.body).variables.after === null
                ? "1"
                : "2";
          const reply = (number) =>
            transport === "REST"
              ? json(
                  [number === "1" ? "first" : "second"],
                  200,
                  number === "1" ? { link: `<${ORIGIN}/items?page=2>; rel="next"` } : {},
                )
              : json({
                  data: {
                    repository: {
                      items: {
                        nodes: [number === "1" ? "first" : "second"],
                        pageInfo: { hasNextPage: number === "1", endCursor: number === "1" ? "second" : null },
                      },
                    },
                  },
                });
          const scan = (client) =>
            transport === "REST"
              ? client.scanRest({
                  source: SOURCE,
                  key: "mixed-deadline/v1",
                  url: "/items?page=1",
                  maxPages: 3,
                  select: (body) => body,
                })
              : client.scanGraphql({
                  source: SOURCE,
                  key: "mixed-deadline/v1",
                  query: QUERY,
                  maxPages: 3,
                  select: (body) => body.repository.items,
                });
          const options = {
            apiOrigin: ORIGIN,
            token: async () => "synthetic-token",
            concurrency: 1,
            maxRetries: 0,
            now: () => now,
            random: () => 0,
          };
          const first = new GithubReadClient({
            ...options,
            checkpoints: new FileCheckpointStore(directory),
            sleep: async () => assert.fail("a zero-retry operation must retain its pause without sleeping"),
            fetch: async (url, request) => {
              const number = page(url, request);
              calls.push({ phase: "original", page: number, at: now });
              return number === "1" ? reply(number) : json({ message: "API rate limit exceeded" }, status, headers);
            },
          }).forRepository(REPOSITORY_ID);
          let failure;
          await assert.rejects(scan(first), (error) => {
            failure = error;
            return error.outcome.kind === "rate_limited";
          });
          // Capture the original values now, but test the deadline only after a
          // fresh store/client actually resumes the previously interrupted scan.
          const retainedUntil = await savedPause(directory);
          const asleep = deferred();
          let resume;
          let released = false;
          const waits = [];
          const restarted = new GithubReadClient({
            ...options,
            checkpoints: new FileCheckpointStore(directory),
            sleep: async (milliseconds) => {
              waits.push(milliseconds);
              if (!released) {
                await new Promise((done) => {
                  resume = done;
                  asleep.resolve();
                });
              }
              now += milliseconds;
            },
            fetch: async (url, request) => {
              if (new URL(url).pathname === "/other") {
                calls.push({ phase: "other", at: now });
                return json({ ok: true });
              }
              const number = page(url, request);
              calls.push({ phase: "resumed", page: number, at: now });
              return reply(number);
            },
          }).forRepository(REPOSITORY_ID);
          const pending = scan(restarted);
          void pending.catch(() => undefined);
          let other;
          try {
            await bounded(asleep.promise, "persisted pause started");
            other = restarted.rest(OTHER, "/other");
            assert.deepEqual(await bounded(other, "unrelated source progresses with the only slot"), { ok: true });
            assert.deepEqual(
              calls.filter((call) => call.phase === "other"),
              [{ phase: "other", at: START }],
            );
            assert.equal(calls.filter((call) => call.phase === "resumed").length, 0);
          } finally {
            // Always release the test's own latch before any assertion can leave
            // the limited scan pending, including a failed before-fix control.
            released = true;
            resume?.();
            await bounded(Promise.allSettled([pending, ...(other ? [other] : [])]), "latch cleanup");
          }
          assert.deepEqual(await pending, ["first", "second"]);
          assert.deepEqual(
            calls.filter((call) => call.phase === "original").map((call) => call.page),
            ["1", "2"],
          );
          const expectedAt = START + Math.max(retrySeconds, resetSeconds) * 1000;
          assert.deepEqual(
            calls.filter((call) => call.phase === "resumed"),
            [{ phase: "resumed", page: "2", at: expectedAt }],
          );
          assert.equal(retainedUntil, expectedAt);
          assert.equal(await savedPause(directory), expectedAt);
          assert.equal(failure.outcome.retryAt, new Date(expectedAt).toISOString());
          assert.equal(failure.outcome.visibility, "unknown");
          assert.equal(failure.outcome.scope, "source");
          assert.equal(failure.source, SOURCE);
          assert.equal(
            waits.reduce((sum, value) => sum + value, 0),
            expectedAt - START,
          );
          assert.ok(waits.every((value) => value > 0 && value <= 60000));
          assert.deepEqual(await scan(restarted), ["first", "second"]);
          assert.equal(
            calls.filter((call) => call.phase === "resumed").length,
            1,
            "completed checkpoint needs no new HTTP page",
          );
        },
      );
    }
  }
}

test("mixed quota classification preserves header, status and date boundaries", () => {
  const laterReset = String((START + 120000) / 1000);
  for (const status of [403, 429]) {
    for (const [retryAfter, remaining, reset, delay] of [
      ["Thu, 01 Jan 2026 00:00:12 GMT", "0", laterReset, 120000],
      ["Thu, 01 Jan 2026 00:03:00 GMT", "0", laterReset, 180000],
      ["120", "0", laterReset, 120000],
      ["12", "42", laterReset, 12000],
      ["12", null, laterReset, 12000],
      ["12", "0", "invalid", 12000],
      ["-1", "0", laterReset, 120000],
    ]) {
      const headers = new Headers({ "retry-after": retryAfter, "x-ratelimit-reset": reset });
      if (remaining !== null) headers.set("x-ratelimit-remaining", remaining);
      assert.deepEqual(
        classifyGithubFailure({ status, headers, now: new Date(START) }),
        {
          kind: "rate_limited",
          visibility: "unknown",
          scope: "source",
          retryAt: new Date(START + delay).toISOString(),
        },
        `${status}: ${retryAfter}, remaining=${remaining}, reset=${reset}`,
      );
    }
  }
  for (const [status, kind] of [
    [401, "authentication_required"],
    [404, "not_found_or_hidden"],
  ]) {
    assert.deepEqual(
      classifyGithubFailure({
        status,
        headers: new Headers({ "retry-after": "12", "x-ratelimit-remaining": "0", "x-ratelimit-reset": laterReset }),
        now: new Date(START),
      }),
      {
        kind,
        visibility: "unknown",
        status,
      },
    );
  }
});
