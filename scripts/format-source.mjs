import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const mode = process.argv[2] ?? "--check";
if (process.argv.length > 3 || !["--check", "--write"].includes(mode)) {
  console.error("Usage: node scripts/format-source.mjs [--check|--write]");
  process.exit(2);
}
const extensions = new Set([".ts", ".tsx", ".mjs", ".css"]);
const roots = new Set(["apps", "packages", "tests", "infra", "scripts"]);
const excluded = new Set([
  ".git",
  ".github",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "generated",
  "planning",
  "docs",
  "playwright-report",
  "test-results",
  ".vite",
]);
function eligible(path) {
  const parts = path.replaceAll("\\", "/").split("/");
  return roots.has(parts[0]) && extensions.has(extname(path)) && !parts.some((part) => excluded.has(part));
}

try {
  // NUL separators preserve spaces/newlines; filenames are never shell code or
  // command options. No untracked file, glob expansion or whole-tree scan.
  const tracked = execFileSync("git", ["ls-files", "--cached", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const files = [...new Set(tracked.split("\0").filter(eligible))].sort();
  const config = JSON.parse(await readFile(resolve(root, ".prettierrc.json"), "utf8"));
  let changed = 0;
  for (const path of files) {
    const absolute = resolve(root, path);
    const metadata = await lstat(absolute);
    const destination = await realpath(absolute);
    const resolvedPath = relative(root, destination);
    const comparable = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      comparable(destination) !== comparable(absolute) ||
      isAbsolute(resolvedPath) ||
      resolvedPath === ".." ||
      resolvedPath.startsWith(`..${sep}`) ||
      !eligible(resolvedPath)
    ) {
      throw new Error(`Refusing linked or out-of-scope source path: ${path}`);
    }
    const source = await readFile(absolute, "utf8");
    const options = { ...config, filepath: absolute };
    if (mode === "--write") {
      const formatted = await prettier.format(source, options);
      if (source !== formatted) {
        await writeFile(absolute, formatted, "utf8");
        changed++;
      }
    } else if (!(await prettier.check(source, options))) {
      console.error(`Formatting required: ${path}`);
      changed++;
    }
  }
  console.log(
    `${mode === "--write" ? "Formatted" : "Checked"} ${files.length} tracked source files; ${changed} ${mode === "--write" ? "changed" : "need formatting"}.`,
  );
  if (mode === "--check" && changed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Source formatting failed");
  process.exitCode = 2;
}
