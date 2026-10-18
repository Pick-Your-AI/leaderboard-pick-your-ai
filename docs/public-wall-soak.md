# Real-duration public wall soak

Refs #127. This opt-in test keeps one connected wall document open for eight
actual hours. Its service uses the real Fastify public handlers, synthetic actors
and fixed contribution values. Both the service and browser use real clocks.
Neither a short run nor a test-clock advance counts as eight-hour evidence.

Run the opt-in command from the repository root:

```sh
WALL_SOAK_HEADFUL=1 npm run test:wall-soak
```

The default duration is 480 minutes. This command is deliberately separate from
the normal browser suite and from pull-request CI. It does not start a cloud
coding task. A full run requires a committed, clean tracked tree and rechecks its
identity at completion. The command first rebuilds the workspace. A manifest
records every served web asset and imported service, contract and metrics build
file, including its size and SHA-256; the full run verifies that these compiled
inputs remain unchanged at completion. The preview server defaults to `127.0.0.1:4277` and refuses
to reuse an existing server. API requests are intercepted into the test's actual
service instance; no GitHub collector or real contributor data is involved.

Use `WALL_SOAK_PORT` to select a distinct owned preview port from 1024 to 65535.
It always binds loopback, retains strict port ownership, and records the selected
base URL in start and summary receipts. Concurrent headful runs also need separate
owned displays, source/build directories and profiles; their elapsed time and
evidence are never combined. An existing run's inputs and browser stay untouched.

Use `WALL_SOAK_MINUTES=2` for a short harness rehearsal. Its result explicitly says
`completed-short-rehearsal-only`. The rehearsal exercises real polling, network
failure, display clearing, recovery and real tab background/foreground behavior;
it does not run the full matrix. Values from 2 through 1440 minutes are accepted.
A custom `WALL_SOAK_BROWSER_PATH` is recorded through the actual browser version
and executable SHA-256 and must be disclosed with a receipt; it does not replace
the pinned browser gate. Headful execution needs a real or
isolated virtual display. The full run requires actual tab visibility changes;
headless browsers that report every tab as visible cannot satisfy that check.
A fresh owned browser profile connects through Playwright’s `noDefaults` CDP
option so its usual focus emulation does not mask browser visibility. Independent,
bounded cleanup steps disconnect the browser, stop its owned process, close its
log and remove its profile only after exit is confirmed. The service and route
cleanup also runs after setup or receipt-writing failures. Separate cleanup
receipts record failures; no existing browser session is used.

## Matrix and measurements

| Real elapsed time | Event and required result                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 30 minutes        | Simulated network loss clears contributor content; bounded ordinary polling recovers after service becomes reachable.                                                                                   |
| 60 minutes        | An actual source exception passes through the service error handler; content clears and recovers.                                                                                                       |
| 90 minutes        | Current controls suppress a displayed contributor while the page is held; subsequent pages keep that suppression.                                                                                       |
| 120–138 minutes   | Hold a real cursor beyond its natural service TTL. The actual 410 response restarts page one at the same snapshot pin.                                                                                  |
| 150–151 minutes   | Background the actual tab. Its real visibility state becomes hidden, contributor content clears and public reads stop. Foregrounding resumes current reads.                                             |
| 180 minutes       | Revoke the held snapshot after publishing a new one. Live mode recovers to an available publication.                                                                                                    |
| 240–270 minutes   | Resize to 4K, change device scale to two, then restore 1080p; scope and controls remain within the viewport.                                                                                            |
| 300–320 minutes   | Stop source heartbeats until real source health becomes stale; resume them and recover fresh health without creating extra contribution values.                                                         |
| 360 minutes       | Change only the display timezone. Source UTC timestamp text retains its original representation.                                                                                                        |
| Throughout        | Observe a natural local midnight, complete board and unranked-roll cycles, consistent publication pins, no duplicate rows, bounded DOM and retained memory, and no uncaught page or harness exceptions. |

The full-run configuration selects a real timezone whose next local date change
is thirty minutes to five hours away. Named zones have hourly fixed-offset
fallbacks, so a candidate about to cross midnight is skipped without assuming
that every local day has twenty-four hours. This reserves startup time and an
hour before the scheduled six-hour timezone change. An explicit
`WALL_SOAK_TIMEZONE` must meet the same window for a full run; short rehearsals
only require a valid zone and make no midnight claim. After browser setup and the initial healthy page, the
test reads the browser's actual timezone and requires the transition still to
be fifteen minutes to five hours away, retaining that observation in
`midnight-window.json`. A missed startup window fails before the long matrix.
One owned CDP session retains the display timezone through navigation and the
later zone change; detaching it during setup would restore the host timezone.
Every run records the requested and actual canonical zones in
`timezone-start.json` and rejects a mismatch before elapsed time begins. The
short rehearsal also executes and verifies a real display-zone change, without
changing the clock or claiming a natural midnight.
Selection and validation use observed real dates and do not alter either clock.
Every two minutes the source republishes the same synthetic input with a fresh
source-sync timestamp. It retains at most sixteen snapshots, allowing the held
cursor to expire while its snapshot remains available. It does not retain all
request URLs or response bodies.

Each invocation creates an exclusive `attempt-*` directory beneath
`test-results/wall-soak-attempts/`, outside both configured Playwright output
directories (`wall-soak` and `browser`) that normal runner startup removes.
A regression runs the actual Playwright runner twice and verifies earlier
receipts survive both cleanup passes. The attempt path is printed at startup. Existing attempt
logs and summaries are never appended to or reused. `attempt.json` identifies
the attempt. The test body writes a `pending-owned-cleanup` primary summary;
the runtime publishes a completed result only after both cleanup receipts carry
the same attempt identity and empty failure lists. It writes the final summary
atomically, after the event and runtime-status receipts. A missing, malformed or
failed cleanup receipt turns primary success into failure. If an interruption
prevents the body from writing a summary, runtime teardown records an explicit
interrupted primary receipt. A killed process may leave a pending or missing
receipt; neither is a successful run. A completed result must also have passed
runtime status and a duration-matched full or short matrix label.

One shared, bounded error recorder retains the first unexpected heartbeat, route
and page error through the final matrix checks and both owned cleanups. The
matrix checks it after final resource and input verification. Each cleanup
checks it again after all awaited operations, including public-route draining
and browser shutdown, and carries any late callback failure into its receipt.
An error arriving during finalization therefore cannot leave a successful
primary result. Synthetic source-tail and cleanup/finalization regressions
exercise late errors separately from elapsed-time execution.

Samples append within that attempt to `samples.jsonl` every fifteen seconds
(every five seconds in a rehearsal). Event and sample entries also carry the attempt ID.
Each future action records its start and completion with its scheduled and actual
elapsed time. A sample's elapsed time is captured after action waits, alongside
its actual browser capture timestamp; the earlier loop-entry time cannot describe
a page observed after a recovery wait. Planned interruptions also record their
start, fixed maximum duration and matching completion, and samples identify the
currently intended interruption, if any.
Separate event and summary files record exact Git input,
actual browser/Node versions, real start/end time, elapsed duration, scenario
completion, response-code counts and resource limits. Tracing and video are off
to avoid retaining every network body or eight hours of video. The application
retains at most the current six contributor rows. Every nonempty sample binds
each contributor link to the visible snapshot and its actual retained source
timestamp. The response counter reads the actual service's string-valued `error`
field; unexpected bodies produce a bounded `unknown` counter. A focused test
uses an actual service-generated cursor-expiry response to verify that recorder.
That test's injected clock supplies no real-duration soak evidence.

A healthy automatic page must advance within two minutes. Every uninterrupted
automatic period must visit all five pages within three real minutes and keep
each page's subsequent absence below that bound throughout the run. Changing
publication pins does not reset this coverage. Only a scheduled harness hold or
deliberately injected outage starts a fresh bounded period on resumption. Transient empty
displays while otherwise automatic do not erase the deadline. Each nonempty page must contain its
complete expected fixture actors, in order, including the current suppression.
This detects skipped rows and actors repeated from earlier pages as well as
duplicates within one page; the same actor may appear once in the board and once
in the separate unranked roll.

A separate bounded tracker requires a whole observed, single-publication cycle
at least once every four minutes of continuous healthy automatic display. It
starts at board page one and observes both board pages and all three contributor
pages. Every view's successive pages must contain disjoint actor IDs; refreshing
one page and appearing in both the board and contributor roll remain valid.
An incidental empty or missing-pin frame clears the partial observation but
retains its deadline. Only an explicitly scheduled hold, planned background tab
or deliberate network/source outage resets the full automatic window. Changing snapshots or repeatedly alternating between only two pages
cannot reset the healthy-window deadline or reuse an earlier successful cycle.
Missed sampled pages cannot certify a full cycle. Samples and the final receipt
retain the completed-cycle count, automatic-window count and observed deadline
measurements; memory retains at most one cycle's five page sets.

The [intent guard](../apps/web/soak/intent.ts) derives expected operation from
the harness's own actions, independently of the product's displayed mode.
Unexpected `Paused`, `Paused while reading`, reduced-motion or background states
fail instead of disabling the checks. Actual tab visibility must also match the
planned foreground/background state. During deliberate network/source failures,
the control mode must remain automatic even though progress is exempt while the
source is intentionally unavailable. Every pause/resume action requires its
actual button and verifies the resulting mode; startup, resumption and completion
require automatic operation.

Each of the six interruption kinds can be granted once and cannot overlap,
repeat or renew. Its original elapsed-time deadline is checked before observation
and before completion clears it: network 90 seconds, source 120 seconds,
suppression 210 seconds, held cursor 19 minutes, revocation 240 seconds and
background 210 seconds. Short privacy/background bounds include the existing
sequential browser-recovery waits; the cursor action deliberately observes
eighteen real minutes. All required interruptions must finish before success.
These bounds are harness allowances, not new product recovery guarantees.

The guard regression completes one cycle through the actual helpers and then
supplies an unsolicited held page: it must fail immediately, regardless of whether rows are
present. Other cases cover a falsely automatic frozen page, unexpected tab
visibility, every expired lease, a late resume, missing completion, repeated or
overlapping grants and a deliberate eighteen-minute cursor hold followed by
fresh complete coverage. Simulated helper sequences are verifier tests, not
elapsed-time acceptance evidence. A long run frozen at an earlier verifier
revision retains that exact source and needs a
[separately reviewed chronology audit](wall-soak-chronology-audit.md); adding the
guard later does not retroactively execute it in that run.

After ten minutes of warmup, then hourly and at completion, explicit renderer garbage collection
allows comparison of retained JavaScript heap and DOM counts. Limits relative to
that baseline are 64 MiB renderer heap, 1,000 DOM nodes and 200 event listeners.
The test/API Node process separately allows 128 MiB heap and 256 MiB RSS growth;
these include test-runner bookkeeping and are not browser process or GPU memory
measurements. A completed receipt must retain these limits and exclusions, along
with any failed rehearsal or runtime limitation that changes its interpretation.

The harness is reproducible implementation, not a completed result. Only an actual
successful full-duration run supplies its stated matrix evidence. Real provider
authorization, deployed hosting, operating-system/GPU resource acceptance and
human assistive-technology journeys remain separate receiving gates.

## Retained local visibility limitation

An independent rehearsal of integrated source
`3c9265b229e627c8ba86ae51f48b92ff6470ca90` used an explicitly selected
Chromium `153.0.8010.0` headless executable. Build and soak TypeScript checks
passed. The actual run started at `2026-10-18T06:18:42.812Z` and ended at
`2026-10-18T06:20:32.976Z` after `110164.312403` real milliseconds with a failure:
the owned background tab did not make the wall's actual visibility state hidden.
Network clearing and recovery passed; both owned cleanup receipts had empty
failure lists. No eight-hour run was started on that environment, and neither
the visibility requirement nor the browser executable pin was relaxed to turn
this limitation into a pass. A visibility-capable environment is still required.
