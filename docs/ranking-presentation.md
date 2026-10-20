# Cohort display policy

This is a versioned presentation convention for the metric-board work in #111. It keeps each metric's approved quantity, unit, eligibility and stored rank history intact. It does not create a universal contributor score, approve a metric for ranking, or establish statistical or privacy protection.

## Captured policy and current projection

New pipeline snapshots capture the closed `ranking-presentation/v1` policy in their content identity and retained document. Its minimum is five comparable contributors, its cohort is `current_public_metric_rows`, and its purpose is `display_convention`. A retained snapshot without that captured policy stays legacy: its existing ordinary ranks remain readable, the browser discloses the missing convention, and comparable movement is unavailable. Reading or restarting does not assign the new policy to an old record.

The service first applies its existing current source, publication, actor, artifact and role controls, including whole-aggregate withholding after an evidence dependency is lost. It then applies the selected actor filter. Only that complete projected cohort is counted, before cursor pagination. Historical pinned reads go through the same current controls; a stored pre-withdrawal count is never reused as current authority.

A comparable contributor is one unique currently public actor with a validated numeric value under the metric's already-approved ranking descriptor in that selected scope and window. This reuses existing measured, zero and partial-value admission. A missing value is unrankable and never becomes zero. Historical source coverage remains visible separately: incomplete historical collection does not itself make enumeration of the complete currently supplied cohort unknown. If the required current projection cannot be obtained safely, the existing read fails instead of publishing a guessed cohort count.

| Current admitted cohort                                           | Presentation                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| At least five comparable contributors and ranking already enabled | Existing approved comparator and dense tied ranks                                                     |
| Fewer than five comparable contributors and ranking enabled       | Measured values, states, coverage and evidence remain; every rank is null and movement is unavailable |
| Ranking is not enabled for this metric                            | No ranking is introduced, regardless of how many numeric values exist                                 |
| Retained policy is absent                                         | Explicit legacy-policy disclosure; no current-policy receipt is invented                              |
| Current full projection is unavailable or inconsistent            | Existing sanitized read failure; no guessed count, rank or fallback data                              |

The response's closed receipt binds the exact snapshot and metric, complete enumeration, comparable/unrankable/total counts, minimum, version and resulting state. Counts add exactly and remain within the existing 10,000-row service boundary. The browser verifies the receipt against response identity, total rows, approved ranking and every supplied row. A rank cannot exceed the comparable cohort size; unknown-valued rows and small or disabled cohorts cannot carry ranks.

## Paired movement

Both selected snapshots must supply the same recorded presentation policy and qualify after current projection before movement can display. Missing, incompatible or small-cohort policy produces explicit unavailable movement. Existing engine requirements for compatible metric policy, windows, complete historical source coverage, backfill lineage and retained evidence still apply; the cohort convention does not replace or relax them.

For an admitted pair, the comparison metadata carries the previous snapshot's closed cohort receipt as well as the current response's receipt. The client binds both snapshot IDs and the metric before accepting movement. It also checks that a supplied delta cannot imply a previous rank outside the previous comparable cohort. Values and original private engine history are never rewritten to manufacture movement.

## JSON, CSV and paging

New policy-bound exports use `public-export/v4`. JSON includes `rankingPresentation`; CSV carries its closed JSON representation in `ranking_presentation`, alongside the established versioned scope columns. Both formats retain the exact current projected ranks and movement: a legacy exporter cannot reintroduce suppressed ranks. Comparison metadata includes the same previous receipt in both formats. Public output does not include private actor lists or engine-history inputs.

Snapshots without the new policy retain their established ordinary `public-export/v1`, `v2` or `v3` formats according to their scope version. There is no reinterpretation of older records as v4 and no downgrade of a supplied v4 receipt to a legacy version. Exact headers, duplicate-aware JSON handling, response bounds, private-field rejection and CSV formula protections remain in place.

The default page size remains 50 and the admitted range remains 1–100. There is no unbounded “Show all” request. Tied ranks can continue across cursors. The receipt describes the complete current cohort, not the loaded page; local page sorting does not alter the counts, metric quantities, proof links, canonical API order or exported bytes.

## Verification scope

Synthetic real-service cases cover four versus five contributors, partial and zero values, unknown values, tied continuation, current suppression on historical pins, whole-aggregate proof loss, actor filters, disabled metrics, malformed receipts, legacy formats and paired movement. Existing history and source-coverage cases keep sufficient baseline contributors to exercise their original boundaries independently of the new threshold. Browser cases exercise mobile disclosure, current-control retirement, exact JSON/CSV downloads and a legacy baseline; actual browser execution must be recorded separately from authored test coverage.

This deliverable does not certify a real source population, enable an unapproved ranking, establish anonymity, or complete the separate line-of-code evidence-context requirements. See [current-page ordering](board-page-sorting.md) and [metric category navigation](metric-category-navigation.md) for the distinct display controls.
