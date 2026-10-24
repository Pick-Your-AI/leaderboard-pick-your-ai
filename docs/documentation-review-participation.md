# Documentation reviewer participation

Refs #81 (LB-09.04). This optional capability specializes the existing
`evidence_reviews` metric for a documentation PR review. Its unit remains one
reviewer, artifact and version; its clock remains the independent review's
`acceptedAt`. The metric registry, its LB-09.01/LB-10.03 definition ownership,
all 98 metric definitions, UI metadata and generated mappings are unchanged.
This is the separate reviewer participation requested by #81, alongside the
existing documentation-author adapter.

The capability is disabled unless a trusted host explicitly configures it.
`evidence_reviews` remains `definition_only` in the UI registry. This change
enables no public board, source installation, reviewer enrollment or live
recognition. Actual source permission, policy/checklist acceptance, qualified
reviewer authority, classification completeness and affected-owner acceptance
remain external gates. External tutorial intake is separate.

## Original source and reviewed revision

The source is an original `review_rounds` fact emitted by the existing GitHub
normalizer. That normalizer supplies the native review author, PR identity,
submitted head and first submission for that reviewer/head round. A GitHub
`APPROVED` state supplies no quality acceptance; a substantive `COMMENTED`
review can qualify only through the same independent evidence review.

The source fact must identify a visible GitHub User account, with no evidenced
automated execution, distinct from the actual PR author retained in
`subjectActorId`. Unknown authors, bots, organizations and service accounts
cannot supply this specialization. The fact must still be observed, with its original source
evidence, no prior acceptance receipt, known occurrence and observation clocks,
and a public GitHub PR locator. Explicitly synthetic source provenance is
rejected by the production qualifier.

A protected record selects the exact source fact, semantic source revision
and submitted head. It supplies a complete pinned before/head diff and an
explicit repository path policy. The existing documentation classifier must
find an eligible substantive documentation change. Its generated, imported,
research, binary, lock, formatting-only and rename-origin exclusions remain
unchanged. File/line volume never weights participation. Before/head pins are
canonical lowercase full Git SHAs; the source and diff must use the same head.

The reviewed head is not inferred from an eventual merge SHA. The PR need not
be merged to establish its original review. Neither a different head on the
same PR nor a more recent observation retargets an earlier acceptance. Source
permission and completeness of the supplied diff are trusted-host obligations;
a digest is integrity evidence, not a source authorization.

## Protected opt-in contract

An existing recognition binding may include a closed `documentationReview`
object. The binding must select `metricId: "evidence_reviews"`,
`sourceMetricId: "review_rounds"`, its exact repository ID and a nonempty
explicit independent-reviewer roster. The selected policy must use count,
canonical grouping, the reviewer role, qualified state and accepted-at clock.

| Protected field | Meaning |
| --- | --- |
| `version` | Exactly `documentation-review/v1` |
| `pathPolicy` | Repository ID, policy version and explicit documentation, research, generated and imported path arrays |
| `checklist` | Approved version and 1–64 unique substantive-review criterion IDs |
| `records` | At most 100 exact request/version/decision/source/head/diff bindings per opt-in |

Each record contains only `requestId`, `requestVersion`, `decisionId`,
`targetFactId`, `sourceRevision`, `head` and `diff`. The diff contains
`before`, `after`, `complete` and `files`; its `after` is the exact
reviewed head. Files use the existing pinned physical-diff fields.

The submitter's protected `request.detail` is a closed JSON descriptor:

```json
{
  "schemaVersion": "documentation-review/v1",
  "targetFactId": "fact:exact-original-review",
  "sourceRevision": "exact-native-semantic-revision",
  "head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "proofHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "checklistVersion": "approved-checklist-v1",
  "completedItems": ["correctness", "clarity", "source-links"]
}
```

These strings are illustrative only. `documentationReviewProofHash` computes
the actual hash of the complete versioned path policy, checklist and original
source/head/diff selection. The set of completed criterion IDs must exactly
match the configured checklist. An arbitrary checkbox, approval message or
matching digest does not grant acceptance.

The current protected request must have the original reviewer as owner and
explicit reviewer submitter role. This first specialization accepts owner-only
claims, with no collaborator attribution. It therefore does not imply that an
invited collaborator consented to private detail that was absent from their
invitation. Existing submitter consent and source-use review remain required.

The authenticated acceptance must match the current request version, receipt ID,
configured decision and approved policy. It must have exactly one unchanged
audit entry and an enrolled independent reviewer who is not the credited owner
or a claimed collaborator. Existing `reviewedInputDigest` binds the exact
detail, source-use statement and roles. Its permitted source-use references
must include the exact immutable head commit URL and revision. Amendment,
withdrawal, missing/stale review, missing audit or current suppression cannot
inherit old acceptance.

## Admission, conservation and publication

The protected opt-in is bounded before the pipeline's first configuration
clone. Accessors, proxies, cycles, non-JSON values and oversized structures are
rejected without evaluating their hooks. Across selected opt-in bindings the
admission budget is 1,000,000 conservative JSON bytes, 30,000 values and depth
16. Dense arrays have at most 1,000 items; each checklist has at most 64 items.
Schema/classifier/hash work happens only after this data admission.

Materialization snapshots its source, request, binding and policy inputs.
Exact recorded targets are selected before the generic PR candidate-ambiguity
check, so two genuinely different reviewed heads can remain separate.
A record with no exact current source fact supplies no unit, including when
another repository scope is selected. Every present target and matching alias
must pass the complete source/checklist/audit boundary before any host receipt
or public-reason callback runs.

The deterministic unit contains the original repository, PR, reviewer and head.
Receipt IDs, caller-provided changeset aliases, number of files and checklist
length cannot create more units. Every alias is validated first; conflicting
source meaning fails closed. Valid equivalent aliases conserve the earliest
acceptance, with request ID as a deterministic tie-breaker. Repeated source
delivery does not create a new reviewer/head unit.

The typed `documentationReview` receipt is the only new cross-metric
conversion from `review_rounds` to `evidence_reviews`. A generic approval
cannot perform it. The original review facts and author documentation facts
remain unchanged. Derived evidence links to the original PR and exact reviewed
head, while the metric uses the independent acceptance clock and existing
half-open time windows. It publishes the reviewer role and fixed recognition
state reasons, without private request/decision IDs, checklist, proof hash or
reviewed-input digest.

Only opted-in configurations add the private
`documentation-review/v1` recognition fingerprint component. Unrelated and
absent configurations retain their existing fingerprint bytes. Existing current
configuration, source visibility, suppression, consent and audit guards apply
to normal publication, pinned reads and private replay; retained snapshots do
not acquire new acceptance merely because software is upgraded.

## Regression scope and remaining evidence

The focused synthetic suite exercises the real GitHub normalizer, protected
recognition materializer and metric engine. It covers independent checklist
acceptance, commented/approved source parity, original author/reviewer identity,
exact multi-head selection, alias conservation, late invalid aliases before
callbacks, callback snapshot isolation, unavailable source, classification and
clock failures, generic-receipt refusal and absent fingerprint compatibility.

Prepared pipeline fixtures cover early constructor admission and valid opt-in,
plus persisted read/reopen and current privacy/withdrawal/audit revocation. That
persistence fixture remaps a real normalized fictional review through the
existing issue collector harness; it does not prove native review collection
or a live GitHub installation. These test sources establish no actual review,
consent, source permission, policy approval or production acceptance. Runtime
results must be qualified on the exact tested source through normal CI.
