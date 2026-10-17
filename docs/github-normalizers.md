# GitHub evidence normalizers

`@pick-your-ai/github` exports `normalizeGithubObservation`, `createGithubEvidenceNormalizer`, `applyRecognitionReceipt`, `groupTriageTransitions`, `parseDeclaredCoauthorTrailers`, `classifyPhysicalDiff`, and `readPinnedGitDiff`. These form the source-to-metric boundary for the engineering and issue-stewardship packages [#65](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/65), [#66](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/66), [#67](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/67), [#68](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/68), [#76](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/76), [#77](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/77), [#78](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/78), [#79](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/79), [#87](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/87), [#96](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/96), and [#104](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/104). No metric or source capability is enabled by importing this package.

## Verified input and output

The core accepts a `GithubEvidenceEnvelope`: an explicitly authorized repository ID/slug/visibility, verified collector provenance, source revision, observation time, optional exact event ID/time, and API/webhook data. Only the trusted collector may set `proof.verified`, `proof.isSynthetic`, verified coauthors, lineage, integration pins and review-cohort proofs. An untrusted payload cannot promote itself to verified evidence. Authorization, installed-App capability, current repository allowlists and privacy revocation remain host responsibilities.

Only explicitly public repositories and safe GitHub artifact URLs produce public evidence. Missing actor IDs, unverified actor kinds and missing event time remain unknown; login, assignee, current creator, current order and updated_at never become historical editors or execution-mode evidence. Numeric actor/repository IDs align with ingestion controls; authoritative node IDs are preserved. Actor kind remains separate from an independently declared execution mode. User-account activity is not certified manual. Returned objects contain allowlisted fields, never raw bodies, commit emails, credentials or unparsed API payloads.

`NormalizedGithubResult` contains structurally compatible metric `facts`, stable `actors`, contract-shaped public `evidence`, source `observations`, explicit `reasons`, `lineage`, `suppressArtifactIds`, shared `participation`, declared model `assistance`, and the trusted `isSynthetic` flag. Source observations retain occurrence and observation time separately. Stable fact/canonical IDs use metric, conserved unit, actor and evidence class; the same creation/merge source fact hydrated through REST and a webhook has the same metric fact ID. Preserve all observations while counting each stable unit once. Conflicting timestamps/actors remain ambiguous in the metric engine rather than selecting an invented attribution.

Public evidence uses contribution IDs matching fact IDs. `qualification: eligible` with `reasonCodes: [raw_observed_only]` means eligibility for a raw observation board, not acceptance of an outcome. Qualified recognition is a separate fact with independent receipt provenance. The API's evidence date is the effective raw/acceptance clock; original source dates remain on the fact and observation.

## Collection pipeline adapter

```ts
const normalize = createGithubEvidenceNormalizer({
  client,                         // GithubReadClient; read-only transport
  source: installationScopeId,     // same authorization/quota boundary
  allowedRepositoryIds,            // protected host configuration
  isSynthetic: false,
});

const normalized = await normalize({
  repository: { id: repositoryId, slug: repositorySlug },
  family, factKey, fact, observedAt, policyVersion,
});
```

The default adapter hydrates issues, pull requests, commits, reviews, issue comments and releases through read-only API routes. It verifies current repository ID/public visibility, exact subject identity, and source revision against the hydrated immutable SHA or source timestamp. An opaque collection revision needs a trusted `verifyRevision(input, payload)` callback backed by the collector's provenance store. A changed/unknown revision returns an explicit reason, not fabricated historical data. Current issue snapshots can establish immutable creation author/time, but cannot manufacture the latest closer or an edit actor. Review hydration fetches its parent PR independently so reviewer and author remain distinct.

Other event families require an authorized `enrich(input)` callback returning the richer verified envelope. Scope/revision must match the collected fact. The callback can supply actual timeline/webhook events, verified integration/diff manifests and independently reviewed relationship receipts; it must not infer missing fields from snapshots. Optional `acceptance(input, normalized)` is a protected receipt lookup, with an explicit `authorizedReviewerIds` allowlist. Public request bodies must never configure it. Production composition must reject synthetic output and apply suppression directives even when an adapter returns no metric facts.

## Supported engineering semantics

- PR creation, evidenced readiness, merge authorship, merge operation and decided-in-window merged/closed-unmerged/pending diagnostics are separate. Reopen/reclose observations never become another merged-PR identity. Target branch is explicit; current draft=false does not prove original readiness.
- Verified coauthor account links create participation records and a separate coauthored facet, while one PR remains one conserved PR. A declared model/version trailer is assistance metadata. Unknown trailer names remain unresolved. No email is output and no fractional effort is inferred.
- Review submissions retain APPROVED, CHANGES_REQUESTED and COMMENTED states as raw evidence. Distinct-PR policies group actor/artifact; separate review rounds retain review-object identity. Pending reviews are not submissions, dismissals are explicit excluded current observations, and review quality requires a receipt. COMMENTED feedback may qualify through the same independent outcome acceptance as approvals. Current resolvedBy alone cannot establish period credit; exact timestamped resolution transitions can.
- Verified readiness cohorts preserve first-ready and first-submitted-review times, including unknown readiness and unresolved censoring. The metric engine supplies distributions/sample counts without speed ranking. Complete source history and cohort selection still require the source capability gate.
- Commit authors and committers remain separate participation roles. Integrated commit counts require explicit pinned default-branch integration and commit membership; branch presence alone does not establish delivery. Supplied evidence-bearing squash, cherry-pick, mirror and import lineage is retained. Explicit revert lineage annotates original contributors without erasing historical merges, awarding the reverter an outcome, or imposing a penalty.
- Release publication uses the evidenced sender and event time, including bot/app publication. The release creator does not become every publisher or notes author. Green CI never creates maintenance, deployment or incident merit. These categories require accepted receipts.

## Physical changes and local fallback

`classifyPhysicalDiff` accepts distinct pinned before/after SHAs and an explicitly complete/truncated file manifest. It reports additions, deletions, changed lines, signed net and changed files separately. Source, tests and docs are separate classes. Deterministic path rules and supplied provenance flags exclude generated output, vendor dependencies, lockfiles, binary files, imports and formatting-only changes from eligible totals. Renames retain old/new paths; unchanged renamed files add no lines. These are physical text changes, not human effort, quality or sole authorship.

Delivered LOC facts require a verified default-branch integration whose diff pins match the manifest; intermediate stacked merges retain PR participation without delivered LOC. Stable canonical integration units prevent duplicate representations from adding delivered changes. Incomplete/truncated manifests produce no complete LOC fact. Raw observed file counts remain available with the incompleteness reason. Signed net is a descriptive sidecar; the current nonnegative metric engine does not enable `net_lines`.

`readPinnedGitDiff` provides an actual bounded fallback against an already authorized local repository. It runs Git directly without a shell, fetch, checkout, external diff or textconv; both refs must be immutable hexadecimal SHAs. Output bytes, file count and execution time are bounded. A separate whitespace-insensitive comparison identifies entirely formatting-only changes; file paths are validated. Missing local history or a failed/bounded-out command fails instead of certifying complete LOC. This fallback does not clone repositories or expand credentials. Imported/generated provenance that cannot be established must remain a source limitation.

## Stewardship and recognition receipts

Issue creation, closure stewardship and implementing outcomes stay separate. A closer does not become the implementer; an assignee or bulk planning batch does not prove accepted findings, bug confirmation, completion, reproduction, mentoring or unblocking. Comments are pending answer evidence until independently accepted.

Exact label/assignment/milestone/type events preserve sender, action, target identity and event time. Label removals are triage observations, not label additions. Label definition changes and milestone definition changes are separate from item membership; renames retain definition identity. Metadata no-ops are excluded when before/after evidence proves equality. Public pin/unpin/lock/unlock are descriptive facets only; there is no private moderation or sanctions intake.

Native issue fields, Project item custom fields, Project status transitions and Project progress publications have four separate dispatch paths and tests. Each requires exact event ID, sender/time and before/after change evidence. Project snapshots produce context only, never historical editor credit. Body/title edits likewise require a real before/after difference and actor-bearing event; semantic clarification/correction remains receipt-based.

Relationship types retain parent/child and blocked-by direction. Related/information links do not become blockers. Reverse representations of an intentional symmetric link share one canonical unit; automatic cross-references do not create intentional-link merit. Public transfer lineage preserves issue identity and grants no new issue creation/authorship credit. Private, unknown or unapproved destinations produce suppression directives; historical projections must obey those controls. Current ordering cannot identify who reordered items.

`groupTriageTransitions` requires an explicit reviewed policy version, adjacency interval and cooldown. It groups per actor/artifact/facet/target, deduplicates exact event IDs, rejects conflicting IDs, marks groups returning to their initial state as reversal-suppressed, and marks repeated terminal states within cooldown. Raw counts remain inspectable. It always reports zero qualified outcomes: persistence, churn suppression and grouping never prove correctness. A scripted batch therefore cannot spill into unrelated accepted-outcome boards. Policy approval, actual triager review and pathological real-source audits remain acceptance work.

`applyRecognitionReceipt` accepts independently authenticated host receipts with known contributor, distinct authorized reviewer, acceptance time, exact target fact and supporting evidence IDs. Accepted/rejected decisions remain explicit and raw evidence stays intact. Supported subjective categories include accepted findings, confirmed bugs, resolution support, label corrections, clarifications, accepted review suggestions, release/automation/maintenance, sanitized deployment/reliability, reproduction, accepted answers, routing, mentoring/onboarding, Project configuration and ordering. A `changesetId` conserves a reviewed configuration/ordering operation across its affected items rather than manufacturing one outcome per child. These receipts do not authorize public release by themselves.

## Remaining acceptance

Synthetic API/webhook fixtures and a real temporary Git repository demonstrate stable duplicate IDs, raw-versus-qualified separation, actor/role/privacy boundaries, review states, scoped fields, triage reversal/cooldown, transfer suppression, pinned stacked integration, line exclusions and bounded fallback. They are not real contribution evidence. The modeled stacked fixture is not a claimed audit of the actual research sequence. Exact historical source reconciliation, installed-App subtype probes, live repository canaries, accepted grouping/recognition policy, authorized receipts, active contributor/triager review and public release acceptance remain open. Retained-line blame, inferred coauthor effort, semantic review-quality detection, snapshot-derived edit history and private moderation remain disabled.

Run `npm test --workspace @pick-your-ai/github`, `npm run typecheck --workspace @pick-your-ai/github` and the repository's planning checks. Definitions and all 98 metrics remain unchanged.
