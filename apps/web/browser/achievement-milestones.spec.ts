import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.use({ storageState: { cookies: [], origins: [] } });
const profile = "/contributors/alex?ui=api&snapshot=synthetic-milestones&repository=synthetic-repo";

async function service(page: Page, extraPeers = 0) {
  const { createService } = await import(new URL("../../service/dist/app.js", import.meta.url).href);
  const { milestoneFixture } = await import(
    new URL("../../service/test/fixtures/achievement-milestones.mjs", import.meta.url).href
  );
  const current = milestoneFixture();
  for (let index = 0; index < extraPeers; index++) {
    const id = "peer-" + String(index).padStart(2, "0");
    const actor = structuredClone(current.selected.actors[1]);
    actor.actorId = id;
    actor.actor.githubNodeId = "synthetic-" + id;
    actor.actor.login = "synthetic-" + id;
    actor.actor.displayName = "Synthetic " + id;
    current.selected.actors.push(actor);
    const entry = structuredClone(current.selected.portfolioEvidence[1]);
    entry.contribution.actorId = id;
    entry.contribution.contributionId = id + "-authored";
    entry.contribution.canonicalEventId = "event-" + id;
    current.selected.portfolioEvidence.push(entry);
    const { activityState: _activity, observedAt: _observed, ...proof } = entry;
    current.selected.evidence.push(proof);
    for (const row of current.selected.rows.filter((row: { actorId: string }) => row.actorId === "bea"))
      current.selected.rows.push({
        ...structuredClone(row),
        actorId: id,
        evidenceIds: [entry.contribution.contributionId],
      });
  }
  const requests: { category: string | null; cursor: string | null }[] = [];
  let paused: { category: string; wait: Promise<void>; release: () => void; seen: number; finished: number } | null =
    null;
  const app = createService({
    approvedAchievementRuleVersion: "accepted-evidence/v2",
    cursorSecret: "synthetic-browser-milestone-cursor-000000",
    source: {
      read: async (scope: unknown) => ({
        ...structuredClone(current),
        selected: { ...structuredClone(current.selected), scope },
      }),
    },
  });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const isAchievement = url.pathname.endsWith("/achievements");
    if (isAchievement)
      requests.push({ category: url.searchParams.get("category"), cursor: url.searchParams.get("cursor") });
    const response = await app.inject({ method: "GET", url: url.pathname + url.search });
    const hold = paused;
    if (isAchievement && hold?.category === url.searchParams.get("category")) {
      hold.seen++;
      await hold.wait;
    }
    await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
    if (isAchievement && hold?.category === url.searchParams.get("category")) hold.finished++;
  });
  return {
    current,
    requests,
    close: () => app.close(),
    pauseCategory: (category: string) => {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      paused = { category, wait, release, seen: 0, finished: 0 };
      return release;
    },
    pausedCount: () => paused?.seen ?? 0,
    finishedCount: () => paused?.finished ?? 0,
  };
}

test("real v2 milestones expose exact category proof and bounded keyboard-accessible shared-artifact pages", async ({
  page,
}) => {
  const api = await service(page, 20);
  try {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(profile + "&category=documentation");
    const recognition = page.getByRole("region", { name: "Sharing and accepted achievements" });
    const shared = page.getByRole("region", { name: "Accepted work on shared artifacts" });
    await expect(recognition.getByRole("heading", { name: /^First accepted contribution in category:/ })).toBeVisible();
    await expect(recognition.getByRole("heading", { name: "First accepted review in available scope" })).toHaveCount(0);
    await expect(shared.getByText("21 links in the visible evidence for this selection. Page 1.")).toBeVisible();
    await expect(shared.getByRole("heading", { level: 4 })).toHaveCount(20);
    expect(api.requests.every((entry) => entry.category === "documentation")).toBe(true);
    const next = recognition.getByRole("button", { name: "Next shared-artifact page" });
    await next.focus();
    await page.keyboard.press("Enter");
    const heading = shared.getByRole("heading", { name: "Accepted work on shared artifacts" });
    await expect(heading).toBeFocused();
    await expect(shared.getByText("21 links in the visible evidence for this selection. Page 2.")).toBeVisible();
    await expect(shared.getByRole("heading", { level: 4 })).toHaveCount(1);
    await expect(shared.getByRole("link", { name: "Synthetic peer-19", exact: true })).toBeVisible();
    const peer = shared.getByRole("link", { name: "Synthetic peer-19", exact: true });
    await expect(peer).toHaveAttribute("href", /snapshot=synthetic-milestones.*category=documentation/);
    const peerHref = (await peer.getAttribute("href"))!;
    expect(new URL(peerHref, page.url()).searchParams.has("cursor")).toBe(false);
    const violations = await new AxeBuilder({ page }).include('[aria-labelledby="recognition-title"]').analyze();
    expect(violations.violations).toEqual([]);
    expect(await recognition.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    const proof = shared.getByRole("link", { name: "Inspect peer contribution" });
    await expect(proof).toHaveAttribute("href", /\/contributions\/peer-19-authored\?.*snapshot=synthetic-milestones/);
    await proof.click();
    await expect(page.getByRole("heading", { name: "Contribution evidence", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe("synthetic-milestones");
    expect(new URL(page.url()).searchParams.get("repository")).toBe("synthetic-repo");
    await expect(page.getByText("peer-19-authored", { exact: true })).toBeVisible();
    await page.goto(peerHref);
    await expect(page.getByRole("heading", { name: "Contributor portfolio", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Synthetic peer-19", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("snapshot")).toBe("synthetic-milestones");
    expect(new URL(page.url()).searchParams.get("category")).toBe("documentation");
  } finally {
    await api.close();
  }
});

test("a changed current peer invalidates the old page and the keyboard restart reads the current projection", async ({
  page,
}) => {
  const api = await service(page, 20);
  try {
    await page.goto(profile);
    const recognition = page.getByRole("region", { name: "Sharing and accepted achievements" });
    await expect(recognition.getByRole("link", { name: "Synthetic bea", exact: true })).toBeVisible();
    api.current.controls.suppressedActorIds = ["bea"];
    await recognition.getByRole("button", { name: "Next shared-artifact page" }).click();
    const error = recognition.getByText(/Achievements are unavailable.*Restart the shared-artifact list/);
    await expect(error).toBeVisible();
    await expect(error).toBeFocused();
    await expect(recognition.getByRole("link", { name: "Shared public artifact" })).toHaveCount(0);
    await expect(recognition.getByRole("link", { name: "Qualifying public artifact" })).toHaveCount(0);
    const restart = recognition.getByRole("button", { name: "Restart shared-artifact list" });
    await restart.focus();
    await page.keyboard.press("Enter");
    await expect(recognition.getByRole("heading", { name: "Accepted work on shared artifacts" })).toBeFocused();
    await expect(recognition.getByText("22 links in the visible evidence for this selection. Page 1.")).toBeVisible();
    await expect(recognition.getByRole("link", { name: "Synthetic bea", exact: true })).toHaveCount(0);
    expect(api.current.controls.version).toBe("synthetic-controls-1");
  } finally {
    await api.close();
  }
});

test("same-scope refresh preserves focused peer links, then incomplete history and current suppression remove only eligible output", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await page.clock.install();
    await page.goto(profile);
    const recognition = page.getByRole("region", { name: "Sharing and accepted achievements" });
    const peer = recognition.getByRole("link", { name: "Synthetic bea", exact: true });
    await expect(peer).toBeVisible();
    await peer.focus();
    const before = api.requests.length;
    await page.clock.fastForward(30_001);
    await expect.poll(() => api.requests.length).toBeGreaterThan(before);
    await expect(peer).toBeFocused();
    api.current.selected.snapshot.coverage[0].state = "partial";
    await page.clock.fastForward(30_001);
    await expect(recognition.getByRole("link", { name: "Qualifying public artifact" })).toHaveCount(0);
    await expect(recognition.getByText("3 links in the visible evidence for this selection. Page 1.")).toBeVisible();
    api.current.controls.suppressedActorIds = ["bea"];
    await page.clock.fastForward(30_001);
    await expect(peer).toHaveCount(0);
    await expect(recognition.getByText("2 links in the visible evidence for this selection. Page 1.")).toBeVisible();
    api.current.controls.revokedSnapshotIds = ["synthetic-milestones"];
    await page.clock.fastForward(30_001);
    await expect(page.getByRole("link", { name: "Shared public artifact" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Qualifying public artifact" })).toHaveCount(0);
  } finally {
    await api.close();
  }
});

test("an older category response cannot restore its milestones or peers after the selection changes", async ({
  page,
}) => {
  const api = await service(page);
  const release = api.pauseCategory("documentation");
  try {
    await page.goto(profile + "&category=documentation");
    await expect.poll(() => api.pausedCount()).toBe(1);
    await page.evaluate((url) => {
      history.pushState(null, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, profile + "&category=prs_reviewed");
    const recognition = page.getByRole("region", { name: "Sharing and accepted achievements" });
    await expect(recognition.getByRole("heading", { name: "First accepted review in available scope" })).toBeVisible();
    await expect(recognition.getByText("0 links in the visible evidence for this selection. Page 1.")).toBeVisible();
    release();
    await expect.poll(() => api.finishedCount()).toBe(1);
    await expect(recognition.getByRole("link", { name: "Synthetic bea", exact: true })).toHaveCount(0);
    await expect(recognition.getByRole("heading", { name: /^First accepted contribution in category:/ })).toHaveCount(
      1,
    );
    expect(api.requests.map((request) => request.category)).toEqual(["documentation", "prs_reviewed"]);
    expect(new URL(page.url()).searchParams.get("category")).toBe("prs_reviewed");
  } finally {
    release();
    await api.close();
  }
});
