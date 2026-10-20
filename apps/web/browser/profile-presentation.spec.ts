import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.use({ storageState: { cookies: [], origins: [] } });
const profile = "/contributors/101?ui=api&snapshot=synthetic-pending-1";
const bio = "Synthetic cafe\u0301 日本語 & plain text " + "x".repeat(450);
const links = [
  "https://github.com/synthetic/repo/issues/1#issuecomment-2",
  "https://github.com/synthetic/repo/issues/" + "2".repeat(100),
];
type Hold = { wait: Promise<void>; release: () => void; seen: number; finished: number; status: number | null };

async function service(page: Page) {
  const { createService } = await import(new URL("../../service/dist/app.js", import.meta.url).href);
  const { readFixture, at } = await import(new URL("../../../tests/fixtures/pending-metric.mjs", import.meta.url).href);
  const input = readFixture();
  for (const entry of input.selected.actors) entry.actor.githubDatabaseId = Number(entry.actorId);
  let optedIn = true,
    unavailable = false,
    hold: Hold | null = null;
  const requests: { path: string; method: string; status: number }[] = [];
  const read = async (scope: typeof input.selected.scope) => {
    if (unavailable) return null;
    const value = structuredClone(input);
    value.selected.scope = structuredClone(scope);
    return value;
  };
  const app = createService({
    now: () => Date.parse(at),
    source: {
      read,
      async readProfile(scope: typeof input.selected.scope, _pin: string | null, actorId: string) {
        const value = await read(scope);
        if (value !== null)
          value.presentation =
            actorId === "101" && optedIn
              ? {
                  schemaVersion: "public-profile-presentation/v1",
                  actorId,
                  bio,
                  highlights: [...links],
                }
              : null;
        return value;
      },
    },
  });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const response = await app.inject({ method: "GET", url: url.pathname + url.search });
    requests.push({ path: url.pathname, method: route.request().method(), status: response.statusCode });
    const waiting = hold && url.pathname === "/api/v1/contributors/101" && hold.seen === 0 ? hold : null;
    if (waiting) {
      waiting.seen++;
      waiting.status = response.statusCode;
      await waiting.wait;
    }
    await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
    if (waiting) waiting.finished++;
  });
  return {
    requests,
    calls: () => requests.filter((entry) => entry.path === "/api/v1/contributors/101").length,
    withdraw: (kind: "private" | "suppressed" | "source unavailable") => {
      input.controls.version = "synthetic-current-withdrawal";
      if (kind === "private") optedIn = false;
      else if (kind === "suppressed") input.controls.suppressedActorIds = ["101"];
      else unavailable = true;
    },
    pause: () => {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = { wait, release, seen: 0, finished: 0, status: null };
      return hold;
    },
    close: async () => {
      hold?.release();
      await page.unrouteAll({ behavior: "wait" });
      await app.close();
    },
  };
}

test("anonymous opted-in text remains plain, ordered and keyboard-accessible at a narrow viewport", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(profile);
    const region = page.getByRole("region", { name: "From this contributor", exact: true });
    await expect(region.getByText(bio, { exact: true })).toBeVisible();
    await expect(
      region.getByText("Contributor-provided links; these are not verified contribution evidence."),
    ).toBeVisible();
    await expect(region.getByRole("link")).toHaveText(links);
    for (let i = 0; i < links.length; i++) {
      await expect(region.getByRole("link").nth(i)).toHaveAttribute("href", links[i]!);
      await expect(region.getByRole("link").nth(i)).toHaveAttribute("rel", "noreferrer nofollow");
    }
    await region.getByRole("link").first().focus();
    await page.keyboard.press("Tab");
    await expect(region.getByRole("link").nth(1)).toBeFocused();
    expect(await region.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(
      (await new AxeBuilder({ page }).include('[aria-labelledby="contributor-presentation-title"]').analyze())
        .violations,
    ).toEqual([]);
    expect(await page.context().cookies()).toEqual([]);
    expect(api.requests.every((request) => request.method === "GET")).toBe(true);
    await expect(
      page.getByRole("heading", { name: "Independent category artifact counts", exact: true }),
    ).toBeVisible();
  } finally {
    await api.close();
  }
});

for (const denied of ["private", "suppressed", "source unavailable"] as const) {
  test(`current ${denied} clears optional text and links from a retained pinned profile`, async ({ page }) => {
    const api = await service(page);
    try {
      await page.clock.install();
      await page.goto(profile);
      const region = page.getByRole("region", { name: "From this contributor", exact: true });
      await expect(region).toBeVisible();
      const before = api.calls();
      api.withdraw(denied);
      await page.clock.fastForward(30_001);
      await expect.poll(api.calls).toBeGreaterThan(before);
      await expect(region).toHaveCount(0);
      await expect(page.getByText(bio, { exact: true })).toHaveCount(0);
      for (const link of links) await expect(page.getByRole("link", { name: link, exact: true })).toHaveCount(0);
      if (denied === "private")
        await expect(
          page.getByRole("heading", { name: "Independent category artifact counts", exact: true }),
        ).toBeVisible();
      expect(new URL(page.url()).searchParams.get("snapshot")).toBe("synthetic-pending-1");
    } finally {
      await api.close();
    }
  });
}

test("an old actor's held profile response cannot replace a newly selected contributor", async ({ page }) => {
  const api = await service(page);
  try {
    await page.clock.install();
    await page.goto(profile);
    await expect(page.getByRole("region", { name: "From this contributor", exact: true })).toBeVisible();
    const held = api.pause();
    await page.clock.fastForward(30_001);
    await expect.poll(() => held.seen).toBe(1);
    expect(held.status).toBe(200);
    await page.evaluate(() => {
      history.pushState(null, "", "/contributors/102?ui=api&snapshot=synthetic-pending-1");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByRole("heading", { name: "synthetic-pending-102", exact: true })).toBeVisible();
    held.release();
    await expect.poll(() => held.finished).toBe(1);
    await expect(page.getByRole("region", { name: "From this contributor", exact: true })).toHaveCount(0);
    await expect(page.getByText(bio, { exact: true })).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/contributors/102");
  } finally {
    await api.close();
  }
});

test("the existing hidden-document boundary clears optional text before a held response is released", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await page.clock.install();
    await page.goto(profile);
    await expect(page.getByRole("region", { name: "From this contributor", exact: true })).toBeVisible();
    const held = api.pause();
    await page.clock.fastForward(30_001);
    await expect.poll(() => held.seen).toBe(1);
    expect(held.status).toBe(200);
    // Exercise the document lifecycle handler, not physical background-tab scheduling.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByRole("region", { name: "From this contributor", exact: true })).toHaveCount(0);
    held.release();
    await expect.poll(() => held.finished).toBe(1);
    await expect(page.getByText(bio, { exact: true })).toHaveCount(0);
    api.withdraw("private");
    const before = api.calls();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(api.calls).toBeGreaterThan(before);
    await expect(
      page.getByRole("heading", { name: "Independent category artifact counts", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "From this contributor", exact: true })).toHaveCount(0);
  } finally {
    await api.close();
  }
});
