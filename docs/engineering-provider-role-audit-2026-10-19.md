# Engineering sample: current commit-role observations

This follow-up to [the 18 October source reconciliation](engineering-source-reconciliation-2026-10-18.md) records current GitHub account bindings for the same four frozen samples. It adds the commit author, committer and coauthor-declaration observations that the earlier PR-author/reviewer sample did not establish. The original dated JSON remains byte-for-byte unchanged, with SHA-256 `1f00ea18b0cf36a875a11d9833cd5c1a0721d0d9a5dbe1597324be0040fe4334`.

The [complete minimized record](engineering-provider-role-audit-2026-10-19.json) contains all twelve examined commit objects, their ordered parents, trees, source URLs, original clock offsets, current provider bindings and actual trailer counts. No names, email addresses or raw commit messages are retained.

## Scope and observation times

Research API observations ran on **19 October 2026, 04:11:19–04:12:10 UTC**, with immutable Git-object readback at 04:14:41. Website role/list/Git Data observations ran at **04:20:23–04:20:24 UTC** after the initial bounded comparisons at 04:17:26–04:17:27; the immutable-object readback time is recorded separately in the JSON. Canonical website repository identity and its accepted integration range were verified at **04:27:02–04:27:03 UTC**.

The website repository has been renamed from `Pick-Your-AI/pickyour.ai` to `Pick-Your-AI/pick-your-ai-website`. Its database identity remains **1422238606**. The historical audit retains its original links and observation times. Research remains repository **1421934086**. These current observations do not reconstruct which account bindings GitHub exposed during the earlier observation windows.

| Frozen sample | PR commit objects | PR head | Separately examined accepted integration |
| --- | ---: | --- | --- |
| [Research #352](https://github.com/Pick-Your-AI/pick-your-ai-research/pull/352) | 2 | `fe4c0ca7` | `0510f87c` → `4f1c22ba` |
| [Research #348](https://github.com/Pick-Your-AI/pick-your-ai-research/pull/348) | 5 | `197af1a6` | `4f1c22ba` → `8cf075b1` |
| [Website #14](https://github.com/Pick-Your-AI/pick-your-ai-website/pull/14) | 1 | `850e15cb` | `65bce2b7` → `f560f2c9` |
| [Website #294](https://github.com/Pick-Your-AI/pick-your-ai-website/pull/294) | 1 | `73d3ca4d` | None; the observed PR remains open and unmerged |

There are **nine PR commit objects and three actual integration commit objects**, twelve distinct objects in total. The PR lists were read with a 100-item page size and a terminal empty second page, then reconciled with their exact bounded graphs. Integration commits have their separately recorded sole accepted-main parents. A PR's reported `merge_commit_sha` is not accepted delivery evidence while that PR is unmerged.

Website #14 retains its previously corrected source boundary: `5d6994c5` → `850e15cb`. The PR's base-tip field `1322c29c` does not replace that comparison boundary. The original diagnostic wrong-base comparison remains documented in the historical audit.

## Observed roles and public caveats

The identifiers below are GitHub provider account identifiers. The JSON also retains their exact provider node IDs and reported type. The provider type `User` does not establish a human operator or the absence of automation.

| Examined commit group | Current commit-author binding | Current committer binding | Standard `Co-authored-by` declarations |
| --- | --- | --- | --- |
| Seven Research PR commits | `5861166` on each | `5861166` on each | Zero on all seven |
| Two Research accepted squash commits | `5861166` on each | `19864447` on each | Zero on both |
| Website #14 source `850e15cb` | `5861166` | `5861166` | One declaration; account association unknown |
| Website #14 accepted `f560f2c9` | `5861166` | `19864447` | One declaration; account association unknown |
| Website #294 source `73d3ca4d` | **Unknown: explicit null** | **Unknown: explicit null** | Zero observed |

**Website #294 has a real account-binding gap.** Its PR author currently binds to `5861166`, while both commit-level roles are explicitly null in the REST commit and PR commit-list responses. The PR author cannot fill either missing role. Raw Git names and emails were not used to construct an account association. This gap remains publicly caveated as unknown.

**All three accepted squash commits have a distinct committer binding.** Their commit authors bind to `5861166`, their committers bind to `19864447`, and their PR merger records bind to `5861166`. These are separately observed roles. Collapsing the merger or PR author into the committer would lose the actual source distinction; matching other identifiers does not establish work effort or contribution allocation.

**Website #14 contains coauthor declarations requiring a separate caveat.** The source and accepted commit each contain one actual standard trailer. The two recorded occurrences do not establish two distinct contributors or any account, person, accepted role or credit allocation. Trailer absence elsewhere does not prove the absence of collaboration. Only occurrence counts and the unknown association are recorded; no identity is joined from a name or email address.

## Verification and interpretation

All twelve raw Git commit-object hashes were recomputed. Their ordered parents, tree hashes and clock fields agree with the bounded API observations. Original offsets normalize to the reported UTC values. These clock values describe commit records; they are not independently verified action times, receipt times or working durations.

The REST author/committer associations agree with the complete PR lists where applicable. Standard trailers were parsed with `git interpret-trailers --parse` and checked against actual label presence. The earlier website URL returned a repository-rename redirect; the canonical public repository and unchanged database identity were verified before continuing the same sample. An unsupported redirected numeric endpoint was a reader limitation, with successful canonical reads recorded separately.

The immutable source counts and integration comparisons from the historical audit remain unchanged. These new observations do not award line counts, original authorship, effort, quality or recognition. The historical reviewer-source-head and COMMENT-versus-APPROVED limitations also remain in force. Unknown commit roles and unbound coauthor declarations must remain visible in any downstream interpretation rather than being filled from PR ownership or guessed identity.

## Remaining acceptance

This is a bounded evidence contribution to [LB-07.06 / #86](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/86). It supplies current role observations and explicit caveats for this fixed sample. Metric-specific acceptance, unresolved account/coauthor associations and the work package's native prerequisites remain open. No metric is activated, historical observation rewritten, private source enabled or whole work package closed by this follow-up.
