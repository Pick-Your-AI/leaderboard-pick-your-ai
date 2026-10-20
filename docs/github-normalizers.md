# GitHub evidence normalizers

`@pick-your-ai/github` exports `normalizeGithubObservation`, `createGithubEvidenceNormalizer`, `applyRecognitionReceipt`, `groupTriageTransitions`, `parseDeclaredCoauthorTrailers`, `classifyPhysicalDiff`, and `readPinnedGitDiff`. These form the source-to-metric boundary for the engineering and issue-stewardship packages [#65](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/65), [#66](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/66), [#67](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/67), [#68](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/68), [#76](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/76), [#77](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/77), [#78](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/78), [#79](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/79), [#87](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/87), [#96](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/96), and [#104](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/104). No metric or source capability is enabled by importing this package.

## Verified input and output

The core accepts a `GithubEvidenceEnvelope`: an explicitly authorized repository ID/slug/visibility, verified collector provenance, source revision, observation time, optional exact event ID/time, and API/webhook data. Only the trusted collector may set `proof.verified`, `proof.isSynthetic`, verified coauthors, lineage, integration pins and review-cohort proofs. An untrusted payload cannot promote itself to verified evidence. Authorization, installed-App capability, current repository allowlists and privacy revocation remain host responsibilities.

Only explicitly public repositories and safe GitHub artifact URLs produce public evidence. Missing actor IDs, unverified actor kinds and missing event time remain unknown; login, assignee, current creator, current order and updated_at never become historical editors or execution-mode evidence. Numeric actor/repository IDs align with ingestion controls; authoritative node IDs are preserved. Actor kind remains separate from an independently declared execution mode. User-account activity is not certified manual. Returned objects contain allowlisted fields, never raw bodies, commit emails, credentials or unparsed API payloads.

`NormalizedGithubResult` contains structurally compatible metric `facts`, stable `actors`, contract-shaped public `evidence`, source `observations`, exact source `decisions`, explicit `reasons`, `lineage`, `suppressArtifactIds`, shared `participation`, declared model `assistance`, and the trusted `isSynthetic` flag. Source observations retain occurrence and observation time separately. Stable fact/canonical IDs use metric, conserved unit, actor and the actual evidence class: pending and unknown records never collide with later observed records. The same creation/merge source fact hydrated through REST and a webhook has the same metric fact ID. Preserve all observations while counting each stable unit once. Conflicting timestamps/actors remain ambiguous in the metric engine rather than selecting an invented attribution.

Public evidence uses contribution IDs matching fact IDs. `qualification: eligible` with `reasonCodes: [raw_observed_only]` means eligibility for a raw observation board, not acceptance of an outcome. Qualified recognition is a separate fact with independent receipt provenance. The API's evidence date is the effective raw/acceptance clock; original source dates remain on the fact and observation and in the optional [strict public metadata projection](public-evidence-metadata.md). That projection adds bounded as-collected labels, actual credited-fact actions, independent acceptance time without private receipt identifiers, and explicitly public partial history records.

The [contributor identity foundation](contributor-identity-foundation.md) distinguishes
the pipeline's stable serving aliases from node-first source-event identity, and
unavailable source attribution from protected account-wide suppression.

## Reviewed service accounts

See [service-account classification and migration](service-account-classification.md)
for the protected `reviewedServiceAccounts` / `authorizedClassifierIds` inputs.
The versioned review record classifies a source `User` account by stable IDs,
never a login pattern or model trailer. Native Bot and App kinds remain
separate. The internal `serviceAccountClassification` provenance survives
normalization; public profiles and exports expose only the account kind and
execution mode, never private classification receipts.

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

The default adapter hydrates issues, pull requests, commits, reviews, issue comments, releases and native Discussions through read-only API routes. It verifies current repository ID/public visibility, exact subject identity, and source revision against the hydrated immutable SHA, source timestamp or native Discussion fingerprint. An opaque collection revision needs a trusted `verifyRevision(input, payload)` callback backed by the collector's provenance store. A changed/unknown revision returns an explicit reason, not fabricated historical data. Current issue snapshots can establish immutable creation author/time, but cannot manufacture the latest closer or an edit actor. Review hydration fetches its parent PR independently so reviewer and author remain distinct. Native answer clocks and retained normalization authority follow the [Discussion chronology rule](discussion-answer-chronology.md).

Other event families require an authorized `enrich(input)` callback returning the richer verified envelope. Scope/revision must match the collected fact. The callback can supply actual timeline/webhook events, verified integration/diff manifests and independently reviewed relationship receipts; it must not infer missing fields from snapshots. Optional `acceptance(input, normalized)` is a protected receipt lookup, with an explicit `authorizedReviewerIds` allowlist. Public request bodies must never configure it. Production composition must reject synthetic output and apply suppression directives even when an adapter returns no metric facts.

## Supported engineering semantics

- PR creation, evidenced first readiness, merge authorship, merge operation and decided-in-window merged/closed-unmerged/pending diagnostics are separate. A ready toggle alone cannot establish the first-ready clock: `reviewCohort.verified` with `firstReadyAt` is required. Reopen/reclose observations never become another merged-PR identity. Target branch is explicit; current draft=false does not prove original readiness. Raw decision metadata is retained, but ratio facts require trusted `decisionCohort` selection whose asOf exactly matches `frozenCutoff` and whose outcome/time match the source. The host must select one current decision per PR at that cutoff and reject competing decided histories; the normalizer never chooses a lifecycle winner from closed/reopened/merged snapshots. The default hydration adapter provides no advanced cohort proof, so ratios remain unavailable until that verified history adapter exists.
- Verified coauthor account links create participation records and a separate coauthored facet, while one PR remains one conserved PR. Repeated linked accounts are deduplicated and the primary author is not credited again as their own coauthor. Unmerged coauthorship stays pending without a fabricated merged_at clock. A declared model/version trailer is assistance metadata. Unknown trailer names remain unresolved. No email is output and no fractional effort is inferred.
- Review submissions retain APPROVED, CHANGES_REQUESTED and COMMENTED states as raw evidence. Distinct-PR participation excludes self-review and non-user accounts and requires verified `reviewParticipation.firstSubmittedAt`. Review rounds require an authoritative full `commit_id`/`commitOid` and verified `roundFirstSubmittedAt`, conserving one reviewer/PR/head unit. Later submissions cannot substitute a new period clock. Feedback groups require actual created_at/createdAt; submitted_at is not silently substituted. Unknown first milestones or heads remain unavailable until history enrichment supplies proof. Pending reviews are not submissions, dismissals are explicit excluded current observations, and review quality requires a receipt. COMMENTED feedback may qualify through the same independent outcome acceptance as approvals. Current resolvedBy alone cannot establish period credit; exact timestamped resolution transitions can.
- Verified readiness cohorts preserve first-ready and first-submitted-review times, including unknown readiness and unresolved censoring. The metric engine supplies distributions/sample counts without speed ranking. Complete source history and cohort selection still require the source capability gate.
- Commit authors and committers remain separate participation roles. Integrated commit counts require explicit pinned default-branch integration and commit membership; branch presence alone does not establish delivery. Supplied evidence-bearing squash, cherry-pick, mirror and import lineage is retained. Explicit revert lineage annotates original contributors without erasing historical merges, awarding the reverter an outcome, or imposing a penalty.
- Release publication uses the evidenced sender and event time, including bot/app publication. The release creator does not become every publisher or notes author. Green CI never creates maintenance, deployment or incident merit. These categories require accepted receipts.

See [persisted default-delivery migration](default-delivery-cache-migration.md) for the observed repository-default requirement, built-in/custom provider version contract, retained-cache replacement, and historical publication recovery.

## Physical changes and local fallback

`classifyPhysicalDiff` accepts distinct pinned before/after SHAs and an explicitly complete/truncated file manifest. It reports additions, deletions, changed lines, signed net and changed files separately. Source, tests and docs are separate classes. Deterministic path rules and supplied provenance flags exclude generated output, vendor dependencies, lockfiles, binary files, imports and formatting-only changes from eligible totals. Renames retain old/new paths; unchanged renamed files add no lines. These are physical text changes, not human effort, quality or sole authorship.

Both `classifyPhysicalDiff` and `readPinnedGitDiff` require matching pin widths and reject identical object IDs, including hexadecimal case aliases, before classifying files or invoking Git. The local reader also checks the repository's storage object format before either diff: SHA-1 repositories require 40-digit pins and SHA-256 repositories require 64-digit pins. Abbreviated IDs and compatibility-format pins are not admitted. This bounded local [`rev-parse --show-object-format=storage`](https://git-scm.com/docs/git-rev-parse) check retains the caller's resource limits and all Git isolation flags. For distinct revisions, the supplied pin spelling is preserved; distinct commits with identical trees remain a complete zero-change diff.

Delivered LOC facts require a verified default-branch integration whose diff pins match the manifest; intermediate stacked merges retain PR participation without delivered LOC. Stable canonical integration units prevent duplicate representations from adding delivered changes. `files_changed` emits one canonical fact per eligible path, without a summed quantity; its policy must count canonical units rather than collapsing all paths under one PR artifact. Incomplete/truncated manifests produce no complete LOC fact. Raw observed file counts remain available with the incompleteness reason. Signed net is a descriptive sidecar; the current nonnegative metric engine does not enable `net_lines`.

`readPinnedGitDiff` provides an actual bounded fallback against an already authorized local repository. It runs Git directly without a shell, fetch, checkout, external diff or textconv; both refs must be full 40- or 64-digit hexadecimal SHAs. Output bytes, file count and execution time are bounded. All line components and combined totals must be safe integers. A separate whitespace-insensitive comparison identifies entirely formatting-only changes; file paths are validated. Missing local history or a failed/bounded-out command fails instead of certifying complete LOC. This fallback does not clone repositories or expand credentials. Imported/generated provenance that cannot be established must remain a source limitation.

## Stewardship and recognition receipts

Issue creation, closure stewardship and implementing outcomes stay separate. A closer does not become the implementer; an assignee or bulk planning batch does not prove accepted findings, bug confirmation, completion, reproduction, mentoring or unblocking. Comments are pending answer evidence until independently accepted.

Exact label/assignment/milestone/type events preserve sender, action, target identity and event time. Label removals are triage observations, not label additions. Every target-dependent transition, including removal and issue-type changes, requires its own stable target identity. An absent target or a display name alone emits an unknown fact without a raw-state value; another metadata field or current item snapshot cannot fill the gap. Label definition changes and milestone definition changes are separate from item membership; renames retain definition identity. Metadata no-ops are excluded when before/after evidence proves equality. Public pin/unpin/lock/unlock are descriptive facets only; there is no private moderation or sanctions intake.

Native REST `issue_type_added` and `issue_type_removed` events map to the existing `issue_typed` and `issue_untyped` raw actions. The source observation retains the native name; the raw grouping and public evidence use the canonical action. The collection revision fingerprint binds the event's own type target before hydration can emit a fact. Missing targets remain unknown, and all pre-existing non-type event fingerprints are unchanged. Other type transitions remain unsupported until their complete source-specific evidence is handled. The [original Android/Apple planning-batch audit](triage-fairness-audit.md) records the observed gap, corrected replay and limits for every LB-08 category.

Native issue fields, Project item custom fields, Project status transitions and Project progress publications have four separate dispatch paths and tests. Each requires exact event ID, sender/time and before/after change evidence. Project snapshots produce context only, never historical editor credit. Body/title edits likewise require a real before/after difference and actor-bearing event; semantic clarification/correction remains receipt-based.

Field-change before/after values follow the JSON value model: object member order
is irrelevant recursively, while array order, member presence and scalar types
remain significant. This matches [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259#section-4).
The comparison uses the existing JSON serialization projection; it does not
change source revision fingerprints or retain raw field values. Reordered object
members therefore preserve the source observation without creating an update
fact. Genuine changes still use the evidenced editor, source clock and raw
observed state, with no invented acceptance receipt.

The `field-change-json-values/v1` normalization generation also covers persisted
claims for these four field metrics, including authorized enrichment collected
under another source family. Current normalization rehydrates an older affected
cache even when its source revision and observation clock are unchanged. The new
generation remains selected if the corrected output contains no field facts;
an obsolete positive cache cannot regain authority. Historical normalization
documents and frozen inputs remain intact. Affected current, pinned and private
publication reads require the current generation before exposing those results;
unrelated metric publications retain their existing authority.

The built-in package exports `fieldChangeNormalizationVersion`. A custom
normalizer must explicitly declare this compatible generation in the protected
runtime options. An enrichment callback still passes through the built-in field
comparator, so its host cannot label an older built-in package as compatible.
The [source-to-metric cases](../packages/metrics/test/field-change-source-semantics.test.js)
and [persisted-generation cases](../apps/pipeline/test/field-change-generation.test.mjs)
use synthetic envelopes and local databases. They establish neither a native
Project change capability nor metric enablement, approved grouping or completion
of [#72](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/72) or
[#79](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/79).

Relationship types retain parent/child and blocked-by direction. Related/information links do not become blockers. The collector must independently verify both endpoints are public and set `relationship.publicEndpointsVerified`; a public container alone does not establish a linked private item's visibility. Reverse representations of an intentional symmetric link share one canonical unit; automatic cross-references do not create intentional-link merit. Public transfer lineage preserves issue identity and grants no new issue creation/authorship credit. Private, unknown or unapproved destinations produce suppression directives; historical projections must obey those controls. Current ordering cannot identify who reordered items.

An enriched public transfer must identify an issue at each endpoint, with complete
`owner/repository` coordinates, a canonical positive safe-integer issue number,
an explicit destination identity and a different positive destination repository
ID. Pull-request payloads, pull-request URLs, repository roots and extra path
segments cannot establish issue-transfer lineage. Missing source actor or event
time remains unknown; another reporter, assignee, update time or later observation
cannot supply it. Reobserving the same transfer preserves its canonical unit;
forward and reverse transfers remain descriptive observations, with no qualified
outcome or new issue-creation credit.

For a known source artifact, a private, unknown, missing or unapproved destination
still produces a suppression directive when the public source locator is absent
or unusable. The directive does not require an attributable actor or event time.
The pipeline must apply it to retained snapshots as well as the current board.
The [transfer admission cases](../packages/github/test/issue-transfer-admission.test.mjs)
exercise 28 source-admission, replay and privacy cases. Two additional
[pipeline cases](../apps/pipeline/test/transfer-visibility.test.mjs) feed the actual
normalizer into the synthetic PGlite/SQLite runtime and verify durable suppression,
cached-board filtering, pinned evidence withdrawal and JSON/CSV export filtering.
They do not represent live GitHub events or installed-service qualification.

The `github-issue-transfer-admission/v1` normalization generation also reprocesses
unchanged source revisions cached before these admission rules. It retains the
previous normalization generation for frozen identity authorization and preserves
historical normalization documents and frozen inputs. The two
[cache migration cases](../apps/pipeline/test/transfer-cache-migration.test.mjs)
seed output from the exact legacy normalizer using a
[synthetic fixture](../tests/fixtures/legacy-transfer-admission.json), restart with
unchanged source revisions and observation clocks, and verify that current and
pinned boards, evidence and JSON/CSV exports obey the new suppression. They also
verify that the original cached documents and frozen inputs remain intact.

Frozen reads also retain the pre-transfer Review, Discussion and default-delivery
cache generations, including delivery wrappers on enriched source families.
Their source-version, exact source-binding and document-hash checks still apply.
Reprocessing adds the current generation without changing the retained record.
An integrity-valid, same-policy pre-transfer cache also retains its delivery
classification when recalculation produces no delivery facts. Only the
classification crosses that boundary; the current normalizer rehydrates the
source, and the new cache keeps the current delivery version. This applies to
enriched source families as well as commits and pull requests. The
[classification migration cases](../apps/pipeline/test/transfer-delivery-classification-migration.test.mjs)
verify an actual database reopen, preservation of the old cache and frozen input,
and rejection of a corrupt historical classification record.

Current normalization applies the transfer-admission wrapper to the
`project-membership-context/v2` generation. Frozen identity reads retain the
original Project v1, transfer-wrapped Project v1 and unwrapped Project v2 keys,
including each review, Discussion and default-delivery wrapper. Every selected
same-source, same-policy predecessor is checked for document integrity and data
mode before either its classification or an existing current cache is used.
The [combined migration cases](../apps/pipeline/test/project-transfer-cache-migration.test.mjs)
cover empty-result classification across both upgrades and reject a corrupt
predecessor even when a valid current delivery cache is already present.

GitHub's native GraphQL
[`TransferredEvent`](https://docs.github.com/en/graphql/reference/issues#transferredevent)
exposes the source repository and associated issue, but no immutable historical
destination field. The current issue repository cannot establish every earlier
transfer destination. These tests exercise an explicitly enriched envelope;
they add no native transfer collector, installed-App capability, reviewed metric
enablement or qualified routing receipt. This bounded COV15 contribution does not
complete [#72](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/72)
or the separate semantic, inclusion and enablement acceptance for all 98 metrics.

Field-change, triage and relationship subtype lookups accept only entries explicitly declared in their metric maps. Inherited object-property names cannot create a fact or contribution evidence. Relationship kinds must be literal supported strings; arrays and objects are not coerced into a supported kind. Unsupported inputs retain their raw observation and existing reason code. The valid metric identities, actor/time handling, endpoint checks and canonical relationship units are unchanged.

`groupTriageTransitions` requires an explicit reviewed policy version, adjacency interval and cooldown. It groups per actor/artifact/facet/target, deduplicates exact event IDs, rejects conflicting IDs, marks groups returning to their initial state as reversal-suppressed, and marks repeated terminal states within cooldown. Raw counts remain inspectable. It also returns a global distinct-artifact count and sorted per-actor raw-action, session and distinct-artifact summaries; unknown actor/artifact/time events cannot invent those totals. It always reports zero qualified outcomes: persistence, churn suppression and grouping never prove correctness. A scripted batch therefore cannot spill into unrelated accepted-outcome boards. The [definition-day and session policy](triage-definition-grouping.md) specifies the exact boundaries and counting scopes. Runtime policy approval, actual triager review and pathological real-source audits remain acceptance work.

Label and milestone definition events always select their own stable definition artifact, including when an envelope also carries issue context. `triage-definition-day/v1` groups their facets once per actor/repository/definition/UTC day, with separate proven source-day and independently accepted receipt-day lenses. Label applications and issue milestone membership never become definition credit. Missing history remains unknown, and neither definition gains a selectable public view from this grouping implementation.

`applyRecognitionReceipt` accepts independently authenticated host receipts with known contributor, distinct authorized reviewer, acceptance time, exact target fact and supporting evidence IDs. Accepted/rejected decisions remain explicit and raw evidence stays intact. Supported subjective categories include accepted findings, confirmed bugs, resolution support, label corrections, clarifications, accepted review suggestions, release/automation/maintenance, sanitized deployment/reliability, reproduction, accepted answers, routing, mentoring/onboarding, Project configuration and ordering. A `changesetId` identifies one reviewed configuration operation; the host selects one representative target/scope fact per changeset, rather than materializing a receipt once per affected child. Ordering instead requires the [reviewed ordering profile](ordering-recognition.md): its actor/repository/scope/public-plan identity ignores supplied `changesetId` values and validates every receipt before plan deduplication. Conflicting duplicate receipt materializations fail closed. These receipts do not authorize public release by themselves.

Release stewardship receipts use the original observed publisher/release identity and publication clock, with independent review recorded separately. The direct receipt API uses the shared validator, and the pipeline runs it before its host receipt callback, and only selected stewardship authority is retired. See [release stewardship publication admission](release-stewardship-recognition.md) for the supported host boundary, conserved unit, exact policy fields and remaining named-participant limitations.

## Remaining acceptance

Synthetic API/webhook fixtures and a real temporary Git repository demonstrate stable duplicate IDs, raw-versus-qualified separation, actor/role/privacy boundaries, review states, scoped fields, triage reversal/cooldown, transfer suppression, pinned stacked integration, line exclusions and bounded fallback. They are not real contribution evidence. The modeled stacked fixture is not a claimed audit of the actual research sequence. Exact historical source reconciliation, installed-App subtype probes, live repository canaries, accepted grouping/recognition policy, authorized receipts, active contributor/triager review and public release acceptance remain open. Retained-line blame, inferred coauthor effort, semantic review-quality detection, snapshot-derived edit history and private moderation remain disabled.

Run `npm test --workspace @pick-your-ai/github`, `npm run typecheck --workspace @pick-your-ai/github` and the repository's planning checks. All 98 metric IDs remain retained; the corrected triage definition and candidate-version compatibility are documented in [UI registry policy](../packages/metrics/UI_REGISTRY.md).
