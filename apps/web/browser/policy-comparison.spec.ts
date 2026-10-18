import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test.use({ storageState: { cookies: [], origins: [] } });

for (const replacement of ["edit", "session reload"] as const) {
  test(`a delayed authority denial after ${replacement} applies only to its current session`, async ({ page }) => {
    const api = await service(page);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    try {
      await selectInput(page, api);
      await page.route("**/controls/policy-comparisons", async (route) => {
        started();
        await pending;
        await route.fulfill({ status: 403, json: { error: "denied" } });
      });
      await page.getByRole("button", { name: "Compare candidate policy", exact: true }).click();
      await requested;
      if (replacement === "edit") {
        await page
          .getByLabel("Complete candidate policy JSON")
          .fill(JSON.stringify({ ...api.candidate, version: "synthetic-preview/v3" }));
      } else {
        await page.getByRole("button", { name: "Reload receipts" }).click();
        await expect(page.getByRole("button", { name: "Load retained policy inputs" })).toBeVisible();
      }
      const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/controls/policy-comparisons");
      release();
      await response;
      if (replacement === "edit") {
        await expect(page.getByRole("heading", { name: "Private policy comparison" })).toHaveCount(0);
        await expect(
          page.getByText("Your reviewer authority or session changed. Reload your account before continuing."),
        ).toBeVisible();
      } else {
        await expect(page.getByRole("heading", { name: "Private policy comparison" })).toBeVisible();
        await expect(
          page.getByText("Your reviewer authority or session changed. Reload your account before continuing."),
        ).toHaveCount(0);
      }
    } finally {
      release?.();
      await api.close();
    }
  });
}

async function service(page: Page, roles = ["reviewer"]) {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { ControlStore } = await import(new URL("../../controls/src/store.mjs", import.meta.url).href);
  const { createControlsServer } = await import(new URL("../../controls/src/server.mjs", import.meta.url).href);
  const { PolicyComparisonStore } = await import(
    new URL("../../controls/src/policy-comparison.mjs", import.meta.url).href
  );
  const { privatePolicyFixture } = await import(
    new URL("../../../tests/fixtures/private-policy-preview.mjs", import.meta.url).href
  );
  const metrics = await import(new URL("../../../packages/metrics/dist/index.js", import.meta.url).href);
  const directory = await mkdtemp(join(tmpdir(), "synthetic-policy-browser-"));
  const store = new ControlStore(join(directory, "controls.sqlite"));
  const comparisons = new PolicyComparisonStore(store, metrics);
  const fixture = privatePolicyFixture();
  fixture.policies[0].unit = metrics.getMetricDefinition("issues_opened").definition.unit;
  const retained = store.transaction((s: any) => comparisons.capture(s, fixture));
  const candidate = { ...fixture.policies[0], version: "synthetic-preview/v2", groupBy: "canonical" };
  const token = "a".repeat(43),
    csrf = "b".repeat(43);
  let currentRoles = roles,
    roleVersion = "1";
  store.transaction((s: any) => {
    s.sessions[createHash("sha256").update(token).digest("base64url")] = {
      actorId: "201",
      csrf,
      roles,
      roleVersion,
      expires: Date.now() + 600000,
    };
  });
  const server = createControlsServer({
    store,
    origin: "https://controls.example.test",
    provider: {
      exchange() {
        throw Error("Unused synthetic OAuth");
      },
      authorizationURL() {
        throw Error("Unused synthetic OAuth");
      },
    },
    rolesForActor: () => ({ roles: currentRoles, version: roleVersion }),
    policyComparisons: {
      comparisons,
      withAuthorizedInputs: async (_: unknown, work: any) =>
        work([], { refreshApproval: async () => true, isCurrent: () => true }),
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const writes: string[] = [];
  await page.route("**/controls/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === "POST") writes.push(path);
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: request.method(),
      headers: {
        cookie: `__Host-controls_session=${token}`,
        origin: "https://controls.example.test",
        ...(request.method() === "POST"
          ? { "content-type": "application/json", "x-csrf-token": request.headers()["x-csrf-token"] ?? "" }
          : {}),
      },
      ...(request.method() === "POST" ? { body: request.postData() } : {}),
    });
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
  return {
    inputId: retained.inputId,
    candidate,
    writes,
    suppress() {
      store.transaction((s: any) => {
        s.profiles["101"] = { suppressed: true };
      });
    },
    revoke() {
      currentRoles = [];
      roleVersion = "2";
    },
    async close() {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await new Promise<void>((r) => server.close(r));
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function selectInput(page: Page, api: Awaited<ReturnType<typeof service>>) {
  await page.goto("/admin");
  await page.getByRole("button", { name: "Load retained policy inputs" }).click();
  await page.getByRole("combobox", { name: "Frozen input", exact: true }).selectOption(api.inputId);
  await page.getByLabel("Complete candidate policy JSON").fill(JSON.stringify(api.candidate));
}
test("reviewer compares actual frozen engine input, rereads current privacy, and never changes public policy", async ({
  page,
}) => {
  const api = await service(page);
  try {
    await page.setViewportSize({ width: 360, height: 900 });
    await selectInput(page, api);
    await page.getByRole("button", { name: "Compare candidate policy", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Candidate preview result" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "1 → 2", exact: true })).toBeVisible();
    await expect(page.getByText("Private preview confirmed. Public rankings have not changed.")).toBeVisible();
    await expect(page.getByRole("button", { name: /activate|approve policy/i })).toHaveCount(0);
    expect(api.writes).toEqual(["/controls/policy-comparisons"]);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    api.suppress();
    await page.getByRole("button", { name: "Recheck saved comparison" }).click();
    await expect(
      page.getByText(
        "Current privacy restrictions removed evidence. Affected rows and all comparison ranks are withheld.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("cell", { name: "1 → 2", exact: true })).toHaveCount(0);
    await expect(page.getByText("0 visible changed contributors.", { exact: false })).toBeVisible();
  } finally {
    await api.close();
  }
});
test("operator-only accounts cannot access the comparison panel", async ({ page }) => {
  const api = await service(page, ["operator"]);
  try {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Review queue" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Private policy comparison" })).toHaveCount(0);
  } finally {
    await api.close();
  }
});
test("server-side reviewer revocation clears all retained preview input and editor state", async ({ page }) => {
  const api = await service(page);
  try {
    await selectInput(page, api);
    api.revoke();
    await page.getByRole("button", { name: "Compare candidate policy", exact: true }).click();
    await expect(
      page.getByText("Your reviewer authority or session changed. Reload your account before continuing."),
    ).toBeVisible();
    await expect(page.getByLabel("Complete candidate policy JSON")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Candidate preview result" })).toHaveCount(0);
  } finally {
    await api.close();
  }
});
test("hidden tabs discard pending private previews and do not restore them after account reload", async ({ page }) => {
  const api = await service(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  try {
    await selectInput(page, api);
    await page.route("**/controls/policy-comparisons", async (route) => {
      started();
      await pending;
      await route.fallback();
    });
    await page.getByRole("button", { name: "Compare candidate policy", exact: true }).click();
    await requested;
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    release();
    await expect(page.getByLabel("Complete candidate policy JSON")).toHaveCount(0);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByRole("button", { name: "Load retained policy inputs" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Candidate preview result" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Frozen input", exact: true })).toHaveCount(0);
  } finally {
    release?.();
    await api.close();
  }
});
test("editing candidate input while a request is pending discards the previous candidate's response", async ({
  page,
}) => {
  const api = await service(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  try {
    await selectInput(page, api);
    await page.route("**/controls/policy-comparisons", async (route) => {
      started();
      await pending;
      await route.fallback();
    });
    await page.getByRole("button", { name: "Compare candidate policy", exact: true }).click();
    await requested;
    await page
      .getByLabel("Complete candidate policy JSON")
      .fill(JSON.stringify({ ...api.candidate, version: "synthetic-preview/v3" }));
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/controls/policy-comparisons");
    release();
    await response;
    await expect(page.getByRole("heading", { name: "Candidate preview result" })).toHaveCount(0);
    await expect(page.getByLabel("Complete candidate policy JSON")).toHaveValue(/synthetic-preview\/v3/);
  } finally {
    release?.();
    await api.close();
  }
});
