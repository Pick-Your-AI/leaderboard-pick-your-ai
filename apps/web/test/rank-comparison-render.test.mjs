import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const source = new URL("../src/remote/RankComparison.tsx", import.meta.url);
const require = createRequire(source);
const transformed = await transformWithOxc(await readFile(source, "utf8"), fileURLToPath(source), {
  jsx: { runtime: "automatic" },
});
const compiled = transformed.code.replace(/from "([^"]+)"/g, (_match, specifier) => {
  const url = specifier.startsWith(".") ? new URL(specifier, source) : pathToFileURL(require.resolve(specifier));
  return `from ${JSON.stringify(url.href)}`;
});
const { RankMovementValue } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const render = (value) => renderToStaticMarkup(React.createElement(RankMovementValue, { value }));

for (const reason of ["constructor", "future_compatible_machine_code"]) {
  test(`unknown rank reason ${reason} uses the unavailable explanation`, () => {
    const value = { actorId: "synthetic-actor", state: "unavailable", delta: null, reason };
    const before = structuredClone(value);
    assert.equal(render(value), `Unavailable: The service cannot establish compatible history (${reason}).`);
    assert.deepEqual(value, before);
  });
}

test("known rank unavailability retains its specific explanation", () => {
  assert.equal(
    render({
      actorId: "synthetic-actor",
      state: "unavailable",
      delta: null,
      reason: "comparison_unavailable",
    }),
    "Unavailable: The baseline is missing, expired, revoked or unavailable.",
  );
});

test("comparable, entrant and absent movement keep their distinct display states", () => {
  for (const [delta, text] of [
    [0, "Rank unchanged"],
    [1, "Up 1 rank"],
    [-2, "Down 2 ranks"],
  ]) {
    assert.equal(render({ actorId: "synthetic-actor", state: "comparable", delta, reason: null }), text);
  }
  assert.equal(
    render({ actorId: "synthetic-actor", state: "new_entrant", delta: null, reason: null }),
    "New entrant; no previous rank",
  );
  assert.equal(render(undefined), "Comparison unavailable");
});
