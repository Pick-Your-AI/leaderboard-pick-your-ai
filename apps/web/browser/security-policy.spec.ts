import { test, expect } from "@playwright/test";

test("built public document enforces CSP while the application renders", async ({ page }) => {
  const response = await page.goto("/?ui=prototype");
  expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
  await expect(page.getByRole("navigation", { name: "Primary", exact: true })).toBeVisible();
  await expect(page.locator(".startup-fallback")).toHaveCount(0);
  const meta = page.locator('meta[http-equiv="Content-Security-Policy"]');
  await expect(meta).toHaveAttribute("content", /script-src 'self'/);
  expect(
    await page.evaluate(() => {
      const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      const script = document.querySelector("script");
      return Boolean(policy && script && policy.compareDocumentPosition(script) & Node.DOCUMENT_POSITION_FOLLOWING);
    }),
  ).toBe(true);

  let escapedRequests = 0;
  await page.route("https://attacker.invalid/**", (route) => {
    escapedRequests++;
    return route.abort();
  });
  const result = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (event) => violations.push(event.effectiveDirective));
    const script = document.createElement("script");
    script.textContent = "document.documentElement.dataset.injected = 'executed'";
    document.body.append(script);
    const button = document.createElement("button");
    button.setAttribute("onclick", "document.documentElement.dataset.injected = 'executed'");
    document.body.append(button);
    button.click();
    const image = document.createElement("img");
    image.src = "https://attacker.invalid/avatar.svg";
    document.body.append(image);
    let blockedFetch = false;
    try {
      await fetch("https://attacker.invalid/private");
    } catch {
      blockedFetch = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    script.remove();
    button.remove();
    image.remove();
    return { injected: document.documentElement.dataset.injected ?? null, blockedFetch, violations };
  });
  expect(result.injected).toBeNull();
  expect(result.blockedFetch).toBe(true);
  expect(result.violations).toEqual(
    expect.arrayContaining(["script-src-elem", "script-src-attr", "img-src", "connect-src"]),
  );
  expect(escapedRequests).toBe(0);
});
