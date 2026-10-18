import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface Attempt {
  id: string;
  directory: string;
  startedAt: string;
}

/** The primary receipt can become successful only after both owned cleanups. */
export async function finalizeAttempt(attempt: Attempt, bodyStatus: string) {
  const failures: string[] = [];
  const read = async (name: string): Promise<Record<string, unknown> | null> => {
    try {
      const value: unknown = JSON.parse(await readFile(join(attempt.directory, name), "utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // A missing, interrupted or unreadable receipt cannot establish success.
    }
    failures.push(`${name} is missing or invalid`);
    return null;
  };
  const summary = await read("summary.json");
  if (summary?.attemptId !== attempt.id) failures.push("The matrix summary does not identify this attempt");
  const cleanupChecks: Record<string, boolean> = {};
  for (const stage of ["service", "browser"]) {
    const receipt = await read(`${stage}-cleanup.json`);
    const entries = receipt?.failures;
    cleanupChecks[stage] = receipt?.attemptId === attempt.id && Array.isArray(entries) && entries.length === 0;
    if (receipt?.attemptId !== attempt.id) failures.push(`${stage} cleanup does not identify this attempt`);
    if (!cleanupChecks[stage]) {
      if (Array.isArray(entries) && entries.length)
        failures.push(...entries.map((failure) => `${stage} cleanup: ${String(failure).slice(0, 1000)}`));
      else failures.push(`${stage} cleanup did not provide a successful receipt`);
    }
  }
  if (bodyStatus !== "passed") failures.push(`The test body ended with status ${bodyStatus}`);
  const candidate = summary?.matrixResult;
  const minutes = summary?.requestedMinutes;
  const elapsed = summary?.elapsedMilliseconds;
  const durationMatches =
    typeof minutes === "number" &&
    Number.isFinite(minutes) &&
    typeof elapsed === "number" &&
    Number.isFinite(elapsed) &&
    elapsed >= minutes * 60_000 &&
    ((candidate === "completed-full-real-duration-matrix" && summary?.fullMatrix === true && minutes >= 480) ||
      (candidate === "completed-short-rehearsal-only" &&
        summary?.fullMatrix === false &&
        minutes >= 2 &&
        minutes < 480));
  if (summary?.result !== "pending-owned-cleanup" || summary.failure !== null || !durationMatches)
    failures.push("The matrix did not provide a completed, duration-matched result awaiting cleanup");
  const completed = failures.length === 0;
  const result = completed ? candidate : bodyStatus === "interrupted" ? "interrupted" : "failed";
  const testStatus = completed ? "passed" : bodyStatus === "interrupted" ? "interrupted" : "failed";
  const endedAt = new Date().toISOString();
  const final = {
    ...summary,
    attemptId: attempt.id,
    result,
    failure: completed ? null : (summary?.failure ?? failures.join("; ")),
    cleanupFinishedAt: endedAt,
    testStatus,
    cleanupChecks,
    cleanupFailures: failures,
  };
  await appendFile(
    join(attempt.directory, "events.jsonl"),
    JSON.stringify({ attemptId: attempt.id, at: endedAt, event: "attempt-end", detail: { result, testStatus } }) + "\n",
  );
  await writeFile(
    join(attempt.directory, "run-status.json"),
    JSON.stringify(
      { attemptId: attempt.id, startedAt: attempt.startedAt, endedAt, bodyStatus, testStatus, result },
      null,
      2,
    ) + "\n",
  );
  // Publish the successful summary last; interrupted writes leave its pending state.
  const temporary = join(attempt.directory, "summary.finalizing.json");
  await writeFile(temporary, JSON.stringify(final, null, 2) + "\n", { flag: "wx" });
  await rename(temporary, join(attempt.directory, "summary.json"));
  return { completed, result, testStatus };
}
