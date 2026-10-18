# Evidence and contributor-rights policy

Decision for [LB-01.05 / #26](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/26), following the audience and success decision in [#22](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/22). Version: **2026-10-18**.

## Decision and scope

Adopt a public-evidence model with verified correction and opt-out controls. Eligible source facts can appear after their source is explicitly onboarded; optional profile details, off-GitHub evidence and editorial participation require their own voluntary choices. Recognition remains explainable and correctable, including for people with observed work but no accepted rank.

The reviewed merge adopts this policy under the maintainer's delegated engineering authority. It does not install a source, assign a reviewer or operator, enable a conditional feature, perform deletion or certify a public release. Each enabled source and public surface must satisfy the [release manifest](../planning/release-manifest.json), actual source-capability checks and the implementation evidence below. The policy is a product and engineering decision; it makes no claim of universal legal compliance or permission to reuse every publicly accessible artifact.

## 1. Source allowlist and minimum public data

**Default deny:** a discoverable repository, membership in the organization or a valid API response does not enroll a source. The versioned allowlist must record immutable source identity, approving authority, public visibility evidence, permitted event and field types, source-use constraints, history boundaries, capability receipt and the current policy version. A repository rename cannot create a second source. Project membership is a view over source artifacts, not a second contribution or proof of authorship.

The reviewed organization inventory currently contains six repository candidates: `pick-your-ai-research`, `pickyour.ai`, `.github`, `pick-your-ai-leaderboard`, `pick-your-ai-apple` and `pick-your-ai-android`, plus public Projects 1–6. The dated repository/Project examples belong to #22. Their inclusion in that audit is **not** an allowlist activation or permission receipt. Enroll each repository and Project by its verified immutable identity; do not replace that identity with an inferred name, copied URL or unverified Project number.

| Source class | Permitted after source-specific approval | Excluded or separately gated |
| --- | --- | --- |
| Public repository issues and pull requests | Stable artifact and account IDs; current public links; necessary public title, state, event time, role and relationship facts; bounded acceptance evidence | Private/deleted content, credentials, commit emails, private contact details, security-report payloads and arbitrary body/attachment mirroring |
| Public commit and review activity | Source revision and artifact identity, evidenced author/coauthor/reviewer roles, relevant timestamps and approved metric inputs | Inferring identity from email, merging accounts by display name, guessed effort/hours, AI/manual authorship or intent; source code retention without a separately justified need |
| Public Project context | Approved field IDs and meanings, native issue links, scoped status/readiness/hierarchy context and source-linked changes where observability is proven | Private Projects, draft items or free text without their own source approval; treating current membership, assignment or a status value as earned contribution credit |
| Optional Discussions or other public GitHub surfaces | Only the event types, attribution and coverage proven by the enabled adapter and its source-capability receipt | Unsupported historical events, inferred acceptance or an enabled-looking interface backed by no collector |
| Voluntary off-GitHub evidence | The bounded public artifact and consented summary described in section 3 | Default crawling of third-party accounts, private/customer material, forced testimonials or claims submitted on another person's behalf without the required consent |

Use the minimum fields needed for the declared contribution and coverage claim. A public source title or document can still contain sensitive or malicious material; render it as untrusted content, apply the current publication policy and provide a functioning correction path. Links and attachments do not authorize fetching arbitrary internal or authenticated resources. Do not publish raw payloads, access tokens, commit emails, personal contact data or private request/audit content.

### Visibility changes and unavailable evidence

A source becoming private, revoked, deleted or otherwise ineligible must be excluded from public reads, subsequent enrichment and republication. Advance the applicable suppression state before any later publication can rely on older eligibility. A retained snapshot, replay, stale worker, paused wall or restored backup cannot override current suppression.

Distinguish an explicit loss of public eligibility from a transient transport failure. An explicit denial suppresses affected data. A transport failure records uncertainty and freshness under the approved source policy; it must not be described as verified current public access. A public claim requiring current visibility stays unavailable when that required verification is missing. Recovery requires fresh permitted evidence and a reviewed eligibility decision where required; it must not clear a contributor opt-out or retention tombstone merely because the source becomes reachable again.

Apply removal to every service-controlled public path: directory, board, profile, evidence detail, activity feed, wall, API, enabled exports/cards/embeds, retained snapshots, search copies and caches. Invalidate or recompute affected aggregates under the current policy; do not retain a person's public contribution through a supposedly historical view after suppression applies.

The service can stop serving or refreshing an export or image it controls. It cannot guarantee erasure of copies a third party already downloaded, screenshots or an unrelated source site's own records. Explain that boundary when accepting the request. Do not promise deletion from systems the project neither owns nor controls.

## 2. Facts, acceptance and editorial selection

| Public representation | Required evidence and meaning | What it cannot establish |
| --- | --- | --- |
| Observed source fact | Attributable permitted source event, role, clock, provenance and known coverage | Quality, human effort, upstream deliverable completion or an accepted outcome merely because activity occurred |
| Qualified or accepted outcome | Source evidence satisfies the versioned metric/rule; any required receiving or independent review is present at its actual reviewed revision | Acceptance by absent co-owners, acceptance of later changes, runtime execution or production readiness outside the receipt's scope |
| Reviewed recognition | Voluntary evidence where applicable, an authorized review receipt, declared conflicts, bounded participants/roles and the published recognition rule | A universal score, unsupported endorsement or self-approved disputed credit |
| Editorial highlight | A clearly labeled selection with public source links, selection reason, responsible editor and applicable participant consent | A ranking result, an objective superiority claim or a fabricated quote/testimonial |

Preserve uncertainty rather than promoting a weaker state. An issue closure, a green check, a review comment and a receiving-owner decision are separate facts. One can support a bounded contribution without satisfying a whole work package. When a reviewer authored the evidence, record that relationship; do not relabel a co-owner response as independent review.

Duplicate delivery, reimported history or repeated receipts cannot earn a second outcome. Distinct roles on one artifact remain separately attributable under their existing definitions. Correcting or withdrawing a receipt changes derived qualified recognition, while the minimized protected decision history records why the policy changed its treatment.

## 3. Voluntary off-GitHub evidence and consent

Off-GitHub evidence is a conditional module. Keep it disabled until the submission, consent, review, withdrawal and privacy paths actually work and their acceptance gate is met. Browsing the base product or receiving credit for eligible source facts must not require a person to submit external evidence or accept editorial participation.

The submission process must:

1. Explain the proposed public claim, participants and roles, intended category, source link, requested date/interval, public summary and retention/removal terms before submission. Unknown dates or roles remain unknown.
2. Record the submitter's verified identity, source-use basis and explicit consent choices with their scope, policy version and time. A preselected checkbox, repository membership, an assignee field or silence is not consent.
3. Obtain the necessary consent from every identifiable participant whose voluntary contribution or endorsement the submission would publish. The submitter cannot grant another person's consent. Keep the claim pending if a required participant or source-use basis is unresolved.
4. Give a qualified reviewer access to the necessary bounded evidence through the approved private workflow. A self-attestation is labeled as such; it does not become verified source evidence merely because the form was submitted. Do not admit private/customer material into the public-data recognition path.
5. Publish only the permitted public artifact reference, consented summary and accepted role/claim. Keep private proof, consent records, contact details and moderation notes out of the public projection. If the source cannot support the claim safely and independently, retain the appropriate unverified or declined state.
6. Provide a durable submission receipt and a verified way to narrow or withdraw consent. Withdrawal suppresses the affected optional claim and its derived recognition. Broader account opt-out uses the same durable suppression authority described below.

Reviewers must not manufacture a testimonial or rewrite a submission into a stronger claim than its evidence and consent allow. A submitter can decline public editorial treatment without losing eligible, separately governed source attribution.

## 4. Identity correction, opt-out and appeals

Use stable source account IDs and verified account control. Login changes are aliases of a verified identity, not a new person. Never join accounts through matching names, commit emails, social guesses or device/IP inference. A source's uncertain author identity remains uncertain until the supported correction process establishes the mapping.

| Request | Required check | Result and receipt |
| --- | --- | --- |
| Correct an attribution or account mapping | Inspect the original public event and verify the requester or other authorized evidence through the supported identity process; declare conflicts | Accept, narrow, decline or request information with reasons. Version the mapping and recompute affected views; preserve unrelated contributors and actual coauthor/reviewer roles. |
| Correct a factual claim or acceptance state | Identify the exact artifact, claim, policy and source/receiving evidence at its reviewed revision | Record the scope and outcome. Pending review remains pending; the request cannot itself grant accepted credit or close the upstream issue. |
| Opt out of public recognition | Verify control of the affected account or an authorized identity-resolution decision; do not trust a claimed login or free-text email alone | Persist suppression for the scoped identity and derived public outputs, issue a receipt and report propagation state. Continue to reject recollection/republication under that scope. |
| Withdraw optional consent | Verify the participant and original consent scope | Remove the affected optional public claim and derived recognition. Do not silently withdraw another participant's separate consent or delete unrelated source work. |
| Appeal a decision | Reference the original receipt and disputed evidence; use an authorized reviewer who did not make the original contested decision | Record a linked accept/narrow/decline/reopen result and its reasons. If no eligible independent reviewer is available, state that review is pending; do not invent concurrence or silently dismiss the appeal. |

Provide the receipt through a route the requester can actually retrieve. Public receipts expose only an appropriate opaque reference and safe state/summary; private details require current authorization. A reporter can submit a concern without acquiring permission to apply a correction, remove another person's data or read private evidence. Credible privacy exposure can receive an authorized protective suppression while identity or the final disposition is assessed; record that provisional scope and reason.

Separate request receipt, verified authority, public suppression, payload deletion and final completion. A request acknowledged as received is not already resolved. Report failed or pending store/cache steps honestly, allow retry with the same operation identity and keep affected public reads suppressed where required. A future return to public participation requires verified, explicit scope and policy checks; it must not erase the original decision or resurrect withdrawn external evidence by default.

Do not advertise response deadlines or an appeal service without a real responsible operator and an accepted commitment. This policy defines the process; operational acceptance must supply its actual roster, supported contact route, availability and measured drills. No existing contributor is assigned that duty by implication.

## 5. Retention and removal across stores

Public suppression is a serving decision. Payload deletion removes stored data. Backup expiry and restoration controls are additional operations. The implementation must report these separately. The current [cross-store retention investigation](source-retention-boundary.md) documents concrete pending boundaries; [authentication expiry](authentication-retention.md) removes expired authentication state only.

Before a data class can be enabled in a public deployment, its versioned retention schedule must identify the purpose, exact scope, start clock, finite cutoff or bounded renewable exception, deletion mechanism, responsible operator, store/cache/backup copies and verification method. Missing retention configuration blocks activation; it does not authorize indefinite retention. Numeric windows, backup bounds and RTO/RPO remain the explicit operations/privacy decisions in DEC-10. They must be selected and validated for the actual deployment, not presented as measured by this policy.

| Data class | Lifecycle and required removal behavior |
| --- | --- |
| Raw permitted source payloads and collection checkpoints | Retain only what ingestion/reconciliation needs for its accepted window. Scope deletion by immutable source identity and clock, not substring matches in free text. A stale checkpoint cannot reintroduce suppressed or expired evidence. |
| Normalized events, snapshots, frozen policy inputs and comparisons | Apply the same source/actor scope to every retained representation. Delete or safely recompute affected derived data and deny stale/pinned reads while required stores are pending. A comparison is not a privacy exemption. |
| Optional profile, external evidence and consent records | Retain only the authorized fields for the declared purpose and window. Withdrawal removes public use first; complete the corresponding payload-deletion process and retain only a justified, protected integrity receipt. |
| Correction requests, review audit and suppression tombstones | Separate deletable narratives/attachments from the minimum integrity record needed to enforce the decision. Even opaque or hashed identifiers may remain linkable personal data; protect them, bound access and retention, and do not call them anonymous by default. |
| Authentication and operational logs | Apply their specific accepted clocks and minimize identifiers. Never log secrets, OAuth verifiers, tokens, raw evidence or request bodies as routine diagnostics. Expiring sessions does not delete contribution history. |
| Backups, search indexes and external caches | Record actual architecture, expiry/deletion bounds and operation-bound acknowledgments. A restore loads the current suppression/tombstone authority before reads, replay or publication. Unconfirmed external cleanup remains pending. |

A deletion operation needs an authorized exact scope, durable operation ID, policy/clock, current suppression fence and per-store progress. Retries must be idempotent and preserve concurrent unrelated work. Retention must use reviewed storage migrations and APIs; it must not disable immutable-source protections, truncate unrelated data or fabricate a source-revocation event to force a purge.

Mark payload deletion complete only after every required store, checkpoint and controlled copy has returned verifiable scoped evidence. Record any bounded backup expiry still outstanding and keep restoration suppression effective. The user-facing result must state what is removed, what is still pending, what minimal protected record remains and why, and which third-party copies are outside control.

## 6. Attributable maintainer decisions

Every source admission, identity change, recognition approval, correction, appeal, editorial selection, suppression exception and policy change needs an attributable audit record. The protected record identifies the operation, actual decision-maker and verified authority, affected scope, evidence references and reviewed revision, prior/new disposition, reason, declared conflicts, policy version, time and resulting publication/deletion receipts. Missing actor, authority, evidence or policy is a failed decision gate.

Keep requester and decision-maker roles distinct. A reviewer may not approve their own disputed recognition or hear the appeal of their own contested decision. Do not substitute an automated score, a check pass or an absent person's name for acceptance. Revoking a reviewer/session also revokes its ability to inspect protected history; retained evidence is always subject to current authorization and privacy rules.

Public explanations use a minimized summary that supports accountability without exposing private evidence, authentication data or an opted-out identity. Protected audit access is purpose-limited and logged. An audit trail is not an exception allowing public publication of the content the decision removed.

## 7. Coverage, evaluation and adoption evidence

Show the source scope, event and publication clocks, collection status, history boundaries, policy version and capability limitations where needed to interpret the claim. Distinguish complete empty results, no filter matches, partial history, unsupported sources, pending acceptance and suppressed/unavailable evidence. Missing history is not zero activity. First observed is not first ever. Incomparable coverage must not produce a favorable rank-movement or productivity claim.

Evaluate the following cases in labeled synthetic data before the affected capability is enabled, then supply the separate permitted public/operational evidence required by its delivery package:

- A public source becomes private while an old worker, cached detail, retained snapshot, paused wall and restore are in progress. Every enabled public path applies the current suppression; unrelated sources remain intact.
- A voluntary external claim lacks one required consent, then gains consent, is reviewed and is withdrawn. Pending consent never becomes accepted public recognition; withdrawal removes derived public credit and reports actual deletion progress.
- An incorrect alias, replayed event, disputed self-review and unauthorized correction attempt cannot create false credit or access private records. A real authorized correction produces a durable scoped receipt.
- An appeal reaches an independent authorized reviewer or visibly remains pending without one. Every disposition has an actual actor, evidence, policy and reason.
- Deletion fails after one store succeeds, then retries. No false completion receipt is issued, current suppression remains effective and the same operation resumes without deleting unrelated data or restoring removed payload.
- An export already downloaded by another party is described accurately as outside the service's deletion control, while every service-controlled copy and newly served view follows the current policy.
- Unsupported history and partial coverage remain explicit across the directory, rankings, evidence, portfolios and wall. Correcting or removing data does not fabricate a zero or erase the explanation for an unavailable comparison.

For #26, review the source allowlist rules, private-to-public suppression, voluntary evidence/consent, correction/opt-out/appeal/retention processes, four representation classes, coverage/removal explanations and attributable decision requirements. Approval of this policy does not mark these scenarios as executed, close the source-retention implementation or replace accepted operating ownership. Future policy changes require a reviewed version, impact examples, migration/correction behavior and a current contributor-facing explanation.
