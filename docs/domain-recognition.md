# Revision-bound specialist contribution evidence

Partial implementation for [#77](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/77),
[#80](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/80),
[#81](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/81),
[#82](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/82),
[#88](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/88),
[#89](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/89),
[#90](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/90) and
[#96](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/96).

The private pipeline can materialize reviewed research, catalog, craft and
operations contributions from an exact collected source revision. These are the
existing 24 registry metrics, with their existing units and event clocks. Decision records
and localization retain their separate record/blob and locale/category source
adapters. No metric,
source grant, production catalog, reviewer roster or policy is activated by this
change. The public API does not accept the evidence records described here.

## Trust and review boundary

The host supplies `recognitionBindings` in its independently verified private
configuration. A matching accepted controls request still needs an independent
authorized reviewer, who is neither its owner nor a listed collaborator, and
exactly one matching private audit entry. The source repository, public artifact
URL, owner and source metric must select exactly one collected fact.

For a specialist metric, the binding also supplies `domainEvidence` with exactly
these keys:

| Key | Meaning |
| --- | --- |
| `version` | `domain-evidence/v1` |
| `ownerIds` | Enrolled affected-owner reviewers for catalog, pricebook, compatibility, evidence-manifest, data-correction, reproduction, governance, deployment-work and reliability acceptance |
| `contractReviewerIds` | Central compatibility reviewers, additionally required for compatibility recognition |
| `disclosureReviewerIds` | Public-disclosure reviewers, additionally required for security recognition |
| `freshnessIntervalSeconds` | Reviewed recheck interval, an integer from 1 second through 366 days, used only for freshness units |
| `records` | At most 1,000 private evidence records; exactly one must match the request |

The record has exactly `requestId`, `requestVersion`, `decisionId`, `factId`,
`sourceRevision`, `sourceRevisionUrl`, `validUntil`, `synthetic`, `publicSafe` and
`details`. Its request version, accepted decision and collected fact must match
the current private state. The accepted decision must have the same version as
the request; editing a request after acceptance requires a new decision and
matching evidence record. `synthetic` must be false, `publicSafe` true, and
`validUntil` must include both acceptance and the publication's observation
cutoff. It limits the cutoff for which this reviewed source revision may be
used; current publication consent is revoked through the private controls and
configuration, which also fence historical reads.

The record's immutable GitHub commit/blob URL and complete 40- or 64-character
lowercase hexadecimal revision must equal the collected evidence's pin.
Intermediate lengths are rejected even if both repeat the same malformed value
and URL. Merged PR observations gain
a pin only with a complete, matching default-branch integration diff whose after
revision equals the provider's merge commit. An intermediate branch, missing or
incomplete diff, changed merge SHA, mutable PR timestamp or URL alone cannot
establish this pin. This initial path requires such collected immutable evidence;
unsupported external artifact and contributor roles remain unqualified.

These records are protected reviewer attestations, not an automated validator
for the contents of a research artifact. The enrolling host must actually review
the named artifact, source permissions, canonical identity, frozen contract,
validator results, contributor attribution and applicable owner authority before
signing the configuration. A boolean inside a submitted public manifest cannot
supply that authority. The research repository continues to own its taxonomy,
contracts and factual acceptance; no frozen builder contract is copied or changed.

Bindings use the controls service's existing request categories. For example, a
host may enroll category `other` with a reviewed scope such as
`repository:2:documentation:guide`. Separate canonical units from one public
artifact need distinct enrolled scopes when the controls service's duplicate-claim
rule would otherwise select the same owner, locator, category and scope. The host
must define those mappings before accepting requests.

## Qualification and canonical units

`details` uses an exact schema for each metric. IDs are bounded, hashes are exact
SHA-256 values, times use the shared timestamp contract, and unrecognized keys or
enum values fail closed. The table summarizes the implemented requirements; the
executable schemas are in `apps/pipeline/src/domain-recognition.mjs`.

| Metric | Required reviewed context | Countable unit | Clock |
| --- | --- | --- | --- |
| `catalog_proposals` | Canonical kind/ID/version, contract version, factual review, sources and owner review | Canonical kind/ID/version | Acceptance |
| `pricebook_proposals` | Pricebook/version/as-of, currency, units, conditions hash, sources and factual/owner review | Pricebook/version/as-of | Acceptance |
| `compatibility_proposals` | Proposal/version, contract version, explicit research #40 acceptance/narrowing and central plus owner review | Proposal/version | Acceptance |
| `primary_sources` | Available canonical source/claim mapping; primary source, publisher statement or independent measurement identified | Canonical source/claim | Acceptance |
| `freshness_checks` | Canonical source/claim, check time and available/changed/unavailable/unknown/contradicted outcome | Source/claim/policy interval | Check |
| `reproduced_measurements` | Experiment/run, pinned conditions and result hashes, independent real measurement | Experiment/run | Acceptance |
| `negative_findings` | Bounded finding/version, limitation/disproved/unknown outcome and sources | Finding identity | Acceptance |
| `rights_reviews` | Artifact, rights question, terms revision and allowed/excluded/unknown conclusion | Artifact/question | Acceptance |
| `assumptions_resolved` | Decision identity, sources and supported/rejected/unknown conclusion | Decision identity | Acceptance |
| `market_research` | Study/version, explicit method and sources; participant material limited to approved sanitized aggregates | Study identity | Acceptance |
| `evidence_manifests` | Artifact identity/hash, approved source use, sources and owner review | Artifact identity/hash | Acceptance |
| `data_quality` | Correction identity/version and target kind/ID; exact changed before/after pins, factual and owner review, supporting sources and complete reviewed origin | Target kind/ID/correction identity | Acceptance |
| `reproductions` | Actual merged-PR artifact author, independently accepted completed scenario, exact scenario/environment/result pins and explicit observed outcome | Target kind/ID/scenario identity | Acceptance |
| `documentation` | Actual source authorship, substantive review and documentation/example/guide category | PR/category | Merge |
| `tests` | Actual source authorship and substantive test-artifact review | PR/test category | Merge |
| `regressions_prevented` | Scenario and fixture hash, distinct before/after revisions, fails-before and passes-after evidence | Failure scenario | Acceptance |
| `accessibility` | Artifact/version, validated criteria, explicit audit/discovery/delivered-fix phase and review method | Artifact/version/phase | Acceptance |
| `design` | Reviewed flow/component/version, actual author/coauthor/reviewer role and public attribution | Flow/component/version | Acceptance |
| `usability` | Study/version and individually accepted finding/version, explicit method and sources; user studies require approved sanitized aggregates | Study/finding identity | Acceptance |
| `performance` | Scoped result/run, independent comparison of the same conditions, metric and units across distinct revisions, actual improvement | Result/scope | Acceptance |
| `security` | Disclosure/version/time, public-disclosure approval, contributor consent and enrolled disclosure reviewer | Disclosure identity | Public disclosure |
| `governance` | Original merged-PR author, accepted public decision/version, affected-owner review and exact public record pin; permission administration alone excluded | Decision/version | Acceptance |
| `deployment_work` | Original merged-PR author, reviewed public improvement linked to deployment identities, affected-owner review and exact sanitized public record pin | Work artifact identity | Acceptance |
| `incidents` | Original merged-PR author, approved public postmortem/remediation narrative, affected-owner review and exact sanitized public record pin | Reliability contribution identity; spotlight only | Acceptance |

Canonical units include the metric and repository. Repeated accepted requests
for the same actor and canonical unit retain the earliest accepted request,
regardless of input order. New review receipts, terms versions, test runs,
criteria lists, currency/conditions or revised study/disclosure prose cannot
split the same unit into extra credit. Separately accepted record versions,
documentation categories and configured freshness intervals can be distinct
where the registry says so. Usability requires an explicit finding identity,
revision and acceptance within its study context; study-only evidence does not
qualify. Separately accepted findings within one study are distinct units.
Revisions, additional sources and repeated acceptance of the same study/finding
retain one unit. Finding and study identifiers, revisions and acceptance details
remain private; public method reasons do not expose them.

Data corrections require actual source authorship or coauthorship and an
independent affected-owner reviewer. Their `details` contain exactly
`canonicalKind`, `canonicalId`, `correctionId`, `correctionVersion`,
`correctionType` (`incorrect` or `stale`), `factualReview`, `sourceIds`,
`before`, `after` and `origin`. Each before/after pin has exactly `revision`,
`sourceRevisionUrl` and `contentHash`. Revisions and SHA-256 content hashes must
both differ. The two immutable URLs identify the same repository and locator:
either two commits or the same blob path. The after revision and URL must match
the collected source evidence exactly. A changed hash or a passing validator alone does not
establish a factual improvement; the host must review the named before/after
relationship and supporting sources before enrolling the private attestation.

The correction's `origin` has exactly `kind`, `complete` and `contributorIds`.
Complete reviewed `prior_contributors` attribution must be nonempty and exclude
the claimant and every currently listed collaborator. Alternatively, a reviewed
`external_source_change` can explain a stale record, with complete origin and an
empty contributor list. Missing history cannot be interpreted as external
staleness or independence. Unknown or incomplete origin, an unchanged artifact,
an unrelated source, and a correction of an error introduced by the claimant or
a listed collaborator remain unqualified. These are protected review assertions,
not automated judgments of blame. Revisions of one correction's proof, source
list or receipt retain one canonical correction unit; the host must preserve its
canonical identity when accepting another version of the same work.

The stock reproduction adapter consumes the pinned `pr_merged` author fact; it
does not hydrate or pin `pr_coauthored`. The common authorship guard can admit a
source-proven coauthor in a separately trusted `pr_merged` input, which is a
different adapter boundary. A generic same-metric receipt, a mutable comment, issue
authorship or a reviewer role cannot substitute for that source. An independent
audited reviewer must also belong to the enrolled affected-owner roster. The
host reviews the relationship to the exact target and scenario; the adapter does
not infer a defect from a PR title, issue label or target identifier.

Their exact `details` fields are `targetKind`, `targetId`, `scenarioId`,
`scenarioVersion`, `runId`, `completedAt`, `executionComplete`, `scenarioAccepted`,
`outcome`, `scenario`, `environment` and `result`. Execution and scenario acceptance
must both be explicit true values. Completion must be no later than the collected
merge, which must be no later than acceptance. Each of the three proof roles has
exactly `revision`, `sourceRevisionUrl` and `contentHash`: a full 40- or
64-character lowercase Git revision and SHA-256 content hash, with a nonempty
GitHub blob path at the exact collected source revision and repository. A reviewed
combined artifact may serve several roles if each repeated immutable URL has the
same hash. Missing, mutable, unrelated or contradictory proof remains unqualified.

An actually observed `reproduced`, `not_reproduced` or `inconclusive` result can
support an accepted scenario contribution. Unexecuted work and missing results
cannot. This does not create a `confirmed_bugs` fact or certify a bug: that separate
definition requires its own report, confirmation and reporter/contributor
attribution. Scenario, environment and result pins and completion assertions are
protected reviewer evidence, not automated execution, fetched-content certification
or actual measurements supplied by this module. Their contents and the target
association must be reviewed before the host enrolls the configuration.

Canonical reproduction identity includes only the target kind, target ID and
scenario ID within the existing metric/repository/actor grouping. New runs,
environment/result evidence, outcomes, scenario versions or review receipts do
not mint additional credit for the same scenario. A host must preserve this
canonical identity when reviewing another revision. Unsupported comment/external
sources and bug-confirmation attribution remain separate adapters.

The target metric policy must use canonical grouping and the qualified evidence
class, keeping observed participation separate. Its time basis must match the
registry. Source occurrence and acceptance remain independently recorded;
merge/check/disclosure events cannot be later than their acceptance. Performance
comparisons use exact nonnegative decimal strings, including values beyond the
JavaScript integer precision range, and never compare unlike units or conditions.

For `regressions_prevented` and `performance`, both before and after revisions are
complete 40- or 64-character lowercase Git object IDs of the same width for the
same bound repository. Mutable refs, abbreviated IDs, mixed or malformed widths
and uppercase aliases are rejected. The two IDs must differ, and the after ID must
equal the collected source revision. These checks bind distinct immutable revision
identities; they do not establish object existence, verify measurements or execute
the scenario. Independent review and all existing conditions, units, outcomes and
source gates still apply.

Reviewer timestamps support millisecond precision and normalize supported offsets
to UTC for metric events. Finer fractions are rejected because the metric engine
cannot preserve them; they cannot silently round into a different event order or
collapse distinct pricebook as-of units.

The three operations metrics have the stricter original-source and reviewed
public-record boundary specified in [operations recognition](operations-recognition.md).
The stock adapter supports an observed `pr_merged` author with a complete current
default-branch pin. It does not invent coauthor, reviewer, deployment-operator or
external attribution. Governance versions can be separate accepted decisions;
new deployment executions, proof versions or reliability receipt aliases do not
multiply the same canonical work. Bot and execution classifications remain source
facts; a user account is not proof of manual work. Reliability stays a spotlight
definition with no selectable board.

## Publication, revocation and privacy

Raw source facts are retained. Recognition is recomputed from current controls
after source normalization and is never saved into the source normalization
cache. The cache version changes when immutable merge pins are introduced.
Historical frozen identity evidence retains its exact prior policy-bound formats,
including the version-one locale projection with or without the verified merge-pin
wrapper. Every accepted format binds all active documentation and research rules;
its stored records and preview results remain unchanged. Fresh normalization always
uses the current projection, and changing classification cannot admit an older
unclassified cache.

The frozen identity budget remains 10,000 distinct source-and-document pairs.
Byte-identical copies in retained cache generations do not consume additional
source slots. The bounded read still locks and validates every matching cache
copy, so a valid copy cannot hide corruption in another accepted generation.

Synthetic provenance is carried through the pipeline's flattening step, and
specialist recognition rejects a synthetic source even if its private attestation
claims real data. Synthetic fixtures never become actual measurement credit.

The private recognition fingerprint includes current recognition bindings and the
relevant audited decisions, requests and suppression. Removing, replacing or duplicating a used audit
entry invalidates a run's confirmation and previously pinned public reads.
Unrelated audit activity does not revoke recognition. Withdrawal, renewed review,
appeal and contributor suppression continue to remove accepted recognition.
Bindings for `data_quality` additionally pin qualifier authority to
`data-quality-recognition/v1`. Older generic correction publications lack that
authority and are withheld on current and historical reads until recomputed from
valid current evidence. At the data-quality introduction, configurations without
a `data_quality` binding retained their exact preceding fingerprint bytes. A
configuration containing both correction and other metric bindings retires its whole bound snapshot; the authority fence
does not preserve individual metrics inside that mixed snapshot.

Bindings for `reproductions` additionally pin `reproduction-recognition/v1`.
Older generic reproduction publications are withheld until recomputed from the
current specialist evidence. Every configuration without a reproduction binding
retains its exact previous fingerprint, including the established data-correction
marker. A mixed configuration containing reproduction bindings retires its whole
snapshot; this applies even if its accepted requests currently belong to other
metrics.

Bindings for `governance`, `deployment_work` or `incidents` additionally pin
`operations-contribution-evidence/v1`. Their earlier generic authority cannot
retain a current or historical publication after the evidence boundary changes.
A mixed configuration retires its whole snapshot. Every configuration without
these three metrics retains its exact preceding fingerprint, including all
previous category markers; private and raw history are preserved.

Bindings for `performance` or `regressions_prevented` additionally pin
`comparison-revision-pins/v1`. Current and pinned reads withhold their preceding
authority until normal authorized recomputation under the complete, distinct Git
revision checks. The marker applies to these configured destinations even when
there are no accepted requests. A mixed configuration retires its entire bound
snapshot; unrelated destination configurations retain their exact prior
fingerprints. Raw source, private receipts and retained frozen documents are not
rewritten by this fence.

Public evidence carries its immutable source link and fixed, bounded explanation
codes for the metric, clock, reviewed outcome/method and contribution class.
Private request text, receipt IDs, source-ID lists, conditions hashes, participant
material and configuration records are not added to the public payload. Errors
also omit this private detail. Evidence-reviewed freshness effort may report
`changed`, `unavailable` or `contradicted`, as well as `available` or `unknown`.
These outcomes describe the reviewed check and preserve its uncertainty; they do
not grant verified-source or accepted-fact credit. The separate `primary_sources`
qualifier still requires an available source and its own reviewed evidence class.
Changing the outcome or receipt within the same source/claim/policy interval
does not create another freshness unit. All existing reviewer, immutable-pin,
source-use and current private-eligibility requirements still apply. Unknown rights
or assumption conclusions retain that uncertainty. Research and catalog evidence
explicitly distinguishes reviewed artifacts from issue completion and production
publication.

Accepted documentation retains its three fixed metric, merge-clock and authored
contribution labels in primary evidence, accepted portfolio proof and contributor
timelines. This projection requires the complete existing explanation and an
accepted-work marker; it never invents missing labels or copies private values.
It is separate from the explicit path-policy and locale classification contract,
so preserving documentation explanations cannot qualify or retarget a locale.
The optional [authored release-notes purpose](authored-release-notes.md) requires
its separately selected source path and exact current private review. It retains
the same documentation unit and merge clock, with one fixed public purpose code;
it does not establish publication or release coordination.

Accepted reproduction proof retains a complete fixed metric/acceptance-clock
explanation, the explicit observed outcome and
`accepted_reproduction_scenario_not_bug_confirmation`. Primary ranked proof,
accepted portfolio copies and contributor timelines preserve the same labels.
Missing or contradictory accepted labels and disagreement between copies fail
closed. An explicit observed, pending or unknown activity context, including
optional evidence metadata, cannot inherit a retained acceptance marker. Raw,
pending and unknown work do not acquire an acceptance or outcome label from
private text. This bounded projection never copies scenario/run IDs,
environment or result hashes, private receipt contents or arbitrary proof fields.

## Verification and remaining acceptance

The synthetic suite exercises all 24 qualification/exclusion pairs, immutable
revision mismatches, stale or ambiguous audits, reviewer roles, policy clocks,
private-field rejection, source-mode provenance, canonical aliases and proof
variations, withdrawal and exact performance arithmetic. Each of the 23 board-capable metrics
also has a source-to-qualification-to-engine case that counts one canonical unit,
preserves it through repeated review and observation delivery in either order,
and checks exact half-open event-clock boundaries. These cases support only the
listed qualified candidate combinations in the [UI registry](../packages/metrics/UI_REGISTRY.md).
Reliability instead exercises accepted/rejected narrative qualification and the
existing prohibition on contributor ranking; it has no selectable candidate board.
Documentation's merge-date domain candidate is additive: its existing acceptance-date
prototype default and overview/wall behavior remain. The prototype rejects every
domain-only combination, and these metadata entries do not enable a public source.

The suite includes a full
pipeline case proving that flattened synthetic source facts cannot publish a
specialist snapshot, plus a marker-free fictional real-mode publication proving
that accepted documentation keeps its bounded explanation through both stored
proof copies and the actual evidence and contributor API routes. Existing
raw-source and generic recognition tests remain applicable.

Data-correction cases cover 40- and 64-character commit/blob pins, changed versus
unchanged artifacts, collected-source mismatches, complete prior attribution,
reviewed external staleness, self/collaborator exclusions, private-field and
identifier boundaries, canonical correction conservation and independent units.
The publication regression uses fictional marker-free data through the actual
pipeline and API, then reopens its persisted database to verify that obsolete
generic correction authority cannot retain public proof or private explanations.

Reproduction cases cover all three explicit observed outcomes, generic/unexecuted
exclusions, exact three-role source pins, reviewer/source authority, canonical
scenario conservation and fingerprint compatibility. Contract and real-service
injection cases preserve bounded outcome explanations across proof copies and
current/pinned API reads without confirming a bug. A fictional marker-free
pipeline publication reopens persisted storage, withholds obsolete generic
authority and verifies withdrawal across public proof and private explanations.

Actual source installations, configured path/category mappings, rights and
measurement review, reviewer enrollment, affected-owner acceptance, external
artifact adapters, policy activation and service delivery remain separate work.
No real participant study, device/accessibility session, benchmark, source grant,
security disclosure approval or public launch is asserted by these fixtures.

The separate [release-inclusion adapter](release-inclusion.md) binds reviewed
accepted PR membership to a collected immutable release and its publication clock.
It does not infer authorship of release notes or stewardship from a publisher.

### Design and remediation role boundaries

The design qualifier accepts `author`, `coauthor` or `reviewer` only when the
reviewed detail matches the role in trusted normalized source input. It preserves
that role in the recognized fact and proof. Role labels do not create additional
flow/component/version units. The focused `domain role boundary` cases exercise
this input contract, matching-role positives, mismatches and unsupported roles;
they do not demonstrate a new stock collector or real contributor attribution.

The stock merged-PR normalization used by these domain fixtures pins its
delivered `pr_merged` author evidence. Its observed `pr_coauthored` and
submitted-review facts retain their separate source roles but do not gain this
immutable domain pin. Positive stock co-design/reviewer recognition therefore
still needs an explicitly reviewed source adapter, exact revision/role evidence
and the existing independent intake, consent, source-use and policy gates.

Private intake role descriptions are review inputs, not aliases for normalized
credit roles. A description of remediation neither creates a `remediator` role
nor relabels an observed author, reporter or reviewer. Security recognition still
requires public-disclosure approval, contributor consent and the enrolled
independent disclosure reviewer.

The existing [operations adapter](operations-recognition.md) can recognize an
approved public postmortem or remediation contribution through `incidents`.
That route credits the original merged-PR author and retains its affected-owner,
immutable public-record and source/policy requirements; it does not grant a new
remediation role or infer credit from private narrative. Additional role mappings
need their own reviewed source contract. These tests do not close the remaining
role task in #90 or its physical, source-rights, participant and website
prerequisites.
