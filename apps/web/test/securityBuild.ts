import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const webRoot = fileURLToPath(new URL("..", import.meta.url));
const execute = promisify(execFile);
const buildScript = `
import { build } from "vite";
const [envDir, outDir] = process.argv.slice(1);
await build({ envDir, mode: "production", logLevel: "error",
  build: { outDir, emptyOutDir: true } });
`;

/** Build the actual application without mutating the test runner's environment. */
export async function buildConfiguredApp(directory: string, fileBase: string, processBase?: string) {
  const envDir = join(directory, "build-env");
  const outDir = join(directory, "dist");
  await mkdir(envDir);
  await writeFile(join(envDir, ".env"), "VITE_PUBLIC_API_BASE=https://default.example.invalid/api/v1\n");
  await writeFile(join(envDir, ".env.production"), `VITE_PUBLIC_API_BASE=${fileBase}\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, VITE_UI_MODE: "api" };
  delete env.VITE_PUBLIC_API_BASE;
  if (processBase !== undefined) env.VITE_PUBLIC_API_BASE = processBase;
  await execute(process.execPath, ["--input-type=module", "--eval", buildScript, envDir, outDir], {
    cwd: webRoot,
    env,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  const html = await readFile(join(outDir, "index.html"), "utf8");
  const assets = join(outDir, "assets");
  const javascript = (
    await Promise.all(
      (await readdir(assets))
        .filter((name) => name.endsWith(".js"))
        .map((name) => readFile(join(assets, name), "utf8")),
    )
  ).join("\n");
  return { outDir, html, javascript };
}
