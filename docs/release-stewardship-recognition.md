# Release stewardship publication admission

This is the bounded publisher path for [#77](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/77) and the existing `release_stewardship` definition. The registry uses the release publication clock and a reviewed stewardship participation. It does not infer the authorship of release notes from the publisher. Other named checklist participants still require supported source evidence and protected review; this correction does not create a participant collection protocol.

## Source and protected review

`normalizeGithubObservation` can retain an original publication observation from an authorized enriched release event: a known publisher, a nondraft `published` action, an original occurrence clock, a release identity and its source revision. A current REST release snapshot does not provide the original event sender and cannot mint this publisher observation. Drafts, snapshots and unknown occurrence time remain distinct from observed publication.

The host authenticates the independent review and any applicable release checklist. Text in a GitHub payload, a release body or an evidence request is not an authenticated receipt. The existing optional-controls path still requires current participant consent, source-use review, an exact audited acceptance and the configured independent reviewer. This implementation introduces no new checklist JSON fields, provider access, named-person attestations or automatic checklist approval.

`validateReleaseStewardshipSource` is shared by the direct receipt API and the pipeline before a host receipt callback. It requires exactly one original observed stewardship fact and one corresponding eligible public GitHub release proof, with matching repository, release, publisher, canonical event, metric and role. The role must also match the unique registered actor using the existing normalizer mapping: bot, GitHub App and service account publishers use `automation`; the other existing kinds use `author`. The proof must retain a nonempty source revision and the same valid publication clock. Optional display metadata, when supplied, must describe that original publication. Reusing a qualified result as source, accepting before publication, or substituting an unrelated artifact fails closed.

Opaque revisions remain supported through the existing protected source adapter. They are revision identities, not cryptographic attestations or independent proof of source access. Synthetic kernel fixtures remain usable for private validation; runtime provenance and publication authority continue to govern actual public reads.

## Conserved unit and clocks

The accepted source's existing `canonicalKey` identifies one publisher/release participation. The direct API preserves the established default recognized ID and canonical ID. A caller's generic `changesetId` cannot create another stewardship unit or combine unrelated release publications. The pipeline validates each current request before selecting the earliest valid receipt for a repeated unit; acceptance time and then request ID provide deterministic ordering.

The original publication stays in the fact and public proof's `occurredAt`. The independent decision remains in `acceptedAt`. Accepted public metadata deliberately uses `sourceAction: recognition_accepted`, while `sourceOccurredAt` continues to describe publication. It must not be changed back to an observed action on accepted metadata.

The pipeline accepts this destination only with:

```json
{
  "metricId": "release_stewardship",
  "dateBasis": "occurredAt",
  "groupBy": "canonical",
  "rankedStates": ["qualified"]
}
```

These are the relevant policy fields, not a complete signed policy. The existing definition version, exact unit, explicit source and actor-role selections, review authority and configuration approval are still required. The generic metrics engine retains its explicit date-basis contract; the stewardship pipeline rejects an `acceptedAt` policy instead of silently interpreting it as publication time.

| Input | Previous receipt behavior | Corrected behavior |
| --- | --- | --- |
| Publication on October 7, independent review on October 9 | Generic pipeline required the acceptance clock; top-level proof occurrence became October 9. | Publication-window unit and proof occurrence remain October 7; acceptance remains October 9. |
| Two current request aliases for the same publisher/release | Repeated receipt materialization could conflict; direct changeset aliases could mint distinct identities. | Canonical identity is fixed to the original source; the pipeline retains the earliest fully validated receipt. |
| Unknown publication time or review before publication | A same-metric receipt could qualify it using the acceptance clock. | Source admission fails before the receipt callback. |
| Publisher is an automated account | Raw automation attribution already exists. | The same actor kind and automation role remain; explicit actor filters still apply. |

## Saved authority and scope

`release-stewardship-publication/v1` is a scoped recognition-authority marker. A configuration selecting this destination retires earlier saved fingerprints, including when no accepted request currently exists. Current and pinned reads must pass the same current-control check; reopening the persisted store does not restore obsolete authority. Re-materialization requires the current source and review to satisfy the corrected contract. Withdrawal, suppression, consent changes and source-use amendments keep their existing fail-closed behavior.

Every unrelated metric binding keeps the previous fingerprint encoding. There is no change to the 98-metric registry, provider or normalization generations, global scan keys, metric maturity, or public activation requirements. The correction addresses publisher-source admission and does not by itself complete all release, deployment, maintenance or operations acceptance in #77.

## Validation boundaries

The direct and pipeline tests use fictional normalized release observations and independently constructed private-control records. Literal historical fingerprints and default recognized identifiers were captured from the unchanged accepted implementation; the tests do not reimplement its hash algorithm. The persisted test uses the existing protected `SourceAdapter` seam for an observed release transition and a disposable database. It verifies current and pinned read rejection across reopen and repair; it does not claim stock REST publisher-history collection, a real checklist review, or production rollout.
