import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `missing ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const tokens: Record<string, string> = {};
  for (const match of css.slice(open + 1, close).matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/gi)) tokens[match[1]!] = match[2]!;
  return tokens;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [r, g, b] = channels.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

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

for (const [name, selector] of [
  ["light", ":root {"],
  ["dark", ':root[data-theme="dark"]'],
] as const) {
  test(`${name} theme text tokens meet WCAG AA 4.5:1 on every surface`, () => {
    const tokens = { ...block(":root {"), ...block(selector) };
    for (const surface of ["--color-bg", "--color-surface", "--color-surface-sunken"]) {
      for (const text of textTokens) {
        const ratio = contrast(tokens[text]!, tokens[surface]!);
        assert.ok(ratio >= 4.5, `${name}: ${text} on ${surface} is ${ratio.toFixed(2)}:1`);
      }
    }
    assert.ok(contrast(tokens["--color-on-brand"]!, tokens["--color-brand"]!) >= 4.5, `${name}: on-brand`);
    assert.ok(contrast(tokens["--color-on-accent"]!, tokens["--color-accent"]!) >= 4.5, `${name}: on-accent`);
    for (const surface of ["--color-bg", "--color-surface"]) {
      assert.ok(contrast(tokens["--color-focus"]!, tokens[surface]!) >= 3, `${name}: focus ring on ${surface}`);
      assert.ok(contrast(tokens["--color-border-strong"]!, tokens[surface]!) >= 3, `${name}: control border on ${surface}`);
    }
  });
}

test("system dark tokens match the explicit dark theme", () => {
  assert.deepEqual(block(':root:not([data-theme="light"])'), block(':root[data-theme="dark"]'));
});

test("tokens record their website source revision", () => {
  assert.match(css, /c731bc451d227eac843750418b6de3c3377ea90b/);
  assert.doesNotMatch(css, /@import|url\(/, "tokens must not load remote styles or fonts");
});
