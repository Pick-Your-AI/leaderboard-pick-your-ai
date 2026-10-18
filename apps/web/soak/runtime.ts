import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, readdir, lstat, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  chromium,
  test as base,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "@playwright/test";
import { createAttempt } from "./monitor.ts";
import { finalizeAttempt } from "./receipt.ts";
import { SoakFailures } from "./failures.ts";

interface Runtime {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  executableSha256: string;
  browserSelection: "explicit executable override" | "Playwright pinned executable";
  attempt: { id: string; directory: string; startedAt: string };
  outputPath: (name: string) => string;
  timezoneId: string;
  failures: SoakFailures;
}

export async function cleanupOwned(
  path: string,
  attemptId: string,
  steps: [string, () => Promise<unknown>][],
  unexpected: SoakFailures,
) {
  const failures: string[] = [];
  for (const [name, run] of steps) {
    try {
      await Promise.race([
        run(),
        delay(5_000, undefined, { ref: false }).then(() => {
          throw new Error("cleanup exceeded five seconds");
        }),
      ]);
    } catch (error) {
      failures.push(`${name}: ${String(error).slice(0, 1000)}`);
    }
  }
  // A route/page callback may fail while a preceding cleanup step is awaited.
  // Keep that error in the owned receipt even when the operation itself resolves.
  try {
    unexpected.assertClear();
  } catch (error) {
    failures.push(`recorded asynchronous errors: ${String(error).slice(0, 1000)}`);
  }
  try {
    await writeFile(path, JSON.stringify({ attemptId, at: new Date().toISOString(), failures }, null, 2) + "\n");
  } catch (error) {
    failures.push(`cleanup receipt: ${String(error).slice(0, 1000)}`);
  }
  if (failures.length)
    throw new AggregateError(
      failures.map((message) => new Error(message)),
      "Owned soak cleanup failed",
    );
}

export async function compiledOutputs() {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const files: { path: string; bytes: number; sha256: string }[] = [];
  const visit = async (relative: string) => {
    const metadata = await lstat(join(root, relative));
    if (metadata.isSymbolicLink()) throw new Error(`Compiled output must not be a symlink: ${relative}`);
    if (metadata.isDirectory()) {
      for (const name of (await readdir(join(root, relative))).sort()) await visit(`${relative}/${name}`);
    } else if (metadata.isFile()) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(join(root, relative))) hash.update(chunk);
      files.push({ path: relative, bytes: metadata.size, sha256: hash.digest("hex") });
    } else throw new Error(`Unexpected compiled output type: ${relative}`);
  };
  for (const relative of ["packages/contracts/dist", "packages/metrics/dist", "apps/service/dist", "apps/web/dist"])
    await visit(relative);
  return { sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files };
}

export const soakTest = base.extend<{ runtime: Runtime }>({
  runtime: async ({}, use, info) => {
    const attempt = {
      ...(await createAttempt(fileURLToPath(new URL("../../../", import.meta.url)))),
      startedAt: new Date().toISOString(),
    };
    const outputPath = (name: string) => join(attempt.directory, name);
    const failures = new SoakFailures();
    let profile: string | null = null;
    const executable = process.env.WALL_SOAK_BROWSER_PATH ?? chromium.executablePath();
    let log: FileHandle | null = null;
    let child: ChildProcess | null = null;
    let browser: Browser | null = null;
    let cdp: CDPSession | null = null;
    let launchError: Error | null = null;
    let exited: Promise<void> = Promise.resolve();
    try {
      await writeFile(outputPath("attempt.json"), JSON.stringify(attempt, null, 2) + "\n", { flag: "wx" });
      console.log(`wall soak attempt: ${attempt.id}; receipts: ${attempt.directory}`);
      profile = await mkdtemp(join(tmpdir(), "pyai-wall-soak-profile-"));
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(executable)) hash.update(chunk);
      log = await open(outputPath("browser.log"), "wx");
      // This is always a new owned profile and a loopback-only debugging endpoint.
      // No signed-in browser or existing display session is selected.
      child = spawn(
        executable,
        [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-sync",
          "--metrics-recording-only",
          "--remote-debugging-address=127.0.0.1",
          "--remote-debugging-port=0",
          `--user-data-dir=${profile}`,
          ...(process.env.WALL_SOAK_HEADFUL === "1" ? [] : ["--headless=new"]),
          "about:blank",
        ],
        { env: { ...process.env }, stdio: ["ignore", log.fd, log.fd] },
      );
      child.on("error", (error) => {
        launchError = error;
      });
      const ownedChild = child;
      exited = new Promise<void>((resolve) => {
        ownedChild.once("exit", () => resolve());
        ownedChild.once("error", () => resolve());
      });
      let port = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        if (launchError) throw launchError;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error("Owned soak browser exited during startup; inspect browser.log");
        try {
          port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]!;
        } catch {
          /* Wait for the owned process's port file. */
        }
        if (/^\d+$/.test(port)) break;
        await delay(100);
      }
      if (!/^\d+$/.test(port))
        throw new Error("Owned soak browser did not provide a debugging port within ten seconds");
      // Ordinary Playwright contexts force focus emulation, which can report a
      // background tab as visible. This documented CDP option preserves actual
      // browser visibility in the owned default context. It changes no clock.
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
      const context = browser.contexts()[0]!;
      context.setDefaultTimeout(10_000);
      const page = context.pages()[0] ?? (await context.newPage());
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      cdp = await context.newCDPSession(page);
      const timezoneId = info.project.use.timezoneId ?? "Etc/UTC";
      await cdp.send("Emulation.setTimezoneOverride", { timezoneId });
      // Chrome removes this override when its owning session detaches. Keep one
      // session for initial setup, navigation and the later display-zone change.
      await use({
        browser,
        context,
        page,
        cdp,
        executableSha256: hash.digest("hex"),
        browserSelection: process.env.WALL_SOAK_BROWSER_PATH
          ? "explicit executable override"
          : "Playwright pinned executable",
        attempt,
        outputPath,
        timezoneId,
        failures,
      });
    } finally {
      const stopped = () => !child?.pid || child.exitCode !== null || child.signalCode !== null;
      let cleanupFailure: unknown = null;
      try {
        await cleanupOwned(
          outputPath("browser-cleanup.json"),
          attempt.id,
          [
            ["detach owned emulation session", async () => cdp?.detach()],
            ["disconnect CDP", async () => browser?.close()],
            [
              "stop owned browser",
              async () => {
                if (!stopped()) child!.kill("SIGTERM");
                await Promise.race([exited, delay(1_000, undefined, { ref: false })]);
                if (!stopped()) {
                  child!.kill("SIGKILL");
                  await Promise.race([exited, delay(2_000, undefined, { ref: false })]);
                }
                if (!stopped()) throw new Error(`Owned browser ${child!.pid} has not exited; retain its profile`);
              },
            ],
            ["close browser log", async () => log?.close()],
            [
              "remove owned profile",
              async () => {
                if (!stopped()) throw new Error(`Profile retained for unconfirmed browser exit: ${profile}`);
                if (profile) await rm(profile, { recursive: true, force: true });
              },
            ],
          ],
          failures,
        );
      } catch (error) {
        cleanupFailure = error;
      }
      const final = await finalizeAttempt(attempt, info.status ?? "unknown");
      if (cleanupFailure) throw cleanupFailure;
      if (info.status === "passed" && !final.completed)
        throw new Error("Wall soak did not finalize successfully; inspect its primary summary");
    }
  },
});
