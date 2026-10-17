# Evidence-preserving event replay candidate

Implements the bounded replay core for [LB-05.03 / #57](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/57), with foundational test coverage for [LB-06.06 / #85](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/85). This is internal state reconstruction, not a ranking engine, public API or certification of current GitHub state. No research contract or proposed public leaderboard contract is modified.

## Inputs and clocks

`Transition` is the separate `transition/v1` internal candidate format. It carries a stable event ID, object ID, facet, value, evidence IDs, three clocks and explicit predecessor/supersession references. Inputs must already be minimized and backed by accepted source evidence. Runtime validation rejects extra fields, missing evidence references, invalid IDs/times, self references and oversized inputs with fixed error codes. Evidence locators are opaque IDs, not payloads or source text. A nonempty evidence-ID list validates shape; it does not prove that evidence exists or authorizes a correction.

| Field | Meaning | Replay use |
| --- | --- | --- |
| `occurredAt` | Source action time, nullable | Preserved as evidence; not an ordering fallback |
| `observedAt` | Receipt/observation time | Preserved; never chooses a winning state |
| `effectiveAt` | When an assertion applies to state, nullable | Strictly earlier known effective times establish order |
| `afterEventIds` | Explicit evidence that an event follows earlier assertions in the same object/facet | Adds predecessor edges; caller must supply actual source-order evidence |
| `supersedesEventIds` | Corrections replacing prior assertions in the same object/facet | Retains original assertions, redirects their explicit predecessor/successor edges to the replacement |

The pure engine does not substitute one clock for another. The delivery adapter sets equal source/effective time for an opening or closing lifecycle transition when its action time is known, because that transition takes effect when the action occurs. For reopen deliveries whose action time is unknown, both remain null. IDs, pagination order, ingestion order and database receive time are never temporal tie breakers. Timestamps are canonical UTC at second or millisecond precision; adapters must normalize supported source representations before input. Equal known timestamps do not establish order.

`value: null` is an explicit absence, such as a label removed. It is meaningful only together with the facet's result state. This prevents an absent label from being confused with unavailable evidence. Stable label IDs must form separate facets; names alone do not establish label identity.

## Deterministic reduction and corrections

`replayTransitions(events)` copies and validates at most 256 supplied records. Identical IDs with identical normalized content deduplicate; conflicting content under one event ID throws `conflicting_event_id`. It groups by object/facet, follows correction chains, redirects explicit ordering edges through replacements, and combines supported predecessor evidence with known effective times. It computes possible final assertions without selecting an arbitrary topological ordering.

| Result | Meaning within the supplied event set |
| --- | --- |
| `known` | Every possible final assertion agrees on one value, including explicit absence |
| `ambiguous` | Unordered final assertions disagree; value remains null |
| `incomplete` | A referenced predecessor or superseded assertion is absent; value remains null |
| `conflicted` | Ordering or correction cycles, competing unreconciled corrections, or cross-facet references prevent a supported result; value remains null |

Result reasons and candidate IDs are stable sorted lists. Unknown effective time is reported even when explicit predecessor evidence or agreeing alternatives support a value. A correction does not automatically become the latest source action just because an operator observed it later. Conflicting corrections require a subsequent explicit reconciliation that supersedes all competing branches. Contradictory clock/order evidence fails closed instead of silently preferring one.

All validated assertions, including superseded versions, remain in the result. Corrections do not overwrite the original evidence. Canonical event/facet serialization and a SHA-256 digest make repeated replay of a fixed evidence set comparable. The digest includes observation clocks and evidence metadata, so collecting different receipts can change it even when the resulting state agrees. The scope is always `supplied_events_only`; it does not imply complete source history or measured contribution counts.

## Retained-inbox integration

`InboxStore.replayObjectState(repositoryId, subjectId)` reads completed observations for one stable repository/subject scope. It normalizes the existing `delivery-observation/v1` records on read and does not update them, change worker state, or publish an outbox notice. Existing database rows need no migration. Unsupported observation versions fail closed. One SQL statement fixes the read's evidence set; a new store instance reconstructs the same state and digest from unchanged rows.

The current delivery bridge supports `opened`, `closed` and `reopened` lifecycle assertions. An `edited` webhook remains a receipt, but does not assert lifecycle or identify a superseded event. Label/correction scenarios are tested through synthetic normalized source assertions, not through a new installed source adapter. The existing webhook event/action allowlist remains unchanged. Live timeline ordering, label identity and correction acceptance require their source adapter/owner gates before they can produce these assertions.

Database replay returns `coverage: retained_observations_only`, the number of retained receipts, and a nested replay result. An empty history returns no facets, not a measured zero or known-open object. It fetches at most 257 rows and throws on histories over the 256-event bound; it never presents a truncated history as complete. Larger histories need a separately reviewed complete-history/checkpoint design. The JSON scope lookup is bounded in returned data, but no database scan-time or production latency claim is made; indexing/resource acceptance belongs to the performance work.

After `npm run build`, the local CLI can emit this report for an explicit stable scope using the managed `INGESTION_DATABASE_URL`. It needs no webhook secret, opens no listener, schedules no work and closes its pool after the read. For example, in a disposable synthetic environment:

```sh
npm run replay -- 2 SYNTHETIC_ISSUE
```

The result goes to standard output; treat it as an internal evidence report, not an authorized public snapshot. Invalid arguments, unavailable storage and unsupported retained formats fail with a fixed diagnostic and a nonzero exit status. This command is distinct from `store.replay()`, the protected operator primitive that requeues quarantined deliveries.

## Verification and remaining acceptance

All 120 arrival permutations of the synthetic lifecycle/label fixture produce identical state and digest. All 120 permutations of a correction-chain fixture also converge. Tests cover unknown and equal times, distinct source/effective times, correction branches and reconciliation, inherited predecessor/successor edges, missing references, cycles, duplicate conflicts, malformed inputs, nonmutation and hard input limits. Database tests cover reversed receipt order, unknown-time reopen ambiguity, restart determinism, read-only behavior, unsupported normalization versions, edits, empty scope and oversized retained histories. Both embedded PostgreSQL and CI PostgreSQL 17 exercise database behavior.

These fixtures are synthetic under `tests/fixtures/event-replay.json`. Passing them does not satisfy the installed-source, accepted contract, permission, attribution, eligibility, deletion/retention, metric totals or affected-owner review requirements. #57 remains open until those handoffs and acceptance requirements are satisfied. #85 still needs full ledger/policy/snapshot rebuild, interruption/rename/deleted-actor cases and retention-expiry limitations. No issue assignment, Project status, collection scope or release decision changes here.

Primary source surfaces checked 2026-10-17: [GitHub issue timeline API](https://docs.github.com/en/rest/issues/timeline) and [webhook event/payload reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads). They document source capabilities; the pure reducer does not assume their page order proves action order.
