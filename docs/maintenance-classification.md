# Reviewed maintenance classification policy

`maintenance-classification/v1` specifies the optional positive classification of an already accepted maintenance PR participation for [LB-07.05](DELIVERY_PLAN.md#lb-0705-recognize-release-and-maintenance-work). Review and merge of this engineering decision adopt these semantics. A protected runtime still needs its own approved binding, policy, source authority, independent reviewer and current participant intake. This document creates none of those runtime grants.

## Decision and meaning

The existing `maintenance` definition counts one accepted category/repository/PR/contributor participation, using the original merge clock. This policy adds descriptive evidence facets to that same unit. It adds no metric, score, category multiplier or automatic classifier, and preserves all 98 metric definitions.

| Positive facet         | Required review conclusion and supporting references                                                                                                                                                                                                | Insufficient evidence by itself                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Dependency maintenance | The exact accepted PR performs a dependency lifecycle change, such as a reviewed update, removal or compatibility repair. The reviewer identifies the accepted change and the public dependency or compatibility evidence used for that conclusion. | A dependency label, file path, manifest filename, version string or update bot identity.                         |
| Build fix              | The exact accepted PR addresses a documented build, packaging or build-configuration problem. The reviewer identifies the accepted change and the public diagnostic or other documented problem evidence.                                           | A completed or green CI job, a build-related title, or a workflow edit with no reviewed repair claim.            |
| Accepted bug fix       | The exact accepted PR addresses a documented defect and the independent reviewer accepts that relationship. References identify the accepted change and the public report or other defect evidence.                                                 | Opening or confirming an issue, closing a report, merging an unrelated PR, or an unsupported claim of causality. |

Several facets may truthfully describe the same participation. Omission always means **unknown**, not a negative classification. A generic maintenance receipt remains supported without any subtype. `confirmed_bugs` continues to describe accepted issue reports; it cannot supply an accepted PR fix.

These are reviewed claims about documented changes. The implementation binds the exact collected PR identity/revision and current authenticated review, validates the private shape and reference pairs, and preserves the reviewer’s responsibility for the stated conclusion. It does not fetch or verify the physical contents of a referenced artifact, infer causality, quantify effort, or turn a stored string into cryptographic attestation. An opaque collected source revision remains valid when it exactly matches the original PR proof.

## Supported protected intake

Use the existing evidence request route with `category: "other"`, a protected scope selected for maintenance, and the approved maintenance policy version. The selected binding opts in explicitly:

```json
{
  "category": "other",
  "scope": "repository:2:maintenance:classification",
  "metricId": "maintenance",
  "sourceMetricId": "pr_merged",
  "repositoryId": "2",
  "policyVersion": "maintenance-classification-policy-v1",
  "reviewerIds": ["202"],
  "maintenanceClassification": { "schemaVersion": "maintenance-classification/v1" }
}
```

The numeric identities and scope above are fictional examples. The policy must retain `dateBasis: "occurredAt"`, `groupBy: "canonical"` and exactly `rankedStates: ["qualified"]`, plus the established definition/unit/source/role approval checks. A separately scoped `pr_coauthored` binding may qualify an already verified coauthor. A bot remains a bot, and neither the reviewer nor merge operator becomes the author.

The current private request `detail` can contain a closed JSON record:

```json
{
  "schemaVersion": "maintenance-classification/v1",
  "policyVersion": "maintenance-classification-policy-v1",
  "targetFactId": "exact-original-merged-fact",
  "sourceRevision": "exact-opaque-collected-revision",
  "classifications": [
    {
      "kind": "build_fix",
      "references": [
        {
          "locator": "https://github.com/example-org/example-repo/pull/10",
          "revision": "reviewed-change-revision"
        },
        {
          "locator": "https://github.com/example-org/example-repo/issues/9",
          "revision": "reviewed-diagnostic-revision"
        }
      ]
    }
  ]
}
```

All object shapes are closed, and every array element must be present and validated. There are one to three distinct supported kinds and one to five distinct reference pairs per kind, with at most five globally distinct pairs in the whole record. The same reviewed pair may support more than one kind. Each pair must also occur exactly as a permitted pair in the current acceptance’s `sourceUseReview.references`; the direct parser and existing review share the five-pair overall bound. Locators use the existing public GitHub URL boundary, reference revisions are at most 128 characters, and the whole JSON fits the existing 2,000-character private detail limit. The target fact and its source revision must match the original collected merged participant proof. Policy versions must match the binding, current request and acceptance audit.

An ordinary narrative detail has no subtype claim. JSON object/array syntax supplied under the selected policy must parse and satisfy the entire schema; malformed or unsupported JSON cannot silently become qualified facets. An unselected binding leaves the established generic maintenance behavior unchanged.

The reviewer must inspect both the subtype claim and its documented support before independently accepting the existing request. Current terms, affirmative participant consent, exact review input digest, approved policy, reviewer role and audit equality remain prerequisites. A permitted source-use review alone does not establish the subtype conclusion. Source payload text, labels and caller-supplied inclusion flags confer no such authority.

## Conservation, amendment and currentness

Every request passes the current policy, source, classification and reference checks **before** the receipt callback and before repeated-unit deduplication. Requests are ordered by accepted time and request ID. The earliest valid canonical receipt supplies the unit’s facets; later aliases neither add units nor union extra kinds. A later malformed alias is still rejected. To change a canonical claim, amend it through the existing versioned request flow and obtain fresh independent review. Pending, declined, withdrawn, rejected or stale review inputs cannot retain its accepted overlay.

An accepted review keeps the original merge occurrence and separate later acceptance time. Verified coauthors retain their existing participant units; bot/human classification and unknown execution evidence are unchanged.

Only supported opted-in maintenance bindings add the `maintenance-classification/v1` recognition authority marker. Every defined classification option is validated before qualification or issuance of a saved-read fingerprint; an unsupported shape, version or destination is rejected even when there are no current requests. Generic maintenance and all bindings without this option retain their existing fingerprint encoding. Current and pinned reads compare saved recognition authority with the present controls state. An obsolete generation, changed intake, amendment or withdrawal therefore withholds the old publication until a valid recomputation. Reopening the controls/database connection does not restore obsolete authority.

This change needs no source cache migration, source recollection, provider-version change or scan-generation change. It does not rewrite source facts or expand a default binding. The generic maintenance definition remains definition-only in the selectable metric UI; enabling a deployment remains an independent reviewed choice.

## Public explanation and conflicts

The public proof contains only a fixed policy marker and the supported positive kind codes. It excludes the private JSON, references, reviewer identity, receipt identifiers, free-form rationale and intake digests. The shared evidence renderer presents “Dependency maintenance”, “Build fix” and “Accepted bug fix”, explains that they describe the same counted participation, and explicitly leaves omitted kinds unknown.

Ranked/descriptive evidence, portfolio evidence, current reads and pinned reads must agree for the same contribution. A missing classification in one copy and a present classification in another is a conflict under this generation. Unsupported or duplicate kinds, different kind sets, incompatible policy markers, nonaccepted context and ineligible proof fail closed. Entirely generic legacy copies remain readable as unknown; projection never manufactures missing facets.

Before this policy, a reviewed merged PR could receive generic maintenance recognition and its detail could name these kinds, but no subtype was qualified or displayed. Under an approved opt-in binding, a valid independently reviewed build repair has the same fact ID, canonical unit and value of one, with a “Build fix” explanation. Adding a dependency facet through a fresh valid canonical review still leaves the count at one. A green run without an accepted change and current review adds nothing.

## Verification boundary

The source tests use fictional GitHub observations and disposable SQLite/PGlite stores. They cover direct invalid records, binding/policy/reference mismatch before callbacks, merge clock and role conservation, canonical duplicate selection, current HTTP consent/review/amendment, fixed public projection and conflict rejection, persisted current/pinned reads across reopen, scoped authority retirement and all 98 unrelated fingerprint controls. The shared TSX renderer is exercised directly for readable labels and unknown/malformed states.

The PR’s source-bound execution records distinguish original failing baselines, corrected focused runs and required build/type/planning gates. These checks demonstrate the local implementation; they establish no real contributor classification, installed source, field observation or live ranking accuracy. The remaining release-note/publication/deployment separation and all literal [LB-07.05](DELIVERY_PLAN.md#lb-0705-recognize-release-and-maintenance-work) prerequisites remain open until separately evidenced.
