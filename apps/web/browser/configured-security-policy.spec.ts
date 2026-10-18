import { test, expect, chromium, type Browser, type BrowserContext } from "@playwright/test";
import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { preview } from "vite";
import { buildConfiguredApp, webRoot } from "../test/securityBuild.ts";
import { documentPolicyForApiBase } from "../security-policy.ts";

// Playwright Test owns tracing for every context, including our certificate-scoped
// browser. Retain its combined trace without starting or stopping a second recorder.
test.use({ trace: "on" });

async function cleanUp(actions: (() => Promise<unknown>)[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

test("configured HTTPS reads and events survive preview env changes while other origins remain blocked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pyai-csp-browser-"));
  let browser: Browser | undefined;
  const registry = JSON.parse(
    await readFile(new URL("../../../packages/metrics/src/v1/registry.json", import.meta.url), "utf8"),
  );
  registry.ui_metadata.metrics.find((entry: { metric_id: string }) => entry.metric_id === "pr_merged").synonyms = [
    "cspconfiguredapi",
  ];
  const module = new URL("../../service/dist/app.js", import.meta.url).href;
  const { createService } = await import(module);
  const app = createService({
    registry,
    source: {
      async read() {
        throw new Error("Synthetic unavailable source");
      },
    },
  });
  let publicOrigin = "";
  const observations: {
    path: string;
    origin: string | undefined;
    cookie: string | undefined;
    authorization: string | undefined;
  }[] = [];
  const failures: string[] = [];
  const errors: unknown[] = [];
  let api: ReturnType<typeof createServer> | undefined;
  try {
    const keyPath = join(directory, "synthetic-key.pem"),
      certPath = join(directory, "synthetic-cert.pem");
    await promisify(execFile)(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { timeout: 15_000, maxBuffer: 64 * 1024 },
    );
    const key = await readFile(keyPath),
      cert = await readFile(certPath);
    const spki = new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" });
    const fingerprint = createHash("sha256").update(spki).digest("base64");
    api = createServer({ key, cert }, async (request, response) => {
      try {
        observations.push({
          path: request.url ?? "",
          origin: request.headers.origin,
          cookie: request.headers.cookie,
          authorization: request.headers.authorization,
        });
        if (request.method !== "GET" || request.headers.origin !== publicOrigin) {
          response.writeHead(403).end();
          return;
        }
        response.setHeader("Access-Control-Allow-Origin", publicOrigin);
        response.setHeader("Vary", "Origin");
        if (request.url === "/api/v1/csp-stream") {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end("data: synthetic configured stream\n\n");
          return;
        }
        const result = await app.inject({ method: "GET", url: request.url });
        response.writeHead(result.statusCode, result.headers).end(result.body);
      } catch (error) {
        failures.push(String(error));
        response.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      api!.once("error", reject);
      api!.listen(0, "127.0.0.1", resolve);
    });
    const apiOrigin = `https://127.0.0.1:${(api.address() as AddressInfo).port}`;
    const apiBase = `${apiOrigin}/api/v1`;
    const built = await buildConfiguredApp(directory, apiBase);
    // Trust only this generated test certificate's public key in this owned browser.
    // No persistent identity, global TLS override or ignoreHTTPSErrors is used.
    browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${fingerprint}`] });
    for (const scenario of ["missing", "different"]) {
      const envDir = join(directory, `preview-${scenario}`);
      await mkdir(envDir);
      if (scenario === "different")
        await writeFile(
          join(envDir, ".env.production"),
          "VITE_PUBLIC_API_BASE=https://unconfigured.example.invalid/api/v1\n",
        );
      const server = await preview({
        root: webRoot,
        envDir,
        logLevel: "error",
        build: { outDir: built.outDir },
        preview: { host: "127.0.0.1", port: 0, strictPort: true },
      });
      publicOrigin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
      let context: BrowserContext | undefined;
      const caseErrors: unknown[] = [];
      try {
        context = await browser.newContext();
        expect(server.config.env.VITE_PUBLIC_API_BASE).toBe(
          scenario === "missing" ? undefined : "https://unconfigured.example.invalid/api/v1",
        );
        await context.addCookies([
          { name: "synthetic-credentials-must-be-omitted", value: "test-only", url: apiOrigin, secure: true },
        ]);
        const page = await context.newPage();
        let escapedRequests = 0;
        await page.route("https://unconfigured.example.invalid/**", (route) => {
          escapedRequests++;
          return route.abort();
        });
        const start = observations.length;
        const response = await page.goto(`${publicOrigin}/leaderboards?ui=api`);
        expect(response?.headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
        await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
          "content",
          documentPolicyForApiBase(apiBase),
        );
        await expect(page.getByRole("status").filter({ hasText: "98 of 98" })).toBeVisible();
        await page.getByRole("searchbox", { name: "Search definitions" }).fill("cspconfiguredapi");
        await page.getByRole("button", { name: "Search measures", exact: true }).click();
        await expect(page.getByRole("status").filter({ hasText: "1 of 98" })).toBeVisible();
        const message = await page.evaluate(
          (base) =>
            new Promise<string>((resolve, reject) => {
              const stream = new EventSource(`${base}/csp-stream`, { withCredentials: false });
              const timer = setTimeout(() => {
                stream.close();
                reject(new Error("Configured event stream timed out"));
              }, 5_000);
              stream.onmessage = (event) => {
                clearTimeout(timer);
                stream.close();
                resolve(event.data);
              };
              stream.onerror = () => {
                clearTimeout(timer);
                stream.close();
                reject(new Error("Configured event stream failed"));
              };
            }),
          apiBase,
        );
        expect(message).toBe("synthetic configured stream");
        const blocked = await page.evaluate(async () => {
          const violations: string[] = [];
          const record = (event: SecurityPolicyViolationEvent) => violations.push(event.effectiveDirective);
          document.addEventListener("securitypolicyviolation", record);
          let rejected = false;
          try {
            await fetch("https://unconfigured.example.invalid/api/v1/metrics");
          } catch {
            rejected = true;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
          document.removeEventListener("securitypolicyviolation", record);
          return { rejected, violations };
        });
        expect(blocked.rejected).toBe(true);
        expect(blocked.violations).toContain("connect-src");
        expect(escapedRequests).toBe(0);
        const calls = observations.slice(start);
        expect(calls.some((call) => call.path.startsWith("/api/v1/metrics"))).toBe(true);
        expect(calls.some((call) => call.path === "/api/v1/csp-stream")).toBe(true);
        expect(calls.every((call) => call.origin === publicOrigin && !call.cookie && !call.authorization)).toBe(true);
        expect(failures).toEqual([]);
      } catch (error) {
        caseErrors.push(error);
      } finally {
        caseErrors.push(
          ...(await cleanUp([
            async () => {
              await context?.close();
            },
            () =>
              new Promise<void>((resolve, reject) => {
                if ("closeAllConnections" in server.httpServer) server.httpServer.closeAllConnections();
                server.httpServer.close((error) => (error ? reject(error) : resolve()));
              }),
          ])),
        );
      }
      if (caseErrors.length) throw new AggregateError(caseErrors, `Configured API scenario ${scenario} failed`);
    }
  } catch (error) {
    errors.push(error);
  } finally {
    errors.push(
      ...(await cleanUp([
        async () => {
          await browser?.close();
        },
        async () => {
          if (api?.listening)
            await new Promise<void>((resolve, reject) => {
              api!.closeAllConnections();
              api!.close((error) => (error ? reject(error) : resolve()));
            });
        },
        () => app.close(),
        () => rm(directory, { recursive: true, force: true }),
      ])),
    );
  }
  if (errors.length) throw new AggregateError(errors, "Configured API browser verification failed");
});
