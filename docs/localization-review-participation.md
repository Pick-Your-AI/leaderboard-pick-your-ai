# Native locale reviewer participation

Localization can recognize a native reviewer as a participant in an explicitly
classified merged pull request. This is a separate role on the existing
`localization` metric and uses its existing locale-specific Controls receipt. It
does not turn the person who accepts that receipt into the native reviewer.

This path is opt-in. The protected metric policy must include `reviewer` in
`roles`, and the repository needs a documentation path policy with explicit
`localizationPaths`. Author-only policies keep their existing normalization
identity and author participation. No metric definition, ranking default, public
enablement switch or generic evidence-intake authority changes here.

## Two original source inputs

The GitHub normalizer retains two closed private records:

- A classified default-branch merge binds the repository, native PR identity,
  submitted head, exact merged revision, merge time, author and configured
  locale/category units. It still requires the existing complete pinned diff and
  path exclusions. Generated, imported and unconfigured paths grant no units.
- A native submitted review binds the same PR and submitted head, the original
  non-author user, exact native review identity and first submission time. The
  bounded complete review cohort must agree on the native identities. A later
  duplicate review does not create another unit; a dismissed first submission
  cannot promote a later one.

The private review proof also binds the existing observed `review_rounds` fact to
that exact submitted head and first `submitted_at` clock. Native REST review
objects need no invented `created_at` field. Generic `review_feedback` clock and
unknown-state behavior remain unchanged.

The reviewer path follows the current native review generation's complete
lowercase 40-character head identities. It also requires a complete lowercase
40-character merge identity for this join. This does not change the broader Git
revision forms already supported by ordinary author localization evidence.
Unknown actors, self reviews, mismatched parent links, stale heads and reviews
submitted after the merge cannot supply reviewer participation.

The pipeline joins these original records only from its selected current source
observations. A new review selection additionally requires the latest completed
native scan identity; a stable per-review content revision alone cannot establish
the cohort. The resulting unit is one reviewer / repository / PR / locale /
category, with the first native review identity in its canonical key. Its activity
clock is the merge time, as required by the localization definition. File counts,
string counts, line counts and repeated submissions do not multiply the unit.

The normalizer does not directly emit a reviewer localization fact. The pipeline
derives that fact only after validating both private inputs. A custom normalizer
cannot substitute a copied author fact with its role changed to `reviewer`.
Custom normalizers used with reviewer enrollment must declare the exact current
`localizationReviewNormalizationVersion` and preserve the same private input
contract. Existing review-source compatibility requirements remain in force.

## Independent optional recognition

The derived fact is initially observed participation. Qualification still needs
the existing independently authorized locale review: exact target fact, merged
source revision, locale, category, path-policy version, owner and current receipt.
The reviewer who submitted the native GitHub review is the fact's actor. The
Controls decision actor is recorded separately as `acceptedBy`; configured
reviewer authority, source-use review, participant consent and durable decision
audit remain mandatory.

An accepted request that names an author's original locale fact cannot qualify
another actor's reviewer fact. A changed merged revision cannot reuse a receipt
for the old revision. A later review cannot silently replace the original first
review identity. No tutorial-host locator, manual external review, documentation
quality judgment or new acceptance authority is inferred from this source join.

## Retained reads and currentness

The frozen private authorization records each derived fact's exact original
merge and review fact keys and normalization hashes. The normalizer generation
changes only for explicitly enrolled reviewer policies. Cache reuse checks the
private proof and source binding; retained reads restore both immutable records
and rederive the same capture.

The existing locked normalization read, signature admission, hash validation and
source authorization remain in use. Protected participation-history reads also
apply their existing row, byte and structural bounds before consuming these
proofs. Their minimized source projection includes only the three source identity
fields needed for this validation, within the existing byte budget.

A missing or changed captured dependency withholds the retained read. Restoring
the exact original row restores its eligibility; a freshly hydrated replacement
does not rewrite the old capture. New native observations govern new
publications, while an otherwise authorized historical snapshot keeps its
original as-of identity. Controls withdrawal, current source denial and existing
actor/privacy suppression continue to fence current and pinned publication.
Private review bodies, dependency keys, decision receipts and this authorization
capture are not public evidence fields.

## Regression boundary

The dedicated suites use the actual GitHub normalizer and collection adapter.
The pipeline fixture uses file-backed PGlite plus durable Controls SQLite, a
fresh SQLite handle after pipeline/database reopen, and an independently acting
synthetic acceptor. The cases cover first-review conservation, copied-author
attempts, stale or unknown native inputs, scan binding, both retained
dependencies, revision-specific acceptance and withdrawal/privacy. These are
synthetic software regressions, not participant approval or real-source evidence.
