import { setTimeout as delay } from "node:timers/promises";

export interface WorkerResources {
  runtime: {
    runOnce(options: { maxPages: number }): Promise<{ state: string }>;
    stop(): Promise<unknown>;
  };
  /** Close externally owned pools/stores only after runtime.stop has drained work. */
  close(): Promise<unknown>;
}
export interface WorkerHost {
  /** Protected host policy; checked before opening resources and before every batch. */
  authorize(): Promise<boolean>;
  /** Must clean up its own partial acquisition if this rejects. No listeners are started here. */
  open(): Promise<WorkerResources>;
}
export interface WorkerOptions {
  maxPages: number;
  intervalMs?: number;
  signal?: AbortSignal;
}
export type WorkerResult = "completed" | "collecting" | "stopped";

/** Sequential bounded batches. An omitted interval means exactly one attempt. */
export async function runWorker(host: WorkerHost, options: WorkerOptions): Promise<WorkerResult> {
  if (
    !host ||
    typeof host.authorize !== "function" ||
    typeof host.open !== "function" ||
    !Number.isInteger(options.maxPages) ||
    options.maxPages < 1 ||
    options.maxPages > 10000 ||
    (options.intervalMs !== undefined &&
      (!Number.isInteger(options.intervalMs) || options.intervalMs < 1000 || options.intervalMs > 3600000))
  )
    throw new Error("invalid_worker_configuration");
  if (options.signal?.aborted) return "stopped";
  if ((await host.authorize()) !== true) throw new Error("worker_authorization_required");
  if (options.signal?.aborted) return "stopped";
  const resources = await host.open();
  try {
    if (
      !resources?.runtime ||
      typeof resources.runtime.runOnce !== "function" ||
      typeof resources.runtime.stop !== "function" ||
      typeof resources.close !== "function"
    )
      throw new Error("invalid_worker_resources");
    while (!options.signal?.aborted) {
      if ((await host.authorize()) !== true) throw new Error("worker_authorization_required");
      if (options.signal?.aborted) break;
      const result = await resources.runtime.runOnce({ maxPages: options.maxPages });
      if (!result || !["published", "collecting"].includes(result.state)) throw new Error("worker_batch_not_completed");
      if (options.signal?.aborted) break;
      if (options.intervalMs === undefined) return result.state === "published" ? "completed" : "collecting";
      try {
        await delay(options.intervalMs, undefined, options.signal ? { signal: options.signal } : undefined);
      } catch (error) {
        if (!options.signal?.aborted) throw error;
      }
    }
    return "stopped";
  } finally {
    // Do not close a database beneath a runtime that failed to drain.
    if (typeof resources?.runtime?.stop === "function") await resources.runtime.stop();
    if (typeof resources?.close === "function") await resources.close();
  }
}
