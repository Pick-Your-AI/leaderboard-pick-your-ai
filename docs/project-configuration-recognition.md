# Reviewed Project configuration change sets

The pipeline qualifies the existing `project_configuration` metric from a protected, independently reviewed change-set record. Its [registry definition](METRICS.md#project_configuration--project-configuration-stewardship) counts one accepted Project configuration change set, with field, option, view, filter, group, sort, layout and workflow facets. The ranking clock remains `accepted_at` and the coverage class remains `attested`.

This implements the typed receipt boundary in COV-14 of [#60](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/60) and [#79](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/79). It adds no metric, changes no registry definition and enables no installation, Project, source family or public policy. It does not establish the separate native-event, permission-canary or real-contributor acceptance criteria in those issues.

## Who supplies authority

`materializeRecognition` calls `qualifyProjectConfiguration` through the existing domain-recognition boundary. The binding and its `domainEvidence` belong to the protected host configuration. Public evidence submissions, source payload descriptions, current Project snapshots and provider metadata cannot supply that configuration.

Before invoking the typed helper, the materializer already requires a current accepted request, required participant consent, supported versioned intake, a matching independently authenticated source-use review, an authorized reviewer, exactly matching private audit history and an approved metric policy. The request owner and listed collaborators cannot review their own contribution. The typed record additionally binds the request ID and current version, accepted decision ID, exact collected source fact, Project, immutable source revision and explicit configuration role.

The host must actually verify the public before/after bytes, their hashes, the Project identity and visibility, the contributor's role and the change-set's canonical identity before supplying a record. The helper validates those attestations and their consistency; it does not fetch the linked files, reconstruct configuration from a live API, authenticate a human reviewer or check that a claimed hash matches remote bytes. A source-use review remains separate from factual review of the change and role. A string ID or `publicSafe: true` in an untrusted document grants no authority.

The first source adapter accepts an original, observed, branch-qualified `pr_merged` fact attributed to a visible human author. The public merged artifact carries the pinned after revision and the reviewed configuration evidence. The source author must also be the authenticated request owner and the explicitly attributed configuration contributor. The configuration role may be `author`, `coauthor` or `editor`, but must exactly match the submitter role in the current consented intake. An unknown or different submitted role needs an amendment, consent and a new review. The fact's existing source role remains `author`; the configuration role is a separate protected attestation.

Other contribution roles and source families need their own supported adapter. Current Project creators, `updatedAt`, item field/status changes, workflow execution senders and automation effects do not establish a later configuration editor. A custom normalizer remains a trusted host component and must preserve current source identity, visibility, branch and normalization authority; this helper is not a replacement for that trust boundary.

## Protected binding

Keep the existing approved policy for `project_configuration` on `dateBasis: "acceptedAt"`, `groupBy: "canonical"` and `rankedStates: ["qualified"]`. A binding with an occurrence clock, raw-observed ranking or per-artifact grouping is rejected. The existing `domainMetricIds` catalog enumeration is unchanged; `domainDateBasis("project_configuration")` explicitly returns `acceptedAt` for this separate typed adapter.

The following abbreviated JavaScript example describes the shape. Its variables must come from actual protected review and collected source authority. It is not an executable approval or a production fixture.

```js
const binding = {
  category: "project_configuration",
  scope: reviewedRequest.scope,
  policyVersion: approvedPolicy.version,
  metricId: "project_configuration",
  sourceMetricId: "pr_merged",
  repositoryId: collectedRepositoryId,
  reviewerIds: currentAuthorizedReviewerIds,
  domainEvidence: {
    version: "project-configuration-evidence/v1",
    projects: [{ id: reviewedProjectId, url: reviewedPublicProjectUrl }],
    records: [
      {
        requestId: reviewedRequest.id,
        requestVersion: reviewedRequest.version,
        decisionId: independentlyAcceptedDecision.id,
        factId: collectedMergedAuthorFact.id,
        sourceRevision: collectedEvidence.sourceRevision,
        sourceRevisionUrl: collectedEvidence.sourceRevisionUrl,
        validUntil: reviewedValidityCutoff,
        synthetic: false,
        publicSafe: true,
        details: {
          projectId: reviewedProjectId,
          changeSetId: canonicalReviewedChangeSetId,
          before: reviewedBeforePin,
          after: reviewedAfterPin,
          contributor: {
            actorId: reviewedRequest.owner,
            role: reviewedRequest.intake.roles.submitter,
            attribution: reviewedExplicitRolePin,
          },
          facets: reviewedTypedFacets,
        },
      },
    ],
  },
};
```

The `domainEvidence` object has exactly `version`, `projects` and `records`. Project admission contains 1–32 unique `{ id, url }` pairs. Both IDs and URLs must be unique. A URL has the exact HTTPS GitHub organization or user Project form, without credentials, query, fragment, escaped path segments or a custom port. That locator check does not itself prove visibility. A record selects an admitted stable Project ID. There can be at most 1,000 records and exactly one matching record for an accepted request. All nested record, contributor, pin and facet objects reject extra or missing fields.

The original source evidence must uniquely identify the selected fact and its artifact, repository, actor, source role, metric and public locator. The immutable collected revision and its URL must match the record. A source occurrence cannot be later than acceptance, including at submillisecond precision. Observation cannot be later than the frozen collection cutoff, and that cutoff must be within `validUntil`. Unknown source clocks, pending/already-recognized targets and synthetic or automated attribution cannot qualify.

## Before/after and attribution pins

Each configuration snapshot and attribution pin has exactly these fields:

```js
{
  revision: fullLowercaseGitCommitId,
  sourceRevisionUrl: exactPublicGithubBlobUrlAtThatRevision,
  contentHash: sha256OfReviewedBytes,
}
```

Revisions are full 40- or 64-character lowercase hexadecimal Git identifiers. Hashes are 64-character lowercase SHA-256 values. Pin URLs use `https://github.com/OWNER/REPOSITORY/blob/REVISION/PATH` with canonical unescaped paths. Mutable branch names, abbreviated commits, credential-bearing URLs and foreign repositories are rejected.

The before and after snapshots must identify the same repository and artifact path, with different revisions and different content hashes. The after revision equals the collected merged artifact's revision. The explicit role evidence uses that same repository and after revision. Its path may be a separate attribution document. An immutable URL cannot carry contradictory hashes within one record or across qualifying records. These checks bind the host-reviewed evidence; they do not independently establish Git ancestry, the meaning of the bytes or whether a declared change actually occurred in a live Project.

## Supported typed facets

One record contains 1–32 facets. Each facet has its own typed identity and before/after value. A facet cannot repeat another facet's identity within the change set. Names are bounded nonblank strings; filters may be empty to represent an unfiltered view. Opaque field, option, view and workflow IDs are bounded stable tokens supplied by the reviewer. Collections require dense own entries: a sparse array cannot stand in for a facet, field ID, sort value, Project or receipt. Empty group and sort arrays remain valid values. Unknown kinds and properties fail closed.

| Kind       | Exact identity and operation fields                               | Before/after values and required change                                                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `field`    | `fieldId`, `operation: "add"` or `"rename"`                       | Add has `before: null` and a new name; rename has two different nonblank names.                                                                                                                                                       |
| `option`   | `fieldId`, `optionId`, `operation: "add"` or `"rename"`           | The same add/rename rule for the identified field option.                                                                                                                                                                             |
| `view`     | `viewId`, `operation: "add"` or `"rename"`                        | The same add/rename rule for a view definition.                                                                                                                                                                                       |
| `filter`   | `viewId`                                                          | Different bounded filter strings, including the empty string.                                                                                                                                                                         |
| `group`    | `viewId`                                                          | Different ordered arrays of 0–16 unique field IDs.                                                                                                                                                                                    |
| `sort`     | `viewId`                                                          | Different ordered arrays of 0–16 `{ fieldId, direction: "asc" or "desc" }` entries, without duplicate fields.                                                                                                                         |
| `layout`   | `viewId`                                                          | Different values from `table`, `board` and `roadmap`.                                                                                                                                                                                 |
| `workflow` | `workflowId`, `operation: "enable"`, `"disable"` or `"configure"` | Each state is `{ enabled: boolean, configurationHash: sha256 }`. Enable/disable flips the corresponding boolean while preserving the configuration hash. Configure changes the configuration hash while preserving the enabled state. |

Every facet also contains `kind`, `before` and `after`. A no-op is rejected. An enable operation cannot disguise an unrelated configuration update, and a configure operation cannot silently toggle enablement. A workflow change that needs additional semantics requires a separately reviewed supported representation. Automated item effects are not facets. The host remains responsible for complete evidence that the listed facets describe the accepted change set.

## Counting and repeated receipts

The canonical unit binds the metric's evidence-version namespace, repository, Project ID and the host's stable change-set ID. Request IDs, decision IDs, proof versions, number of facets and number of affected items do not mint additional units. The existing metric machinery retains attribution to the contributor; this does not change repository-wide multi-actor conservation policy.

The host must use one canonical change-set ID for an event and its confirming receipts. The code does not discover equivalent names for a change set. Current accepted requests are processed in deterministic acceptance-time/ID order, so repeated valid receipts keep the earliest qualifying acceptance for the unit. Every repeated receipt first passes current consent, review, source, role and typed-proof validation. An invalid later alias therefore fails the materialization instead of being silently hidden by deduplication.

For the same canonical change set, the before/after pins and normalized typed facets must agree. Object-key or facet ordering does not change that signature; ordered group and sort values preserve their meaning. Inconsistent state for one change-set ID and conflicting hashes for a shared immutable URL are rejected before any duplicate unit can be skipped.

One independently reviewed workflow configuration change with 100 raw automated item updates contributes one configuration unit. The 100 original observations and source facts remain unchanged, including their automation identity. This helper does not create extra human authorship from those item effects or rewrite their existing metric treatment.

## Currentness, withdrawal and output

The existing recognition fingerprint includes the complete private requests, accepted audit records and configured bindings. A scoped `project-configuration-evidence/v1` authority marker also retires publications produced under the earlier generic Project-receipt semantics. Unaffected bindings retain their previous fingerprint format.

Current source/configuration authorization, normalization generation, replay confirmation and final publication/read fences remain the worker's responsibility. The typed helper is synchronous and is invoked inside that existing flow. `validUntil` is checked against the frozen observation cutoff; it is not a wall-clock revocation scheduler. A host that revokes Project visibility, source use, reviewer authority or a factual attestation must revoke or replace the current configuration/worker authority and relevant private review state. Keeping an obsolete worker and unchanged approval callback does not establish current authorization.

Withdrawal, reopened review, missing or declined required consent, missing current intake and suppression prevent recognition materialization. The existing runtime denies a stored publication when its current recognition authority no longer matches, including after persistent storage is reopened. Recalculation uses retained source observations and current review state. This does not claim deletion of raw collection payloads, audit history or unrelated stored documents.

The overlay preserves the fact's original source clock and separately records acceptance. Its evidence display clock is acceptance, as required by this metric. Protected record text, Project/change-set IDs, snapshot hashes, contributor attribution documents and receipt identifiers are not copied into the new public evidence projection. The helper emits only fixed or enum-valued reason codes; downstream public projections retain their existing reason-code allowlists. No public schema or display taxonomy changes here.

The low-level `applyRecognitionReceipt` function remains a trusted host primitive. A caller using it directly must supply its own authenticated and factually qualified receipt. It does not invoke this pipeline's typed Project qualifier. A generic low-level receipt is consequently not proof that the full configured materializer's COV-14 gate was executed.

## Verification scope

The focused test file exercises the actual normalizer, materializer and receipt application with explicit fictional data. It includes each typed facet, actual finite before/after fixture bytes and hashes, missing or contradictory proof, source/actor/reviewer/consent boundaries, exact acceptance policy, repeated valid and invalid aliases, and one workflow change alongside 100 unchanged automated observations.

The persistent case uses the real PGlite SQL store, SQLite controls, pipeline publication and service HTTP path. It publishes a current accepted unit, records withdrawal, closes/reopens the SQL engine and physical SQLite handle, checks that old proof and explanation reads are denied, and recomputes without accepted credit while original normalization rows remain. This is synthetic local execution of the implementation boundary. It supplies no live Project edit, independent human acceptance, installation permission canary or production rollout evidence.
