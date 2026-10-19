import {
  parsePublicWindows,
  publicWindowsSchemaVersion,
  publicWindowPeriods,
  type PublicScope,
  type PublicWindows,
} from "@pick-your-ai/contracts";
import { resolveMetricWindow } from "@pick-your-ai/metrics";
import {
  PublicReadError,
  readSuppressedContributionIds,
  type PublicRead,
  type PublicWindowsRead,
} from "./public-source.js";

/** Discovery uses the same complete projection validation as a current read.
 * Private provider objects, controls and ingestion clocks never enter the wire. */
export function projectPublicWindows(
  input: PublicWindowsRead | null,
  scope: PublicScope,
  project: (read: PublicRead, scope: PublicScope) => PublicRead,
): PublicWindows {
  if (!input || !Array.isArray(input.windows) || input.windows.length > publicWindowPeriods.length)
    throw new PublicReadError(503, "public_windows_unavailable");
  const body = parsePublicWindows(
    {
      schemaVersion: publicWindowsSchemaVersion,
      scope: input.scope,
      windows: Array.from(input.windows, (entry) => ({
        period: entry?.period,
        scope: entry?.read?.selected?.scope,
        snapshotId: entry?.read?.selected?.snapshot?.snapshotId,
        revision: entry?.read?.selected?.snapshot?.revision,
      })),
    },
    scope,
    resolveMetricWindow,
  );
  let authority: string | undefined;
  input.windows.forEach((entry, i) => {
    project(entry.read, body.windows[i]!.scope);
    // Projection first validates every control field. All choices must have
    // shared the same final current authority, including suppression sets.
    const controls = entry.read.controls;
    const signature = JSON.stringify([
      controls.version,
      [...controls.suppressedActorIds].sort(),
      [...controls.suppressedArtifactIds].sort(),
      [...controls.revokedSnapshotIds].sort(),
      readSuppressedContributionIds(controls).sort(),
    ]);
    if (authority !== undefined && signature !== authority)
      throw new PublicReadError(503, "public_windows_authority_changed");
    authority = signature;
  });
  return body;
}
