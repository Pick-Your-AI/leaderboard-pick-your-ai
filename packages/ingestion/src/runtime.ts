import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createWebhookHandler, type WebhookOptions } from "./webhook.js";
import type { FailureCode, Lease } from "./store.js";

class BodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function json(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage, max: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", data);
      request.off("end", end);
      request.off("aborted", aborted);
      request.off("error", aborted);
    };
    const abort = (error: BodyError) => {
      cleanup();
      request.pause();
      reject(error);
    };
    const data = (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > max) return abort(new BodyError(413, "body_too_large"));
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const aborted = () => abort(new BodyError(400, "incomplete_body"));
    const timer = setTimeout(() => abort(new BodyError(408, "body_timeout")), timeoutMs);
    request.on("data", data);
    request.once("end", end);
    request.once("aborted", aborted);
    request.once("error", aborted);
  });
}

export interface ServerOptions extends WebhookOptions {
  bodyTimeoutMs?: number;
  maxConcurrentRequests?: number;
}

/** Creates an unbound HTTP server. The caller selects the approved bind address. */
export function createIngestionServer(options: ServerOptions): Server {
  const handle = createWebhookHandler(options);
  const maxBytes = options.maxBodyBytes ?? 1_048_576;
  const timeoutMs = options.bodyTimeoutMs ?? 10_000;
  const maxConcurrent = options.maxConcurrentRequests ?? 32;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new RangeError("Invalid bodyTimeoutMs");
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 1024)
    throw new RangeError("Invalid maxConcurrentRequests");
  let active = 0;
  const server = createServer(
    { maxHeaderSize: 16_384, headersTimeout: timeoutMs, requestTimeout: timeoutMs + 1000 },
    (request, response) => {
      request.on("error", () => {
        /* body reader reports incomplete requests without leaking socket errors */
      });
      // Strict origin-form routing: query strings and alternate spellings are rejected.
      if (request.url === "/healthz" && request.method === "GET") return json(response, 200, { status: "alive" });
      if (request.url !== "/webhooks/github") return json(response, 404, { error: "not_found" });
      if (request.method !== "POST") return json(response, 405, { error: "method_not_allowed" });
      if (active >= maxConcurrent) return json(response, 503, { error: "ingress_busy" });
      const length = request.headers["content-length"];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes))
        return json(response, 413, { error: "body_too_large" });
      // Reject ambiguous authentication/routing metadata rather than letting Headers join it.
      for (const name of [
        "x-github-delivery",
        "x-github-event",
        "x-hub-signature-256",
        "content-type",
        "content-encoding",
      ]) {
        if ((request.headersDistinct[name]?.length ?? 0) > 1) return json(response, 400, { error: "duplicate_header" });
      }
      active++;
      void (async () => {
        try {
          const body = await readBody(request, maxBytes, timeoutMs);
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers)) {
            if (typeof value === "string") headers.set(name, value);
          }
          const result = await handle(
            new Request("http://localhost/webhooks/github", { method: "POST", headers, body: new Uint8Array(body) }),
          );
          json(response, result.status, (await result.json()) as Record<string, unknown>);
        } catch (error) {
          if (!response.destroyed && !response.writableEnded) {
            json(response, error instanceof BodyError ? error.status : 503, {
              error: error instanceof BodyError ? error.code : "intake_unavailable",
            });
          }
        } finally {
          active--;
        }
      })();
    },
  );
  server.maxRequestsPerSocket = 100;
  return server;
}

export interface WorkerStore {
  claim(leaseSeconds?: number): Promise<Lease | null>;
  complete(lease: Lease): Promise<boolean>;
  fail(lease: Lease, reason: FailureCode, permanent?: boolean): Promise<boolean>;
}

export type WorkerStatus = "idle" | "processed" | "lease_lost" | "retry_scheduled" | "store_unavailable";
export interface WorkerOptions {
  signal: AbortSignal;
  idleMs?: number;
  failureBackoffMs?: number;
  leaseSeconds?: number;
  /** Fixed state only: never logs source payloads, credentials or raw exceptions. */
  onStatus?: (status: WorkerStatus) => void;
}

/** Finish an in-flight transaction on shutdown; never reuse an expired lease. */
export async function runWorker(store: WorkerStore, options: WorkerOptions): Promise<void> {
  const idleMs = options.idleMs ?? 1000;
  const backoffMs = options.failureBackoffMs ?? 5000;
  const leaseSeconds = options.leaseSeconds ?? 60;
  for (const value of [idleMs, backoffMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw new RangeError("Invalid worker delay");
  }
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600)
    throw new RangeError("Invalid leaseSeconds");
  const report = (status: WorkerStatus) => {
    // Observability callbacks must not change processing outcomes.
    try {
      options.onStatus?.(status);
    } catch {
      /* host owns callback diagnostics */
    }
  };
  const wait = async (ms: number) => {
    try {
      await delay(ms, undefined, { signal: options.signal });
    } catch (error) {
      if (!options.signal.aborted) throw error;
    }
  };
  while (!options.signal.aborted) {
    let lease: Lease | null = null;
    try {
      lease = await store.claim(leaseSeconds);
      if (!lease) {
        report("idle");
        await wait(idleMs);
        continue;
      }
      report((await store.complete(lease)) ? "processed" : "lease_lost");
    } catch {
      let recorded = false;
      if (lease) {
        try {
          recorded = await store.fail(lease, "normalization_failed");
        } catch {
          /* expiry recovers it */
        }
      }
      report(recorded ? "retry_scheduled" : "store_unavailable");
      await wait(backoffMs);
    }
  }
}
