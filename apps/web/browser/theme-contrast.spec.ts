import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";
import { evidenceService } from "./evidenceHarness.ts";

const textTokens = [
  "--color-text",
  "--color-text-muted",
  "--color-link",
  "--state-observed",
  "--state-provisional",
  "--state-qualified",
  "--state-reviewed",
  "--state-excluded",
  "--state-not-measured",
  "--health-ok",
  "--health-warn",
  "--health-error",
];
const surfaces = ["--color-bg", "--color-surface", "--color-surface-sunken"];
function luminance(hex: string) {
  expect(hex).toMatch(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex.length === 4) hex = `#${[...hex.slice(1)].map((digit) => digit + digit).join("")}`;
  const [red, green, blue] = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}
function contrast(foreground: string, background: string) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

for (const colorScheme of ["light", "dark"] as const) {
  for (const preference of ["system", "light", "dark"] as const) {
    test(`${preference} theme with ${colorScheme} system colors preserves text contrast when more contrast is requested`, async ({
      page,
    }, info) => {
      const api = await evidenceService(page);
      try {
        await page.emulateMedia({ colorScheme, contrast: "no-preference", forcedColors: "none" });
        await page.goto("/leaderboards/pr_opened?ui=api&snapshot=api-1");
        await expect(page.getByRole("link", { name: "e-api-a", exact: true })).toBeVisible();
        await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption(preference);
        if (preference === "system") await expect(page.locator("html")).not.toHaveAttribute("data-theme");
        else await expect(page.locator("html")).toHaveAttribute("data-theme", preference);
        const read = () =>
          page.evaluate(
            (names) => {
              const style = getComputedStyle(document.documentElement);
              return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]));
            },
            [...textTokens, ...surfaces],
          );
        const ordinary = await read();
        await page.emulateMedia({ colorScheme, contrast: "more", forcedColors: "none" });
        const media = await page.evaluate(() => ({
          dark: matchMedia("(prefers-color-scheme: dark)").matches,
          light: matchMedia("(prefers-color-scheme: light)").matches,
          increasedContrast: matchMedia("(prefers-contrast: more)").matches,
          forcedColors: matchMedia("(forced-colors: active)").matches,
          effectiveColorScheme: getComputedStyle(document.documentElement).colorScheme,
        }));
        expect(media).toEqual({
          dark: colorScheme === "dark",
          light: colorScheme === "light",
          increasedContrast: true,
          forcedColors: false,
          effectiveColorScheme: preference === "system" ? colorScheme : preference,
        });
        const increased = await read();
        const pairs = surfaces.flatMap((surface) =>
          textTokens.map((foreground) => ({
            foreground,
            surface,
            ordinary: contrast(ordinary[foreground]!, ordinary[surface]!),
            increased: contrast(increased[foreground]!, increased[surface]!),
          })),
        );
        const receipt = info.outputPath("contrast-observations.json");
        await writeFile(
          receipt,
          JSON.stringify(
            {
              browserVersion: page.context().browser()?.version(),
              colorScheme,
              preference,
              media,
              ordinary,
              increased,
              pairs,
            },
            null,
            2,
          ),
        );
        await info.attach("contrast-observations.json", { path: receipt, contentType: "application/json" });
        const screenshot = info.outputPath("contrast-more.png");
        await page.screenshot({ path: screenshot });
        await info.attach("contrast-more.png", { path: screenshot, contentType: "image/png" });
        for (const pair of pairs) {
          expect.soft(pair.increased, JSON.stringify(pair)).toBeGreaterThanOrEqual(4.5);
          expect.soft(pair.increased + 0.000001, JSON.stringify(pair)).toBeGreaterThanOrEqual(pair.ordinary);
        }
        const result = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
        expect(result.violations).toEqual([]);
      } finally {
        await api.close();
      }
    });
  }
}
