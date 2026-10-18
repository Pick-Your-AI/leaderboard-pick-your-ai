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
inputs remain unchanged at completion. The preview server binds only `127.0.0.1:4277` and refuses
to reuse an existing server. API requests are intercepted into the test's actual
service instance; no GitHub collector or real contributor data is involved.

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

The configuration chooses a real timezone with midnight in the next six hours.
`WALL_SOAK_TIMEZONE` can select a different IANA timezone, but the full test still
requires a real date transition. Timezone selection does not alter the clock.
The candidate zones include New York so a start shortly after UTC midnight also
has an eligible natural transition within six hours.
Every two minutes the source republishes the same synthetic input with a fresh
source-sync timestamp. It retains at most sixteen snapshots, allowing the held
cursor to expire while its snapshot remains available. It does not retain all
request URLs or response bodies.

Samples append to `test-results/wall-soak/.../samples.jsonl` every fifteen seconds
(five in a rehearsal). Separate event and summary files record exact Git input,
actual browser/Node versions, real start/end time, elapsed duration, scenario
completion, response-code counts and resource limits. Tracing and video are off
to avoid retaining every network body or eight hours of video. The application
retains at most the current six contributor rows. Every nonempty sample binds
each contributor link to the visible snapshot and its actual retained source
timestamp. A healthy automatic page must advance within two minutes, and the
initial full-run cycle must visit all five pages within three real minutes.

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
