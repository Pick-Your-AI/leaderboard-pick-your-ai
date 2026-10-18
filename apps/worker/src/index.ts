import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { lstat } from "node:fs/promises";
import { runWorker, type WorkerHost, type WorkerOptions } from "./runner.js";

/** Explicit trusted local code, never a URL or a browser-supplied source. */
export function parseWorkerArguments(args: string[]): { hostPath: string; options: WorkerOptions } {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key ||
      !["--host", "--max-pages", "--interval-ms"].includes(key) ||
      values.has(key) ||
      !value ||
      value.startsWith("--")
    )
      throw new Error("invalid_worker_arguments");
    values.set(key, value);
  }
  const hostPath = values.get("--host");
  if (!hostPath || !isAbsolute(hostPath) || !hostPath.endsWith(".mjs")) throw new Error("worker_host_required");
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = values.get(key);
    if (value !== undefined && !/^[1-9]\d*$/.test(value)) throw new Error("invalid_worker_arguments");
    const result = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error("invalid_worker_arguments");
    return result;
  };
  return {
    hostPath,
    options: {
      maxPages: number("--max-pages", 100, 1, 10000),
      ...(values.has("--interval-ms") ? { intervalMs: number("--interval-ms", 1000, 1000, 3600000) } : {}),
    },
  };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { hostPath, options } = parseWorkerArguments(args);
  const metadata = await lstat(hostPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("invalid_worker_host");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    // This module is reviewed executable host configuration, not an authorization receipt.
    const host: WorkerHost = (await import(pathToFileURL(hostPath).href)).default;
    const outcome = await runWorker(host, { ...options, signal: controller.signal });
    console.info(`worker_${outcome}`);
    if (outcome === "collecting") process.exitCode = 2;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    // Provider exceptions may contain tokens, private data or connection strings.
    console.error("worker_failed");
    process.exitCode = 1;
  });
}
