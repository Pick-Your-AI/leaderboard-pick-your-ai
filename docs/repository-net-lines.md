# Descriptive repository net text changes

The public `net_lines` definition measures additions minus deletions once per
verified default-branch integration. Its unit is signed net text lines. It is a
repository aggregate: a decrease is a valid physical result, and neither an
increase nor a decrease establishes effort, quality or individual ownership.
The definition is retained in the [metric registry](../packages/metrics/src/v1/registry.json).

`summarizeRepositoryNetLines` in the GitHub source package implements a bounded
internal projection for that definition. It consumes the existing protected
`GithubEvidenceEnvelope` integration input and calls the same
`normalizeGithubObservation` / `classifyPhysicalDiff` path as the source
normalizer. It does not sum contributor rows, require an author account or use
commit metadata to invent individual credit.

## Required source authority

The host supplies currently authorized public envelopes after checking the
repository's default-branch history, exact diff and first integration time.
The `proof.verified` and `integration` fields are host authority; copied issue
text or a payload's claim of verification cannot supply them. This helper does
not perform that collection or verification, grant GitHub access, or activate a
source. Existing physical collection and policy owners retain those tasks.

Each admitted observation must have all of these inputs:

- A selected stable repository ID, its known public visibility and default
  branch, and a matching public source envelope.
- An integration-commit payload with the exact repository commit URL and
  `sha` equal to the protected `after` revision. A nested issue, PR, review,
  release, label or milestone cannot replace that commit identity.
- Distinct complete 40- or 64-digit before/after pins of the same length,
  consistent diff pins, a nonempty canonical integration ID, and a bounded
  enumerated commit set containing that exact after revision. The target must
  equal the known default branch; a staging branch is insufficient.
- A proven integration occurrence time no later than its observation, and a
  complete diff accepted by the existing physical classifier.

Times use the source path's supported UTC millisecond precision. Missing,
invalid, future or unsupported-precision integration times remain unavailable;
collection time is never substituted. The source clock selects the half-open
`[from, to)` window. Observations after the explicit cutoff do not backfill an
earlier frozen projection.

## Conservation and exclusions

Repository ID and canonical integration ID identify the conserved change.
Repeated observations with identical pins, occurrence time and classified file
contents retain one unit even if their observation times or source event IDs
differ. The same integration in another repository has its own namespace.
Two canonical names for the same repository/after revision are conflicting
inputs, not two changes.

Competing complete interpretations of one canonical change are withheld. This
comparison happens before the date-window filter, so a competing clock outside
the selected window cannot conceal a conflict. Input order and identical replay
do not change the result. Known private or unknown-visibility evidence in the
supplied cutoff suppresses every subtotal and change ID for that repository.
This does not remove the caller's duty to apply current privacy authorization
when serving a historical result.

The existing classifier excludes vendor, generated, lock, binary, imported and
formatting-only files. Eligible source, test and documentation changes retain
their exact quantities. Unknown or truncated diffs remain unavailable, rather
than being estimated from a PR overview, author totals or a repository's current
size. Quantities and final subtotals must fit the safe integer bound; aggregation
uses exact integer arithmetic before any numeric conversion.

## Partial results and explicit unknowns

This input has no certificate of complete repository history. Every result
therefore has `coverage: incomplete`, `publicEnabled: false` and `ranked: false`.
The existing actor metric engine continues to reject signed net aggregation;
this separate export does not silently change its contract or the UI registry.

Each selected repository receives a row. At least one admitted integration
produces `state: partial` and known additions, deletions, signed net subtotal and
integration count. Otherwise those three line quantities are `null` with
`state: unknown`. An actual complete empty diff can establish a known zero
subtotal, as can cancellation between known additions and deletions. Neither
establishes that the repository's entire selected history has zero change.

`unavailableObservations` counts rejected supplied observations, including
repeats; it is an input diagnostic, not a contribution metric.
`conflictingChangeIdentities` separately counts withheld canonical identities.
`outsideScopeObservations` counts envelopes outside the selected repository ID
set. Reasons are bounded code labels. Admitted `changeIds` are opaque hashes;
the result contains no actor identities, source bodies, raw canonical IDs or
commit messages. Original input objects remain unchanged.

Consumers must label these values as known physical subtotals and retain their
unknown/incomplete status. They must not create public ranking, a person-level
line score, newcomer classifications or a certificate of source completeness
from this helper. Public API/UI admission, current rights, full default-branch
collection and real operational acceptance are separate requirements.

## Synthetic verification

[The source tests](../packages/github/test/repository-net-lines.test.mjs) call
the real normalizer, classifier and repository projection with explicit
synthetic protected envelopes. They exercise signed values and cancellation,
replay, canonical conflicts, source windows, exact pins/URLs, unknown authors,
private inputs, source-class exclusions, incomplete and empty diffs, bounds,
immutability and the unchanged actor-engine rejection. These are implementation
examples; they are not live repository measurements or evidence of deployed
access. See also the [source semantic inventory](metric-source-semantics.md).
