/** Display preferences never change the UTC instants used for source selection. */
export const defaultDisplayTimeZone = "UTC";

export function isDisplayTimeZone(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(value)
  )
    return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Include valid aliases from copied links even if the runtime lists only canonical names. */
export function displayTimeZones(selected: string = defaultDisplayTimeZone): string[] {
  const available =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Asia/Tokyo"];
  const values = new Set([defaultDisplayTimeZone, ...available]);
  if (isDisplayTimeZone(selected)) values.add(selected);
  return [defaultDisplayTimeZone, ...[...values].filter((value) => value !== defaultDisplayTimeZone).sort()];
}

export function formatDisplayInstant(iso: string, timeZone: string = defaultDisplayTimeZone): string {
  if (!isDisplayTimeZone(timeZone)) throw new RangeError("Invalid display timezone");
  const instant = new Date(iso);
  if (!Number.isFinite(instant.getTime())) throw new RangeError("Invalid display instant");
  return new Intl.DateTimeFormat("en", {
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
    timeZone,
    // An offset disambiguates repeated local hours at the autumn transition.
    timeZoneName: "longOffset",
    // A timezone west of UTC can display the last day BC for an instant in year 0001.
    ...(instant.getUTCFullYear() <= 1 ? { era: "short" as const } : {}),
  }).format(instant);
}
