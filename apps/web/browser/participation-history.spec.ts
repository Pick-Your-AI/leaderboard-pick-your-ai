import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.use({ storageState: { cookies: [], origins: [] } });
const profile =
  "/contributors/101?ui=api&snapshot=synthetic-history-selected&repository=2&start=2026-10-01T00:00:00.000Z&end=2026-10-18T00:00:00.000Z";
const first = "2026-02-01T00:00:00.000000001Z";
type Hold = {
  kind: "history" | "proof";
  category: string | null;
  wait: Promise<void>;
  release: () => void;
  seen: number;
  finished: number;
};

async function service(page: Page, capability = true) {
  const { createService } = await import(new URL("../../service/dist/app.js", import.meta.url).href);
  const { participationHistorySource } = await import(
    new URL("../../../tests/fixtures/participation-history.mjs", import.meta.url).href
  );
  const input = participationHistorySource();
  const app = createService({ source: capability ? input.source : { read: input.source.read } });
  const requests: { url: URL; status: number }[] = [];
  let hold: Hold | null = null;
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const response = await app.inject({ method: "GET", url: url.pathname + url.search });
    requests.push({ url, status: response.statusCode });
    const kind = url.pathname.endsWith("/participation-history")
      ? "history"
      : url.pathname.includes("/participation-history/")
        ? "proof"
        : null;
    const waiting =
      hold?.kind === kind && hold.category === url.searchParams.get("category") && hold.seen === 0 ? hold : null;
    if (waiting) {
      waiting.seen++;
      await waiting.wait;
    }
    await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
    if (waiting) waiting.finished++;
  });
  return {
    state: input.state,
    requests,
    historyCalls: () => requests.filter((entry) => entry.url.pathname.endsWith("/participation-history")).length,
    pause: (kind: Hold["kind"], category: string | null = null) => {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = { kind, category, wait, release, seen: 0, finished: 0 };
      return hold;
    },
    close: async () => {
      hold?.release();
      await page.unrouteAll({ behavior: "wait" });
      await app.close();
    },
  };
}

test("reviewed full history exposes an out-of-scope first proof through a fresh keyboard-accessible route", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(profile + "&category=pr_merged&role=author");
    const history = page.getByRole("region", { name: "Reviewed organization history", exact: true });
    await expect(history.getByText(/falls outside the selected start-inclusive, end-exclusive period/)).toBeVisible();
    await expect(history.locator(`time[datetime="${first}"]`)).toBeVisible();
    await history.getByText("Required history sources and qualifying policies", { exact: true }).click();
    await expect(history.getByText("Repository 3; github_rest.", { exact: true })).toBeVisible();
    const inspect = history.getByRole("button", { name: "Inspect first proof", exact: true });
    await inspect.focus();
    await page.keyboard.press("Enter");
    const proof = history.getByRole("region", { name: "First qualifying proof", exact: true });
    await expect(proof.getByRole("heading", { name: "First qualifying proof", exact: true })).toBeFocused();
    await expect(proof.getByText("synthetic-earlier-review", { exact: true })).toBeVisible();
    await expect(proof.getByText('"synthetic-opaque:synthetic-earlier-review=="', { exact: true })).toBeVisible();
    await expect(proof.getByRole("link", { name: "Open the public first-proof source" })).toHaveAttribute(
      "href",
      "https://github.com/synthetic-history/repository-3/pull/3",
    );
    const requested = api.requests.filter((entry) => entry.url.pathname.includes("/participation-history/"));
    expect(requested).toHaveLength(1);
    expect(requested[0]!.url.pathname).toMatch(
      /\/participation-history\/[a-f0-9]{64}\/evidence\/synthetic-earlier-review$/,
    );
    for (const [key, value] of [
      ["category", "pr_merged"],
      ["role", "author"],
      ["repository", "2"],
      ["snapshot", "synthetic-history-selected"],
    ])
      expect(requested[0]!.url.searchParams.get(key!)).toBe(value);
    expect(
      (await new AxeBuilder({ page }).include('[aria-labelledby="organization-history-title"]').analyze()).violations,
    ).toEqual([]);
    expect(await history.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await proof.getByRole("link", { name: "Open the public first-proof source" }).focus();
    await page.keyboard.press("Escape");
    await expect(proof).toHaveCount(0);
    await expect(inspect).toBeFocused();
    expect(new URL(page.url()).searchParams.get("category")).toBe("pr_merged");
  } finally {
    await api.close();
  }
});

test("an ordinary provider retains unknown history and an all-time admitted read has no newcomer denominator", async ({
  page,
}) => {
  const api = await service(page, false);
  try {
    await page.goto(profile);
    const history = page.getByRole("region", { name: "Reviewed organization history", exact: true });
    await expect(
      history.getByText(/First qualifying contribution is unknown.*unavailable from this provider/),
    ).toBeVisible();
    await expect(history.getByRole("button", { name: "Inspect first proof" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Participation in this snapshot", exact: true })).toBeVisible();
    expect(api.state.calls).toBe(0);
  } finally {
    await api.close();
  }
  const admitted = await service(page);
  try {
    await page.goto("/contributors/101?ui=api&snapshot=synthetic-history-selected");
    const history = page.getByRole("region", { name: "Reviewed organization history", exact: true });
    await expect(
      history.getByText("The all-time selection has no completed-period newcomer assessment.", { exact: true }),
    ).toBeVisible();
    await expect(history.getByText(/falls within|falls outside/)).toHaveCount(0);
    await expect(history.getByRole("button", { name: "Inspect first proof" })).toBeVisible();
  } finally {
    await admitted.close();
  }
});

test("same-key refresh retains proof focus while a history-only replacement retires the open proof", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await page.clock.install();
    await page.goto(profile);
    const history = page.getByRole("region", { name: "Reviewed organization history", exact: true });
    await history.getByRole("button", { name: "Inspect first proof" }).click();
    const source = history.getByRole("link", { name: "Open the public first-proof source" });
    await expect(source).toBeVisible();
    await source.focus();
    const before = api.historyCalls();
    await page.clock.fastForward(30_001);
    await expect.poll(api.historyCalls).toBeGreaterThan(before);
    await expect(source).toBeFocused();
    api.state.pair.history.dataset.backfillRevision = "synthetic-history-only-replacement";
    await page.clock.fastForward(30_001);
    await expect(history.getByRole("region", { name: "First qualifying proof" })).toHaveCount(0);
    await expect(history.getByRole("heading", { name: "Reviewed organization history", exact: true })).toBeFocused();
    await expect(history.getByRole("button", { name: "Inspect first proof" })).toBeVisible();
    expect(api.state.pair.current.controls.version).toBe("synthetic-controls-1");
  } finally {
    await api.close();
  }
});

test("current artifact withdrawal withholds the old first-proof key and keyboard retry shows unknown history", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await page.goto(profile);
    const history = page.getByRole("region", { name: "Reviewed organization history", exact: true });
    const inspect = history.getByRole("button", { name: "Inspect first proof" });
    await expect(inspect).toBeVisible();
    const id = api.state.pair.history.publication.selected.portfolioEvidence[0].artifact.stableId;
    api.state.pair.current.controls.suppressedArtifactIds = [id];
    api.state.pair.history.publication.controls.suppressedArtifactIds = [id];
    await inspect.focus();
    await page.keyboard.press("Enter");
    const error = history.getByText(
      "Organization history is unavailable or changed. Previous first-proof details have been cleared.",
      { exact: true },
    );
    await expect(error).toBeFocused();
    await expect(history.getByRole("link", { name: "Open the public first-proof source" })).toHaveCount(0);
    expect(
      api.requests.some((entry) => entry.url.pathname.includes("/participation-history/") && entry.status === 409),
    ).toBe(true);
    await history.getByRole("button", { name: "Check organization history again" }).focus();
    await page.keyboard.press("Enter");
    await expect(history.getByText(/First qualifying contribution is unknown.*current visibility/)).toBeVisible();
    await expect(history.getByRole("heading", { name: "Reviewed organization history", exact: true })).toBeFocused();
    await expect(history.getByText("synthetic-earlier-review", { exact: true })).toHaveCount(0);
    await expect(history.getByRole("button", { name: "Inspect first proof" })).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("a held parent refresh cannot restore history after a newer first-proof denial", async ({ page }) => {
  const api = await service(page);
  try {
    await page.clock.install();
    await page.goto(profile);
    const history = page.getByRole("region", { name: "Reviewed organization history", exact: true });
    const inspect = history.getByRole("button", { name: "Inspect first proof", exact: true });
    await expect(inspect).toBeVisible();
    await expect(history.locator(`time[datetime="${first}"]`)).toBeVisible();

    // The handler has already authorized and produced this same-selection 200.
    // Hold only its transport while the existing known state remains inspectable.
    const held = api.pause("history");
    await page.clock.fastForward(30_001);
    await expect.poll(() => held.seen).toBe(1);
    expect(api.requests.filter((entry) => entry.url.pathname.endsWith("/participation-history")).at(-1)).toMatchObject({
      status: 200,
    });
    await expect(inspect).toBeVisible();

    const id = api.state.pair.history.publication.selected.portfolioEvidence[0].artifact.stableId;
    api.state.pair.current.controls.suppressedArtifactIds = [id];
    api.state.pair.history.publication.controls.suppressedArtifactIds = [id];
    await inspect.focus();
    await page.keyboard.press("Enter");
    const error = history.getByText(
      "Organization history is unavailable or changed. Previous first-proof details have been cleared.",
      { exact: true },
    );
    await expect(error).toBeFocused();
    expect(
      api.requests.some((entry) => entry.url.pathname.includes("/participation-history/") && entry.status === 409),
    ).toBe(true);

    held.release();
    await expect.poll(() => held.finished).toBe(1);
    await expect(error).toBeFocused();
    await expect(history.locator(`time[datetime="${first}"]`)).toHaveCount(0);
    await expect(inspect).toHaveCount(0);
    await expect(history.getByRole("region", { name: "First qualifying proof", exact: true })).toHaveCount(0);
    await expect(history.getByRole("link", { name: "Open the public first-proof source" })).toHaveCount(0);

    const beforeRetry = api.historyCalls();
    await history.getByRole("button", { name: "Check organization history again" }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(api.historyCalls).toBeGreaterThan(beforeRetry);
    await expect(history.getByText(/First qualifying contribution is unknown.*current visibility/)).toBeVisible();
    await expect(history.getByRole("heading", { name: "Reviewed organization history", exact: true })).toBeFocused();
    await expect(history.locator(`time[datetime="${first}"]`)).toHaveCount(0);
    await expect(inspect).toHaveCount(0);
    await expect(history.getByRole("link", { name: "Open the public first-proof source" })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe("synthetic-history-selected");
  } finally {
    await api.close();
  }
});

test("an older selected history response cannot restore a known first proof after protected admission changes", async ({
  page,
}) => {
  const api = await service(page);
  const held = api.pause("history", "pr_merged");
  try {
    await page.goto(profile + "&category=pr_merged");
    await expect.poll(() => held.seen).toBe(1);
    api.state.authorized = false;
    await page.evaluate((url) => {
      history.pushState(null, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, profile + "&category=prs_reviewed");
    const region = page.getByRole("region", { name: "Reviewed organization history", exact: true });
    await expect(
      region.getByText(/First qualifying contribution is unknown.*unavailable from this provider/),
    ).toBeVisible();
    held.release();
    await expect.poll(() => held.finished).toBe(1);
    await expect(region.getByRole("button", { name: "Inspect first proof" })).toHaveCount(0);
    await expect(region.locator(`time[datetime="${first}"]`)).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("category")).toBe("prs_reviewed");
  } finally {
    held.release();
    await api.close();
  }
});

test("closing a paused first-proof read prevents its late response from restoring source details", async ({ page }) => {
  const api = await service(page),
    held = api.pause("proof");
  try {
    await page.goto(profile);
    const history = page.getByRole("region", { name: "Reviewed organization history", exact: true });
    await history.getByRole("button", { name: "Inspect first proof" }).click();
    await expect.poll(() => held.seen).toBe(1);
    await history.getByRole("button", { name: "Close first proof" }).click();
    held.release();
    await expect.poll(() => held.finished).toBe(1);
    await expect(history.getByRole("region", { name: "First qualifying proof" })).toHaveCount(0);
    await expect(history.getByRole("link", { name: "Open the public first-proof source" })).toHaveCount(0);
    await expect(history.getByRole("button", { name: "Inspect first proof" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(history.getByRole("link", { name: "Open the public first-proof source" })).toBeVisible();
  } finally {
    held.release();
    await api.close();
  }
});
