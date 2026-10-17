import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

// Load real TSX through the app's compiler so these checks cover rendered hrefs.
test("primary navigation and evidence links retain the selected scope and snapshot", async () => {
  const server = await createServer({
    configFile: "apps/web/vite.config.ts",
    server: { middlewareMode: true },
    appType: "custom",
  });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const search =
    "?period=90d&repo=syn-repo-leaderboard&project=syn-proj-web&actor=all&snapshot=syn-r41&density=compact&q=code&proof=synthetic-aster";
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { pathname: "/leaderboards/pr_merged", search } },
  });
  try {
    const { RouterProvider } = await server.ssrLoadModule("/apps/web/src/lib/router.tsx");
    const { Layout } = await server.ssrLoadModule("/apps/web/src/components/Layout.tsx");
    const { PersonName, ReceiptRow } = await server.ssrLoadModule("/apps/web/src/components/Receipt.tsx");
    const { people, contributions } = await server.ssrLoadModule("/apps/web/src/data/synthetic.ts");
    const body = React.createElement(Layout, {
      title: "Review",
      children: [
        React.createElement(PersonName, { key: "person", person: people[0] }),
        React.createElement(ReceiptRow, { key: "receipt", record: contributions[0] }),
      ],
    });
    const html = renderToStaticMarkup(React.createElement(RouterProvider, null, body));
    for (const path of [
      "/",
      "/leaderboards",
      "/contributors",
      "/activity",
      "/methodology",
      "/coverage",
      "/live",
      "/contributors/synthetic-aster",
      "/contributions/syn-c-001",
    ]) {
      const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = html.match(new RegExp(`href="(${escapedPath}\\?[^" ]*)"`));
      assert.ok(match, `missing scoped link to ${path}`);
      const url = new URL(match[1]!.replaceAll("&amp;", "&"), "https://prototype.example");
      for (const name of ["period", "repo", "project", "actor", "snapshot", "density"])
        assert.equal(url.searchParams.get(name), new URLSearchParams(search).get(name));
      assert.equal(url.searchParams.has("q"), false);
      assert.equal(url.searchParams.has("proof"), false);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
    await server.close();
  }
});
