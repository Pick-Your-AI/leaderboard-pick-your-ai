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
pages. The unranked contributor roll uses the directory's GitHub-login ordering,
with unavailable logins first and stable public IDs breaking ties. Each row
shows that login or its unavailable-login/public-ID fallback beneath the public
display name. It includes attributable public activity that does not qualify
for a ranking and does not assign new ranks. Values retain
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
motion. One polite status region announces successfully displayed page and source
health changes, coalescing them for one second; refreshed rows are not themselves
live regions. A privacy recheck with unchanged page and health does not repeat the
announcement or restart the rotation timer. If a page boundary coincides with an
unfinished controls read,
one due rotation waits for that read to succeed and uses the resulting current
page and cursor. Pausing, entering a reading hold, changing the interval, leaving
the tab, moving manually or a read failure cancels that pending rotation. Resuming
starts a full new interval; a delayed tick cannot jump past those holds.

Every page uses one snapshot, computation revision, metric-definition version and
current publication-policy version. Health and content must also agree on the
current head's snapshot, revision and publication timestamp before content is
displayed. The wall retains only the current bounded page and its cursor.
At a complete cycle boundary, live modes clear the old pin so the next health
read selects the then-current publication, including a head published after the
previous page finished loading. Intermediate pages keep their existing pin;
frozen mode keeps its explicit snapshot across every boundary.
The public client's existing eight-second deadline, decoded response limit,
credential omission and redirect rejection apply to each request.

Current publication controls are rechecked every 20 seconds while the tab is
visible, on return to the tab, and on explicit recheck. Hidden tabs abort active
reads and clear contributor content. A failed or inconsistent read also clears
the contributor display until a successful reread; no cached contributor response
or fixture replaces it. Successful same-page rechecks preserve surviving keyed
contributor links and their keyboard focus. Suppressed contributors are removed
even when their data snapshot was frozen. If suppression removes the focused
contributor, the wall reconciles its reading hold with the actual remaining DOM
focus; a removed node cannot leave automatic rotation permanently paused. Other
pause, pointer, reduced-motion and visibility holds still apply.

Cursor expiry and cursor-policy invalidation restart the current stage at page
one on the next bounded recheck, using the same snapshot pin. A publication-head
change during a read clears the incoherent display, then retries the same page
and cursor: that race alone does not invalidate the continuation. Completed page
progress is retained, and live modes adopt the latest publication at the next
complete cycle boundary. An expired or revoked snapshot lets live modes restart
from the current publication. Frozen mode continues to require its explicit pin and stays
unavailable if that snapshot is revoked. Other errors remain explicit; they do
not silently broaden the scope or adopt an unrelated publication.

## Startup fallback and operator recovery

The delivered HTML contains a readable **Live data has not loaded** message before
the application starts. It identifies source freshness as unknown and shows no
contribution rows. The message remains when JavaScript is disabled or the entry
script cannot load; a `noscript` explanation identifies disabled JavaScript. Its
separate external stylesheet uses the existing same-origin CSP, and the semantic
message remains readable if that stylesheet also fails. The first application
render replaces it. This startup message does not recover a later application
crash or replace the wall's active source-failure handling.

Use the visible state to choose the next check:

| Visible state | Meaning and next check |
| --- | --- |
| Live data has not loaded | Application startup has not completed. Keep the exact URL, including scope and snapshot, when reloading. Check that JavaScript is enabled and the page's generated script and stylesheet URLs return their expected content types. A stale asset URL, failed download, CSP rejection or an asset incorrectly rewritten to the SPA document can prevent startup. Repair the deployment or connection; do not weaken CSP. |
| PUBLIC READ LOST | The running wall could not complete a coherent authorized public read and has cleared contributor content. Check the served source health and network response. Each request has an eight-second deadline; while visible, the wall rechecks every 20 seconds and also offers an explicit recheck. |
| STALE OR DEGRADED DATA | A coherent publication is visible, while served source health is stale, incomplete, missing or degraded. Inspect its coverage, publication and source-sync timestamps; an older publication is not evidence of current collection success. |
| Recently reconciled | The served health reports recent reconciliation. A quiet board or zero count alone does not establish complete source coverage. |

For a collection problem, an authorized operator can open the protected `/admin`
console, find **Collection diagnostics and inbox replay**, enter the affected
**Repository numeric ID** and choose **Load protected diagnostics**. The host must
enable that adapter and grant the current operator access to that repository; a
role alone does not grant it. Follow the [protected diagnostics and audited replay
guide](operator-operations.md) to inspect retained inbox counts, collection runs,
sanitized failure codes and existing receipts. Keep private diagnostic output out
of the public wall. Counts describe processing, and a queued replay does not prove
collection recovery or a resulting publication. After an uncertain replay result,
read its durable receipt before deciding on another action.

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

The focus-removal regression verifies that a surviving focused link stays held
through an ordinary privacy poll, then its suppression releases the obsolete
hold and starts a full new page interval. The roll-ordering regression traverses
all pages with display names deliberately ordered differently from logins; the
visible login keys preserve the API's complete ordering without sorting pages
independently. Both board and roll layouts are checked and captured at all four
target resolutions.

Separate safe-boundary cases publish only after the final page has finished
loading. One-board and cycling modes select that publication on the next cycle,
while the frozen control keeps its existing pin. A same-page health regression
verifies a stale status and subsequent recovery each update the polite region
after its one-second coalescing delay, with no repeated DOM announcement from an
unchanged privacy recheck.

These are synthetic implementation and automated accessibility checks. They do
not establish a completed human assistive-technology journey, an eight-hour
continuous-display soak, real collector/source authorization, deployed hosting or
public-release acceptance. The linked issues retain those remaining gates.
