import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Browser, BrowserContext } from "@playwright/test";
import { build } from "vite";
import { documentHeaders } from "../security-policy.ts";

const execute = promisify(execFile);
const loopback = "127.0.0.1";
const authorizationEndpoint = "https://github.com/login/oauth/authorize";
const providerPath = "/__synthetic_controls_provider";
const digest = (value: string) => createHash("sha256").update(value).digest("base64url");
type OAuthParameters = { state: string; challenge: string; redirectURI: string };
type ExchangeParameters = { code: string; verifier: string; redirectURI: string };
type Grant = { actorId: string; challenge: string; redirectURI: string };
type AuditEvent = { id: string; receipt: string; actor: string; action: string; at: number; version: number };
export type StoredReceipt = {
  id: string;
  owner: string;
  kind: string;
  detail: string;
  status: string;
  version: number;
  history: AuditEvent[];
};
type Profile = { bio?: string; highlights?: string[]; public?: boolean; suppressed?: boolean };
type ProtectedState = {
  profiles: Record<string, Profile>;
  requests: Record<string, StoredReceipt>;
  audit: AuditEvent[];
  revision: number;
};
type Store = { read(): ProtectedState; close(): void };
type PublicServer = { listen(options: { host: string; port: number }): Promise<string>; close(): Promise<void> };
type RequestRecord = { path: string; method: string; hasCookie: boolean; origin: string | undefined };

async function listen(server: Server | HttpsServer) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, loopback, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
async function stop(server: Server | HttpsServer | undefined) {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

// Ubuntu 24.04 Browser CI includes OpenSSL. This creates only a temporary,
// self-signed loopback server certificate; no production credential is used.
// Tool authority: actions/runner-images@68bd77adbdf0017e6e3d622348abdb2763ca26f4,
// images/ubuntu/Ubuntu2404-Readme.md (OpenSSL 3.0.13).
async function loopbackCertificate(directory: string) {
  const configuration = join(directory, "tls.cnf");
  const key = join(directory, "tls.key");
  const certificate = join(directory, "tls.crt");
  await writeFile(
    configuration,
    [
      "[req]",
      "distinguished_name=subject",
      "x509_extensions=server",
      "prompt=no",
      "[subject]",
      "CN=127.0.0.1",
      "[server]",
      "subjectAltName=IP:127.0.0.1",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await execute(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-batch",
      "-days",
      "1",
      "-config",
      configuration,
      "-keyout",
      key,
      "-out",
      certificate,
    ],
    { cwd: directory, timeout: 10_000, maxBuffer: 128 * 1024 },
  );
  await chmod(key, 0o600);
  await chmod(certificate, 0o600);
  return { key: await readFile(key), cert: await readFile(certificate) };
}

export async function createControlsJourney(browser: Browser) {
  const directory = await mkdtemp(join(tmpdir(), "lb-controls-journey-"));
  const site = join(directory, "site");
  const filename = join(directory, "private", "controls.sqlite");
  const contexts = new Set<BrowserContext>();
  const authorizations = new Map<string, Omit<OAuthParameters, "state">>();
  const bridges = new Map<string, Omit<OAuthParameters, "state">>();
  const authorizationRedirects: Array<{ status: number; endpoint: string }> = [];
  const grants = new Map<string, Grant>();
  const exchanges: string[] = [];
  const requests: RequestRecord[] = [];
  const failures: string[] = [];
  let origin = "";
  let controlsPort = 0;
  let publicPort = 0;
  let controls: Server | undefined;
  let ingress: HttpsServer | undefined;
  let publicServer: PublicServer | undefined;
  let store: Store | undefined;
  let closed = false;

  async function close() {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    for (const context of [...contexts]) {
      try {
        await context.close();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const server of [ingress, controls]) {
      try {
        await stop(server);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await publicServer?.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      store?.close();
    } catch (error) {
      errors.push(error);
    }
    authorizations.clear();
    bridges.clear();
    grants.clear();
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Synthetic Controls journey cleanup failed");
  }

  function bridgeAuthorization(request: IncomingMessage, incoming: IncomingMessage) {
    const headers = { ...incoming.headers };
    if (headers.location === undefined) return headers;
    const target = new URL(headers.location, origin);
    assert.equal(target.username, "");
    assert.equal(target.password, "");
    assert.equal(target.hash, "");
    if (target.origin === origin) return headers;
    // Playwright does not route later redirect hops. Substitute the fictional
    // provider here, before its external Location can reach the browser.
    assert.equal(request.method, "GET");
    assert.equal(new URL(request.url ?? "/", origin).pathname, "/controls/auth/login");
    assert.equal(incoming.statusCode, 302);
    assert.equal(target.origin + target.pathname, authorizationEndpoint);
    assert.deepEqual([...target.searchParams.keys()].sort(), [
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "redirect_uri",
      "scope",
      "state",
    ]);
    assert.equal(target.searchParams.get("client_id"), "synthetic-controls-journey");
    assert.equal(target.searchParams.get("scope"), "");
    assert.equal(target.searchParams.get("code_challenge_method"), "S256");
    const state = target.searchParams.get("state")!;
    const authorization = authorizations.get(state);
    assert.ok(authorization, "The actual login must issue this authorization state");
    assert.equal(target.searchParams.get("redirect_uri"), authorization.redirectURI);
    assert.equal(target.searchParams.get("code_challenge"), authorization.challenge);
    assert.equal(bridges.has(state), false);
    authorizations.delete(state);
    bridges.set(state, authorization);
    authorizationRedirects.push({ status: incoming.statusCode, endpoint: authorizationEndpoint });
    headers.location = origin + providerPath + "/authorize?" + new URLSearchParams({ state });
    return headers;
  }

  function forward(request: IncomingMessage, response: ServerResponse, port: number) {
    assert.ok(port > 0);
    // Request headers/body and response status/Set-Cookie remain untouched.
    // Only a validated fictional-provider Location is bridged below; no Cookie,
    // Origin, CSRF or identity header is injected.
    const upstream = httpRequest(
      { hostname: loopback, port, path: request.url, method: request.method, headers: request.headers, agent: false },
      (incoming) => {
        try {
          const headers = bridgeAuthorization(request, incoming);
          response.writeHead(incoming.statusCode ?? 502, headers);
          incoming.pipe(response);
        } catch (error) {
          failures.push("Rejected upstream redirect: " + String(error));
          incoming.resume();
          if (!response.headersSent) response.writeHead(502);
          response.end();
        }
      },
    );
    request.once("aborted", () => upstream.destroy());
    response.once("close", () => upstream.destroy());
    upstream.once("error", (error) => {
      if (request.aborted || response.destroyed) return;
      failures.push("Loopback forwarding: " + error.message);
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  }

  async function serve(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", origin);
    assert.equal(url.origin, origin);
    requests.push({
      path: url.pathname,
      method: request.method ?? "",
      hasCookie: Boolean(request.headers.cookie),
      origin: request.headers.origin,
    });
    if (url.pathname === providerPath + "/authorize") {
      assert.equal(request.method, "GET");
      assert.deepEqual([...url.searchParams.keys()], ["state"]);
      const state = url.searchParams.get("state")!;
      assert.ok(bridges.has(state), "Only an observed real login redirect reaches this provider page");
      const choices = ["101", "202"].map(
        (actor) =>
          '<p><a href="' +
          providerPath +
          "/complete?state=" +
          encodeURIComponent(state) +
          "&amp;actor=" +
          actor +
          '">Continue as synthetic account ' +
          actor +
          "</a></p>",
      );
      response.writeHead(200, {
        ...documentHeaders,
        "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic identity provider</title></head>' +
          "<body><main><h1>Synthetic identity provider</h1>" +
          "<p>This local test substitutes the external provider. These accounts are fictional.</p>" +
          choices.join("") +
          "</main></body></html>",
      );
      return;
    }
    if (url.pathname === providerPath + "/complete") {
      assert.equal(request.method, "GET");
      assert.deepEqual([...url.searchParams.keys()].sort(), ["actor", "state"]);
      const state = url.searchParams.get("state")!;
      const actorId = url.searchParams.get("actor")!;
      assert.ok(["101", "202"].includes(actorId));
      const authorization = bridges.get(state);
      assert.ok(authorization, "A fictional provider state is consumed only once");
      bridges.delete(state);
      const code = randomBytes(24).toString("base64url");
      grants.set(code, { actorId, ...authorization });
      response.writeHead(302, {
        location: authorization.redirectURI + "?" + new URLSearchParams({ state, code }),
        "Cache-Control": "no-store",
      });
      response.end();
      return;
    }
    if (url.pathname.startsWith("/controls/")) return forward(request, response, controlsPort);
    if (url.pathname.startsWith("/api/v1/")) return forward(request, response, publicPort);
    if (!["GET", "HEAD"].includes(request.method ?? "")) {
      response.writeHead(405);
      response.end();
      return;
    }
    const candidate = resolve(site, "." + decodeURIComponent(url.pathname));
    assert.ok(candidate === site || candidate.startsWith(site + sep));
    const information = await stat(candidate).catch(() => null);
    const target = information?.isFile() ? candidate : join(site, "index.html");
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".woff2": "font/woff2",
    };
    response.writeHead(200, {
      ...documentHeaders,
      "Content-Type": types[extname(target)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : await readFile(target));
  }

  const provider = {
    authorizationURL({ state, challenge, redirectURI }: OAuthParameters) {
      assert.equal(redirectURI, origin + "/controls/auth/callback");
      authorizations.set(state, { challenge, redirectURI });
      return (
        authorizationEndpoint +
        "?" +
        new URLSearchParams({
          client_id: "synthetic-controls-journey",
          state,
          redirect_uri: redirectURI,
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "",
        })
      );
    },
    async exchange({ code, verifier, redirectURI }: ExchangeParameters) {
      const grant = grants.get(code);
      assert.ok(grant, "Only a one-use fictional authorization code is accepted");
      grants.delete(code);
      assert.equal(grant.redirectURI, redirectURI);
      assert.equal(grant.challenge, digest(verifier));
      exchanges.push(grant.actorId);
      return { actorId: grant.actorId };
    },
  };

  try {
    await chmod(directory, 0o700);
    const tls = await loopbackCertificate(directory);
    ingress = createHttpsServer(tls, (request, response) => {
      void serve(request, response).catch((error: unknown) => {
        failures.push("Synthetic ingress: " + String(error));
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    origin = "https://" + loopback + ":" + (await listen(ingress));

    // Dynamic imports retain the repository's existing Node/build boundary.
    const controlsModule = await import(new URL("../../controls/src/server.mjs", import.meta.url).href);
    const storeModule = await import(new URL("../../controls/src/store.mjs", import.meta.url).href);
    const serviceModule = await import(new URL("../../service/dist/app.js", import.meta.url).href);
    async function startControls() {
      store = new storeModule.ControlStore(filename) as Store;
      controls = controlsModule.createControlsServer({
        store,
        provider,
        origin,
        loginSuccessPath: "/account",
      }) as Server;
      controlsPort = await listen(controls);
    }
    await startControls();
    publicServer = serviceModule.createService({
      cursorSecret: "synthetic-controls-journey-cursor-secret",
      source: {
        async read() {
          return null;
        },
      },
    }) as PublicServer;
    publicPort = Number(new URL(await publicServer.listen({ host: loopback, port: 0 })).port);

    // Ignore ambient VITE_* overrides. CSP resolves its existing /api/v1
    // default, matching the explicit client definition; no global env mutation.
    await build({
      root: fileURLToPath(new URL("..", import.meta.url)),
      envDir: false,
      cacheDir: join(directory, "vite-cache"),
      envPrefix: "SYNTHETIC_CONTROLS_JOURNEY_",
      define: {
        "import.meta.env.VITE_PUBLIC_API_BASE": JSON.stringify("/api/v1"),
        "import.meta.env.VITE_PUBLIC_CONTROLS_BASE": JSON.stringify(origin + "/controls/"),
      },
      build: { outDir: site, emptyOutDir: true },
      logLevel: "error",
    });

    return {
      origin,
      requests,
      exchanges,
      authorizationRedirects,
      state(): ProtectedState {
        assert.ok(store);
        const { profiles, requests: receipts, audit, revision } = store.read();
        return structuredClone({ profiles, requests: receipts, audit, revision });
      },
      async reopen() {
        await stop(controls);
        controls = undefined;
        controlsPort = 0;
        store?.close();
        store = undefined;
        await startControls();
      },
      async open(actorId: string) {
        assert.match(actorId, /^[1-9][0-9]{0,19}$/);
        const context = await browser.newContext({
          storageState: { cookies: [], origins: [] },
          // Only this test context ignores certificate errors. Initial requests
          // are origin-restricted below and every ingress redirect remains local.
          // Production HTTPS, Origin and Secure-cookie rules stay exact.
          ignoreHTTPSErrors: true,
          serviceWorkers: "block",
        });
        contexts.add(context);
        context.on("close", () => contexts.delete(context));
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin === origin) return route.continue();
          // All redirects served by the ingress are local too. The real
          // external provider is never visited by this synthetic journey.
          failures.push("Blocked outbound request: " + url.origin);
          await route.abort();
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => failures.push("Browser: " + error.message));
        return { actorId, context, page };
      },
      assertHealthy() {
        assert.deepEqual(failures, []);
        assert.equal(authorizations.size, 0, "Every issued authorization must reach the ingress bridge");
        assert.equal(bridges.size, 0, "Every observed provider redirect must have one account choice");
        assert.equal(grants.size, 0, "Every issued fictional code must have been consumed by the actual callback");
        assert.equal(authorizationRedirects.length, exchanges.length);
        assert.ok(
          requests
            .filter((request) => request.path.startsWith("/api/v1/"))
            .every((request) => request.method === "GET" && !request.hasCookie),
        );
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Synthetic Controls journey setup and cleanup failed");
    }
    throw error;
  }
}
export type ControlsJourney = Awaited<ReturnType<typeof createControlsJourney>>;
