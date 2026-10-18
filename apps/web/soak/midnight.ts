const HOUR = 3_600_000;
const SELECTION_MARGIN = 30 * 60_000;
const START_MARGIN = 15 * 60_000;
const LATEST_ROLLOVER = 5 * HOUR;

// Hourly fixed-offset zones guarantee coverage between the preferred named
// zones, including seasonal offset changes. No browser or host clock is changed.
const zones = [
  "Etc/UTC",
  "America/Los_Angeles",
  "America/New_York",
  "Pacific/Honolulu",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Europe/Paris",
  ...Array.from({ length: 23 }, (_, index) => {
    const offset = index + 1;
    return offset <= 12 ? "Etc/GMT-" + offset : "Etc/GMT+" + (24 - offset);
  }),
];

export function nextCalendarRollover(timeZone: string, now: number): number {
  if (!Number.isSafeInteger(now)) throw new Error("A finite integer clock observation is required");
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const initial = formatter.format(now);
  let low = now;
  let high = now + 26 * HOUR;
  if (formatter.format(high) === initial) throw new Error("No calendar transition found within 26 real hours");
  // Find the actual next local date change instead of assuming a 24-hour day.
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (formatter.format(middle) === initial) low = middle;
    else high = middle;
  }
  return high;
}

function inWindow(timeZone: string, now: number, margin: number): boolean {
  const delay = nextCalendarRollover(timeZone, now) - now;
  return delay >= margin && delay <= LATEST_ROLLOVER;
}

export function selectSoakTimezone(now: number, full: boolean, requested?: string): string {
  if (requested !== undefined) {
    nextCalendarRollover(requested, now); // Validate explicit zones even for a short rehearsal.
    if (full && !inWindow(requested, now, SELECTION_MARGIN))
      throw new Error("WALL_SOAK_TIMEZONE must cross a real local date 30 minutes to five hours after setup");
    return requested;
  }
  if (!full) return "Etc/UTC";
  const selected = zones.find((zone) => inWindow(zone, now, SELECTION_MARGIN));
  if (!selected) throw new Error("No timezone provides the required natural rollover window");
  return selected;
}

export function requireSoakMidnightWindow(timeZone: string, now: number) {
  const rollover = nextCalendarRollover(timeZone, now);
  if (!inWindow(timeZone, now, START_MARGIN))
    throw new Error("The real calendar rollover window expired during startup; restart the full soak");
  return {
    timeZone,
    observedAt: new Date(now).toISOString(),
    nextRolloverAt: new Date(rollover).toISOString(),
    minimumRemainingMinutes: START_MARGIN / 60_000,
    latestRemainingMinutes: LATEST_ROLLOVER / 60_000,
  };
}
