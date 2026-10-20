import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { types } from "node:util";
import { GithubReadClient, GithubClientError } from "../../../packages/github/dist/client.js";
import { nextRestLink } from "../../../packages/github/dist/index.js";

const VERSION = "github-source-canary/v1";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const opaque = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const canaryErrorCodes = new WeakMap();
class CanaryError extends GithubClientError {
  constructor(code) {
    super({ kind: "unsafe_request" }, "source-canary");
    this.message = `source_canary_${code}`;
    canaryErrorCodes.set(this, code);
  }
}
const fail = (code) => {
  throw new CanaryError(code);
};
const exactKeys = (value, keys) =>
  object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function requestSnapshot(value) {
  if (
    !exactKeys(value, [
      "runId",
      "source",
      "repository",
      "history",
      "reviews",
      "scanMode",
      "apiOrigin",
      "apiVersion",
      "maxPages",
    ])
  )
    fail("invalid_configuration");
  const { runId, source, scanMode, apiOrigin, apiVersion, maxPages } = value;
  const repository = value.repository;
  if (!exactKeys(repository, ["id", "installationId", "slug"])) fail("invalid_configuration");
  const scope = { id: repository.id, installationId: repository.installationId, slug: repository.slug };
  const targets = [
    ["issue_events", value.history],
    ["pull_reviews", value.reviews],
  ].map(([kind, target]) => {
    if (!exactKeys(target, ["number", "id"])) fail("invalid_configuration");
    const result = { kind, number: target.number, id: target.id };
    if (!positive(result.number) || !positive(result.id)) fail("invalid_configuration");
    return Object.freeze(result);
  });
  let origin;
  try {
    origin = new URL(apiOrigin);
  } catch {
    fail("invalid_configuration");
  }
  if (
    !opaque(runId) ||
    !opaque(source) ||
    !positive(scope.id) ||
    !positive(scope.installationId) ||
    typeof scope.slug !== "string" ||
    scope.slug.length > 200 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(scope.slug) ||
    scope.slug.split("/").some((part) => [".", ".."].includes(part)) ||
    !["refresh", "resume"].includes(scanMode) ||
    !positive(maxPages) ||
    maxPages > 100 ||
    origin.protocol !== "https:" ||
    origin.origin !== apiOrigin ||
    origin.username ||
    origin.password ||
    typeof apiVersion !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(apiVersion)
  )
    fail("invalid_configuration");
  return Object.freeze({
    runId,
    source,
    repository: Object.freeze(scope),
    targets: Object.freeze(targets),
    scanMode,
    apiOrigin,
    apiVersion,
    maxPages,
  });
}

function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19)
    ? parsed.toISOString()
    : null;
}

function projectRecord(value, target, request) {
  if (!object(value) || !positive(value.id)) fail("invalid_record");
  const repositoryPath = `/repos/${request.repository.slug}`;
  const expected =
    target.kind === "issue_events"
      ? `${repositoryPath}/issues/events/${value.id}`
      : `${repositoryPath}/pulls/${target.number}`;
  const raw = target.kind === "issue_events" ? value.url : value.pull_request_url;
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("invalid_record");
  }
  if (
    url.origin !== request.apiOrigin ||
    url.pathname.toLowerCase() !== expected.toLowerCase() ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    fail("invalid_record");
  const actor = target.kind === "issue_events" ? value.actor : value.user;
  const action = target.kind === "issue_events" ? value.event : value.state;
  return {
    id: value.id,
    actorId: positive(actor?.id) ? actor.id : null,
    occurredAt: timestamp(target.kind === "issue_events" ? value.created_at : value.submitted_at),
    action: typeof action === "string" && /^[A-Za-z_]{1,64}$/.test(action) ? action : null,
  };
}

function checkedRetainedRows(values) {
  if (!Array.isArray(values)) fail("invalid_retained_result");
  const ids = new Set();
  return values.map((value) => {
    if (
      !exactKeys(value, ["id", "actorId", "occurredAt", "action"]) ||
      !positive(value.id) ||
      ids.has(value.id) ||
      !(value.actorId === null || positive(value.actorId)) ||
      !(value.occurredAt === null || timestamp(value.occurredAt) === value.occurredAt) ||
      !(value.action === null || (typeof value.action === "string" && /^[A-Za-z_]{1,64}$/.test(value.action)))
    )
      fail("invalid_retained_result");
    ids.add(value.id);
    return { id: value.id, actorId: value.actorId, occurredAt: value.occurredAt, action: value.action };
  });
}

function pageNumber(url, path, request) {
  const parameters = [...url.searchParams];
  if (
    url.origin !== request.apiOrigin ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname.toLowerCase() !== path.toLowerCase() ||
    parameters.length !== 2 ||
    url.searchParams.getAll("per_page").length !== 1 ||
    url.searchParams.get("per_page") !== "100" ||
    url.searchParams.getAll("page").length !== 1 ||
    !/^[1-9]\d*$/.test(url.searchParams.get("page") ?? "")
  )
    fail("unsafe_route");
  const page = Number(url.searchParams.get("page"));
  // maxPages bounds actual admitted pages in the existing scan. A next link
  // beyond this invocation's budget must still allow the current page to save.
  if (!positive(page)) fail("page_bound");
  return page;
}

function headerInteger(headers, name) {
  const value = headers.get(name);
  if (value === null || !/^[0-9]{1,16}$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/**
 * Opt-in protected-host probe of the existing reader, never a source grant.
 * Host callbacks/store/transport remain trusted and must settle on cancellation.
 */
export async function runGithubSourceCanary(host, options = {}) {
  try {
    if (!object(options) || Object.keys(options).some((key) => key !== "signal")) fail("invalid_configuration");
    const signal = options.signal;
    let request;
    try {
      request = requestSnapshot(host?.request);
    } catch {
      fail("invalid_configuration");
    }
    const authorize = host?.authorize,
      assertAuthorized = host?.assertAuthorized,
      open = host?.open;
    if (
      typeof authorize !== "function" ||
      typeof assertAuthorized !== "function" ||
      typeof open !== "function" ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    )
      fail("invalid_configuration");
    const check = () => {
      if (signal?.aborted) fail("stopped");
      // Host authority outlives each opened store. Closing a resource must not
      // invalidate the callback used at the final result-delivery boundary.
      const decision = assertAuthorized.call(host, request);
      if (decision !== true) {
        // Asynchronous authority never grants access. Observe its rejection so
        // an invalid async callback cannot emit a private unhandled exception.
        if (types.isPromise(decision)) {
          void Promise.prototype.then.call(
            decision,
            () => undefined,
            () => undefined,
          );
        }
        fail("authorization_required");
      }
    };
    const hostCheck = async () => {
      check();
      if ((await authorize.call(host, request)) !== true) fail("authorization_required");
      check();
    };
    const binding = digest([
      VERSION,
      request.runId,
      request.source,
      request.repository,
      request.apiOrigin,
      request.apiVersion,
      request.targets,
    ]);
    const observations = [],
      passes = [];
    let requestCount = 0;
    for (const phase of ["scan", "reuse"]) {
      await hostCheck();
      const resources = await open.call(host, { phase, signal, request });
      const close = resources?.close;
      try {
        if (
          typeof close !== "function" ||
          typeof resources?.token !== "function" ||
          !resources?.checkpoints ||
          (resources.fetch !== undefined && typeof resources.fetch !== "function")
        )
          fail("invalid_resources");
        const token = resources.token;
        const transport = resources.fetch ?? globalThis.fetch;
        await hostCheck();
        check();
        let active;
        const client = new GithubReadClient({
          checkpoints: resources.checkpoints,
          apiOrigin: request.apiOrigin,
          apiVersion: request.apiVersion,
          concurrency: 1,
          maxRetries: 0,
          timeoutMs: 30_000,
          token: async (source) => {
            check();
            if (source !== request.source) fail("invalid_source");
            const value = await token.call(resources, source, { signal });
            check();
            if (typeof value !== "string" || !value) fail("token_required");
            return value;
          },
          // An existing pause is a result to investigate, never permission to
          // wait indefinitely, shorten its deadline or force quota exhaustion.
          sleep: async () => {
            fail("source_paused");
          },
          fetch: async (raw, options) => {
            check();
            const url = new URL(raw);
            if (
              !active ||
              options.method !== "GET" ||
              url.origin !== request.apiOrigin ||
              url.username ||
              url.password ||
              url.hash
            )
              fail("unsafe_route");
            const page = active.collection ? pageNumber(url, active.path, request) : null;
            if (!active.collection && (url.pathname.toLowerCase() !== active.path.toLowerCase() || url.search))
              fail("unsafe_route");
            if (phase === "reuse" && active.collection) fail("retained_reuse_missing");
            if (++requestCount > 2 * request.maxPages + 8) fail("request_bound");
            const response = await transport(raw, {
              ...options,
              signal: signal ? AbortSignal.any([options.signal, signal]) : options.signal,
            });
            try {
              check();
              const link = response.headers.get("link");
              if (link !== null && link.length > 8192) fail("unsafe_route");
              const next = nextRestLink(link);
              const nextPage =
                next && active.collection ? pageNumber(new URL(next, request.apiOrigin), active.path, request) : null;
              if (next && !active.collection) fail("unsafe_route");
              const resource = response.headers.get("x-ratelimit-resource");
              observations.push({
                phase,
                endpoint: active.endpoint,
                targetId: active.targetId ?? null,
                page,
                status: response.status,
                nextPage,
                linkDigest: link === null ? null : digest(link),
                quota: {
                  resource: ["core", "search", "code_search", "graphql"].includes(resource) ? resource : "unknown",
                  limit: headerInteger(response.headers, "x-ratelimit-limit"),
                  remaining: headerInteger(response.headers, "x-ratelimit-remaining"),
                  used: headerInteger(response.headers, "x-ratelimit-used"),
                  resetEpochSeconds: headerInteger(response.headers, "x-ratelimit-reset"),
                  retryAfterSeconds: headerInteger(response.headers, "retry-after"),
                },
              });
              return response;
            } catch (error) {
              if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
              throw error;
            }
          },
        }).forRepository(request.repository.id);
        const repositoryPath = `/repos/${request.repository.slug}`;
        const readRepository = async () => {
          active = { endpoint: "repository", path: repositoryPath };
          const value = await client.rest(request.source, repositoryPath, check);
          if (
            value?.id !== request.repository.id ||
            value.private !== false ||
            typeof value.full_name !== "string" ||
            value.full_name.toLowerCase() !== request.repository.slug.toLowerCase()
          )
            fail("public_repository_unverified");
        };
        await readRepository();
        const quotaBefore = await client.readQuota(request.source, check);
        const results = [];
        for (const target of request.targets) {
          const subjectPath = `${repositoryPath}/${target.kind === "issue_events" ? "issues" : "pulls"}/${target.number}`;
          active = { endpoint: "subject", targetId: target.id, path: subjectPath };
          const subject = await client.rest(request.source, subjectPath, check);
          if (
            subject?.id !== target.id ||
            subject.number !== target.number ||
            (target.kind === "pull_reviews" && subject.base?.repo?.id !== request.repository.id)
          )
            fail("subject_identity_unverified");
          const path = `${subjectPath}/${target.kind === "issue_events" ? "events" : "reviews"}`;
          active = { endpoint: target.kind, targetId: target.id, path, collection: true };
          let selectedPages = 0;
          const selectedIds = new Set();
          const values = await client.scanRest({
            source: request.source,
            key: `${VERSION}:${binding}:${target.kind}`,
            url: `${path}?per_page=100&page=1`,
            maxPages: request.maxPages,
            refresh: phase === "scan" && request.scanMode === "refresh",
            assertAuthorized: check,
            select: (page) => {
              check();
              if (!Array.isArray(page) || page.length > 100) fail("invalid_page");
              const rows = page.map((value) => projectRecord(value, target, request));
              for (const row of rows) {
                if (selectedIds.has(row.id)) fail("duplicate_identity");
                selectedIds.add(row.id);
              }
              selectedPages++;
              return rows;
            },
          });
          check();
          const rows = checkedRetainedRows(values);
          results.push({
            kind: target.kind,
            subjectId: target.id,
            number: target.number,
            records: rows.length,
            selectedPages,
            identityDigest: digest(rows.map((row) => row.id)),
            observationDigest: digest(rows),
            unknownActor: rows.filter((row) => row.actorId === null).length,
            unknownTime: rows.filter((row) => row.occurredAt === null).length,
            unknownAction: rows.filter((row) => row.action === null).length,
          });
        }
        await readRepository();
        const quotaAfter = await client.readQuota(request.source, check);
        await hostCheck();
        check();
        passes.push({ phase, results, quotaBefore, quotaAfter });
      } finally {
        // Never close a store beneath an unsettled token, checkpoint or read.
        if (typeof close === "function") await close.call(resources);
      }
      await hostCheck();
    }
    for (let index = 0; index < request.targets.length; index++) {
      const first = passes[0].results[index],
        second = passes[1].results[index];
      if (
        first.identityDigest !== second.identityDigest ||
        first.observationDigest !== second.observationDigest ||
        second.selectedPages !== 0
      )
        fail("retained_result_changed");
    }
    await hostCheck();
    check();
    return {
      schemaVersion: VERSION,
      binding,
      repository: request.repository,
      apiOrigin: request.apiOrigin,
      requestedApiVersion: request.apiVersion,
      scanMode: request.scanMode,
      state: passes[0].results.every((result) => result.records > 100 && result.selectedPages > 1)
        ? "observed"
        : "insufficient_sample",
      installedCapability: "unverified",
      sourceEnabled: false,
      observations,
      passes,
    };
  } catch (error) {
    // Fixed categories only. No token, URL, private body or provider exception
    // reaches the exported error or command-line diagnostic. Classifying an
    // injected exception may itself invoke an untrusted getter/prototype trap.
    let code = canaryErrorCodes.get(error);
    if (code === undefined) {
      code = "failed";
      try {
        if (error instanceof GithubClientError) {
          const kind = error.outcome.kind;
          if (
            [
              "invalid_response",
              "unsafe_request",
              "invalid_checkpoint",
              "authentication_required",
              "permission_denied",
              "not_found_or_hidden",
              "rate_limited",
              "transient_failure",
              "unknown_failure",
            ].includes(kind)
          )
            code = kind;
        }
      } catch {
        /* Classification failure stays within the fixed boundary. */
      }
    }
    fail(code);
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== "--host" || !isAbsolute(args[1]) || !args[1].endsWith(".mjs"))
    fail("host_required");
  const path = args[1],
    metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail("invalid_host");
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const host = (await import(pathToFileURL(path).href)).default;
    const result = await runGithubSourceCanary(host, { signal: controller.signal });
    console.info(JSON.stringify(result));
    if (result.state !== "observed") process.exitCode = 2;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    console.error("source_canary_failed");
    process.exitCode = 1;
  });
}
