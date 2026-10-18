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

New required aggregate explanations retain a `private-rank-evidence/v1` section containing only included evidence clocks and opaque comparison signatures. Existing receipt metrics already retain actual ranks, values, policy hashes, scope, cutoff and backfill identity, so no identity/provider records or raw inputs are copied into the new section. The complete required explanation remains covered by its immutable digest and publication confirmation.

Pre-extension explanations are never rewritten or upgraded in place. They remain valid for ordinary reads and repeated publication/restart; their comparison is explicitly `insufficient_evidence_history`. Optional policy-preview retention is not a comparison dependency.

The retained clocks consume the metric engine's existing explicit UTC precision boundary (up to milliseconds). The engine rejects finer effective/observation instants before aggregate capture; this slice neither truncates them nor narrows a previously accepted engine input. Broader public source timestamp support is separate from that engine boundary.

Only `{actorId, state, delta, reason}` is added to visible rows. States are `comparable`, `new_entrant`, and `unavailable`. New entrants have a null delta; unavailable comparisons also have a null delta. Private signatures, receipt contents, backfill identifiers, hidden actor IDs and audit records are not public response or export fields.

## Current implementation limits

The pipeline currently publishes fixed custom scopes or all-time scopes with incomplete historical coverage. This change preserves those facts: it does not certify historical completeness, change publication-window semantics or produce artificial progress. Positive movement/new-entrant API tests use actual engine-generated synthetic named-period aggregates with complete synthetic coverage. The actual pipeline tests use two persisted fixed-window snapshots and assert `insufficient_history`.

Named-period publication integration and remote Web presentation remain separate unfinished integration work under #91/#97. This backend slice alone does not close #97, and no production deployment requirement has been added to its automated-validation gate.

## Validation

- `node --test apps/service/test/rank-comparison.test.mjs`: compatible engine receipts, entrant state, partial coverage, changed policies/backfill, corrections, privacy on both snapshots, pagination, query bounds and safe JSON/CSV output.
- `node --test --test-concurrency=1 apps/pipeline/test/rank-comparison.test.mjs`: actual persistence/restart, immutable legacy replay, shared transaction/no nested connection, authority changes during pairing and confirmed-digest tamper rejection.

Build workspace packages first. Fixtures are synthetic; their success establishes these executable invariants, not real-source accuracy or coverage.
