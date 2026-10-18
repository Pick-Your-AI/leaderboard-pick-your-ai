import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { expect, type Page } from "@playwright/test";
import { soakTest as test, cleanupOwned, compiledOutputs } from "./runtime.ts";
import { assertPageActors, CycleCoverage, fixturePages, responseKey } from "./monitor.ts";
import { WallCycleTracker } from "./assertions.ts";
import { WallIntent, type WallInterruption } from "./intent.ts";
import { requireSoakMidnightWindow } from "./midnight.ts";
import { scope, snapshot } from "../browser/wallFixture.ts";

const minutes = Number(process.env.WALL_SOAK_MINUTES ?? "480");
const full = minutes >= 480;
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const contributors = (page: Page) => page.locator('.api-wall-content a[href*="/contributors/"]');

test("real elapsed wall display, bounded resources and recovery", async ({ runtime }) => {
  const { page, context, browser, cdp, attempt, outputPath, failures } = runtime;
  const sourceStartedAt = new Date().toISOString();
  const input = {
    head: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    status: git("status", "--porcelain", "--untracked-files=no"),
  };
  if (full) assert.equal(input.status, "", "An acceptance-length run requires committed, clean tracked inputs");
  const built = await compiledOutputs();
  await writeFile(outputPath("build-inputs.json"), JSON.stringify({ attemptId: attempt.id, ...built }, null, 2) + "\n");
  const samplesPath = outputPath("samples.jsonl");
  const summaryPath = outputPath("summary.json");
  const eventsPath = outputPath("events.jsonl");
  const record = async (event: string, detail: unknown = null) =>
    appendFile(
      eventsPath,
      JSON.stringify({ attemptId: attempt.id, at: new Date().toISOString(), event, detail }) + "\n",
    );
  const checks: Record<string, boolean> = {};
  const cycles = new WallCycleTracker();
  const intent = new WallIntent();
  const counters = {
    requests: 0,
    bytes: 0,
    concurrent: 0,
    maxConcurrent: 0,
    networkAborts: 0,
    responses: {} as Record<string, number>,
  };
  let current = snapshot("wall-soak-1", 1, sourceStartedAt);
  const stages = [
    { heading: "PRs merged", actors: current.selected.rows.map((row) => row.actorId) },
    { heading: "Contributors in this scope", actors: current.selected.actors.map((entry) => entry.actorId) },
  ];
  let expectedPages = fixturePages(stages);
  const coverage = new CycleCoverage(expectedPages.keys());
  const history = new Map([[current.head.snapshotId, current]]);
  const controls = current.controls;
  let revision = 1,
    networkFailed = false,
    sourceFailed = false,
    publishEnabled = true;
  const background: { page: Page | null } = { page: null };
  let hiddenRequestCount = 0;
  let suppressedActor: string | null = null,
    suppressedAt = Infinity;
  let cursorPin = "",
    cursorFailuresBefore = 0;
  let revokedPin = "";
  const publish = () => {
    current = snapshot(`wall-soak-${++revision}`, revision, new Date().toISOString());
    // Republish the same accepted input values with a real source heartbeat;
    // neither heartbeat nor calendar rollover invents additional activity.
    for (const entry of current.selected.evidence) entry.occurredAt = sourceStartedAt;
    for (const entry of current.selected.portfolioEvidence) {
      entry.occurredAt = sourceStartedAt;
      entry.observedAt = sourceStartedAt;
    }
    current.controls = controls;
    history.set(current.head.snapshotId, current);
    while (history.size > 16) history.delete(history.keys().next().value!);
  };
  const module = new URL("../../service/dist/app.js", import.meta.url).href;
  const { createService } = await import(module);
  const app = createService({
    now: Date.now,
    cursorSecret: "synthetic-real-wall-soak-cursor-secret-0001",
    source: {
      async read(selected: typeof scope, pin: string | null) {
        if (sourceFailed) throw new Error("SYNTHETIC_WALL_SOAK_SOURCE_FAILURE");
        const chosen = pin ? history.get(pin) : current;
        if (!chosen) return null;
        const value = structuredClone(chosen);
        value.selected.scope = { ...selected };
        value.head = structuredClone(current.head);
        value.controls = structuredClone(controls);
        return value;
      },
    },
  });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    await page.route("**/api/v1/**", async (route) => {
      counters.requests++;
      counters.maxConcurrent = Math.max(counters.maxConcurrent, ++counters.concurrent);
      try {
        if (networkFailed) {
          counters.networkAborts++;
          await route.abort("internetdisconnected");
          return;
        }
        const url = new URL(route.request().url());
        const response = await app.inject({ method: "GET", url: url.pathname + url.search });
        counters.bytes += Buffer.byteLength(response.body);
        const code = responseKey(response);
        counters.responses[code] = (counters.responses[code] ?? 0) + 1;
        await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
      } catch (error) {
        failures.record("route", error);
      } finally {
        counters.concurrent--;
      }
    });
    page.on("pageerror", (error) => {
      failures.record("page", error);
    });
    heartbeat = setInterval(() => {
      if (!publishEnabled) return;
      try {
        publish();
      } catch (error) {
        failures.record("heartbeat", error);
      }
    }, 120_000);
    await cdp.send("Performance.enable");
    // Playwright's focus emulation can mask real tab backgrounding. Disable the
    // emulation and require the browser's actual visibilitychange behavior.
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    const completed: string[] = [];
    let start = 0,
      startedAt = "",
      elapsed = 0,
      sampleCount = 0;
    let baseline: { heap: number; nodeHeap: number; rss: number; nodes: number; listeners: number } | null = null;
    let maxRetainedGrowth = { heap: 0, nodeHeap: 0, rss: 0, nodes: 0, listeners: 0 };
    let lastCollection = -Infinity,
      lastProgress = -Infinity;
    let previousDay = "",
      previousZone = "",
      naturalRollover = false;
    const seen = new Set<string>();
    let unexpectedSince: number | null = null;
    let lastPage = "",
      lastPageChange = 0,
      wasAutomatic = false;
    let result = "failed",
      failure: string | null = null;
    const beginInterruption = async (kind: WallInterruption) => {
      const elapsed = performance.now() - start;
      const lease = intent.begin(kind, elapsed);
      coverage.reset();
      cycles.interrupt();
      wasAutomatic = false;
      await record("intent-begin", lease);
    };
    const endInterruption = async (kind: WallInterruption) => {
      const elapsed = performance.now() - start;
      intent.end(kind, elapsed);
      await record("intent-end", { kind, elapsedMilliseconds: elapsed });
    };
    const requireAutomatic = async () =>
      expect(page.locator(".api-wall-state")).toHaveText(/^Automatic page boundaries(?: ·.*)?$/, {
        timeout: 5_000,
      });
    const healthy = async () => {
      await expect(page.getByRole("alert")).toHaveCount(0, { timeout: 65_000 });
      await expect(contributors(page).first()).toBeVisible({ timeout: 65_000 });
    };
    const releaseReading = async () => {
      await page.getByRole("button", { name: "Recheck current publication controls" }).focus();
      await page.mouse.move(0, 0);
    };
    const pause = async (kind: "suppression" | "cursor" | "revocation") => {
      await requireAutomatic();
      await beginInterruption(kind);
      const button = page.getByRole("button", { name: "Pause wall", exact: true });
      await expect(button).toBeVisible();
      await button.click();
      await expect(page.locator(".api-wall-state")).toHaveText(/^Paused(?: ·.*)?$/);
    };
    const resume = async (kind: "suppression" | "cursor" | "revocation") => {
      const button = page.getByRole("button", { name: "Resume wall", exact: true });
      await expect(button).toBeVisible();
      await button.click();
      await releaseReading();
      await requireAutomatic();
      await endInterruption(kind);
    };
    const pin = async () => {
      const href = await contributors(page).first().getAttribute("href");
      assert(href, "A displayed page must provide a pinned contributor link");
      return new URL(href, "http://127.0.0.1").searchParams.get("snapshot")!;
    };
    const cursorFailures = () =>
      Object.entries(counters.responses)
        .filter(([key]) => key.includes("cursor_expired_refetch"))
        .reduce((sum, [, count]) => sum + count, 0);
    const measureResources = async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      const performanceMetrics = await cdp.send("Performance.getMetrics");
      const dom = await cdp.send("Memory.getDOMCounters");
      const node = process.memoryUsage();
      const resource = {
        heap: performanceMetrics.metrics.find((metric) => metric.name === "JSHeapUsedSize")!.value,
        nodeHeap: node.heapUsed,
        rss: node.rss,
        nodes: dom.nodes,
        listeners: dom.jsEventListeners,
      };
      baseline ??= resource;
      for (const key of Object.keys(maxRetainedGrowth) as (keyof typeof maxRetainedGrowth)[])
        maxRetainedGrowth[key] = Math.max(maxRetainedGrowth[key], resource[key] - baseline[key]);
      assert(maxRetainedGrowth.heap <= 64 * 1024 * 1024, "Retained renderer JS heap grew beyond 64 MiB");
      assert(maxRetainedGrowth.nodeHeap <= 128 * 1024 * 1024, "Test/API Node heap grew beyond 128 MiB");
      assert(maxRetainedGrowth.rss <= 256 * 1024 * 1024, "Test/API Node RSS grew beyond 256 MiB");
      assert(
        maxRetainedGrowth.nodes <= 1_000 && maxRetainedGrowth.listeners <= 200,
        "Retained DOM/listeners grew beyond the bounded page budget",
      );
      return resource;
    };
    const actions: { at: number; name: string; run: () => Promise<void> }[] = [
      {
        at: full ? 30 * 60_000 : 20_000,
        name: "network-loss",
        run: async () => {
          await beginInterruption("network");
          networkFailed = true;
        },
      },
      {
        at: full ? 30.6 * 60_000 : 50_000,
        name: "network-cleared-display",
        run: async () => {
          await expect(contributors(page)).toHaveCount(0);
          await expect(page.getByRole("alert")).toBeVisible();
          checks.networkCleared = true;
          networkFailed = false;
          await endInterruption("network");
        },
      },
      {
        at: full ? 31.5 * 60_000 : 85_000,
        name: "network-recovery",
        run: async () => {
          await healthy();
          checks.networkRecovered = true;
        },
      },
    ];
    if (full)
      actions.push(
        {
          at: 60 * 60_000,
          name: "source-exception",
          run: async () => {
            await beginInterruption("source");
            sourceFailed = true;
          },
        },
        {
          at: 61 * 60_000,
          name: "source-cleared-display",
          run: async () => {
            await expect(contributors(page)).toHaveCount(0);
            await expect(page.getByRole("alert")).toBeVisible();
            checks.sourceCleared = true;
            sourceFailed = false;
            await endInterruption("source");
          },
        },
        {
          at: 61.5 * 60_000,
          name: "source-recovery",
          run: async () => {
            await healthy();
            checks.sourceRecovered = true;
          },
        },
        {
          at: 90 * 60_000,
          name: "current-suppression",
          run: async () => {
            await healthy();
            await pause("suppression");
            const href = await contributors(page).first().getAttribute("href");
            suppressedActor = new URL(href!, "http://127.0.0.1").pathname.split("/").at(-1)!;
            controls.version = "privacy-soak-2";
            controls.suppressedActorIds = [suppressedActor];
            suppressedAt = performance.now();
            await expect(page.locator(`.api-wall-content a[href*="/contributors/${suppressedActor}?"]`)).toHaveCount(
              0,
              {
                timeout: 45_000,
              },
            );
            await healthy();
            checks.suppressionApplied = true;
            expectedPages = fixturePages(stages, suppressedActor);
            await resume("suppression");
          },
        },
        {
          at: 120 * 60_000,
          name: "hold-real-cursor",
          run: async () => {
            await healthy();
            await pause("cursor");
            for (let i = 0; i < 6; i++) {
              if (
                (await page.locator("h1").textContent()) === "PRs merged" &&
                (await page.locator(".api-wall-page").textContent())?.startsWith("Page 2")
              )
                break;
              await page.getByRole("button", { name: "Next page", exact: true }).click();
              await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
            }
            await expect(page.locator(".api-wall-page")).toContainText("Page 2");
            await expect(page.locator("h1")).toHaveText("PRs merged");
            cursorPin = await pin();
            cursorFailuresBefore = cursorFailures();
          },
        },
        {
          at: 138 * 60_000,
          name: "natural-cursor-expiry-recovery",
          run: async () => {
            await healthy();
            assert(cursorFailures() > cursorFailuresBefore, "A real cursor must expire on the actual service clock");
            assert.equal(await pin(), cursorPin, "Cursor recovery retains the original snapshot pin");
            await expect(page.locator(".api-wall-page")).toContainText("Page 1");
            checks.realCursorExpired = true;
            await resume("cursor");
          },
        },
        {
          at: 180 * 60_000,
          name: "revoke-held-snapshot",
          run: async () => {
            await healthy();
            await pause("revocation");
            revokedPin = await pin();
            publish();
            controls.revokedSnapshotIds = [revokedPin];
            await expect
              .poll(async () => ((await contributors(page).count()) ? pin() : ""), { timeout: 65_000 })
              .not.toBe(revokedPin);
            await healthy();
            assert.notEqual(await pin(), revokedPin);
            checks.revocationRecovered = true;
            await resume("revocation");
          },
        },
        {
          at: 240 * 60_000,
          name: "resize-4k",
          run: async () => {
            await page.setViewportSize({ width: 3840, height: 2160 });
            checks.fourK = true;
          },
        },
        {
          at: 255 * 60_000,
          name: "change-device-scale",
          run: async () => {
            await cdp.send("Emulation.setDeviceMetricsOverride", {
              width: 1920,
              height: 1080,
              deviceScaleFactor: 2,
              mobile: false,
            });
            assert.equal(await page.evaluate(() => devicePixelRatio), 2);
            checks.deviceScale = true;
          },
        },
        {
          at: 270 * 60_000,
          name: "restore-device-scale",
          run: async () => {
            await cdp.send("Emulation.clearDeviceMetricsOverride");
            await page.setViewportSize({ width: 1920, height: 1080 });
          },
        },
        {
          at: 300 * 60_000,
          name: "stop-source-heartbeat",
          run: async () => {
            publishEnabled = false;
          },
        },
        {
          at: 306 * 60_000,
          name: "real-stale-source",
          run: async () => {
            await healthy();
            await expect(page.locator(".api-wall-health")).toHaveText("STALE OR DEGRADED DATA");
            checks.sourceStale = true;
          },
        },
        {
          at: 317 * 60_000,
          name: "resume-source-heartbeat",
          run: async () => {
            publishEnabled = true;
            publish();
          },
        },
        {
          at: 320 * 60_000,
          name: "fresh-source-recovery",
          run: async () => {
            await healthy();
            await expect(page.locator(".api-wall-health")).toHaveText("Recently reconciled", { timeout: 65_000 });
            checks.sourceFreshAgain = true;
          },
        },
      );
    actions.push(
      {
        at: full ? 360 * 60_000 : 90_000,
        name: "change-display-timezone",
        run: async () => {
          const before = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
          const timezoneId = before === "Pacific/Kiritimati" ? "Etc/UTC" : "Pacific/Kiritimati";
          await cdp.send("Emulation.setTimezoneOverride", { timezoneId });
          const after = await page.evaluate(
            (requested) => ({
              actual: Intl.DateTimeFormat().resolvedOptions().timeZone,
              expected: new Intl.DateTimeFormat("en", { timeZone: requested }).resolvedOptions().timeZone,
            }),
            timezoneId,
          );
          assert.equal(after.actual, after.expected, "The browser must use the requested display timezone");
          assert.notEqual(after.actual, before, "The browser must actually change its display timezone");
          checks.timezoneChanged = true;
        },
      },
      {
        at: full ? 150 * 60_000 : 100_000,
        name: "real-tab-background",
        run: async () => {
          await beginInterruption("background");
          background.page = await context.newPage();
          const hiddenCdp = await context.newCDPSession(background.page);
          await hiddenCdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
          await background.page.bringToFront();
          await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("hidden");
          await expect(contributors(page)).toHaveCount(0);
          await delay(1_000);
          hiddenRequestCount = counters.requests;
          checks.realBackgroundCleared = true;
        },
      },
      {
        at: full ? 151 * 60_000 : 110_000,
        name: "real-tab-foreground",
        run: async () => {
          assert.equal(counters.requests, hiddenRequestCount, "Hidden wall must stop public reads");
          await page.bringToFront();
          await background.page!.close();
          background.page = null;
          await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
          await healthy();
          checks.realForegroundRecovered = true;
          await releaseReading();
          await requireAutomatic();
          await endInterruption("background");
        },
      },
    );
    actions.sort((a, b) => a.at - b.at);
    let actionIndex = 0;
    try {
      await page.goto("http://127.0.0.1:4277/live?ui=api&mode=cycle&boards=pr_merged&interval=20");
      await healthy();
      await releaseReading();
      await requireAutomatic();
      const zones = await page.evaluate(
        (requested) => ({
          actual: Intl.DateTimeFormat().resolvedOptions().timeZone,
          expected: new Intl.DateTimeFormat("en", { timeZone: requested }).resolvedOptions().timeZone,
        }),
        runtime.timezoneId,
      );
      await writeFile(
        outputPath("timezone-start.json"),
        JSON.stringify({ attemptId: attempt.id, requested: runtime.timezoneId, ...zones }, null, 2) + "\n",
      );
      assert.equal(zones.actual, zones.expected, "The configured display timezone must survive navigation");
      if (full) {
        const window = requireSoakMidnightWindow(zones.actual, Date.now());
        await writeFile(
          outputPath("midnight-window.json"),
          JSON.stringify({ attemptId: attempt.id, ...window }, null, 2) + "\n",
        );
      }
      start = performance.now();
      startedAt = new Date().toISOString();
      await record("start", {
        ...input,
        requestedMinutes: minutes,
        fullMatrix: full,
        browser: browser.version(),
        executableSha256: runtime.executableSha256,
        browserSelection: runtime.browserSelection,
        node: process.version,
        clocks: "real; no installed clock or time advancement",
      });
      while ((elapsed = performance.now() - start) < minutes * 60_000) {
        failures.assertClear();
        while (actionIndex < actions.length && actions[actionIndex]!.at <= performance.now() - start) {
          const action = actions[actionIndex++]!;
          await record("action-start", {
            action: action.name,
            scheduledMilliseconds: action.at,
            elapsedMilliseconds: performance.now() - start,
          });
          await action.run();
          completed.push(action.name);
          await record(action.name, {
            scheduledMilliseconds: action.at,
            elapsedMilliseconds: performance.now() - start,
          });
        }
        const state = await page.evaluate(() => {
          const links = Array.from(
            document.querySelectorAll<HTMLAnchorElement>('.api-wall-content a[href*="/contributors/"]'),
          );
          const time = document.querySelector<HTMLTimeElement>(".api-wall-provenance time");
          const scope = document.querySelector(".api-wall-scope");
          const controls = document.querySelector(".api-wall-footer");
          const fits = (element: Element | null) => {
            if (!element) return false;
            const box = element.getBoundingClientRect();
            return box.top >= 0 && box.left >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;
          };
          return {
            visibility: document.visibilityState,
            localDay: new Intl.DateTimeFormat("en-CA").format(new Date()),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            utc: new Date().toISOString(),
            page: document.querySelector(".api-wall-page")?.textContent ?? "",
            heading: document.querySelector("h1")?.textContent ?? "",
            health: document.querySelector(".api-wall-health")?.textContent ?? "",
            error: document.querySelector('[role="alert"]')?.textContent ?? "",
            snapshot:
              document
                .querySelector(".api-wall-provenance span")
                ?.textContent?.match(/^Snapshot (wall-soak-\d+) · generated /)?.[1] ?? null,
            controlState: document.querySelector(".api-wall-state")?.textContent ?? "",
            generated: time?.dateTime ?? null,
            renderedTime: time?.textContent ?? null,
            links: links.map((link) => ({
              id: new URL(link.href).pathname.split("/").at(-1)!,
              pin: new URL(link.href).searchParams.get("snapshot"),
            })),
            values: Array.from(document.querySelectorAll(".api-wall-table tbody strong"), (value) => value.textContent),
            scopeFits: fits(scope),
            controlsFit: fits(controls),
            overflow:
              document.documentElement.scrollWidth > innerWidth + 1 ||
              document.documentElement.scrollHeight > innerHeight + 1,
          };
        });
        // Actions can await browser recovery. Bind progress and the sample to
        // this post-action capture, never the earlier loop-entry timestamp.
        elapsed = performance.now() - start;
        const identity = `${state.heading}:${state.page.split(" · ")[0]}`;
        assert(state.links.length <= 6, "Only the current bounded page may remain mounted");
        assert.equal(
          new Set(state.links.map((link) => link.id)).size,
          state.links.length,
          "Contributors must not be duplicated on a page",
        );
        assert(
          new Set(state.links.map((link) => link.pin)).size <= 1,
          "Displayed contributor links share a publication pin",
        );
        if (state.links.length) {
          assertPageActors(
            expectedPages,
            identity,
            state.links.map((link) => link.id),
          );
          assert(state.snapshot, "A nonempty page must name its visible source publication");
          const published = history.get(state.snapshot);
          assert(published, "Displayed publication must remain in the real test source history");
          assert.equal(
            state.generated,
            published.selected.snapshot.generatedAt,
            "Displayed time must belong to the retained publication",
          );
          for (const link of state.links)
            assert.equal(link.pin, state.snapshot, "Each contributor link must match visible provenance");
        }
        if (state.generated)
          assert.equal(
            state.generated,
            state.renderedTime,
            "Display timezone changes must preserve the source UTC timestamp",
          );
        for (const value of state.values)
          assert(["5", "1"].includes(value!), "Heartbeats and midnight must not inflate fixed input values");
        if (performance.now() - suppressedAt > 45_000)
          assert(!state.links.some((link) => link.id === suppressedActor), "Current suppression must remain effective");
        if (state.visibility === "hidden") assert.equal(state.links.length, 0);
        else {
          assert(
            state.scopeFits && state.controlsFit && !state.overflow,
            "Scope and controls remain visible without overflow",
          );
          if (state.links.length) {
            seen.add(`${state.heading}:${state.page.split(" · ")[0]}`);
            unexpectedSince = null;
          } else if (!networkFailed && !sourceFailed) {
            unexpectedSince ??= performance.now();
            assert(
              performance.now() - unexpectedSince < 70_000,
              "Ordinary reads must recover within bounded polling intervals",
            );
          }
        }
        const automaticMode = intent.observe(elapsed, state);
        const automatic = automaticMode && state.links.length > 0;
        coverage.observe(performance.now() - start, automaticMode, state.links.length ? identity : null);
        if (!automatic || !wasAutomatic || identity !== lastPage) lastPageChange = performance.now();
        if (automatic)
          assert(
            performance.now() - lastPageChange < 120_000,
            "A healthy automatic wall must keep advancing after reads and holds",
          );
        wasAutomatic = automatic;
        lastPage = identity;
        cycles.observe({
          elapsed: performance.now() - start,
          automatic: automaticMode,
          snapshot: state.snapshot,
          view: state.heading,
          page: state.page.split(" · ")[0]!,
          actorIDs: state.links.map((link) => link.id),
        });
        if (full && elapsed > 180_000 && elapsed < 30 * 60_000)
          assert(seen.size >= 5, "The initial healthy cycle must visit all pages within three real minutes");
        if (state.timezone === previousZone && previousDay && previousDay !== state.localDay) naturalRollover = true;
        previousZone = state.timezone;
        previousDay = state.localDay;
        const collect = baseline === null ? elapsed >= (full ? 600_000 : 0) : elapsed - lastCollection >= 3_600_000;
        let resource = null;
        if (collect) {
          resource = await measureResources();
          lastCollection = elapsed;
        }
        sampleCount++;
        await appendFile(
          samplesPath,
          JSON.stringify({
            attemptId: attempt.id,
            at: new Date().toISOString(),
            elapsedMilliseconds: elapsed,
            intendedInterruption: intent.summary(),
            ...state,
            resource,
            requestCount: counters.requests,
            retainedSnapshots: history.size,
            cycles: cycles.summary(),
            cycleCoverage: coverage.summary(),
          }) + "\n",
        );
        if (elapsed - lastProgress >= 60_000) {
          console.log(
            `wall soak: ${(elapsed / 60_000).toFixed(1)}/${minutes} real minutes; ${counters.requests} reads; ${state.health}; ${completed.length}/${actions.length} events`,
          );
          lastProgress = elapsed;
        }
        await delay(Math.min(full ? 15_000 : 5_000, Math.max(0, minutes * 60_000 - (performance.now() - start))));
      }
      await healthy();
      await requireAutomatic();
      const finalMode = await page.evaluate(() => ({
        visibility: document.visibilityState,
        controlState: document.querySelector(".api-wall-state")?.textContent ?? "",
      }));
      intent.observe(performance.now() - start, finalMode);
      intent.finish(performance.now() - start, full);
      await record("final-resources", await measureResources());
      assert.equal(actionIndex, actions.length, "All scheduled events must execute");
      assert(counters.networkAborts > 0 && checks.networkCleared && checks.networkRecovered);
      assert.equal(history.size <= 16, true);
      assert(checks.realBackgroundCleared && checks.realForegroundRecovered);
      assert(checks.timezoneChanged);
      if (full) {
        assert(naturalRollover, "The unmodified real clock must cross a local midnight during the run");
        assert(seen.size >= 5, "The full board and unranked roll must continue cycling");
        assert(
          cycles.summary().completeCycles > 0,
          "At least one whole pinned board and contributor cycle must complete",
        );
        for (const name of [
          "sourceCleared",
          "sourceRecovered",
          "suppressionApplied",
          "realCursorExpired",
          "realBackgroundCleared",
          "realForegroundRecovered",
          "revocationRecovered",
          "fourK",
          "deviceScale",
          "sourceStale",
          "sourceFreshAgain",
          "timezoneChanged",
        ])
          assert(checks[name], `${name} must execute successfully`);
        assert.equal((await compiledOutputs()).sha256, built.sha256, "Compiled runtime inputs must remain unchanged");
        assert.equal(git("rev-parse", "HEAD^{tree}"), input.tree);
        assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
      }
      failures.assertClear();
      result = full ? "completed-full-real-duration-matrix" : "completed-short-rehearsal-only";
    } catch (error) {
      failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
      throw error;
    } finally {
      clearInterval(heartbeat);
      elapsed = start ? performance.now() - start : 0;
      await writeFile(
        summaryPath,
        JSON.stringify(
          {
            attemptId: attempt.id,
            result: result === "failed" ? "failed" : "pending-owned-cleanup",
            matrixResult: result === "failed" ? null : result,
            failure,
            startedAt,
            endedAt: new Date().toISOString(),
            requestedMinutes: minutes,
            elapsedMilliseconds: elapsed,
            fullMatrix: full,
            input,
            compiledOutputsSha256: built.sha256,
            browser: browser.version(),
            executableSha256: runtime.executableSha256,
            browserSelection: runtime.browserSelection,
            node: process.version,
            checks,
            completed,
            naturalRollover,
            sampleCount,
            pagesSeen: [...seen],
            cycleCoverage: coverage.summary(),
            cycles: cycles.summary(),
            counters,
            baseline,
            maxRetainedGrowth,
            limits: {
              rendererRetainedHeapMiB: 64,
              testApiNodeHeapMiB: 128,
              testApiNodeRssMiB: 256,
              domNodes: 1000,
              listeners: 200,
            },
            exclusions: [
              "real provider or collector authorization",
              "deployed hosting",
              "human assistive technology acceptance",
              "browser process/GPU/operating-system memory",
            ],
          },
          null,
          2,
        ) + "\n",
      );
      await record("matrix-end", {
        matrixResult: result,
        elapsedMilliseconds: elapsed,
        acceptance: "pending-owned-cleanup",
      });
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await cleanupOwned(
      outputPath("service-cleanup.json"),
      attempt.id,
      [
        ["close owned background tab", async () => background.page?.close()],
        ["finish public routes", async () => page.unrouteAll({ behavior: "wait" })],
        ["close synthetic service", async () => app.close()],
      ],
      failures,
    );
  }
});
