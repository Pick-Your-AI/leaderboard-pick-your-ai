# Reviewed reversion and qualified effectiveness

Refs [#74](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/74).

## Implementation and admission

The pipeline exposes `applyReversionDecision({ operation, lineageEvidenceIds })`
to an approved private host. Admission requires the host's
`authorizeReversionDecision(candidate)` callback to approve the complete immutable
prepared candidate. The default is denial. Calling the pure helper alone does
not record a decision or change a board; the runtime method performs the durable
transaction and private acknowledgment described below. This implementation does
not close #74 or establish a deployed correction service.

The operation names an original confirmed snapshot, a pending correction request
and its expected version, original and reverting fact IDs, exact qualified
target IDs, effect, predecessor, effective/review clocks, reviewer, private
approval receipt and public review URL. The supplied lineage evidence IDs must
resolve in that immutable snapshot. The request must point to the original
pull request, and its owner must differ from the reviewer. The callback receives
the resulting source, target, policy and authority bindings, not just a request
ID or a caller-provided approval flag.

## Meaning and source evidence

A reviewed reversion can make specifically named qualified units ineffective.
It does not erase the observed fact that the original pull request merged, add
negative quantities, or award a contribution to the person who reverted it.
Configured raw activity remains raw activity. A qualified policy remains bound
to its exact approved policy and independently accepted source unit.
Named units may belong to independently qualified authors or coauthors of the
same pinned original pull request. The reviewer must differ from every selected
contributor; unselected units and mismatched proof identities remain unchanged
or rejected, respectively.

Both original and reverting inputs must contain actual observed `pr_merged`
facts and the normalizer's immutable delivered commit revision and commit URL.
The existing normalizer supplies that pin only after its verified default-branch
integration and diff checks. A mutable REST timestamp, ordinary pull-request URL,
title/body match, unavailable item, 404, or missing page does not supply it.
The first path is deliberately limited to original and reverting pull requests
in the same repository. Missing source evidence is a rejected proposal.

The explicit relationship is a separate protected review. The helper prepares
the complete candidate, including the two source identities, their evidence IDs,
exact qualified targets, configuration hash, source generation, data mode and
policy hashes. A privileged host reviewer must approve that candidate and the
original-to-revert relationship. The helper neither contacts GitHub nor treats
a caller-supplied boolean as authority. The reviewer must differ from both
credited original and reverting contributors. Runtime admission also enforces
the existing pending correction request and requester distinction.

## Clocks and supersession

Source occurrence, selected observation, effective time, review time and durable
recording time are separate. This version requires canonical UTC millisecond
instants and rejects unsupported precision rather than rounding it. It cannot
apply a source event before its observation or a decision before its review and
recording. A later decision does not rewrite an earlier frozen cutoff.

An initial decision is inactive. Restoration requires an explicitly named
previous decision with the identical original and target set, new independent
review and nondecreasing clocks. Branching decisions, overlapping independent
roots, missing parents and cycles are rejected. Neither input order nor a
lexically larger ID chooses a winner.

Materialization retains every original fact and appends reviewed revisions of
only the named qualified facts. An inactive revision is excluded; a later active
revision restores the bound qualified state. Source pins, qualified acceptance,
and policy changes cannot inherit an earlier review. Recollection time and
membership projection are not the identity of the reviewed unit; an overlay
retains the selected fact's current context without inventing historical
membership or erasing its raw merge.

## Durable and public integration

The helper's record kind is `pipeline-reversion-effectiveness/v1`. The runtime
reuses the repository-scoped correction table and the existing
`correction_applied` receipt kind. It adds no table, retention policy,
deletion authority or public route. The row and seal are atomic: the exact
operation key, record digest, decision digest, request, original fact, operator
and approval receipt are checked independently of the receipt store's generic
idempotent lookup. Admission locks every repository in the original capture and
checks current configuration, source generation, confirmation, independent
recognition and private controls before and after protected review. Joined
readback validates the actual persisted row and receipt before commit.
The host configuration grant is rechecked after the awaited authorizer and
again at the final asynchronous boundary, followed by synchronous frozen-input
and request checks; an earlier grant cannot authorize admission after its withdrawal.

The sealed SQL decision remains authoritative if the separate private control
acknowledgment fails. An exact retry after reopen completes that acknowledgment
without changing the decision's recording clock or duplicating its audit event.
Changed request versions, decision content, receipt content or applied audit
records fail closed. The same repository lock serializes competing successor
decisions; two reviewers cannot create separate children of one predecessor.

Every correction consumer must classify complete rows before reading a legacy
`document.fact` or exempting an artifact. An unknown, corrupt or unsealed tag
fails closed. Untagged legacy rows retain whole-artifact suppression; a reversion
cannot restore an artifact removed by privacy, source authorization, a legacy
correction or changed independent acceptance.

The current versioned reversion authority, including active restorations, is
captured separately from legacy artifact/fact correction hashes. It is
bound to every complete effective decision prefix, including each predecessor's
full sealed content; an unchanged restoration cannot authorize a changed ancestor.
The complete joined row/receipt state is re-read under the final repository
locks before publication and included in current read controls and private
comparison/explanation captures. Source
generation alone cannot detect a concurrently inserted correction. With no
tagged decisions, existing legacy capture bytes remain unchanged.

The public hook suppresses exact contribution IDs after validating all proof
copies. Existing whole-aggregate proof completeness then withholds an affected
aggregate rather than subtracting an invented fraction. Raw original merge
proof remains available. Old qualified pins remain restricted by current
decisions; restoration requires a rebuilt snapshot carrying the current exact
authority. Both runtime pairing and the service's raw-provider authority
comparison include this contribution-ID set. A valid restored current snapshot
may therefore have an unavailable comparison baseline while retaining its own
values; a malformed or stale global authority is never downgraded to that
fallback. Every public copy of a restored unit uses the same selected reviewed
observation, while the original occurrence and independent acceptance clocks
remain unchanged.

Correction notices use the existing bounded public evidence history record:
`kind: correction`, the recording clock and an approved public review URL.
Private request details, reviewer identifiers, source payloads and approval
tokens do not become public metadata. These notices are partial history, not
proof of complete source history.

Older readers treat every tagged row as whole-artifact suppression, so they
over-suppress the original merge rather than disclose a revoked qualified unit.
Older publishers expect `document.fact` and cannot safely materialize this new
record. No old snapshot or audit receipt is silently upgraded to the new
authority. The integrated implementation and deployment procedure must preserve
that fail-closed boundary during mixed-version operation. Deploy the writer,
private capture readers, runtime public provider and service projection together;
older binaries are not an alternate writer or a way to clear the new authority.

## Validation and remaining scope

The thirteen focused synthetic helper cases exercise exact source pins, independent
review and policy binding, separate clocks, qualified-only overlays, explicit
restoration chains, record/receipt tampering, retry identity, changed source or
acceptance, recollection and membership, and current/pinned authority selection.
An independent review found that hashing only an effective chain's tail failed
to bind an altered sealed predecessor. The retained failing case and correction
bind the entire effective prefix; the thirteen-case helper run passed afterward.
Two later review findings had distinct reproductions: an exact-pin qualified
coauthor was rejected solely for differing from the raw merge author, and a host
grant withdrawn inside the awaited authorizer still admitted a decision. The
same four targeted controls changed from two passes and those two failures to
four passes after the narrow fixes. They also preserve unselected units and
reject wrong-actor proofs, another pull request, self-acceptance and an interested
operator. Earlier thirteen-case and storage phases retain their original scope.
An additional real-storage control withdrew the host grant after the actual
joined receipt readback: the original store admitted it, while the final grant
check rolled back both the correction and seal and retained the pending request.

Eight real-storage synthetic runtime cases exercise admission and request
changes, exact row/receipt sealing, unknown tags, all affected read/publication
consumers, publication races, competing restorations, failed acknowledgment,
reopen and retry, current actor/source controls, raw merge preservation, rebuilt
qualified results and restricted historical pins. The first integration run
stopped at an invalid use of a parameter-only SQL helper. After that query fix,
the remaining lifecycle exposed mismatched primary/portfolio observation clocks;
the same assertion passed after both copies used the selected reviewed revision.
These failures and their scoped corrections remain distinct execution evidence.

Fourteen service cases cover exact contribution suppression, all-copy validation,
whole aggregate withholding, current/pinned HTTP and conditional responses,
legacy privacy, paired-provider authority and an unavailable restored baseline.
Seven cases failed on the unchanged service and all fourteen passed after the
narrow service correction. These are synthetic implementation and storage tests,
not an actual maintainer review, production source audit, hosted receiving run
or native browser result.

The broader #74 tasks for withdrawal, deletion, inaccessible sources,
supersession, unsafe details and derived-cache purge remain literal tracked
work. This path adds no disappearance heuristic or retention authority. Real
deployment, permitted source access and actual maintainer decisions remain
separate from synthetic implementation evidence.
