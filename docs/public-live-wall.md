# Public API wall display

Refs #125, #126, #127 and #106. The connected `/live?ui=api` route now opens
a public wall configurator. It reads the served metric registry and source health;
its choices and contribution data do not fall back to the prototype fixtures.
The existing explicitly selected prototype remains a separate development mode.

## Configuration and display

Start from the **Live** link on a public board to retain its organization,
repository, workstream, time window and actor filter. The configurator shows that
scope, offers the fetched registry's wall metrics, and creates a copyable public
URL. Display-only query fields never reach the API. Duplicate display options,
unsupported filters, invalid intervals and incompatible snapshot/mode selections
are rejected before a source read. Registry-ineligible metrics are rejected
without substituting another board.

| Mode | Snapshot and page behavior |
| --- | --- |
| Frozen snapshot | Requires an explicit snapshot. Manual page changes retain that pin; automatic rotation stays off. Current publication controls still apply. |
| One board | Visits every page of the chosen board before applying a newer published snapshot. |
| Cycle | Visits every page of every chosen board, then every page of the unranked contributor roll, before applying a newer snapshot. |

The URL chooses landscape, portrait or compact overlay presentation. Landscape
and portrait request at most six rows per page; the overlay requests three.
Ranks remain those supplied by the API, including a tie-continuation label across
pages. The alphabetical contributor roll includes attributable public activity
that does not qualify for a ranking. It does not assign new ranks. Values retain
their unit, measurement/coverage state and pending-work distinction; ratio and
elapsed-time summaries show their applicable diagnostics. Avatars are off.

The display keeps the selected scope, publication timestamp, earliest known
successful source sync and health visible. A degraded collector is labeled
**STALE OR DEGRADED DATA**. Opening a wall stays in the browser. Fullscreen is
requested only by the user's fullscreen button and a declined request leaves
the browser display usable.

## Safe boundaries and recovery

Page speed is 20–300 seconds, counted from when the requested page is successfully
displayed; loading that page does not consume its visible interval. Manual pause,
keyboard focus or pointer interaction
with the content, reduced motion and background visibility hold automatic page
changes. Manual next-page control remains available while paused or under reduced
motion. One polite status region announces successfully displayed page changes,
coalescing rapid manual changes for one second; refreshed rows are not themselves
live regions. A privacy recheck does not repeat the page announcement or restart
the rotation timer. If a page boundary coincides with an unfinished controls read,
one due rotation waits for that read to succeed and uses the resulting current
page and cursor. Pausing, entering a reading hold, changing the interval, leaving
the tab, moving manually or a read failure cancels that pending rotation. Resuming
starts a full new interval; a delayed tick cannot jump past those holds.

Every page uses one snapshot, computation revision, metric-definition version and
current publication-policy version. Health and content must also agree on the
current head's snapshot, revision and publication timestamp before content is
displayed. The wall retains only the current bounded page and its cursor.
The public client's existing eight-second deadline, decoded response limit,
credential omission and redirect rejection apply to each request.

Current publication controls are rechecked every 20 seconds while the tab is
visible, on return to the tab, and on explicit recheck. Hidden tabs abort active
reads and clear contributor content. A failed or inconsistent read also clears
the contributor display until a successful reread; no cached contributor response
or fixture replaces it. Successful same-page rechecks preserve surviving keyed
contributor links and their keyboard focus. Suppressed contributors are removed
even when their data snapshot was frozen.

Cursor expiry, cursor-policy invalidation and a publication change during a read
restart the current stage at page one on the next bounded recheck, using the same
snapshot pin. An expired or revoked snapshot lets live modes restart from the
current publication. Frozen mode continues to require its explicit pin and stays
unavailable if that snapshot is revoked. Other errors remain explicit; they do
not silently broaden the scope or adopt an unrelated publication.

## Verification and remaining acceptance

[`wall.spec.ts`](../apps/web/browser/wall.spec.ts) uses the actual Fastify public
handlers over explicitly synthetic contributors. It exercises invalid URLs,
registry choices and configurator navigation, complete pagination and continued
ties, the unranked roll, held and frozen snapshots, privacy removal, failed reads,
focus preservation, pause/reduced motion, cursor and snapshot recovery, and stale
display layouts at 1920×1080, 3840×2160, 1080×1920 and 960×540. The layout checks
require visible pause/scope controls, no viewport overflow, and no automated axe
violations in the selected WCAG tags. The existing remote browser journeys run
alongside these cases.

The timer regressions include a real-clock 20-second page advance and a controlled
overlap in which a controls read remains pending across that deadline. The latter
reproduces the lost-tick defect on the earlier implementation and verifies that a
successful fresh read advances once, current suppression still applies, and pause
cancels the deferred advance. The short real-clock check is not the eight-hour
continuous-display acceptance run.

Controlled regressions also delay a requested page for six seconds and verify
that it receives the full configured visible interval. Separate board and
contributor cases publish a new head between the actual health and content
handlers; the mixed read clears the display, then a coherent recheck recovers
under the existing pin with the current head held for the next safe boundary.

These are synthetic implementation and automated accessibility checks. They do
not establish a completed human assistive-technology journey, an eight-hour
continuous-display soak, real collector/source authorization, deployed hosting or
public-release acceptance. The linked issues retain those remaining gates.
