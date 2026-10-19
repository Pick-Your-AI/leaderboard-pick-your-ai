# Reviewed governance and operations contributions

This implements the three COV-07 evidence examples in
[LB-07.05 / #77](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/77)
through the existing private recognition pipeline. The existing registry remains
authoritative: governance recognizes accepted decision versions, deployment work
recognizes accepted public work artifacts, and reliability recognizes approved
postmortem or remediation contributions as narrative spotlights. The feature
does not create metrics, source grants, reviewer enrollment, real deployment
evidence, public enablement or a universal contribution score.

## Source and review boundary

The host uses the protected `domain-evidence/v1` binding and exact current record
described in [specialist recognition](domain-recognition.md). A controls request
must be accepted by an independently authorized affected-owner reviewer, with the
matching request version, decision and single current audit entry. Private source
review supplies the meaning and permission basis of each record. Submitted public
text, labels, manifest booleans and a green workflow do not supply that authority.

The initial adapter accepts only an original observed `pr_merged` author fact.
The source must be nonsynthetic and have one matching actor and one exact
fact/evidence identity, with an eligible public GitHub PR proof. Source and proof
must agree on artifact, repository, author role, metric, canonical source event,
and merge time. An existing acceptance must not be hidden on that source fact.
Optional source metadata must describe an observed merge with no acceptance.
The source merge cannot follow the independent acceptance.

The collected immutable revision must come from the stock normalizer's complete,
matching default-branch integration evidence. This path does not substitute an
open or closed-unmerged PR, issue author, merge operator, release sender,
automation execution, already qualified fact, or unsupported review/coauthor
source. Stock `pr_coauthored` does not carry this immutable integration pin;
separate attribution adapters remain required. Bot-authored merged work retains
its actual bot identity and execution classification. A user account does not
establish that work was manual.

## Exact metric records

Each metric has the following exact `details` object. Additional keys are
rejected; private access rosters, environment names, incident totals and free-text
explanations do not belong in these objects.

| Metric | Exact fields | Qualification | Canonical work unit |
| --- | --- | --- | --- |
| `governance` | `decisionId`, `decisionVersion`, `kind`, `disposition`, `publicRecord` | Disposition is `accepted`; kind is `governance_decision`, `repository_rules`, `public_repository_settings` or `repository_process` | Decision ID and separately accepted decision version |
| `deployment_work` | `workArtifactId`, `workVersion`, `workKind`, `deploymentIds`, `sourceUse`, `publicRecord` | Kind is `deployment_improvement`; source use is `approved_public`; one through 32 distinct bounded deployment IDs have a reviewed relationship to the work | Work artifact ID |
| `incidents` | `contributionId`, `contributionVersion`, `workKind`, `narrativeApproved`, `publicRecord` | Kind is `postmortem` or `remediation`; narrative approval is the boolean `true` | Reliability contribution ID |

All IDs use one through 200 ASCII letters, digits or `_.:-`, without surrounding
whitespace. They identify reviewed canonical work, not lines, receipt aliases,
incident counts, deployment retries or a person's uptime. Deployment and
reliability proof versions remain review metadata. Another execution, deployment
ID, contribution version, source file or acceptance receipt cannot create a
second unit for the same work. The metric, repository and contributor remain
part of the existing canonical grouping.

Every `publicRecord` has exactly `revision`, `sourceRevisionUrl` and `contentHash`.
The revision is the complete 40- or 64-character lowercase hexadecimal Git
revision already collected for the source. The URL is a canonical HTTPS GitHub
blob URL in that same repository and revision, with a nonempty file path and no
credentials, query, fragment, encoded path or empty path segments. The content
hash is exactly 64 lowercase hexadecimal characters. A mutable branch URL,
commit-only URL, unrelated repository, missing hash or contradictory hashes for
the same immutable file cannot establish the reviewed artifact.

These are protected attestations. The adapter validates their structure and
binding; it does not fetch the artifact, verify its bytes, inspect its contents,
prove that a deployment occurred, or infer contribution quality. Before enrolling
the record, the host must review the actual immutable file and hash, its public
sanitization, source-use authorization, canonical identity, source attribution,
deployment association where applicable and affected-owner acceptance. A green
CI run or permission administration alone cannot replace that review.

## Accepted and rejected synthetic examples

The fixtures in `apps/pipeline/test/operations-recognition.test.mjs` normalize
fictional source envelopes through the real adapter. They never describe actual
contributor acceptance, source permission, deployment measurements or incidents.

| Metric | Accepted fixture | Rejected fixture |
| --- | --- | --- |
| Governance | The author of a merged public decision artifact has an independent current review of its exact decision/version and pinned public record | An unaccepted proposal, permission administration alone, access-roster payload, unsupported source role or unbound artifact |
| Deployment work | A merged improvement artifact is independently accepted with a sanitized immutable public record and reviewed deployment identities | A deployment execution alone, unknown source use, absent or repeated deployment IDs, private environment payload or a release bot's execution fact |
| Reliability | A merged postmortem or remediation artifact has an independently approved public narrative and pinned source | An incident count, personally attributed uptime, unapproved narrative, string approval, private details or an unrelated source |

## Time, replay, publication and privacy

All three metrics use the registry's `accepted_at` event clock. Their policies
require the qualified evidence class and canonical grouping. The original merge
occurrence stays in the source fact and source metadata, while acceptance remains
a separately recorded decision. Half-open date windows apply to the acceptance
instant. Unknown, finer-than-millisecond or inconsistent clocks are refused at
this protected boundary instead of being replaced with a collection time.

Every eligible record is validated before canonical deduplication. Reordered or
repeated valid receipts retain the earliest accepted authority. An invalid later
alias cannot disappear behind an earlier valid unit, and two currently reviewed
records cannot assign different hashes to the same immutable public file. Raw
facts and private audit history are not rewritten by materialization.

`operations-contribution-evidence/v1` versions the new authority only when a
configuration binds one of these three metrics. Prior generic authority is
withheld from current and historical reads until recomputation. A mixed
configuration retires its whole bound snapshot; configurations without these
metrics preserve their exact earlier fingerprint and all existing category
markers. Withdrawal, rejection and suppression continue to withhold recognition.

The new private artifact pin, work IDs, deployment identifiers, content hashes,
review records and request text are not added to public evidence or errors.
Public source links and existing bounded recognition explanations remain
separate from that protected evidence. Source permissions and contributor consent
remain their own current controls; this adapter does not bypass those gates.

Governance and deployment have synthetic `qualified` / `acceptedAt` candidate
metadata with no prototype data adapter or public enablement. Reliability keeps
its existing `spotlight` definition, empty selectable board combinations and the
engine's explicit prohibition on contributor ranking. Qualification does not
create a spotlight selection or imply operator responsibility, incident blame,
incident-count merit or personal uptime ownership.

## Remaining work-package acceptance

This delivers the bounded COV-07 source/receipt path. It does not establish
release/tag ancestry for `release_changes`, prove release-note authorship from a
publisher's account, add an external or review-only source adapter, or close
native prerequisites. The separate maintenance/tooling and raw release-sender
rules continue to apply. Broader #77 and public-service acceptance require their
own reviewed evidence and native completion records.
