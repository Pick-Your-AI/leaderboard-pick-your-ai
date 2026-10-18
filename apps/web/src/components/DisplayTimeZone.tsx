import React from "react";
import { defaultDisplayTimeZone, displayTimeZones, formatDisplayInstant } from "../lib/display-time-zone.ts";

export function TimeZoneOptions({ selected }: { selected: string }) {
  return displayTimeZones(selected).map((zone) => (
    <option key={zone} value={zone}>
      {zone}
    </option>
  ));
}

/** Exact UTC bounds remain visible; an absent bound is never inferred from generation time. */
export function WindowBounds({
  start,
  end,
  timeZone = defaultDisplayTimeZone,
}: {
  start: string | null;
  end: string | null;
  timeZone?: string;
}) {
  return (
    <div className="display-window">
      <p>
        Display timezone: <strong>{timeZone}</strong>.{" "}
        {start ? (
          <>
            <time dateTime={start}>{formatDisplayInstant(start, timeZone)}</time> (inclusive)
          </>
        ) : (
          "No explicit start bound"
        )}
        {" to "}
        {end ? (
          <>
            <time dateTime={end}>{formatDisplayInstant(end, timeZone)}</time> (exclusive)
          </>
        ) : (
          "no explicit end bound"
        )}
        .
      </p>
      {(start || end) && (
        <p className="small">
          Exact UTC bounds: <code>{start ?? "no explicit start"}</code> (inclusive) to{" "}
          <code>{end ?? "no explicit end"}</code> (exclusive).
        </p>
      )}
    </div>
  );
}
