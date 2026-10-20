# Pull-request target branch at merge

This opt-in source lens implements the merge-time part of [LB-07.01 / #65](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/65). It selects one repository and the exact branch name recorded by GitHub's historical `MergedEvent`. It supports `pr_merged`, `maintainer_merges`, and independently verified merged `pr_coauthored` participation. It does not activate sources or establish a live public service.

## Source and clocks

The stock GitHub normalizer reads a bounded, complete `MERGED_EVENT` timeline through the existing authorized GraphQL client. It binds the repository database identity and public visibility, PR node identity, number and URL, selected source revision, native merged instant, event identity, event `mergeRefName`, and native merge commit. The actual observation clock is captured after collection. A deleted `mergeRef` does not invalidate a retained historical `mergeRefName`. Neither today's REST `base.ref`, a private `rawState` string, nor the repository default branch supplies missing historical authority.

The private `github-pr-merge-target/v1` capture has a strict, version-prefixed canonical digest. The digest detects a changed capture; it does not make a caller-provided statement authoritative. The runtime separately verifies the capture against the exact retained PR source row and every selected fact's repository, PR, role and merge clock. Public evidence keeps `leaderboard-evidence/v1`; its source link/revision and the exact selected scope remain visible without exposing the private capture or its digest.

Missing, ambiguous, incomplete or unverifiable native merge evidence retains an explicit unknown reason. A numeric legacy subject without a verified native node binding also remains unknown. Mismatched enclosing repository or PR identity, a changed selected commit, or a mismatched retained checkpoint is rejected as a source-binding failure. Provider permission, authentication, transport or storage failures keep the existing source-unavailable behavior. Unknown proof cannot manufacture measured zero, infer a branch or certify a complete historical inventory. A PR into an intermediate branch remains a merge fact, independently of default-branch LOC delivery.

## Approved configuration

The repository must already be approved for public collection and include the `pull_requests` family. Add an explicit branch scope to the approved pipeline configuration; the option is not a public permission grant. For example:

```json
{
  "organization": "Pick-Your-AI",
  "repository": "2",
  "workstream": null,
  "start": null,
  "end": null,
  "branch": "release/previous-target"
}
```

At least one of the three supported metric policies must already be approved. A branch publication selects those supported policies with their original signatures and rules; an unfiltered publication retains its full existing policy set. No registry definition or policy approval identity is silently replaced.

Names are case-sensitive, bounded to 255 UTF-8 bytes and validated as literal branch names. There is no implicit `refs/heads/` prefix removal, trimming, case folding or current-ref lookup. Control characters, malformed UTF-8 transport, ambiguous query duplicates and unsupported metrics are rejected. A scope without one repository is invalid. `context=event/current` continues to describe Project and workstream membership; it does not change the merge-target clock.

The merge-only lens deliberately rejects opened/ready/decision-ratio/reverted-delivery and other metric requests. An opened, readiness or decision-time branch requires independent history at that clock. The lens does not fabricate a ratio denominator or reclassify pending requests. Existing unfiltered ratio, readiness, first-review, coauthor and default-delivery behavior is unchanged.

## Retention, refresh and retries

The stock runtime derives the enabled repositories from approved branch scopes. It collects target proof for their inventoried PRs before freezing the publication's observation cutoff. No manual PR allowlist can silently narrow the repository inventory.

Every collection cycle uses a separate immutable normalization generation. A later fresh cycle may obtain known evidence for the same PR source revision after an earlier unknown capture; the earlier capture and frozen publication remain byte-bound to their own generation. A retry after an implicit cycle has frozen its cutoff reads that exact compatible generation and does not contact the provider again. Missing compatible retained bytes fail closed and require a fresh cycle.

Current reads, held snapshots, comparisons and exports recheck source authorization, retained source/capture hashes and their fact bindings. This applies to empty and unknown-only branch publications, even when they contain no review, Discussion, default-delivery or transfer rows. Repository retirement, changed source authority or missing capture dependencies cannot be bypassed by copying a branch string into a frozen fact. Existing suppression and revocation guards still apply.

## Public selection and export

Example API selection:

```text
/api/v1/boards?organization=Pick-Your-AI&repository=2&branch=release%2Fprevious-target&metric=pr_merged
```

The browser's **Merge target at merge** field preserves the literal name. Boards, source proofs, held snapshot links, cards, update polling and comparisons carry the complete scope. Selecting an unsupported measure produces an explicit error. Metadata navigation without a metric uses the supported `pr_merged` default only when a branch is present.

Branch scopes serialize as `public-scope/v4`, with explicit membership context, Project union, role union and branch. Reads use `public-read/v4`; JSON and CSV exports use `public-export/v5`. CSV includes a dedicated branch column, including empty exports. Existing captured ranking presentation may accompany v5, with its original policy identity. The new version does not reinterpret v1–v4 exports. Without a branch, the previous five-field, v2/v3 scopes and all legacy key/export formats remain unchanged.

## Verification and remaining acceptance

Focused source tests cover strict native event selection, no current-ref fallback, retained digest/fact binding, a real collector→normalizer→persisted publication→public board/proof/export journey, unknown-to-known refresh, immutable frozen retries, empty-board dependency withdrawal, exact scope/cursor/navigation identity, unsupported queries and legacy serialization controls. Test execution and hosted results must be reported against their actual source; these examples are synthetic and do not prove production access or deployment.

This slice does not close #65 or its parent: all-state branch history, selected-as-of decision ratios/pending consistency, complete readiness/COV-04 evidence, broader COV-10 delivery acceptance and live-source/public-service requirements remain their literal separate gates.
