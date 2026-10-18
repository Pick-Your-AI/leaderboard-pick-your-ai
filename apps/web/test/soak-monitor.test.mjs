import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createService } from "../../service/dist/app.js";
import { at, snapshot } from "../browser/wallFixture.ts";
import { assertPageActors, createAttempt, CycleCoverage, fixturePages, responseKey } from "../soak/monitor.ts";

const stages = [
  { heading: "PRs merged", actors: Array.from({ length: 12 }, (_, i) => `wall-${String(i + 1).padStart(2, "0")}`) },
  {
    heading: "Contributors in this scope",
    actors: Array.from({ length: 15 }, (_, i) => `wall-${String(i + 1).padStart(2, "0")}`),
  },
];
const pages = fixturePages(stages);
const keys = [...pages.keys()];

test("soak counter recognizes the actual service's expired cursor error shape", async (t) => {
  let now = Date.parse(at);
  const data = snapshot();
  const app = createService({
    now: () => now,
    cursorSecret: "synthetic-wall-soak-counter-test-secret-0001",
    source: {
      async read(scope) {
        const value = structuredClone(data);
        value.selected.scope = { ...scope };
        return value;
      },
    },
  });
  t.after(() => app.close());
  const url = "/api/v1/boards?organization=Pick-Your-AI&metric=pr_merged&limit=6";
  const first = await app.inject(url);
  assert.equal(first.statusCode, 200);
  assert.equal(responseKey(first), "200");
  assert(first.json().nextCursor);
  // This focused recorder regression uses a test clock. The separate soak does not.
  now += 16 * 60_000;
  const expired = await app.inject(`${url}&cursor=${encodeURIComponent(first.json().nextCursor)}`);
  assert.equal(expired.statusCode, 410);
  assert.deepEqual(expired.json(), { error: "cursor_expired_refetch" });
  assert.equal(responseKey(expired), "410:cursor_expired_refetch");
});

test("soak response counters bound malformed or unexpected errors without retaining payloads", () => {
  for (const body of [
    "not json",
    "null",
    "[]",
    '{"error":{"code":"cursor_expired_refetch"}}',
    '{"error":"PRIVATE DETAIL"}',
  ])
    assert.equal(responseKey({ statusCode: 503, body }), "503:unknown");
  assert.equal(responseKey({ statusCode: 200, body: "not parsed" }), "200");
});

test("repeated attempts preserve earlier logs and cannot inherit an earlier success summary", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "pyai-soak-output-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const first = await createAttempt(parent);
  await writeFile(join(first.directory, "summary.json"), '{"result":"old-rehearsal"}\n');
  await writeFile(join(first.directory, "events.jsonl"), "original event\n");
  const second = await createAttempt(parent);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(await readdir(second.directory), []);
  await writeFile(join(second.directory, "events.jsonl"), "new event\n");
  assert.equal(await readFile(join(first.directory, "events.jsonl"), "utf8"), "original event\n");
  await assert.rejects(readFile(join(second.directory, "summary.json")), { code: "ENOENT" });
});

test("normal Playwright output cleanup preserves the separate attempt receipts across invocations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pyai-soak-runner-output-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "test-results", "wall-soak");
  const receipts = join(root, "test-results", "wall-soak-attempts");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "old-runner-output.txt"), "must be removed by normal Playwright startup\n");
  const imports = {
    playwright: new URL("../../../node_modules/@playwright/test/index.mjs", import.meta.url).href,
    monitor: new URL("../soak/monitor.ts", import.meta.url).href,
  };
  await writeFile(
    join(root, "probe.spec.mjs"),
    `import { test } from ${JSON.stringify(imports.playwright)};\n` +
      `import { createAttempt } from ${JSON.stringify(imports.monitor)};\n` +
      'import { writeFile } from "node:fs/promises";\n' +
      'import { join } from "node:path";\n' +
      `test("record invocation", async () => { const attempt = await createAttempt(${JSON.stringify(root)}); ` +
      'await writeFile(join(attempt.directory, "summary.json"), JSON.stringify({attemptId: attempt.id, result: "probe-only"})); });\n',
  );
  const config = join(root, "playwright.config.mjs");
  await writeFile(
    config,
    `export default ${JSON.stringify({
      testDir: root,
      testMatch: "probe.spec.mjs",
      workers: 1,
      retries: 0,
      reporter: "list",
      projects: [
        { name: "soak", outputDir: output },
        { name: "browser", outputDir: join(root, "test-results", "browser") },
      ],
    })};\n`,
  );
  const run = () =>
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("../../../node_modules/playwright/cli.js", import.meta.url)), "test", "--config", config],
      { cwd: root, timeout: 20_000, encoding: "utf8", stdio: "pipe" },
    );
  run();
  await assert.rejects(readFile(join(output, "old-runner-output.txt")), { code: "ENOENT" });
  const original = new Map();
  for (const id of await readdir(receipts))
    original.set(id, await readFile(join(receipts, id, "summary.json"), "utf8"));
  assert.equal(original.size, 2);
  run();
  assert.equal((await readdir(receipts)).length, 4);
  for (const [id, body] of original) assert.equal(await readFile(join(receipts, id, "summary.json"), "utf8"), body);
});

test("complete fixture membership rejects actors repeated across otherwise unique pages", () => {
  for (const [identity, ids] of pages) assertPageActors(pages, identity, [...ids]);
  const second = [...pages.get("PRs merged:Page 2")];
  second[0] = pages.get("PRs merged:Page 1")[0];
  assert.equal(new Set(second).size, second.length, "The faulty page has no within-page duplicate");
  assert.throws(() => assertPageActors(pages, "PRs merged:Page 2", second), /complete fixture page/);
  assert.throws(() => assertPageActors(pages, "PRs merged:Page 2", second.slice(1)), /complete fixture page/);
});

test("fixture membership permits the same actor in separate board and roll stages and applies suppression", () => {
  const suppressed = fixturePages(stages, "wall-02");
  for (const [identity, ids] of suppressed) {
    assert(!ids.includes("wall-02"));
    assertPageActors(suppressed, identity, [...ids]);
  }
  assert.equal(suppressed.size, 5);
  assert(suppressed.get("PRs merged:Page 1").includes("wall-01"));
  assert(suppressed.get("Contributors in this scope:Page 1").includes("wall-01"));
});

test("continued full-cycle observations stay bounded and tolerate same-page privacy refreshes", () => {
  const coverage = new CycleCoverage(keys);
  for (let time = 0; time < 8 * 60 * 60_000; time += 5_000)
    coverage.observe(time, true, keys[Math.floor(time / 20_000) % keys.length]);
  assert(coverage.summary().completeWindows > 250);
  assert.equal(Object.keys(coverage.summary().lastSeenMilliseconds).length, 5);
});

test("one initial complete cycle cannot conceal later alternation between only two pages", () => {
  const coverage = new CycleCoverage(keys);
  keys.forEach((key, i) => coverage.observe(i * 20_000, true, key));
  assert.equal(coverage.summary().completeWindows, 1);
  assert.throws(() => {
    for (let time = 100_000; time <= 300_000; time += 20_000) coverage.observe(time, true, keys[(time / 20_000) % 2]);
  }, /must keep visiting/);
});

test("a resumed automatic period has a fresh bounded deadline after an actual hold", () => {
  const coverage = new CycleCoverage(keys);
  coverage.observe(0, true, keys[0]);
  coverage.observe(60_000, false, "Paused");
  keys.forEach((key, i) => coverage.observe(1_200_000 + i * 20_000, true, key));
  assert.equal(coverage.summary().automaticPeriods, 2);
  assert.equal(coverage.summary().completeWindows, 1);
  assert.throws(() => coverage.observe(1_500_001, true, keys[1]), /must keep visiting/);
});

test("repeated transient empty displays cannot reset the automatic coverage deadline", () => {
  const coverage = new CycleCoverage(keys);
  coverage.observe(0, true, keys[0]);
  for (let time = 20_000; time <= 180_000; time += 20_000)
    coverage.observe(time, true, time % 40_000 === 0 ? keys[0] : null);
  assert.throws(() => coverage.observe(180_001, true, null), /must keep visiting/);
  assert.equal(coverage.summary().automaticPeriods, 1);
});
