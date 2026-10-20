import { test as base, expect, type Page } from "@playwright/test";
import { build } from "vite";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const configuredControls = "https://accounts.example.invalid/controls/";
const test = base.extend<{ controlsBase: string; configuredApp: string }>({
  controlsBase: [configuredControls, { option: true }],
  configuredApp: [
    async ({ controlsBase }, use) => {
      const directory = await mkdtemp(join(tmpdir(), "lb-correction-entry-"));
      try {
        await build({
          root: fileURLToPath(new URL("..", import.meta.url)),
          define: {
            "import.meta.env.VITE_PUBLIC_API_BASE": JSON.stringify("/api/v1"),
            "import.meta.env.VITE_PUBLIC_CONTROLS_BASE": JSON.stringify(controlsBase),
          },
          build: { outDir: directory, emptyOutDir: true },
          logLevel: "error",
        });
        await use(directory);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    { scope: "test" },
  ],
});
test.use({ storageState: { cookies: [], origins: [] } });

const failures = [
  { name: "unavailable", status: 503, body: '{"error":"public_read_unavailable"}', code: "public_read_unavailable" },
  { name: "malformed", status: 200, body: "{", code: "invalid_api_response" },
] as const;

async function fixture(page: Page, directory: string, failure: (typeof failures)[number] = failures[0]) {
  const origin = new URL(test.info().project.use.baseURL!).origin;
  const privateRequests: string[] = [];
  const errors: string[] = [];
  const apiCalls: Array<{ origin: string; path: string; method: string; cookie: string | undefined }> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const reads: Array<{
      credentials: RequestCredentials | undefined;
      cache: RequestCache | undefined;
      redirect: RequestRedirect | undefined;
    }> = [];
    Reflect.set(window, "syntheticCorrectionMetricReads", reads);
    const fetch = window.fetch.bind(window);
    window.fetch = (...args) => {
      const [input, init] = args;
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname === "/api/v1/metrics")
        reads.push({ credentials: init?.credentials, cache: init?.cache, redirect: init?.redirect });
      return fetch(...args);
    };
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    // No test follows account authentication or contacts an external host.
    if (url.origin !== origin || url.pathname.startsWith("/controls/")) {
      privateRequests.push(url.href);
      return route.abort();
    }
    const candidate = resolve(directory, "." + url.pathname);
    if (candidate !== directory && !candidate.startsWith(directory + sep)) return route.abort();
    const file = await stat(candidate)
      .then((entry) => (entry.isFile() ? candidate : null))
      .catch(() => null);
    const target = file ?? join(directory, "index.html");
    const types: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".woff2": "font/woff2",
    };
    await route.fulfill({
      contentType: types[extname(target)] ?? "application/octet-stream",
      body: await readFile(target),
    });
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    apiCalls.push({ origin: url.origin, path: url.pathname, method: request.method(), cookie: headers.cookie });
    const response = url.pathname === "/api/v1/metrics" ? failure : failures[0];
    await route.fulfill({ status: response.status, contentType: "application/json", body: response.body });
  });
  return {
    apiCalls,
    metricCalls: () => apiCalls.filter((call) => call.path === "/api/v1/metrics").length,
    async assertReadOnly() {
      expect(privateRequests).toEqual([]);
      expect(errors).toEqual([]);
      expect(apiCalls.every((call) => call.origin === origin && call.method === "GET" && !call.cookie)).toBe(true);
      const reads = await page.evaluate(() => Reflect.get(window, "syntheticCorrectionMetricReads"));
      for (const read of reads) {
        expect(read).toEqual({ credentials: "omit", cache: "no-store", redirect: "error" });
      }
      await expect(page.getByRole("button", { name: "Submit request", exact: true })).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: "Details", exact: true })).toHaveCount(0);
    },
    close: () => page.unrouteAll({ behavior: "wait" }),
  };
}
const accountLink = (page: Page) =>
  page.getByRole("link", { name: "Open configured account authentication", exact: true });

for (const failure of failures) {
  const title = "configured correction login remains reachable when public metrics are " + failure.name;
  test(title, async ({ page, configuredApp }) => {
    const api = await fixture(page, configuredApp, failure);
    try {
      await page.goto("/corrections?ui=api");
      await expect(page.getByRole("alert")).toContainText(failure.code);
      await expect(accountLink(page)).toBeVisible();
      await expect(accountLink(page)).toHaveAttribute("href", "https://accounts.example.invalid/controls/auth/login");
      await expect(
        page.getByText("No correction or private request is submitted here.", { exact: false }),
      ).toBeVisible();
      const calls = api.metricCalls();
      expect(calls).toBeGreaterThan(0);
      await page.getByRole("button", { name: "Retry this selection", exact: true }).click();
      await expect.poll(api.metricCalls).toBeGreaterThan(calls);
      await expect(page.getByRole("alert")).toContainText(failure.code);
      await expect(accountLink(page)).toBeVisible();
      await expect(page).toHaveURL(new URL("/corrections?ui=api", test.info().project.use.baseURL!).href);
      await api.assertReadOnly();
    } finally {
      await api.close();
    }
  });
}

const selectionTitle = "correction login does not clear an invalid public selection or start a public read";
test(selectionTitle, async ({ page, configuredApp }) => {
  const api = await fixture(page, configuredApp);
  try {
    await page.goto("/corrections?ui=api&actors=invalid");
    await expect(page.getByRole("alert")).toContainText("invalid_actor_filter");
    await expect(accountLink(page)).toBeVisible();
    await expect(accountLink(page)).toHaveAttribute("href", "https://accounts.example.invalid/controls/auth/login");
    expect(api.apiCalls).toEqual([]);
    await api.assertReadOnly();
  } finally {
    await api.close();
  }
});

for (const configuration of [
  {
    name: "invalid",
    value: "http://accounts.example.invalid/controls",
    message: "The configured contributor-controls URL is invalid.",
  },
  { name: "absent", value: "", message: "No protected contributor-controls endpoint is configured." },
]) {
  const title = "public metrics failure preserves the configuration diagnostic and no account link";
  test.describe(configuration.name + " correction account configuration", () => {
    test.use({ controlsBase: configuration.value });
    test(title, async ({ page, configuredApp }) => {
      const api = await fixture(page, configuredApp);
      try {
        await page.goto("/corrections?ui=api");
        await expect(page.getByRole("alert")).toContainText("public_read_unavailable");
        await expect(page.getByText(configuration.message, { exact: true })).toBeVisible();
        await expect(accountLink(page)).toHaveCount(0);
        expect(api.metricCalls()).toBeGreaterThan(0);
        await api.assertReadOnly();
      } finally {
        await api.close();
      }
    });
  });
}
