import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { evidenceService } from "./evidenceHarness.ts";

test.use({ storageState: { cookies: [], origins: [] } });
const board = "/leaderboards/pr_opened?ui=api&snapshot=api-1";

test("API drawer and permanent route have identical proof, retain cursor/scope and hold a new head", async ({
  page,
}) => {
  const api = await evidenceService(page);
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `${board}&repository=repo-1&workstream=triage&start=2026-10-01T00%3A00%3A00.000Z&end=2026-11-01T00%3A00%3A00.000Z&limit=1`,
    );
    await page.getByRole("link", { name: "Next cursor page" }).click();
    const background = new URL(page.url());
    const opener = page.getByRole("link", { name: "e-api-b", exact: true });
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Contribution evidence" });
    await expect(dialog).toHaveAttribute("aria-modal", "false");
    await expect(dialog.getByRole("heading", { name: "Contribution evidence", exact: true })).toBeFocused();
    await expect(dialog.locator("[data-proof-projection]")).toBeVisible();
    const projection = await dialog.locator("[data-proof-projection]").innerText();
    const source = dialog.getByRole("link", { name: "Open public source artifact" });
    await source.focus();
    api.next();
    const calls = api.calls.length;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => api.calls.length).toBeGreaterThan(calls);
    await expect(page.getByText("Rechecking…")).toHaveCount(0);
    await expect(source).toBeFocused();
    await expect(dialog.locator("[data-proof-projection]")).toHaveText(projection, { useInnerText: true });
    const fullPage = await dialog.getByRole("link", { name: "Open as a full page" }).getAttribute("href");
    await dialog.getByRole("button", { name: "Close evidence panel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(new URL(page.url()).searchParams.get("cursor")).toBe(background.searchParams.get("cursor"));
    await page.goForward();
    await expect(dialog.locator("[data-proof-projection]")).toBeVisible();
    await dialog.getByRole("link", { name: "Open as a full page" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Contribution evidence" })).toBeFocused();
    expect(new URL(page.url()).search).toBe(new URL(fullPage!, page.url()).search);
    expect(await page.locator("[data-proof-projection]").innerText()).toBe(projection);
    const proofs = api.calls.filter((call) => call.pathname.endsWith("/evidence/e-api-b"));
    expect(proofs.length).toBeGreaterThan(1);
    expect(
      proofs.every(
        (call) =>
          call.searchParams.get("snapshot") === "api-1" &&
          call.searchParams.get("repository") === "repo-1" &&
          call.searchParams.get("workstream") === "triage" &&
          call.searchParams.get("start") === "2026-10-01T00:00:00.000Z" &&
          call.searchParams.get("end") === "2026-11-01T00:00:00.000Z",
      ),
    ).toBe(true);
    await page.goBack();
    await expect(dialog.locator("[data-proof-projection]")).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Contribution evidence", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  } finally {
    await api.close();
  }
});

test("320px mobile proof is modal, traps keyboard, reflows, restores focus and handles Back/Forward", async ({
  page,
}) => {
  const api = await evidenceService(page);
  try {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(board);
    const opener = page.getByRole("link", { name: "e-api-a", exact: true });
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    const heading = dialog.getByRole("heading", { name: "Contribution evidence", exact: true });
    await expect(heading).toBeFocused();
    await expect(page.locator(".remote-app")).toHaveAttribute("inert", "");
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("link", { name: "Open as a full page" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close evidence panel" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("link", { name: "Open as a full page" })).toBeFocused();
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
    ).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(page.locator(".remote-app")).not.toHaveAttribute("inert", "");
    await opener.click();
    await expect(dialog).toBeVisible();
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await page.goForward();
    await expect(heading).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(dialog).toHaveAttribute("aria-modal", "false");
    await expect(page.locator(".remote-app")).not.toHaveAttribute("inert", "");
    await dialog.getByRole("button", { name: "Close evidence panel" }).click();
    await expect(opener).toBeFocused();
  } finally {
    await api.close();
  }
});

for (const withdrawal of ["suppress", "suppressArtifact", "revoke", "fail"] as const) {
  test(`pinned focused proof clears on ${withdrawal} and restores a stable heading when the opener disappears`, async ({
    page,
  }) => {
    const api = await evidenceService(page);
    try {
      await page.goto(board);
      await page.getByRole("link", { name: "e-api-a", exact: true }).click();
      const dialog = page.getByRole("dialog");
      const source = dialog.getByRole("link", { name: "Open public source artifact" });
      await expect(source).toBeVisible();
      await source.focus();
      api.next();
      api[withdrawal]();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(dialog.getByRole("alert")).toBeVisible();
      await expect(dialog.locator("[data-proof-projection]")).toHaveCount(0);
      await expect(source).toHaveCount(0);
      await expect(dialog).not.toContainText("SENSITIVE_SYNTHETIC_PROVIDER_FAILURE");
      await expect(dialog.getByRole("heading", { name: "Contribution evidence", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    } finally {
      await api.close();
    }
  });
}

test("API proof omits private reasons and keeps unknown times, titles, revisions and acceptance honest", async ({
  page,
}) => {
  const api = await evidenceService(page);
  api.unknownAndHostile();
  try {
    await page.goto(board);
    await page.getByRole("link", { name: "e-api-a", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("[data-evidence-body]")).toBeVisible();
    await expect(dialog.getByText('<img src=x onerror="window.proofInjected=true">', { exact: false })).toHaveCount(0);
    await expect(dialog.locator("img, script")).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, "proofInjected"))).toBeUndefined();
    await expect(dialog.getByText("Unknown; no event time is inferred", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Unknown collection time", { exact: true })).toBeVisible();
    await expect(
      dialog.getByText("Unknown; neither acceptance nor its time can be inferred", { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText("Not supplied by the public evidence API", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Public source link unavailable", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Revision source" })).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("deep linked unavailable source has no fabricated replacement and Close stays on its pinned board", async ({
  page,
}) => {
  const api = await evidenceService(page);
  api.unavailableSource();
  try {
    await page.goto(`${board}&proof=e-api-a`);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("alert")).toContainText("Public record unavailable");
    await expect(dialog.locator("[data-proof-projection]")).toHaveCount(0);
    await expect(dialog.getByRole("link", { name: "Open public source artifact" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close evidence panel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    expect(new URL(page.url()).pathname).toBe("/leaderboards/pr_opened");
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe("api-1");
    expect(new URL(page.url()).searchParams.has("proof")).toBe(false);
  } finally {
    await api.close();
  }
});

test("board suppression withdraws focused proof before a slower evidence recheck completes", async ({ page }) => {
  const api = await evidenceService(page);
  try {
    await page.goto(board);
    await page.getByRole("link", { name: "e-api-a", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("[data-proof-projection]")).toBeVisible();
    api.holdEvidenceReads();
    api.suppress();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(dialog.getByRole("alert")).toContainText("evidence_no_longer_in_displayed_count");
    await expect(dialog.locator("[data-proof-projection]")).toHaveCount(0);
    api.releaseEvidenceReads();
    await expect(dialog.locator("[data-proof-projection]")).toHaveCount(0);
  } finally {
    await api.close();
  }
});

for (const accepted of [false, true]) {
  test(`versioned ${accepted ? "accepted" : "observed"} metadata is literal and identical in drawer, permanent route and activity proof`, async ({
    page,
  }) => {
    const api = await evidenceService(page);
    try {
      api.withMetadata(accepted);
      await page.setViewportSize({ width: 320, height: 850 });
      await page.goto(board);
      await page.getByRole("link", { name: "e-api-a", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Contribution evidence" });
      await expect(dialog.locator("[data-evidence-body]")).toBeVisible();
      const receipt = await dialog.locator("[data-evidence-body]").innerText();
      expect(receipt).toContain('<img src=x onerror="window.proofInjected=true"> Collected title');
      expect(receipt).toContain("not an event-time title");
      expect(receipt).toContain(accepted ? "recognition accepted" : "artifact created");
      expect(receipt).toContain("Partial public history only");
      expect(receipt).toContain("Public correction");
      expect(receipt).toContain("Source revision abcdef");
      expect(receipt).toContain(accepted ? "2026-10-15T12:00:00.000Z" : "No acceptance time is supplied");
      await expect(dialog.locator("img, script")).toHaveCount(0);
      expect(await page.evaluate(() => (window as Window & { proofInjected?: boolean }).proofInjected)).toBeUndefined();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await dialog.getByRole("link", { name: "Open as a full page" }).click();
      await expect(page.locator("[data-evidence-body]")).toHaveText(receipt, { useInnerText: true });
      await page.goto("/activity?ui=api&snapshot=api-1");
      await page
        .locator("ol[aria-label='Public activity groups'] > li")
        .filter({ has: page.getByRole("link", { name: "Synthetic API A", exact: true }) })
        .getByRole("link", { name: /Explore .* source proofs/ })
        .click();
      await expect(page.locator("[data-evidence-body]").first()).toHaveText(receipt, { useInnerText: true });
      api.suppressArtifact();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.locator("[data-evidence-body]")).toHaveCount(0);
      await expect(page.getByText("Collected title", { exact: false })).toHaveCount(0);
    } finally {
      await api.close();
    }
  });
}
