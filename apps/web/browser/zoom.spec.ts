import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { evidenceService } from "./evidenceHarness.ts";
import { nativeZoom, noPageOverflow, zoomContext } from "./nativeZoom.ts";

async function capture(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(name);
  // Native browser zoom changes the CSS/device-pixel ratio outside Playwright's
  // viewport emulation. Capture the actual visible surface without a CSS clip.
  const session = await page.context().newCDPSession(page);
  try {
    const { data } = await session.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const png = Buffer.from(data, "base64");
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, ratio: devicePixelRatio }));
    expect(Math.abs(png.readUInt32BE(16) - viewport.width * viewport.ratio)).toBeLessThanOrEqual(1);
    expect(Math.abs(png.readUInt32BE(20) - viewport.height * viewport.ratio)).toBeLessThanOrEqual(viewport.ratio);
    await writeFile(path, png);
  } finally {
    await session.detach();
  }
  await info.attach(name, { path, contentType: "image/png" });
}

for (const factor of [2, 4]) {
  test(`${factor * 100}% native browser zoom preserves scoped controls, proof navigation and font fallback`, async ({
    baseURL,
    launchOptions,
  }, info) => {
    test.setTimeout(120_000);
    const context = await zoomContext(baseURL!, launchOptions);
    let api: Awaited<ReturnType<typeof evidenceService>> | undefined;
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const errors: string[] = [];
      const fontRequests: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await context.route("**/*", (route) => {
        if (route.request().resourceType() === "font") {
          fontRequests.push(route.request().url());
          return route.abort();
        }
        return route.fallback();
      });
      api = await evidenceService(page);
      api.withMetadata(false);
      const observations = [];
      for (const media of [
        { name: "light", colorScheme: "light", forcedColors: "none" },
        { name: "dark", colorScheme: "dark", forcedColors: "none" },
        { name: "forced-colors", colorScheme: "light", forcedColors: "active" },
      ] as const) {
        await page.emulateMedia({ colorScheme: media.colorScheme, forcedColors: media.forcedColors });
        await page.goto("/leaderboards/pr_merged?ui=api&snapshot=api-1&repository=repo-1&limit=1");
        const opener = page.getByRole("link", { name: "e-api-a", exact: true });
        await expect(opener).toBeVisible();
        const receipt = await nativeZoom(context, page, factor);
        observations.push({ media: media.name, ...receipt });
        expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(
          media.forcedColors === "active",
        );
        expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(
          media.colorScheme === "dark",
        );
        await noPageOverflow(page);
        const scope = page.locator("summary").filter({ hasText: "Exact scope and snapshot" });
        await scope.focus();
        await page.keyboard.press("Enter");
        await page.getByRole("textbox", { name: "workstream", exact: true }).fill("triage");
        await page.getByRole("textbox", { name: "start", exact: true }).fill("2026-10-01T00:00:00.000Z");
        await page.getByRole("textbox", { name: "end", exact: true }).fill("2026-11-01T00:00:00.000Z");
        await noPageOverflow(page);
        const submit = page.getByRole("button", { name: "Read exact scope" });
        await submit.focus();
        await page.keyboard.press("Enter");
        await expect(opener).toBeVisible();
        for (const [key, value] of Object.entries({
          snapshot: "api-1",
          repository: "repo-1",
          workstream: "triage",
          start: "2026-10-01T00:00:00.000Z",
          end: "2026-11-01T00:00:00.000Z",
        })) {
          expect(new URL(page.url()).searchParams.get(key)).toBe(value);
        }
        await opener.focus();
        await capture(page, info, `api-board-${media.name}-${factor * 100}.png`);
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", { name: "Contribution evidence" });
        await expect(dialog).toHaveAttribute("aria-modal", "true");
        await expect(dialog.locator("[data-proof-projection]")).toBeVisible();
        await expect(dialog.getByRole("heading", { name: "Contribution evidence", exact: true })).toBeFocused();
        expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        await page.keyboard.press("Shift+Tab");
        const permanent = dialog.getByRole("link", { name: "Open as a full page" });
        await expect(permanent).toBeFocused();
        await expect(permanent).toBeInViewport();
        await page.keyboard.press("Tab");
        const close = dialog.getByRole("button", { name: "Close evidence panel" });
        await expect(close).toBeFocused();
        await expect(close).toBeInViewport();
        const source = dialog.getByRole("link", { name: "Open public source artifact" });
        await source.focus();
        await expect(source).toBeInViewport();
        await noPageOverflow(page);
        await capture(page, info, `api-proof-${media.name}-${factor * 100}.png`);
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(opener).toBeFocused();
        await opener.press("Enter");
        await expect(permanent).toBeVisible();
        await permanent.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("heading", { level: 1, name: "Contribution evidence" })).toBeFocused();
        await expect(page.locator("[data-proof-projection]")).toBeVisible();
        await noPageOverflow(page);
        await nativeZoom(context, page, factor);
        await page.goBack();
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(opener).toBeFocused();

        await page.goto("/leaderboards/pr_merged?ui=prototype&snapshot=syn-r44-rebuilding");
        const snapshot = page.getByRole("combobox", { name: "Snapshot", exact: true });
        await expect(snapshot).toHaveValue("syn-r44-rebuilding");
        await expect(page.locator(".loading")).toHaveCount(0);
        await nativeZoom(context, page, factor);
        await noPageOverflow(page);
        await snapshot.focus();
        await capture(page, info, `prototype-scope-${media.name}-${factor * 100}.png`);
        await snapshot.selectOption("syn-r42");
        const proof = page.locator(".proof-link").first();
        await expect(proof).toBeVisible();
        await proof.focus();
        await page.keyboard.press("Enter");
        const prototypeDialog = page.getByRole("dialog");
        await expect(page.locator("#drawer-title")).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(prototypeDialog.getByRole("link", { name: "Open as a full page" })).toBeFocused();
        await expect(prototypeDialog.getByRole("link", { name: "Open as a full page" })).toBeInViewport();
        await noPageOverflow(page);
        await capture(page, info, `prototype-proof-${media.name}-${factor * 100}.png`);
        await page.keyboard.press("Escape");
        await expect(prototypeDialog).toHaveCount(0);
        await expect(proof).toBeFocused();
      }
      expect(errors).toEqual([]);
      const receiptPath = info.outputPath("native-zoom-observations.json");
      await writeFile(
        receiptPath,
        JSON.stringify(
          { browser: context.browser()?.version(), observations, blockedFontRequests: fontRequests },
          null,
          2,
        ),
      );
      await info.attach("native-zoom-observations.json", { path: receiptPath, contentType: "application/json" });
    } finally {
      try {
        await api?.close();
      } finally {
        await context.close();
      }
    }
  });
}
