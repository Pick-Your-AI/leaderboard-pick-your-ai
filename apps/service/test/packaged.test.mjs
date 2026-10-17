import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../../", import.meta.url));

test("built service starts from dist-only workspace packages with no metrics source tree", async t => {
  const temporary = await mkdtemp(join(resolve(tmpdir()), "leaderboard-api-package-"));
  t.after(async () => {
    assert.equal(dirname(temporary), resolve(tmpdir()));
    assert.ok(temporary.includes("leaderboard-api-package-"));
    await rm(temporary, { recursive: true, force: true });
  });
  const service = join(temporary, "apps", "service");
  await mkdir(service, { recursive: true });
  await cp(join(repository, "apps", "service", "dist"), join(service, "dist"), { recursive: true });
  await cp(join(repository, "apps", "service", "package.json"), join(service, "package.json"));
  for (const name of ["metrics", "contracts"]) {
    const destination = join(temporary, "node_modules", "@pick-your-ai", name);
    await mkdir(destination, { recursive: true });
    await cp(join(repository, "packages", name, "dist"), join(destination, "dist"), { recursive: true });
    await cp(join(repository, "packages", name, "package.json"), join(destination, "package.json"));
    await assert.rejects(access(join(destination, "src")), { code: "ENOENT" });
  }
  // Third-party runtime packages retain their installed dependency resolution.
  for (const name of ["fastify", "zod"]) {
    await symlink(dirname(require.resolve(`${name}/package.json`)), join(temporary, "node_modules", name), "junction");
  }
  const moduleUrl = pathToFileURL(join(service, "dist", "app.js")).href;
  const script = `const { createService } = await import(${JSON.stringify(moduleUrl)});
    const app = createService();
    const response = await app.inject('/api/v1/metrics');
    console.log(JSON.stringify({ status: response.statusCode, metrics: response.json().metrics.length }));
    await app.close();`;
  const result = await execute(process.execPath, ["--input-type=module", "--eval", script], { cwd: temporary, timeout: 15000 });
  assert.deepEqual(JSON.parse(result.stdout), { status: 200, metrics: 98 });
});
