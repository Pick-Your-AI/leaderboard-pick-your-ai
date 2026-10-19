import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const receipt = "11111111-1111-1111-1111-111111111111";
async function account(page: Page) {
  const writes: string[] = [];
  await page.route("**/controls/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      writes.push(path);
      await route.fulfill({ json: { id: receipt, status: "pending", version: 1 } });
      return;
    }
    const responses: Record<string, unknown> = {
      "/controls/session": { actorId: "1", csrf: "a".repeat(43), roles: [], expires: Date.now() + 600000 },
      "/controls/profile": { bio: "Saved bio", highlights: [], public: false, suppressed: false },
      "/controls/requests": { requests: [] },
      "/controls/invitations": { invitations: [] },
      "/controls/spotlights/queue": { nominations: [] },
      "/controls/spotlight-rotation/queue": { schemaVersion: "editorial-dimensions/v1", records: [] },
    };
    await route.fulfill({ json: responses[path] ?? {} });
  });
  await page.goto("/account");
  await expect(page.getByLabel("Bio (up to 500 characters)")).toHaveValue("Saved bio");
  await page.getByLabel("Replace my optional profile with these values").check();
  return writes;
}

async function saveWithKeyboard(page: Page) {
  await page.getByRole("button", { name: "Save profile", exact: true }).focus();
  await page.keyboard.press("Enter");
}

test("keyboard profile save moves lost form focus to the verified service receipt", async ({ page }) => {
  const writes = await account(page);
  await saveWithKeyboard(page);
  const notice = page.getByRole("status").filter({ hasText: "Service confirmed" });
  await expect(notice).toContainText(receipt);
  await expect(notice).toBeFocused();
  expect(writes).toEqual(["/controls/profile"]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("keyboard mutation failure restores lost form focus and shows the actual error", async ({ page }) => {
  const writes = await account(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/controls/profile", async (route) => {
    if (route.request().method() === "GET") return route.fallback();
    await held;
    await route.fulfill({ status: 409, json: { error: "Receipt changed" } });
  });
  try {
    await saveWithKeyboard(page);
    const save = page.getByRole("button", { name: "Save profile", exact: true });
    await expect(save).toBeDisabled();
    release();
    const error = page.getByRole("alert");
    await expect(error).toContainText("Reload before trying again");
    await expect(save).toBeEnabled();
    await expect(save).toBeFocused();
    await expect(page.getByLabel("Bio (up to 500 characters)")).toHaveValue("Saved bio");
    await expect(page.getByText(/Service confirmed/)).toHaveCount(0);
    expect(writes).toEqual([]);
  } finally {
    release();
  }
});

test("a delayed mutation receipt preserves navigation focus deliberately moved by the reader", async ({ page }) => {
  await account(page);
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/controls/profile", async (route) => {
    if (route.request().method() === "GET") return route.fallback();
    started();
    await held;
    await route.fulfill({ json: { id: receipt, status: "pending", version: 1 } });
  });
  try {
    await saveWithKeyboard(page);
    await requested;
    const navigation = page.getByRole("link", { name: "Public leaderboard", exact: true });
    await navigation.focus();
    release();
    await expect(page.getByRole("status").filter({ hasText: "Service confirmed" })).toContainText(receipt);
    await expect(navigation).toBeFocused();
  } finally {
    release();
  }
});

test("a hidden mutation response cannot restore a receipt or move reopened account focus", async ({ page }) => {
  await account(page);
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/controls/profile", async (route) => {
    if (route.request().method() === "GET") return route.fallback();
    started();
    await held;
    await route.fulfill({ json: { id: receipt, status: "pending", version: 1 } });
  });
  try {
    await saveWithKeyboard(page);
    await requested;
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    release();
    await expect(page.getByLabel("Bio (up to 500 characters)")).toHaveCount(0);
    await expect(page.getByText(receipt)).toHaveCount(0);
    const navigation = page.getByRole("link", { name: "Public leaderboard", exact: true });
    await navigation.focus();
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByLabel("Bio (up to 500 characters)")).toHaveValue("Saved bio");
    await expect(page.getByText(/Service confirmed/)).toHaveCount(0);
    await expect(navigation).toBeFocused();
  } finally {
    release();
  }
});
