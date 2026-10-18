# Audit the retained frozen wall-soak chronology

Refs #127. This is an offline reader for the 480-minute recorder at source
`16437501b119615d82d054b16749aa667f231e0f`, tree
`cd3bdcf19dec49d834a1f9f8d27988fc90607000`. It supplements the
[real-duration harness](public-wall-soak.md). It does not start a browser, a
service, a background task, a provider request or another soak. The original
running source and every retained input stay unchanged.

The frozen recorder derives its automatic-mode flag partly from the product's
displayed control state. An unsolicited pause could therefore stop that
recorder's coverage watchdogs. This reader decides when verification is required
from the pinned action schedule and its ordered completion receipts. The page's
own text cannot grant a new pause or extend an existing one.

## Commands and results

Use the repository's Node 24 runtime. Dependencies beyond Node and the committed
source helpers are unnecessary:

```sh
node --test --test-isolation=none apps/web/test/wall-soak-chronology.test.mjs
node scripts/audit-wall-soak.mjs \
  --input /absolute/path/to/attempt-IDENTITY \
  --output /absolute/external/path/new-chronology-audit.json
```

The complete command requires the original attempt, compiled-input manifest,
timezone and midnight-window receipts, all samples and events, the final primary
summary, runtime status and both owned-cleanup receipts. Success returns
`completed-frozen-chronology-audit` with `acceptedCompleteChronology: true`.
The reader verifies the full 480-minute duration and matching finalization; this
result is narrower than complete issue or public-service acceptance.

During an ongoing run, add `--prefix` and choose a new output filename:

```sh
node scripts/audit-wall-soak.mjs \
  --input /absolute/path/to/attempt-IDENTITY \
  --output /absolute/external/path/new-prefix-audit.json \
  --prefix
```

Every prefix result is `incomplete-prefix-not-acceptance` with
`acceptedCompleteChronology: false`, even if final files happen to be present.
It cannot satisfy elapsed duration, final cleanup or receiving acceptance. A
prefix can include an action that completed after the last available sample;
that tail remains explicitly unobserved. Malformed or contradictory available
records fail validation. A file that changes during its read or ends with a
partial JSONL record requires a stable read-only snapshot before another audit.

The output is an exclusive new file outside the evidence directory and the
original frozen source tree recorded by the attempt. Existing outputs are never
replaced. Input files are opened read-only, must be bounded regular files and
cannot be symbolic links. The output binds every read input by its byte count
and SHA-256; it retains neither browser logs nor raw response bodies.

## Timing authority and the missing action starts

`elapsedMilliseconds` was captured at the top of each historical loop, before
scheduled actions run. The browser's `utc` records the later display capture;
`at` is the later append timestamp. These are separate observations. An action
may legitimately take time between the loop and its captured display. Replacing
the loop value with the capture value would erase that distinction.

The audit requires an initial sample within five seconds, the fixed fifteen-second
sampling cadence, no ordinary loop gap over thirty seconds, no capture-to-append
delay over fifteen seconds, and at most five seconds of ordinary capture
overhead. A one-second tolerance covers the historical monotonic/UTC observation
offset and millisecond rounding. It does not authorize skipped periods. Samples
must continue to the final duration; a large gap remains a failure during a
deliberate hold because the recorder continues sampling while held.

Each of the twenty actions must complete in its first eligible observed loop,
in the exact frozen order. Additional capture time is allowed only for those
specific completed actions. The finite ceilings below conservatively cover the
source's sequential 10-, 45- and 65-second waits and bounded command overhead.
They are audit ceilings, not observed durations or new runtime behavior.

| Actions | Maximum time per action |
| --- | ---: |
| Set network failure, set source failure, stop heartbeat, resume heartbeat | 5 seconds |
| Assert network/source cleared display | 25 seconds |
| Network/source recovery | 135 seconds |
| Apply current suppression and finish resuming | 370 seconds |
| Select and hold the real cursor | 450 seconds |
| Check natural cursor expiry and finish resuming | 195 seconds |
| Background the actual tab | 60 seconds |
| Foreground and recover the tab | 180 seconds |
| Revoke the held snapshot and finish resuming | 400 seconds |
| Resize, change/restore device scale, change timezone | 30 seconds |
| Check the stale source | 145 seconds |
| Check fresh-source recovery | 200 seconds |

The eighteen-minute scheduled cursor hold and one-minute scheduled background
interval are bounded by their own start-action and recovery-action completion
receipts. A missing or late recovery cannot turn either interval into an
unlimited exception. Short suppression/revocation actions may reset a tracker
once when the action completes; their next captured display must already be
automatic. Any unsolicited `Paused`, reading hold, reduced-motion hold, hidden
state or changed rotation interval fails.

Historical events do **not** record action-start timestamps. The output therefore
lists the enclosing loop start, recorded completion and finite allowance for each
action. Internal UI state during that gap is unknown. The audit does not call the
completion timestamp an observed action start or claim continuous visibility
inside an interval the recorder did not sample.

## Recomputed evidence

The reader feeds actual capture times and independently determined intended mode
to `CycleCoverage` and `WallCycleTracker`. It verifies continued five-page coverage
within three minutes, whole single-publication cycles within four minutes and
page advancement within two minutes. Empty incidental frames do not erase these
deadlines. Recorded counts and timestamps must agree with this replay; one early
cycle or a fabricated large count cannot conceal later failure.

Every nonempty sample retains the exact ordered fixture membership: twelve board
actors and fifteen unranked-roll actors before suppression. The suppressed actor
was not logged in the action event. The audit therefore intersects the possible
single-actor exclusions across all later complete page observations and requires
one unique answer before complete acceptance. It never selects a convenient
exclusion separately for each page. Fixed actor values, duplicate rejection,
source-pin/link equality, immutable pin-to-generation timestamps and exact UTC
text remain checked. Every empty observation must also clear the source snapshot,
generation timestamp and rendered provenance; empty contributor/value arrays
alone do not prove a cleared display. The held cursor keeps one pin and must
expose both its original second page and recovered first page.

The initial actual timezone, its calculated midnight window, every local date
and the sole scheduled timezone change are reconciled against capture UTC. A
changed zone cannot manufacture the required same-zone natural midnight.

Resources are replayed from the first scheduled ten-minute observation, every
subsequent hourly observation and the final resource event. The final event must
be no earlier than the 480-minute endpoint minus the profile's existing
one-second clock tolerance, and must follow the last recorded sample append.
The summary still requires the complete 480-minute duration. Baseline and maximum
growth must match the primary receipt and preserve the frozen renderer/Node/DOM
bounds. The primary summary, ordered matrix end, service cleanup, browser
cleanup, attempt end and runtime status must identify the same attempt and
successful completed result. Missing, failed, pending or contradictory receipts
cannot establish completion.

The response counters are a body snapshot taken before owned service cleanup
waits for public routes to finish. A pending read may already be classified as a
response or abort, or may still be unclassified. The audit requires classified
responses plus aborts to be no greater than entered requests, and remaining
unclassified requests to be no greater than current concurrent reads, which in
turn cannot exceed the observed concurrency maximum. It exposes the pending and
unclassified counts explicitly. The later successful owned-cleanup receipt
supplies the bounded drain outcome; the earlier body snapshot does not claim
that concurrency was already zero.

The frozen `16437501` recorder did not retain asynchronous heartbeat/route/page error
latches raised during its final section or cleanup. Successful final receipts
therefore cannot certify that those latches stayed clear in these phases, and
the offline audit cannot reconstruct their missing history. Checks added to a
later harness apply to future executions and supply no retroactive evidence
about this run. This limitation by itself does not establish that the retained
run failed.

The audit checks retained evidence consistency. It does not independently
authenticate physical execution, recover absent response bodies, recreate
unlogged action starts, or prove a deployed source revision. Response categories
and resize/device-scale assertions still rely on the original recorder's retained
receipts where samples lack those fields. Real provider or collector authority,
deployed hosting, human assistive-technology acceptance and browser-process/GPU/OS
memory remain separate gates. All regression records are synthetic and supply no
elapsed-time acceptance evidence.
