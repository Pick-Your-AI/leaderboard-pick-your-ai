import { chromium, expect, type BrowserContext, type LaunchOptions, type Page, type Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";

type ZoomAPI = {
  tabs: {
    query(input: { url: string }): Promise<{ id?: number; url?: string }[]>;
    setZoomSettings(id: number, settings: { mode: "automatic"; scope: "per-origin" }): Promise<void>;
    setZoom(id: number, factor: number): Promise<void>;
    getZoom(id: number): Promise<number>;
    getZoomSettings(id: number): Promise<{ mode: string; scope: string }>;
  };
};

// A fresh persistent Chromium profile is required for the test-only extension.
// The normal headless shell cannot load extensions. The chromium channel uses
// the pinned full browser, including when CI runs without a display server.
export async function zoomContext(baseURL: string, options: LaunchOptions) {
  const extension = fileURLToPath(new URL("./zoom-extension", import.meta.url));
  const context = await chromium.launchPersistentContext("", {
    ...options,
    channel: "chromium",
    headless: true,
    viewport: null,
    baseURL,
    args: [
      ...(options.args ?? []),
      "--window-size=1280,960",
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  context.setDefaultTimeout(10_000);
  return context;
}

export async function nativeZoom(context: BrowserContext, page: Page, factor: number) {
  const extensionWorker = (worker: Worker) => worker.url().startsWith("chrome-extension://");
  const worker =
    context.serviceWorkers().find(extensionWorker) ??
    (await context.waitForEvent("serviceworker", { predicate: extensionWorker, timeout: 10_000 }));
  const actual = await worker.evaluate(
    async ({ url, factor }) => {
      const api = (globalThis as unknown as { chrome: ZoomAPI }).chrome;
      const matches = (await api.tabs.query({ url: "http://127.0.0.1/*" })).filter((tab) => tab.url === url);
      if (matches.length !== 1 || matches[0]?.id === undefined) throw Error("Expected exactly one owned local page");
      const id = matches[0].id;
      await api.tabs.setZoomSettings(id, { mode: "automatic", scope: "per-origin" });
      await api.tabs.setZoom(id, factor);
      return { factor: await api.tabs.getZoom(id), settings: await api.tabs.getZoomSettings(id) };
    },
    { url: page.url(), factor },
  );
  expect(actual.factor).toBeCloseTo(factor, 6);
  expect(actual.settings).toMatchObject({ mode: "automatic", scope: "per-origin" });
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(Math.round(1280 / factor));
  const metrics = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    devicePixelRatio,
    visualScale: visualViewport?.scale,
    rootZoom: getComputedStyle(document.documentElement).zoom,
    bodyZoom: getComputedStyle(document.body).zoom,
  }));
  expect(metrics.devicePixelRatio).toBeCloseTo(factor, 6);
  expect(metrics.visualScale).toBe(1);
  expect(metrics.rootZoom).toBe("1");
  expect(metrics.bodyZoom).toBe("1");
  return { ...actual, ...metrics };
}

export async function noPageOverflow(page: Page) {
  const bounds = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
    controls: [...document.querySelectorAll("button, input:not([type=hidden]), select, summary")]
      .filter((element) => element.getClientRects().length > 0 && !element.closest(".table-region"))
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.left < -1 || box.right > document.documentElement.clientWidth + 1;
      })
      .map((element) => ({ tag: element.tagName, text: element.textContent, name: element.getAttribute("name") })),
  }));
  expect(bounds.width, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.viewport + 1);
  expect(bounds.controls, JSON.stringify(bounds)).toEqual([]);
}
