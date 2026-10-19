# Persisted default-delivery migration

This is the retained-data counterpart to the repository default-branch guard in the GitHub normalizer. It contributes to [LB-07.03 / #66](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/66), and composes with the [review identity migration](review-cache-migration.md). Its fixtures and execution evidence are synthetic. They do not establish production source coverage, accepted contributor credit, live integration audits, or the work package's full acceptance gate.

## Source and cache contract

Commit delivery and physical changes require a separately observed, nonblank `repository.defaultBranch`. The integration's default branch must equal that observed value, and its target branch must equal the default. An integration witness cannot supply its own missing repository observation. Existing commit membership, immutable diff pins, completeness, exclusions, and attribution requirements still apply.

The built-in GitHub package exports `defaultDeliveryNormalizationVersion` with value `default-delivery-scope/v1`. A pipeline using the built-in normalizer verifies the version exported by the loaded component. An unrelated host option cannot qualify an older component. A `githubEnrich` callback still passes through that component's normalizer and its branch guard. A replacement `normalizer` must explicitly assert the same pipeline option before it can populate or reuse affected caches. This assertion assigns responsibility to the trusted replacement provider; it does not create independent source evidence. A version field in the provider's output is insufficient.

The pipeline places an outer `default-delivery-scope/v1` wrapper around the source's existing normalization signature. For a review source, the review identity wrapper remains inside it. The affected metrics are:

| Metric | Existing conserved evidence |
| --- | --- |
| `commits_integrated` | A verified integrated commit |
| `direct_changes` | A verified direct default-branch integration |
| `pr_lines_added` | Eligible added lines in the pinned physical diff |
| `pr_lines_removed` | Eligible removed lines in the pinned physical diff |
| `pr_lines_changed` | Eligible added plus removed lines |
| `files_changed` | One canonical eligible file-path unit; count aggregation |

Commit and pull-request sources enter the new generation even if their corrected output is empty. Other source families enter it when an existing cache or new normalized output contains any affected metric. This is necessary because the physical diff adapter can emit facts from an enriched issue, review, or other envelope. Restricting migration to the commit/PR family names would leave that path uncovered.

The new wrapped cache takes precedence once present, including after reprocessing removes every delivery fact. Its old base-generation row remains unchanged. An unrelated issue-only cache retains its original signature and data. New publications involving the wrapped generation include the version in their content identity and private confirmation, and bind exact source-fact/normalization-hash pairs even without actor renames. These private details are not included in public board or export responses.

## Retained public and private authority

Public applicability uses the actual policy-matching fact references in the integrity-checked aggregate explanation. Both the selected snapshot and confirmed current head must qualify. The reader resolves their retained normalization bindings, verifies every returned document hash, checks the current version on every affected document, and validates the corresponding frozen input's hash, scope, dataset, cutoff, backfill revision, configuration, and exact source identities. Verifying every row prevents one corrupt row from hiding its affected facts behind another valid row.

A version flag on a confirmation does not upgrade an obsolete normalization. A valid newer head does not restore an obsolete historical pin, and a valid historical selection cannot bypass an invalid head. Current/pinned boards and JSON/CSV exports share the source check. Obsolete current publications remain unavailable; obsolete pins remain withheld. Corrupt evidence uses the existing projection-unavailable response. Unrelated public issue history retains its earlier frozen-read behavior, including when its old normalization rows are no longer retained.

Private comparison and aggregate-explanation authorization checks all bound normalization facts, including facts outside the currently displayed metric. An entirely unbound legacy private capture cannot establish the absence of enriched delivery claims and requires replay/recapture. A hash-only binding must still resolve its actual documents; new affected captures bind exact source pairs. Saved incomplete comparisons and input listings are checked before their manager callback can return retained private output, even when the comparison engine would otherwise reuse an incomplete cached result without recomputation.

These checks keep the existing source access locks, current approvals, reviewer/session fences, privacy overlays, immutable publication history, and permanent-retirement rules. They do not delete source facts, old normalization rows, old snapshots, or old comparison results.

## Dispatch and recovery

A dispatch interrupted after publication must requalify its actual retained evidence before retry acknowledgment. The final acknowledgment also rechecks evidence after publication, and a SQL commit without SQLite confirmation must match its original complete frozen-input receipt before it can acquire private authority. A correction that changes that input cannot be attached to the old operation. An empty corrected delivery result retains its already confirmed version identity during an otherwise valid retry.

Operator replay verification reconstructs the publication's complete content identity, including the private normalization version fields. Those fields are checked against the immutable content hash and rechecked at the final confirmation fence. Actual retained-source authorization still applies; metadata alone cannot certify a published replay.

Recovery follows the existing authorized collection/replay workflow:

1. Load matching built-in components, or qualify the protected custom normalizer's explicit version contract.
2. Replay the retained observations under the corrected semantics. Unchanged observations are hydrated again when their affected cache is obsolete; absent or contradictory default-branch evidence produces no delivery credit.
3. Verify the new publication and its SQL/SQLite confirmation. Fresh verified source evidence can restore eligible current credit. Obsolete pins and captures remain immutable and unavailable.
4. Create a new private capture or dispatch operation where an old operation's immutable input no longer matches. Preserve its earlier failure and audit history.

## Focused regression coverage

The pipeline regression uses real disposable PGlite and SQLite databases, with both actually closed and reopened. Its integrity-valid legacy fixtures explicitly reconstruct stored hashes and bindings; these fixture writes are not production migration code.

Coverage includes all six metric read routes; exact, hash-only, and unbound captures; unchanged-source hydration and fresh-source recovery; old-row/snapshot immutability; unrelated issue compatibility; forged provider/confirmation markers; independently corrupted selected/head frozen inputs; mixed valid/corrupt normalization rows; saved incomplete comparison GET/list boundaries; interrupted SQL/SQLite/acknowledgment windows; and a combined review/default-delivery source whose review feedback remains intact after physical credit is withdrawn.

After building the workspace, run the focused migrations and source guards with:

```sh
node --test --test-concurrency=1 \
  apps/pipeline/test/default-delivery-*.test.mjs \
  apps/pipeline/test/review-cache-migration.test.mjs \
  packages/github/test/default-integration-scope.test.mjs \
  packages/github/test/review-cohort-identity.test.mjs
```

The normal repository test glob also includes the regression files. Preserve the original failing and corrected execution receipts separately; a reconstructed synthetic fixture is not evidence of a production incident or an executed live-source audit.
