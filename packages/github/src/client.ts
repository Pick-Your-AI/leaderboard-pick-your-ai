import { createHash } from "node:crypto";
import { classifyGithubFailure, nextRestLink, type EndpointOutcome, type GraphqlPage } from "./index.js";
import type { CheckpointStore } from "./checkpoints.js";

export class GithubClientError extends Error {
  constructor(
    public readonly outcome: EndpointOutcome | { kind: "invalid_response" | "unsafe_request" | "invalid_checkpoint" },
    public readonly source: string,
  ) {
    super(`GitHub source request failed: ${outcome.kind}`);
    this.name = "GithubClientError";
  }
}

export interface GithubClientOptions {
  /** Installation/account authorization boundary; use the same ID for one quota pool. */
  token: (source: string) => Promise<string | undefined>;
  checkpoints: CheckpointStore;
  /** Explicitly configured API authority, including approved Enterprise hosts. */
  apiOrigin?: string;
  graphqlPath?: string;
  apiVersion?: string;
  concurrency?: number;
  maxRetries?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

interface CachedResponse {
  version: 1;
  etag: string;
  body: unknown;
  link: string | null;
}
interface ScanCheckpoint {
  version: 1;
  fingerprint: string;
  next: string | null;
  visited: string[];
  items: unknown[];
  complete: boolean;
}

export interface RestScan<T> {
  source: string;
  /** Stable operation identity; change it when selection semantics change. */
  key: string;
  url: string;
  maxPages: number;
  select: (body: unknown) => readonly T[];
  /** A deliberate refresh replaces a finished scan; interrupted scans resume by default. */
  refresh?: boolean;
  /** Optional synchronous host authorization check, repeated before HTTP, page acceptance and result delivery. */
  assertAuthorized?: () => void;
}

export interface GraphqlScan<T> {
  source: string;
  key: string;
  query: string;
  variables?: Record<string, unknown>;
  first?: number;
  maxPages: number;
  /** Select one connection, including connections nested under repository/node. */
  select: (data: unknown) => GraphqlPage<T>;
  refresh?: boolean;
  /** Optional synchronous host authorization check, repeated before HTTP, page acceptance and result delivery. */
  assertAuthorized?: () => void;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Omit structured identity emails; free-text source content is not sanitized here. */
function minimizeIdentityEmails(value: unknown, identity = false): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => minimizeIdentityEmails(item, identity));
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (!object(value)) return value;
  let changed = false;
  const entries = Object.entries(value).flatMap(([key, item]) => {
    if (identity && key === "email") {
      changed = true;
      return [];
    }
    const minimized = minimizeIdentityEmails(item, key === "author" || key === "committer");
    if (minimized !== item) changed = true;
    return [[key, minimized]];
  });
  return changed ? Object.fromEntries(entries) : value;
}

function readOnlyQuery(query: string): boolean {
  // Remove GraphQL strings and comments before examining operation tokens.
  const tokens = query.replace(/"""(?:\\[\s\S]|(?!""")[\s\S])*"""|"(?:\\.|[^"\\])*"|#[^\r\n]*/g, " ");
  return /^\s*(?:query\b|\{)/.test(tokens) && !/\b(?:mutation|subscription)\b/.test(tokens);
}

function checkAuthorization(source: string, check?: () => void): void {
  try {
    check?.();
  } catch {
    throw new GithubClientError({ kind: "unsafe_request" }, source);
  }
}

/** Read-only, credential-scoped transport. No upstream mutation entry points. */
export class GithubReadClient {
  private readonly origin: URL;
  private readonly options: Required<Omit<GithubClientOptions, "checkpoints" | "token">> &
    Pick<GithubClientOptions, "checkpoints" | "token">;
  private readonly pauses = new Map<string, number>();
  private readonly pauseWrites = new Map<string, Promise<void>>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly scans = new Set<string>();

  constructor(options: GithubClientOptions) {
    this.origin = new URL(options.apiOrigin ?? "https://api.github.com");
    if (
      this.origin.protocol !== "https:" ||
      this.origin.username ||
      this.origin.password ||
      this.origin.pathname !== "/" ||
      this.origin.search ||
      this.origin.hash
    ) {
      throw new Error("Configure an HTTPS GitHub API origin without credentials, path, or query");
    }
    this.options = {
      ...options,
      apiOrigin: this.origin.origin,
      graphqlPath: options.graphqlPath ?? "/graphql",
      apiVersion: options.apiVersion ?? "2022-11-28",
      concurrency: options.concurrency ?? 4,
      maxRetries: options.maxRetries ?? 3,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxResponseBytes: options.maxResponseBytes ?? 16 * 1024 * 1024,
      fetch: options.fetch ?? globalThis.fetch,
      now: options.now ?? Date.now,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      random: options.random ?? Math.random,
    };
    for (const name of ["concurrency", "timeoutMs", "maxResponseBytes"] as const) {
      if (!Number.isSafeInteger(this.options[name]) || this.options[name] < 1) throw new RangeError(`Invalid ${name}`);
    }
    if (
      this.options.concurrency > 100 ||
      !Number.isSafeInteger(this.options.maxRetries) ||
      this.options.maxRetries < 0
    ) {
      throw new RangeError("Invalid concurrency or retry bound");
    }
    this.trustedUrl(this.options.graphqlPath, "configuration");
  }

  private trustedUrl(raw: string, source: string): string {
    let url: URL;
    try {
      url = new URL(raw, this.origin);
    } catch {
      throw new GithubClientError({ kind: "unsafe_request" }, source);
    }
    if (url.protocol !== "https:" || url.origin !== this.origin.origin || url.username || url.password || url.hash) {
      throw new GithubClientError({ kind: "unsafe_request" }, source);
    }
    return url.toString();
  }

  private async acquire(): Promise<() => void> {
    if (this.active >= this.options.concurrency) await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.active += 1;
    return () => {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    };
  }

  private async pause(source: string, until: number): Promise<void> {
    const next = Math.max(this.pauses.get(source) ?? 0, until);
    this.pauses.set(source, next);
    // Concurrent responses must not persist an older, shorter pause after a
    // newer one. Serialize source writes and read the latest deadline at save.
    const previous = this.pauseWrites.get(source) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() =>
        this.options.checkpoints.save(`pause:${hash(source)}`, { version: 1, until: this.pauses.get(source)! }),
      );
    this.pauseWrites.set(source, write);
    await write;
  }

  private async wait(source: string): Promise<void> {
    while ((this.pauses.get(source) ?? 0) > this.options.now()) {
      // Timer values above signed 32-bit overflow in Node. Recheck after chunks.
      await this.options.sleep(Math.min(60_000, this.pauses.get(source)! - this.options.now()));
    }
  }

  private async body(response: Response, source: string): Promise<unknown> {
    if (!response.body) throw new GithubClientError({ kind: "invalid_response" }, source);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.byteLength;
        if (length > this.options.maxResponseBytes) throw new GithubClientError({ kind: "invalid_response" }, source);
        chunks.push(item.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch (error) {
      if (error instanceof GithubClientError) throw error;
      if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
        throw new GithubClientError({ kind: "transient_failure", visibility: "unknown" }, source);
      }
      throw new GithubClientError({ kind: "invalid_response" }, source);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private async request(
    source: string,
    rawUrl: string,
    query?: { query: string; variables: Record<string, unknown> },
    assertAuthorized?: () => void,
  ): Promise<{ body: unknown; link: string | null }> {
    const authorize = () => checkAuthorization(source, assertAuthorized);
    authorize();
    const url = this.trustedUrl(rawUrl, source);
    const persistedPause = await this.options.checkpoints.load(`pause:${hash(source)}`);
    if (persistedPause !== undefined) {
      if (
        !object(persistedPause) ||
        persistedPause.version !== 1 ||
        typeof persistedPause.until !== "number" ||
        !Number.isFinite(persistedPause.until)
      ) {
        throw new GithubClientError({ kind: "invalid_checkpoint" }, source);
      }
      this.pauses.set(source, Math.max(this.pauses.get(source) ?? 0, persistedPause.until));
    }
    const cacheKey = `http:${hash([source, this.options.apiVersion, url])}`;
    const cached = query ? undefined : await this.options.checkpoints.load(cacheKey);
    if (
      cached !== undefined &&
      (!object(cached) ||
        cached.version !== 1 ||
        typeof cached.etag !== "string" ||
        !(cached.link === null || typeof cached.link === "string") ||
        !("body" in cached))
    ) {
      throw new GithubClientError({ kind: "invalid_checkpoint" }, source);
    }
    const cache = cached as CachedResponse | undefined;
    if (cache) {
      const body = minimizeIdentityEmails(cache.body);
      if (body !== cache.body) {
        cache.body = body;
        // Migrate legacy values before any request or conditional cache reuse.
        await this.options.checkpoints.save(cacheKey, cache);
      }
    }
    for (let attempt = 0; ; attempt += 1) {
      await this.wait(source);
      const release = await this.acquire();
      let outcome: EndpointOutcome | undefined;
      let response: Response | undefined;
      try {
        // Another request may have paused this source while this one queued.
        if ((this.pauses.get(source) ?? 0) > this.options.now()) {
          attempt -= 1;
          continue;
        }
        const headers = new Headers({
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": this.options.apiVersion,
          "User-Agent": "pick-your-ai-leaderboard",
        });
        const token = await this.options.token(source);
        if (token) headers.set("Authorization", `Bearer ${token}`);
        if (cache) headers.set("If-None-Match", cache.etag);
        if (query) headers.set("Content-Type", "application/json");
        // Recheck after checkpoint, quota, concurrency and token awaits, on every retry.
        authorize();
        response = await this.options.fetch(url, {
          method: query ? "POST" : "GET",
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(this.options.timeoutMs),
          ...(query ? { body: JSON.stringify(query) } : {}),
        });
        // Access can change while fetch is pending, before any response is consumed.
        authorize();
        if (response.status >= 300 && response.status < 400 && response.status !== 304) {
          await response.body?.cancel();
          throw new GithubClientError({ kind: "unsafe_request" }, source);
        }
        // Conditional 304 responses still carry quota state. Observe it before
        // returning a cached representation, just as for a fresh HTTP 200.
        if ((response.ok || response.status === 304) && response.headers.get("x-ratelimit-remaining") === "0") {
          const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
          await this.pause(
            source,
            Number.isFinite(reset) && reset > this.options.now() ? reset : this.options.now() + 60_000,
          );
        }
        authorize();
        if (response.status === 304) {
          await response.body?.cancel();
          authorize();
          if (!cache) throw new GithubClientError({ kind: "invalid_response" }, source);
          return { body: cache.body, link: cache.link };
        }
        let body: unknown;
        try {
          body = minimizeIdentityEmails(await this.body(response, source));
        } catch (error) {
          // Error responses may be empty/non-JSON (for example proxy outages).
          // Their HTTP status still determines authorization/retry behavior.
          if (response.ok) throw error;
          body = {};
        }
        authorize();
        if (response.ok && !(query && object(body) && Array.isArray(body.errors) && body.errors.length)) {
          const link = response.headers.get("link");
          if (!query && response.headers.get("etag")) {
            await this.options.checkpoints.save(cacheKey, {
              version: 1,
              etag: response.headers.get("etag"),
              body,
              link,
            });
          }
          authorize();
          return { body, link };
        }
        const errors = object(body) && Array.isArray(body.errors) ? body.errors : [];
        const rateError = errors.some(
          (error) =>
            object(error) &&
            (error.type === "RATE_LIMITED" || (object(error.extensions) && error.extensions.code === "RATE_LIMITED")),
        );
        const hasErrorType = (type: string) =>
          errors.some(
            (error) =>
              object(error) && (error.type === type || (object(error.extensions) && error.extensions.code === type)),
          );
        const message = object(body) && typeof body.message === "string" ? body.message : rateError ? "rate limit" : "";
        const graphqlStatus = hasErrorType("FORBIDDEN")
          ? 403
          : hasErrorType("NOT_FOUND")
            ? 404
            : hasErrorType("UNAUTHENTICATED")
              ? 401
              : undefined;
        outcome = classifyGithubFailure({
          status: rateError ? 429 : (graphqlStatus ?? response.status),
          headers: response.headers,
          message,
          now: new Date(this.options.now()),
        });
        if (response.ok && !rateError && graphqlStatus === undefined)
          throw new GithubClientError({ kind: "invalid_response" }, source);
      } catch (error) {
        if (error instanceof GithubClientError) {
          if (error.outcome.kind !== "transient_failure") throw error;
          outcome = error.outcome;
        } else {
          // Do not expose payloads, tokens or URLs through raw transport errors.
          outcome = { kind: "transient_failure", visibility: "unknown" };
        }
      } finally {
        // Rejected headers can leave an unread stream. Cleanup must not keep a
        // request slot occupied if an injected transport has a slow cancel hook.
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
        release();
      }
      if (!outcome) throw new GithubClientError({ kind: "invalid_response" }, source);
      const retryable = outcome.kind === "rate_limited" || outcome.kind === "transient_failure";
      if (retryable) {
        const jitter = Math.floor(Math.max(0, Math.min(1, this.options.random())) * 1000);
        const backoff = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
        const retryAt =
          outcome.kind === "rate_limited"
            ? Math.max(this.options.now() + backoff, Date.parse(outcome.retryAt))
            : this.options.now() + backoff;
        await this.pause(source, retryAt + jitter);
      }
      if (!retryable || attempt >= this.options.maxRetries) throw new GithubClientError(outcome, source);
    }
  }

  async rest<T = unknown>(source: string, url: string, assertAuthorized?: () => void): Promise<T> {
    const { body } = await this.request(source, url, undefined, assertAuthorized);
    checkAuthorization(source, assertAuthorized);
    return body as T;
  }

  async graphql<T = unknown>(
    source: string,
    query: string,
    variables: Record<string, unknown> = {},
    assertAuthorized?: () => void,
  ): Promise<T> {
    if (!readOnlyQuery(query)) throw new GithubClientError({ kind: "unsafe_request" }, source);
    const { body } = await this.request(source, this.options.graphqlPath, { query, variables }, assertAuthorized);
    checkAuthorization(source, assertAuthorized);
    if (!object(body) || !("data" in body) || body.data === null)
      throw new GithubClientError({ kind: "invalid_response" }, source);
    return body.data as T;
  }

  private async scan<T>(
    source: string,
    key: string,
    fingerprint: string,
    start: string,
    maxPages: number,
    refresh: boolean | undefined,
    fetchPage: (next: string) => Promise<{ items: readonly T[]; next: string | null }>,
    assertAuthorized?: () => void,
  ): Promise<T[]> {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1)
      throw new RangeError("maxPages must be a positive safe integer");
    const storageKey = `scan:${hash([source, key])}`;
    if (this.scans.has(storageKey)) throw new Error("A scan with this source/key is already running");
    this.scans.add(storageKey);
    try {
      const loaded = refresh ? undefined : await this.options.checkpoints.load(storageKey);
      checkAuthorization(source, assertAuthorized);
      if (
        loaded !== undefined &&
        (!object(loaded) ||
          loaded.version !== 1 ||
          loaded.fingerprint !== fingerprint ||
          !Array.isArray(loaded.visited) ||
          !loaded.visited.every((value) => typeof value === "string") ||
          !Array.isArray(loaded.items) ||
          typeof loaded.complete !== "boolean" ||
          !(loaded.next === null || typeof loaded.next === "string") ||
          loaded.complete !== (loaded.next === null))
      ) {
        throw new GithubClientError({ kind: "invalid_checkpoint" }, source);
      }
      const state: ScanCheckpoint = (loaded as unknown as ScanCheckpoint) ?? {
        version: 1,
        fingerprint,
        next: start,
        visited: [],
        items: [],
        complete: false,
      };
      const items = minimizeIdentityEmails(state.items) as unknown[];
      if (items !== state.items) {
        state.items = items;
        // Completed and interrupted legacy scans both migrate before reuse.
        await this.options.checkpoints.save(storageKey, state);
      }
      while (state.next !== null) {
        if (state.visited.length >= maxPages)
          throw new Error("Source pagination exceeded maxPages; checkpoint retained");
        if (state.visited.includes(state.next))
          throw new Error("Source pagination repeated a page; checkpoint retained");
        const next = state.next;
        const page = await fetchPage(next);
        checkAuthorization(source, assertAuthorized);
        if (!Array.isArray(page.items)) throw new GithubClientError({ kind: "invalid_response" }, source);
        state.items.push(...(minimizeIdentityEmails(page.items) as unknown[]));
        state.visited.push(next);
        state.next = page.next;
        state.complete = page.next === null;
        // Commit only fully validated pages. Retrying a failed save is safe:
        // callers receive results only after the durable checkpoint succeeds.
        await this.options.checkpoints.save(storageKey, state);
      }
      checkAuthorization(source, assertAuthorized);
      return state.items as T[];
    } finally {
      this.scans.delete(storageKey);
    }
  }

  async scanRest<T>(options: RestScan<T>): Promise<T[]> {
    const initialUrl = this.trustedUrl(options.url, options.source);
    const fingerprint = hash(["rest/v1", initialUrl, this.options.apiVersion, options.key]);
    return this.scan(
      options.source,
      options.key,
      fingerprint,
      initialUrl,
      options.maxPages,
      options.refresh,
      async (url) => {
        const page = await this.request(options.source, url, undefined, options.assertAuthorized);
        checkAuthorization(options.source, options.assertAuthorized);
        const link = nextRestLink(page.link);
        return { items: options.select(page.body), next: link ? this.trustedUrl(link, options.source) : null };
      },
      options.assertAuthorized,
    );
  }

  async scanGraphql<T>(options: GraphqlScan<T>): Promise<T[]> {
    const first = options.first ?? 100;
    if (!Number.isInteger(first) || first < 1 || first > 100)
      throw new RangeError("GraphQL first must be 1 through 100");
    if (options.variables && ("first" in options.variables || "after" in options.variables))
      throw new Error("first and after are managed scan variables");
    const fingerprint = hash([
      "graphql/v1",
      this.options.apiOrigin,
      this.options.graphqlPath,
      this.options.apiVersion,
      options.query,
      options.variables ?? {},
      first,
      options.key,
    ]);
    return this.scan(
      options.source,
      options.key,
      fingerprint,
      "",
      options.maxPages,
      options.refresh,
      async (cursor) => {
        const data = await this.graphql(
          options.source,
          options.query,
          {
            ...options.variables,
            first,
            after: cursor || null,
          },
          options.assertAuthorized,
        );
        checkAuthorization(options.source, options.assertAuthorized);
        const page = options.select(data);
        if (
          !object(page) ||
          page.errors?.length ||
          !object(page.pageInfo) ||
          typeof page.pageInfo.hasNextPage !== "boolean" ||
          !(page.pageInfo.endCursor === null || typeof page.pageInfo.endCursor === "string") ||
          (page.pageInfo.hasNextPage && !page.pageInfo.endCursor)
        )
          throw new GithubClientError({ kind: "invalid_response" }, options.source);
        return { items: page.nodes, next: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null };
      },
      options.assertAuthorized,
    );
  }

  /** Each parent gets its own durable child cursor; parent cursors never substitute for child cursors. */
  async scanNestedGraphql<P, T>(
    parents: readonly P[],
    child: (parent: P) => GraphqlScan<T>,
  ): Promise<Array<{ parent: P; items: T[] }>> {
    const result: Array<{ parent: P; items: T[] }> = new Array(parents.length);
    const authorizations: Array<{ source: string; assertAuthorized: (() => void) | undefined }> = [];
    let index = 0;
    const worker = async () => {
      while (index < parents.length) {
        const current = index++;
        const parent = parents[current]!;
        const options = child(parent);
        authorizations.push({ source: options.source, assertAuthorized: options.assertAuthorized });
        result[current] = { parent, items: await this.scanGraphql(options) };
      }
    };
    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(this.options.concurrency, parents.length) }, worker),
    );
    const failure = settled.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    // An earlier child can lose access while a later child is still pending.
    for (const authorization of authorizations)
      checkAuthorization(authorization.source, authorization.assertAuthorized);
    return result;
  }
}
