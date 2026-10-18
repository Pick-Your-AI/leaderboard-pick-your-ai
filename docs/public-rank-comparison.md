# Snapshot-bound public rank comparison

This is backend integration for [#97](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/97). Ordinary board and export responses are unchanged. An optional comparison request exposes movement only when two retained, currently authorized publications have compatible engine history. It does not recalculate published values, infer a prior rank, or authorize a source or metric.

## Explicit API selection

`GET /api/v1/boards` and `GET /api/v1/exports` accept these additional optional query parameters:

- `compare`: the exact earlier published snapshot ID.
- `compareStart` and `compareEnd`: optional paired half-open UTC baseline bounds. If omitted, the baseline uses the current request's exact bounds. Dates use the existing `.000Z` API format, and each bounded window is limited to 366 days.

The baseline retains the same organization, repository and workstream selection. The provider must have published both requested scopes; a query is not a request to compute a new scope. The persisted engine period, filters, policy and evidence metadata remain authoritative. In particular, matching window lengths never reinterpret `custom` windows as a named rolling period.

Comparison selection is bound into signed pagination cursors and snapshot-pinned share links. JSON exports contain the same safe comparison and row movement fields as the board. Requested CSV comparisons add `comparison` and `movement` columns. Requests without `compare` retain the existing output shape and cursor binding.

## Provider and privacy boundary

The optional `PublicSnapshotSource.readComparison` loads both selected snapshots inside one existing database transaction, reusing that transaction rather than acquiring a nested connection. The pipeline holds both repository source locks and checks current configuration, recognition, confirmation markers, confirmed heads and private actor suppression after its final awaited authorization check. A changed authority prevents the paired read from returning stale current rows.

Both snapshots then pass the existing public projection, including current actor/artifact suppression, disabled metrics and revoked snapshots. The service verifies exact receipt/public row, value, rank, evidence and clock agreement before calling `compareRankMovement`. A changed visible cohort is unavailable; hidden rows are never used to reconstruct a visible historical rank. Actor-filtered requests currently return `filtered_cohort_unavailable` rather than pretending that an all-actor receipt establishes a narrower cohort comparison.

The service also rejects the entire paired response when provider control versions or exact current suppression/revocation lists disagree, including private edits without a version increment. Withholding movement alone cannot make earlier current rows safe under a changed authority.

Providers without atomic paired-read support return an unavailable comparison using the ordinary current board. A missing, expired or revoked baseline never produces a guessed history. The baseline's public identity and bounds are returned only when its projected receipt is usable.

## Immutable private metadata

New required aggregate explanations retain a `private-rank-evidence/v1` section containing selected-policy source identities, included evidence clocks and opaque comparison signatures. Coverage checks require each selected source/repository pair and ignore unrelated snapshot coverage; missing or contradictory required coverage stays unavailable. For both publications, every required snapshot and result coverage record must have a source reconciliation watermark through the selected interval's end, and the public snapshot generation boundary must also reach that end. Declared coverage bounds alone cannot establish completeness. Exact source-time comparison accepts an equal boundary and withholds movement when reconciliation is even one nanosecond short. Existing receipt metrics already retain actual ranks, values, policy hashes, scope, cutoff and backfill identity, so no identity/provider records or raw inputs are copied into the new section. The complete required explanation remains covered by its immutable digest and publication confirmation.

Pre-extension explanations are never rewritten or upgraded in place. They remain valid for ordinary reads and repeated publication/restart; their comparison is explicitly `insufficient_evidence_history`. Optional policy-preview retention is not a comparison dependency.

The retained clocks consume the metric engine's existing explicit UTC precision boundary (up to milliseconds). The engine rejects finer effective/observation instants before aggregate capture; this slice neither truncates them nor narrows a previously accepted engine input. Broader public source timestamp support is separate from that engine boundary.

Only `{actorId, state, delta, reason}` is added to visible rows. States are `comparable`, `new_entrant`, and `unavailable`. New entrants have a null delta; unavailable comparisons also have a null delta. Private signatures, receipt contents, backfill identifiers, hidden actor IDs and audit records are not public response or export fields.

## Persisted reconciliation lineage

The pipeline's private `backfillRevision` is a versioned digest of its normalization signature, repository-scoped imported source-fact identities and the captured corrections observed by the frozen observation cutoff. Ordinary `reconcile` run IDs and normalized output contents are excluded. A new timely issue can change the dataset and its measured value without being reported as an import.

Imported history comes from immutable `source_facts` joined to the explicit `backfill` or `audit` run that first retained each fact. The digest binds each ordered `(first_run_id, fact_key)` pair, rather than only the run ID. Another committed page of the same import therefore changes the lineage. A committed page remains part of it if a later page fails or a current-state refresh replaces the selected source revision. Restart and mutable run completion state cannot erase that provenance. Duplicate audits, empty scans and failures before any committed fact introduce no new history identity.

The query uses the publication's observation cutoff, including the persisted cutoff reused by webhook dispatch. Source facts first observed after that boundary cannot change the earlier import set. The correction component sorts a separate list of fact digests; it preserves the existing captured correction order and keeps later corrections in the full private input. Those later facts remain excluded from the earlier epoch while the existing exact dispatch-input fence can still reject a changed unconfirmed replay. Stored snapshots and explanation receipts are never rewritten to acquire a new marker. Comparisons across the old output-digest format and the versioned lineage are conservatively unavailable.

An interrupted dispatch may already have committed its SQL publication before private confirmation. Recovery verifies that publication's retained frozen-input hash, exact observation cutoff and opaque marker, then reuses only that recorded marker while recomputing the other inputs. Its full comparison-input hash must still match the original publication receipt before confirmation. A missing or altered frozen record, a substituted marker or a later correction cannot acquire the old receipt. New publications continue to derive the current lineage; recovering an existing immutable publication does not reinterpret it using a newer marker algorithm or rewrite its input.

The cumulative imported-history read admits at most 10,000 retained source facts per publication scope and rejects the 10,001st with `reconciliation_history_budget_exceeded`. This includes obsolete imported current-state revisions, not only the currently selected normalization set. The implementation does not truncate that history or substitute a constant marker. A deployment reaching this bound needs a separately reviewed durable lineage/retention design under [#95](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/95); deleting provenance or increasing the limit without resource evidence is not an automatic recovery.

This lineage is an invalidation input, not a complete-coverage or completed-import receipt. Existing late-evidence and changed/removed evidence-signature checks still detect historical changes discovered through ordinary reconciliation. Source capability, publication windows, coverage and current privacy authority remain independently required.

## Current implementation limits

The pipeline publishes fixed custom/all-time scopes and opt-in named-period scopes with incomplete historical coverage. This change preserves those facts: it does not certify historical completeness, reinterpret legacy custom scopes or produce artificial progress. Positive movement/new-entrant API tests use actual engine-generated synthetic named-period aggregates with complete synthetic coverage. The actual pipeline tests use persisted fixed-window and named-period snapshots and assert `insufficient_history`.

The opt-in named-period publisher is described below. A connected complete-coverage producer and remote Web presentation retain their separate #75/#91/#97 integration work. The persisted reconciliation lineage corrects the ordinary-ingestion marker boundary but does not certify source completeness. This backend slice alone does not close #97, and no production deployment requirement has been added to its automated-validation gate.

## Validation

- `node --test apps/service/test/rank-comparison.test.mjs`: compatible engine receipts, entrant state, partial coverage, changed policies/backfill, corrections, privacy on both snapshots, pagination, query bounds and safe JSON/CSV output.
- `node --test --test-concurrency=1 apps/pipeline/test/rank-comparison.test.mjs`: actual persistence/restart, immutable legacy replay, shared transaction/no nested connection, authority changes during pairing and confirmed-digest tamper rejection.
- `node --test --test-concurrency=1 apps/pipeline/test/reconciliation-lineage*.test.mjs`: actual ordinary ingestion, correction capture and retry, partial/failed/resumed imports, current-state refresh, audit, frozen cutoffs and cumulative history overflow, while every published coverage record remains partial.
- `node --test --test-concurrency=1 apps/pipeline/test/reconciliation-recovery.test.mjs`: a synthetic prior-producer marker passes through the actual SQL publisher before interrupted private confirmation; database restart recovers the exact receipt, while missing, altered or substituted frozen records stay unavailable. The existing webhook-dispatch cases separately retain later-correction denial.

Build workspace packages first. Fixtures are synthetic; their success establishes these executable invariants, not real-source accuracy or coverage.

## Opt-in named-period publication

The pipeline accepts an optional `period` on an already-approved configuration scope. For `7d`, `30d`, `90d`, `month`, `quarter` and `year`, keep `start` and `end` null in the template. Each explicit `runOnce({ cutoff })` materializes the existing public scope with exact UTC bounds at that collection cutoff. Month, quarter and year are calendar-to-cutoff windows. Their first instant would be an empty window and is rejected. `all` keeps the existing null public bounds. Omitted periods preserve the existing fixed custom/all-time behavior; an exact 30-day custom scope does not become a rolling period.

For example, an approved scope `{ organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null, period: "30d" }` and explicit cutoff `2026-11-02T12:00:00.000Z` materialize `[2026-10-03T12:00:00.000Z, 2026-11-02T12:00:00.000Z)`. The existing `start` and `end` query parameters select those retained bounds; `compareStart` and `compareEnd` select the prior retained bounds. There is no new public `period` query or on-demand calculation. A request for valid but unpublished bounds remains unavailable. Current configuration, repository access, installation controls, privacy, policy and immutable-publication checks still apply to historical pins.

Bounded named presets require a whole-second `.000Z` collection cutoff because that is the existing shareable API date contract. A fractional cutoff fails before collection; it is never truncated. Hosts must explicitly select a compatible event cutoff when invoking these opt-in templates. The existing implicit wall-clock worker/dispatcher default is not a scheduling policy for named periods and can reject a fractional cutoff. This slice does not add automatic preset scheduling, a latest-preset alias or a new initial UI default. Source timestamps and the separate frozen observation cutoff keep their existing precision. The engine checks that the observation cutoff covers the named event window and detects late evidence against the prior event-window end, rather than treating collection latency as part of that event window. Reversed windows remain unavailable.

Public identity is still organization/repository/workstream/exact bounds. Templates that resolve to the same identity (for example month and quarter during the first month of a quarter) are rejected before collection. Reads also reject ambiguously matched templates. Hosts must choose an unambiguous approved set; one label never wins by configuration order. Dispatcher publication receipts use the materialized bounds from the immutable operation cutoff. A retry cannot choose a later rolling window.

### Evidence and acceptance limits

No coverage certificate, reviewer acceptance or real-source evidence producer has been added. Existing complete-coverage checks require every requested repository and policy source to have complete coverage, a known history start spanning the requested bounds, a source watermark covering the selected event-window end, no missing pages, permissions or source errors, and no qualification uncertainty. The current pipeline still emits `partial`, `knownStart: null` and `historical_capability_not_certified`; a completed scan cannot satisfy those requirements. Named-period publication preserves the accepted persisted reconciliation lineage described above: ordinary fresh ingestion leaves its marker stable, while retained imports and effective corrections can change it. The marker and its immutable recovery fence do not certify source completeness. Actual persisted named-period fixtures therefore return `insufficient_history`, including after restart. No positive real-pipeline movement or new entrant is claimed.

- #91: this slice connects existing rolling/calendar/all-time engine semantics to approved publisher scopes and shareable explicit UTC bounds. It tests half-open boundaries around DST and preserves fixed custom semantics. Initial UI selection, timezone presentation, Project/role/context filter UI and broader acceptance remain separate.
- #97: immutable named-period receipts now reach the existing atomic comparison path without conflating event and observation clocks. Synthetic complete engine fixtures test fresh activity and late-history suppression. The real pipeline-shaped synthetic fixture retains partial coverage and suppresses deltas. Web presentation and truthful compatible source-history evidence remain open.
- #75: no history certification is inferred. Actual complete source/definition coverage, freshness acceptance and affected-owner review remain required separately.

Additional synthetic checks:

- `node --test apps/pipeline/test/publication-windows.test.mjs packages/metrics/test/engine.test.js`: all presets, calendar/UTC/DST boundaries, ambiguous identities, explicit cutoff validation, event/observation separation and late-history detection.
- `node --test --test-concurrency=1 apps/pipeline/test/named-period-publication.test.mjs`: actual collection/publication/read path, retained named receipts, partial-history comparison, immutable retry/restart, current approval loss, rejection before collection and dispatcher retry identity.

No database migration or new public schema is needed. Existing receipts are not rewritten. These changes are partial implementation evidence for #91/#97 and do not close either issue or establish #75's evidence-review gate.
