import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

type InputMode = "keyboard" | "touch";
type Action = { target: string; input: string; from: string; to: string };

async function walkthrough(page: Page, info: TestInfo, mode: InputMode, controlledClock = false) {
  const actions: Action[] = [];
  // Reach controls through the browser's actual tab order; never focus them by script.
  async function reach(target: Locator) {
    await expect(target).toBeVisible();
    if (mode === "touch") {
      await target.tap();
      return "touch tap";
    }
    let tabs = 0;
    while (!(await target.evaluate((element) => element === document.activeElement)) && tabs < 160) {
      await page.keyboard.press("Tab");
      tabs++;
    }
    await expect(target).toBeFocused();
    return `${tabs} Tab key presses`;
  }
  async function activate(target: Locator) {
    const from = page.url();
    const label = (await target.getAttribute("aria-label")) ?? (await target.innerText());
    const input = await reach(target);
    if (mode === "keyboard") await page.keyboard.press("Enter");
    if (controlledClock) await page.clock.runFor(200);
    actions.push({ target: label, input: mode === "keyboard" ? `${input}, Enter` : input, from, to: page.url() });
  }
  async function guide(label: string) {
    if (new URL(page.url()).pathname !== "/prototype") {
      await activate(page.getByRole("link", { name: "What this prototype shows", exact: true }));
    }
    await expect(page.getByRole("heading", { level: 1, name: "Prototype guide" })).toBeVisible();
    await activate(page.getByRole("main").getByRole("link", { name: label, exact: true }));
  }
  async function capture(name: string) {
    const path = info.outputPath(`${name}.png`);
    await page.screenshot({ path, fullPage: false });
    await info.attach(name, { path, contentType: "image/png" });
  }
  async function finish() {
    const capabilities = await page.evaluate(() => ({
      viewport: { width: innerWidth, height: innerHeight },
      maxTouchPoints: navigator.maxTouchPoints,
      coarsePointer: matchMedia("(pointer: coarse)").matches,
    }));
    expect(actions.length).toBeGreaterThan(0);
    if (mode === "touch") expect(capabilities.maxTouchPoints).toBeGreaterThan(0);
    await info.attach("walkthrough-receipt", {
      body: JSON.stringify(
        {
          journey: info.title,
          mode,
          capabilities,
          controlledClock,
          actions,
          finalUrl: page.url(),
          scope: "Synthetic prototype, browser keyboard or emulated mobile touch; no participant or physical device.",
          boundaries:
            "Reserved synthetic source URLs are inspected but never fetched. Touch text entry uses browser keyboard events after a tap. Native date/select popups and an operating-system virtual keyboard are outside these journeys. The live journey explicitly advances synthetic publication/page timers; it is not a duration or production-soak result.",
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  }
  await page.goto("/prototype?ui=prototype");
  if (controlledClock) await page.clock.runFor(200);
  await expect(page.getByRole("complementary", { name: "Synthetic data notice" })).toBeVisible();
  return { activate, reach, guide, capture, finish, actions };
}

async function fixture(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Fixture explanation:");
  return dialog;
}

for (const mode of ["keyboard", "touch"] as const) {
  test.describe(`${mode} primary prototype walkthrough`, () => {
    test.use({
      viewport: mode === "touch" ? { width: 360, height: 900 } : { width: 1280, height: 900 },
      hasTouch: mode === "touch",
      isMobile: mode === "touch",
    });

    test("overview to metric to contributor to source evidence", async ({ page }, info) => {
      const journey = await walkthrough(page, info, mode);
      await journey.guide("Overview");
      await journey.activate(page.getByRole("link", { name: "PRs merged", exact: true }));
      const row = page.locator(".board-table tbody tr").filter({ hasText: "Aster (synthetic)" });
      await journey.activate(row.locator('td[data-label="Ranked value"] a'));
      const dialog = await fixture(page);
      await journey.activate(dialog.getByRole("link", { name: "Open as a full page", exact: true }));
      await expect(page.getByRole("heading", { level: 1, name: "Aster (synthetic)" })).toBeVisible();
      await journey.activate(page.locator('section[aria-labelledby="first-observed"] a'));
      await expect(page.getByText("Fixture explanation", { exact: true })).toBeVisible();
      const source = page.getByRole("link", { name: /^Synthetic source link/ });
      await expect(source).toHaveAttribute("href", /^https:\/\/synthetic\.example\//);
      await source.scrollIntoViewIfNeeded();
      await journey.capture("source-explanation");
      await journey.finish();
    });

    test("newcomer discovery includes observed and pending contributions without a rank", async ({ page }, info) => {
      const journey = await walkthrough(page, info, mode);
      await journey.guide("First observed contributions on the overview");
      const newcomers = page.locator('section[aria-labelledby="first-heading"]');
      await expect(newcomers).toContainText("alphabetically and unranked");
      await journey.activate(newcomers.getByRole("link", { name: /^Gale \(synthetic\)/ }));
      await expect(page.getByRole("heading", { level: 1, name: "Gale (synthetic)" })).toBeVisible();
      await expect(page.getByText("Listed, not ranked", { exact: true }).first()).toBeVisible();
      await journey.activate(
        page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Contributors", exact: true }),
      );
      const search = page.getByRole("searchbox", { name: "Find a contributor" });
      const from = page.url();
      const input = await journey.reach(search);
      await page.keyboard.type("gale");
      journey.actions.push({
        target: "Find a contributor: gale",
        input: `${input}, keyboard text`,
        from,
        to: page.url(),
      });
      const entry = page.locator(".directory-entry");
      await expect(entry).toHaveCount(1);
      const count = entry.locator(".count-link");
      const records = Number((await count.innerText()).match(/^\d+/)![0]);
      await journey.activate(count);
      const dialog = await fixture(page);
      await expect(dialog.locator(".receipt-row")).toHaveCount(records);
      await expect(dialog).toContainText("This is not a rank or an overall score");
      await journey.capture("newcomer-explanation");
      await journey.finish();
    });

    test("triage proof exposes a corrected exclusion and its public correction history", async ({ page }, info) => {
      const journey = await walkthrough(page, info, mode);
      await journey.guide("Labels applied board");
      const row = page.locator(".board-table tbody tr").filter({ hasText: "Birch (synthetic)" });
      await journey.activate(row.locator('td[data-label="Ranked value"] a'));
      const dialog = await fixture(page);
      await journey.activate(dialog.getByRole("button", { name: "Close evidence panel", exact: true }));
      await expect(dialog).toHaveCount(0);
      await journey.activate(page.locator('section[aria-labelledby="excluded"] a').first());
      await expect(page.locator(".notice-title").filter({ hasText: /Corrected result$/ })).toBeVisible();
      await expect(page.getByText("Exclusion", { exact: true })).toBeVisible();
      await journey.guide("Corrections history");
      await expect(page.getByRole("heading", { level: 1, name: "Corrections" })).toBeVisible();
      await journey.activate(
        page.getByRole("link", { name: "Applied label: security (duplicate event)", exact: true }),
      );
      await expect(page.locator(".receipt")).toContainText("syn-cr-1");
      await page.locator(".receipt").getByText("Corrections", { exact: true }).scrollIntoViewIfNeeded();
      await journey.capture("correction-explanation");
      await journey.finish();
    });

    test("lines of change retain excluded categories in the contribution explanation", async ({ page }, info) => {
      const journey = await walkthrough(page, info, mode);
      await journey.guide("Lines changed, with excluded lockfile and vendor lines");
      const row = page.locator(".board-table tbody tr").first();
      await journey.activate(row.locator('td[data-label="Excluded lines"] a'));
      const dialog = await fixture(page);
      await journey.activate(dialog.locator(".receipt-row-main a").first());
      await expect(page.getByText("Lines changed", { exact: true })).toBeVisible();
      await expect(page.locator(".receipt")).toContainText(/excluded: generated \d+, vendor \d+, lockfile \d+/);
      await page.getByText("Lines changed", { exact: true }).scrollIntoViewIfNeeded();
      await journey.capture("lines-explanation");
      await journey.finish();
    });

    test("stale scope, input filters, held updates and the wall remain controllable", async ({ page }, info) => {
      await page.clock.install({ time: new Date("2026-10-18T12:00:00Z") });
      await page.clock.pauseAt(new Date("2026-10-18T12:01:00Z"));
      const journey = await walkthrough(page, info, mode, true);
      await journey.guide("Stale data and disconnected collector");
      await expect(page.locator(".notice-title").filter({ hasText: /Stale data$/ })).toBeVisible();
      const scope = page.getByRole("region", { name: "Scope", exact: true });
      const users = scope.getByRole("radio", { name: "User accounts", exact: true });
      const automation = scope.getByRole("radio", { name: "Automation", exact: true });
      const from = page.url();
      if (mode === "keyboard") {
        const input = await journey.reach(users);
        await page.keyboard.press("ArrowRight");
        journey.actions.push({ target: "Actors: Automation", input: `${input}, ArrowRight`, from, to: page.url() });
      } else await journey.activate(automation);
      await expect(automation).toBeChecked();
      await expect(page).toHaveURL(/actor=automation/);
      await expect(page.locator(".notice-title").filter({ hasText: /Stale data$/ })).toBeVisible();
      if (mode === "keyboard") {
        const from = page.url();
        await page.keyboard.press("ArrowLeft");
        journey.actions.push({ target: "Actors: User accounts", input: "ArrowLeft", from, to: page.url() });
      } else await journey.activate(users);
      await expect(users).toBeChecked();
      await journey.guide("Held update (publishes immediately with arrive=now)");
      await page.clock.runFor(20_200);
      await journey.activate(page.getByRole("button", { name: "Apply updates", exact: true }));
      await expect(page.getByRole("button", { name: "Apply updates", exact: true })).toHaveCount(0);
      await journey.guide("Wall configurator");
      await expect(page.getByRole("radio", { name: /^Cycling live boards/ })).toBeChecked();
      await journey.activate(page.getByRole("link", { name: "Open the wall", exact: true }));
      const heading = page.getByRole("heading", { level: 1 });
      await expect(heading).toBeVisible();
      const first = await heading.innerText();
      await journey.activate(page.getByRole("button", { name: "Pause", exact: true }));
      await expect(page.getByRole("button", { name: "Play", exact: true })).toHaveAttribute("aria-pressed", "true");
      await page.clock.runFor(60_000);
      await expect(heading).toHaveText(first);
      await journey.capture("paused-wall");
      await journey.activate(page.getByRole("button", { name: "Next", exact: true }));
      await expect(heading).not.toHaveText(first);
      await journey.activate(page.getByRole("link", { name: "Exit wall", exact: true }));
      await expect(page.getByRole("heading", { level: 1, name: "Live wall" })).toBeVisible();
      await journey.finish();
    });
  });
}
