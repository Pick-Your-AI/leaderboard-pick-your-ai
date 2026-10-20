# Private pull-request decision history

Refs [LB-07.01 / #65](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/65).

The private github-pr-decision-history/v1 producer captures a pull request's complete API-visible close, reopen and merge sequence. Its selector returns one historical state before an exclusive event cutoff. The runtime does not yet collect this receipt, normalize it into a metric, or publish an acceptance rate or pending count. The metric registry and existing public behavior are unchanged.

## Interfaces and authority

| Interface                          | Result                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| capturePullRequestDecisionHistory  | A captured private receipt, a typed unavailable reason, or the existing GitHub client's transport/authorization error.           |
| validatePullRequestDecisionHistory | Strict receipt integrity and exact expected repository, PR, semantic revision, source, collection generation and cutoff binding. |
| selectPullRequestDecisionAsOf      | One private merged, closed-unmerged or pending state, not-yet-created, or unavailable.                                           |

The caller supplies the protected repository-scoped GithubReadClient, the exact selected native PR identity, its current collector semantic revision, a durable scan identity, an event cutoff, a trusted clock and a live synchronous authorization callback. Data and callback identities are captured before asynchronous work. The original callback remains live before and after each awaited request and trusted-clock call. A throwing clock still triggers the final authority check. Returned or thrown native Promise rejections are observed and rejected as invalid synchronous callback values; foreign thenable getters are never invoked.

The SHA-256 digest binds the version, selected source, PR identity and author, generation, cutoff, original capture clocks, before/after anchors, complete minimized events and pagination metadata. The strict validator replays and verifies the retained sequence as well as checking the digest. A digest is an integrity identifier. Anyone can hash data; schema validity or a matching digest alone confers no protected-host authority. A future runtime must admit these receipts through the actual protected producer and its immutable selected-run persisted source row, not through a caller-supplied verified flag or arbitrary callback result.

The receipt retains native IDs, timestamps and explicitly nullable author/merge-commit identity. It collects no title, body, email, branch, actor login, coauthor, diff or arbitrary native payload. A missing author remains null; the merge operator is never substituted as the author.

## Complete visible capture

The reader uses the existing authorized, read-only GraphQL method. It does not use a completed scan checkpoint as a fresh completeness claim. Every invocation performs a new bounded scan; there is no partial scan resume or fresh timestamp on cached pages.

The native query selects CLOSED_EVENT, REOPENED_EVENT and MERGED_EVENT from the beginning of the PR timeline, without a reporting-window or since filter. Every event must have the selected PR endpoint and public repository identity. The reader requires:

- Stable repository and PR IDs, number, URL, creation and author identity on every response.
- Stable current state, close/merge times, PR update time, timeline update time and whole-connection count before, during and after pagination.
- Unique native event IDs and edge cursors, coherent filtered/page counts, complete terminal pagination and a consumed count equal to the selected connection total.
- At most 100 pages of 100 events, 10,000 events and a two-megabyte minimized receipt. Smaller caller page budgets are enforced.
- Valid native UTC timestamps with up to nine fractional digits, preserved exactly. Comparison does not round to milliseconds. Unsupported timestamp profiles remain unavailable.

[GitHub's timeline connection reference](https://docs.github.com/en/graphql/reference/pulls#pullrequesttimelineitemsconnection) describes the counts, pagination and update timestamp. [ClosedEvent and ReopenedEvent](https://docs.github.com/en/graphql/reference/issues#closedevent) bind a closable object; [MergedEvent](https://docs.github.com/en/graphql/reference/pulls#mergedevent) binds its pull request.

These checks establish this version's captured API-visible sequence. The reference does not promise an atomic historical snapshot or universally retained real-world history. A changed anchor, redacted/null event, inconsistent native response, exhausted bound or unsupported profile remains unavailable. It does not become a complete empty history or measured zero. Actual source-capability and permission acceptance remain tracked work.

## Historical decision semantics

A newly created PR starts pending, including drafts. This says nothing about initial review readiness. The selector first validates the full captured lifecycle against the stable current native state, then replays the prefix strictly before the event cutoff. Current REST state can legitimately differ from that historical prefix.

| Visible native sequence before the cutoff | Selected private state                          |
| ----------------------------------------- | ----------------------------------------------- |
| No transitions after creation             | Pending                                         |
| Close                                     | Closed-unmerged at that close                   |
| Close, reopen                             | Pending; the old close no longer decides the PR |
| Close, reopen, close                      | Closed-unmerged at the last close only          |
| Merge                                     | Merged at the native merge event                |
| Creation exactly at or after the cutoff   | Not yet created                                 |

A transition exactly at the cutoff is excluded. Equal instants with different fractional spellings compare equally. Conflicting simultaneous transitions have no inferred event-ID or arrival-order precedence. The sole compatible multi-event group is one same-PR close plus one merge at the same instant, while pending; it retains both source IDs and the native merge timestamp. A merge is terminal. An orphan reopen, later reopen after merge, repeated closure without reopening, repeated merge or other impossible sequence is unavailable.

Selection happens before any subsequent reporting-window filter. An earlier in-window close cannot survive a later reopen or be resurrected when the final decision is outside a selected window. Native merged state does not establish historical default-branch integration or conserved physical delivery. A nullable native merge commit remains nullable.

## Remaining runtime and public work

The future collector must preserve the clock order: event cutoff E <= capture completion C <= persisted observation O <= frozen observation cutoff F. The receipt's E is explicit and exclusive. Neither original capture time nor stored observation time may be rewritten to equal F, and a retry of a frozen snapshot must not perform a newer native lookup and backdate it.

Production integration must bind the proof and version into persisted source revisions, normalized cache generations and final publication authorization. It must choose one PR state per selected generation, including pending, before deciding which final merged/closed decisions fall in a reporting window. Historical branch scopes need their own evidence.

Pending backlog needs an explicit coverage-aware contract through the metric engine, persisted dependencies, public projector, client and exports. In particular, an old PR still open at E must not disappear merely because it was created before the reporting window. A lower-bound change in the engine alone is insufficient: the current public evidence projector also applies ordinary occurrence-time filtering. An unavailable or partial source cannot establish zero pending PRs. This private producer deliberately emits no public count or ranking.

The existing minimized REST/webhook rows do not contain complete lifecycle history and cannot reconstruct it from a hash. The readiness, target-branch and organization-participation producers retain their separate contracts and ownership.

## Synthetic verification

The focused decision-history tests use the actual GithubReadClient with a synthetic HTTP transport and repository-scoped in-memory checkpoint seam. They cover lifecycle cycles, historical/current disagreement, exact cutoff precision, pagination, subject binding, source races, authorization revocation, immutable request inputs and strict retained-receipt validation. They neither collect live contributor data nor establish deployed service, actual GitHub-source completeness, physical delivery or whole-work-package acceptance.
