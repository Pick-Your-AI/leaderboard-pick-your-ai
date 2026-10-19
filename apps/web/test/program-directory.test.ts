import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ReadFailure, selection } from "../src/remote/client.ts";
import {
  programDirectory,
  programDirectoryAsset,
  parseProgramDirectory,
  programSelection,
  programHref,
  programRoute,
  readProgramDirectory,
} from "../src/remote/program-directory.ts";

const raw = readFileSync(new URL("../public/program-directory.json", import.meta.url), "utf8");
const original = JSON.parse(raw);
const directory = parseProgramDirectory(raw, "Pick-Your-AI");
const invalid = (error: unknown) =>
  error instanceof ReadFailure && error.status === 502 && error.code === "invalid_program_directory";

test("the fixed asset remains inside the current deployment before any request begins", () => {
  for (const base of ["/", "./", "https://frontend.invalid/"])
    assert.equal(
      programDirectoryAsset(base, "https://frontend.invalid"),
      "https://frontend.invalid/program-directory.json",
    );
  for (const base of ["/leaderboard/", "https://frontend.invalid/leaderboard/"])
    assert.equal(
      programDirectoryAsset(base, "https://frontend.invalid"),
      "https://frontend.invalid/leaderboard/program-directory.json",
    );
  for (const base of [
    "https://other.invalid/",
    "//other.invalid/",
    "http://frontend.invalid/",
    "https://user@frontend.invalid/",
    "/leaderboard/?query=1",
    "/leaderboard/#hash",
    "/leaderboard",
  ])
    assert.throws(() => programDirectoryAsset(base, "https://frontend.invalid"), invalid);
  for (const origin of ["file:///tmp/", "https://frontend.invalid/path", "https://frontend.invalid/", "not a URL"])
    assert.throws(() => programDirectoryAsset("/", origin), invalid);
});

test("deployed display metadata retains the five reviewed Project identities and each Status/custom-field vocabulary", () => {
  const inventory = JSON.parse(
    readFileSync(new URL("../../../planning/organization-inventory-2026-10-18.json", import.meta.url), "utf8"),
  );
  assert.equal(directory.observedOn, inventory.collected_on);
  assert.deepEqual(
    directory.programs.map((p) => p.id),
    ["research", "market", "website", "android", "apple"],
  );
  for (const program of directory.programs) {
    const source = inventory.projects.find((row: { number: number }) => row.number === program.projectNumber);
    assert.equal(program.projectId, source.node_id);
    assert.equal(program.name, source.title);
    assert.deepEqual(
      program.fieldNames,
      source.fields
        .filter((field: { name: string; user_defined: boolean }) => field.user_defined || field.name === "Status")
        .map((field: { name: string }) => field.name),
    );
  }
  assert.deepEqual(directory.programs[0]!.repositoryIds, directory.programs[1]!.repositoryIds);
  assert.equal(directory.repositories.length, 4);
  assert.match(directory.sourceUrl, /\/blob\/699550ee6030f2c53ac174d779319cde264f5f1f\/planning\//);
  assert.equal("issue_pr_observation_window" in directory, false);
});

test("configuration is detached and immutable; empty configured metadata does not invent programs", () => {
  const input = structuredClone(original);
  const result = programDirectory(input, "Pick-Your-AI");
  input.programs[0].name = "changed";
  input.programs[0].repositoryIds.push("3");
  assert.equal(result.programs[0]!.name, directory.programs[0]!.name);
  assert.deepEqual(result.programs[0]!.repositoryIds, directory.programs[0]!.repositoryIds);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.programs[0]!.fieldNames));
  assert.equal(programDirectory({ ...original, repositories: [], programs: [] }, "Pick-Your-AI").programs.length, 0);
});

const changes: [string, (value: any) => void][] = [
  ["unknown field", (x) => (x.approved = true)],
  ["unknown schema", (x) => (x.schemaVersion = "program-directory/v2")],
  ["wrong organization", (x) => (x.organization = "another-org")],
  ["malformed date", (x) => (x.observedOn = "2026-13-99")],
  ["normalized impossible date", (x) => (x.observedOn = "2026-02-30")],
  ["mutable source", (x) => (x.sourceUrl = x.sourceUrl.replace(/[a-f0-9]{40}/, "main"))],
  ["unsafe source origin", (x) => (x.sourceUrl = x.sourceUrl.replace("github.com", "github.com.evil.invalid"))],
  ["duplicate slug", (x) => (x.programs[1].id = x.programs[0].id)],
  ["duplicate native identity", (x) => (x.programs[1].projectId = x.programs[0].projectId)],
  ["duplicate project number", (x) => (x.programs[1].projectNumber = x.programs[0].projectNumber)],
  ["unsafe project number", (x) => (x.programs[0].projectNumber = Number.MAX_SAFE_INTEGER + 1)],
  ["invalid project ID", (x) => (x.programs[0].projectId = "pvt?query")],
  ["overlong project ID", (x) => (x.programs[0].projectId = "x".repeat(129))],
  ["duplicate repository", (x) => (x.repositories[1].id = x.repositories[0].id)],
  ["case alias repository", (x) => (x.repositories[1].name = x.repositories[0].name.toUpperCase())],
  ["unknown repository reference", (x) => (x.programs[0].repositoryIds = ["999"])],
  ["numeric repository ID", (x) => (x.repositories[0].id = 1421934086)],
  ["duplicate repository reference", (x) => x.programs[0].repositoryIds.push(x.programs[0].repositoryIds[0])],
  ["control character", (x) => (x.programs[0].name = "private\nlabel")],
  ["duplicate field name", (x) => x.programs[0].fieldNames.push("Status")],
  ["too many programs", (x) => (x.programs = Array(21).fill(x.programs[0]))],
];
for (const [name, change] of changes)
  test(`configuration rejects ${name} without replacement metadata`, () => {
    const value = structuredClone(original);
    change(value);
    assert.throws(() => programDirectory(value, "Pick-Your-AI"), invalid);
    assert.throws(() => parseProgramDirectory(JSON.stringify(value), "Pick-Your-AI"), invalid);
  });

test("decoded duplicate keys, truncated syntax and oversized UTF-8 configuration are rejected", () => {
  for (const value of [
    raw.replace('"schemaVersion":', '"schemaVersion":"discarded","schemaVersion":'),
    raw.replace('"projectId":', '"projectId":"discarded","\\u0070rojectId":'),
    raw.slice(0, -10),
    " ".repeat(131073),
  ])
    assert.throws(() => parseProgramDirectory(value, "Pick-Your-AI"), invalid);
});

test("program links preserve dates, roles and actors while retiring unrelated scope and proof pins", () => {
  const selected = selection(
    "?organization=Pick-Your-AI&repository=old&workstream=old&context=current&project=old&role=author&start=2026-10-01T00:00:00.000Z&end=2026-10-18T00:00:00.000Z&actors=user&snapshot=old-pin&proof=old-proof&search=reader&category=code&tz=Asia%2FKathmandu&compare=old-comparison",
    { comparison: true },
  );
  const before = structuredClone(selected);
  const result = programSelection(selected, directory, [directory.programs[0]!], "event");
  assert.deepEqual(selected, before);
  assert.equal(result.schemaVersion, "public-scope/v3");
  assert.equal(result.context, "event");
  assert.deepEqual(result.projects, [directory.programs[0]!.projectId]);
  assert.deepEqual(result.roles, selected.roles);
  for (const key of ["start", "end", "actors", "timeZone", "limit", "metric"] as const)
    assert.equal(result[key], selected[key]);
  for (const key of [
    "repository",
    "workstream",
    "snapshot",
    "cursor",
    "proof",
    "search",
    "category",
    "department",
    "catalogQuery",
  ] as const)
    assert.equal(result[key], null);
  assert.equal(result.compare, undefined);
  const params = new URL(
    programHref("/leaderboards", selected, directory, [directory.programs[0]!], "current", null, "research"),
    "https://example.invalid",
  ).searchParams;
  assert.equal(params.get("department"), "research");
  assert.equal(params.get("context"), "current");
  assert.equal(params.get("role"), "author");
  assert.equal(params.get("snapshot"), null);
});

test("union and unboarded links use the shared exact-scope contract, not sums or inferred repository membership", () => {
  const selected = selection("");
  const union = programSelection(
    selected,
    directory,
    [directory.programs[1]!, directory.programs[0]!, directory.programs[0]!],
    "event",
  );
  assert.equal(union.schemaVersion, "public-scope/v2");
  assert.deepEqual(union.projects, [directory.programs[0]!.projectId, directory.programs[1]!.projectId].sort());
  assert.equal(union.repository, null);
  const unboarded = programSelection(selected, directory, [], "event");
  assert.equal(unboarded.schemaVersion, undefined);
  assert.equal(unboarded.projects, undefined);
  const scoped = programSelection(
    selected,
    directory,
    [directory.programs[0]!],
    "current",
    directory.repositories[0]!.id,
  );
  assert.equal(scoped.repository, directory.repositories[0]!.id);
  assert.throws(
    () => programSelection(selected, directory, [directory.programs[0]!], "event", directory.repositories[1]!.id),
    invalid,
  );
  assert.throws(() => programSelection(selected, directory, [{ ...directory.programs[0]! }], "event"), invalid);
});

test("program routes are separate from the retained workstream project alias", () => {
  assert.equal(programRoute("/projects/legacy"), false);
  assert.equal(programRoute("/programs"), null);
  assert.equal(programRoute("/programs/research"), "research");
  for (const route of ["/programs/", "/programs/a/b", "/programs/%2e%2e", "/programs/a?b"])
    assert.throws(() => programRoute(route), /invalid_program_route/);
});

test("asset reading bounds bytes, rejects invalid UTF-8 and releases malformed response streams", async (t) => {
  let cancelled = 0;
  let init: RequestInit | undefined;
  let response = new Response(raw, { headers: { "content-type": "application/json" } });
  t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], value?: RequestInit) => {
    init = value;
    return response;
  });
  assert.equal(
    (
      await readProgramDirectory(
        "https://frontend.invalid/program-directory.json",
        "Pick-Your-AI",
        new AbortController().signal,
      )
    ).programs.length,
    5,
  );
  assert.equal(init?.credentials, "omit");
  assert.equal(init?.cache, "no-store");
  assert.equal(init?.redirect, "error");
  for (const chunk of [new Uint8Array(131073), new Uint8Array([0xff])]) {
    response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled++;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    // Invalid UTF-8 must reach end-of-stream before decoding; over-budget data fails during the first read.
    if (chunk.length === 1) response = new Response(chunk, { headers: { "content-type": "application/json" } });
    await assert.rejects(
      readProgramDirectory(
        "https://frontend.invalid/program-directory.json",
        "Pick-Your-AI",
        new AbortController().signal,
      ),
    );
  }
  assert.equal(cancelled, 1);
  response = new Response(raw, { headers: { "content-type": "text/html" } });
  await assert.rejects(
    readProgramDirectory(
      "https://frontend.invalid/program-directory.json",
      "Pick-Your-AI",
      new AbortController().signal,
    ),
    invalid,
  );
});
