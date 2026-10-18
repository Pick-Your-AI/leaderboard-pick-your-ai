import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { auditFrozenSoak } from "../apps/web/soak/chronology.ts";

const args = process.argv.slice(2);
const values = new Map();
let prefix = false;
try {
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--prefix" && !prefix) {
      prefix = true;
      continue;
    }
    if (
      !["--input", "--output"].includes(key) ||
      values.has(key) ||
      !args[index + 1] ||
      args[index + 1].startsWith("--")
    )
      throw new Error(
        "Usage: node scripts/audit-wall-soak.mjs --input ATTEMPT_DIRECTORY --output NEW_EXTERNAL_FILE [--prefix]",
      );
    values.set(key, args[++index]);
  }
  if (!values.has("--input") || !values.has("--output"))
    throw new Error("Both --input and --output are required; --prefix can never establish completion");
  const input = await realpath(resolve(values.get("--input")));
  if (!(await lstat(input)).isDirectory()) throw new Error("The input must be an existing attempt directory");
  const output = resolve(await realpath(dirname(resolve(values.get("--output")))), basename(values.get("--output")));
  const inside = (path, root) => {
    const name = relative(root, path);
    return name === "" || (!isAbsolute(name) && name !== ".." && !name.startsWith(`..${sep}`));
  };
  if (inside(output, input)) throw new Error("Audit output must be outside the original evidence directory");
  const files = {},
    identities = [];
  // Samples precede events so a newly completed action may appear only as an
  // explicitly unobserved prefix tail; it cannot be backdated into a sample.
  const names = [
    "attempt.json",
    "build-inputs.json",
    "timezone-start.json",
    "midnight-window.json",
    "samples.jsonl",
    "events.jsonl",
    "summary.json",
    "service-cleanup.json",
    "browser-cleanup.json",
    "run-status.json",
  ];
  for (const name of names) {
    const required = names.indexOf(name) < 6 || !prefix;
    let handle;
    try {
      handle = await open(resolve(input, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (!required && error.code === "ENOENT") continue;
      throw error;
    }
    let bytes;
    try {
      const metadata = await handle.stat();
      const limit = name === "samples.jsonl" ? 16 * 1024 * 1024 : 1024 * 1024;
      if (!metadata.isFile() || metadata.size <= 0 || metadata.size > limit)
        throw new Error(`${name} must be a nonempty bounded regular file`);
      bytes = await handle.readFile();
      if (bytes.length !== metadata.size)
        throw new Error(`${name} changed while it was read; retain a stable snapshot and retry the audit`);
    } finally {
      await handle.close();
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (name.endsWith(".jsonl")) {
      if (!source.endsWith("\n")) throw new Error(`${name} ends in an incomplete JSONL record`);
      const lines = source.slice(0, -1).split("\n");
      if (lines.some((line) => line.trim() === "")) throw new Error(`${name} contains a missing JSONL record`);
      files[name] = lines.map((line) => JSON.parse(line));
    } else files[name] = JSON.parse(source);
    identities.push({ path: name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const original = files["attempt.json"]?.directory;
  if (typeof original === "string" && isAbsolute(original)) {
    const marker = `${sep}test-results${sep}wall-soak-attempts${sep}`;
    const boundary = original.indexOf(marker);
    const originalRoot = boundary < 0 ? original : original.slice(0, boundary);
    if (inside(output, resolve(originalRoot)))
      throw new Error("Audit output must be outside the frozen source/attempt tree");
  }
  const audit = auditFrozenSoak(files, { prefix });
  const receipt = {
    ...audit,
    auditVersion: "wall-soak-chronology/v1",
    inputFiles: identities,
    inputFilesSha256: createHash("sha256").update(JSON.stringify(identities)).digest("hex"),
  };
  // A new exclusive external artifact: never replace a previous audit or input.
  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  console.log(
    JSON.stringify({
      result: receipt.result,
      acceptedCompleteChronology: receipt.acceptedCompleteChronology,
      samples: receipt.sampleCount,
      output,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "The chronology audit failed");
  process.exitCode = 1;
}
