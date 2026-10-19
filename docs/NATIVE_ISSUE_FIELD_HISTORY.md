# Native issue-field history

This adapter implements a bounded native GitHub issue-field history source for
[#79](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/79). Its source
family is `issue_field_history`. It is separate from the existing `project_history`
reader and does not turn current field snapshots into historical editor evidence.

Implementation and synthetic validation do not establish installation access,
available history, configured source approval, or metric readiness. The capability
matrix remains unprobed. Hosts must independently approve this source family and
its metric policy before admitting it. The remaining Project custom-field and
progress-history subtypes in #79 are outside this adapter.

## Native evidence and attribution

The reader selects `ISSUE_FIELD_CHANGED_EVENT` entries from an issue's native
GraphQL timeline. An admitted transition binds all of these independently checked
values:

- The approved public repository's numeric identity and canonical slug.
- The issue's native node ID and canonical issue URL.
- The native event ID and its original `createdAt`.
- The native issue-field node ID, supported data type, and current `ALL` visibility.
- The nullable native actor and explicit historical before/after states.

The normalizer emits only the existing `issue_field_updates` metric, with the
native editor in the `triager` role and the native event time. Its public artifact
is the actual issue, not the field or event node. A nullable or unsupported actor
remains unknown and does not become a known editor or a zero-valued metric.
Account kind and execution mode are separate: a native Bot may be a bot account,
while execution stays `unknown`. This adapter does not query intent or infer
automation, assistance, or model identity.

The source references are GitHub's
[IssueFieldChangedEvent schema](https://docs.github.com/en/graphql/reference/issues#issuefieldchangedevent),
[issue-field data types](https://docs.github.com/en/graphql/reference/issues#issuefielddatatype),
and [visibility enum](https://docs.github.com/en/graphql/reference/issues#issuefieldvisibility).
The schema exposes the nullable `IssueFields` union. Node identity is selected
through `... on Node { id }`; `dataType` and `visibility` are selected separately
through `... on IssueFieldCommon`. The common interface is not assumed to declare
an `id` field.

## Public scope and completeness

Only fields explicitly visible to `ALL` are eligible. An explicit `ORG_ONLY`
field encountered before admission is filtered before retaining its field or
event identity. Null, unknown, or malformed initial scope is unavailable; it is
not treated as evidence that no edits occurred.

Previously admitted records require stronger handling. Each retained field and
event is directly re-probed even if a newly refreshed timeline contains no events.
A missing or newly hidden field, missing native event, or changed issue identity
fails closed. Omission from a timeline cannot silently erase the requirement to
verify historical credit.

The family reports `expectedCount: null`, including for an empty public result.
A completed bounded scan means the selected public data was traversed; it does
not certify complete native history. GitHub documents that organization-only
events can disappear from the timeline for nonmembers in
[Adding and managing issue fields](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-and-managing-issue-fields).
This source neither reports an unknown history count as zero nor claims that
every possible native value profile is supported.

Pull-request subject URLs, current-state facts, missing stable issue/field IDs,
mismatched native identities, and revisions that do not reproduce the collected
transition cannot produce native issue-field credit.

## Read ordering and checkpoints

The subject inventory selects public repository identity and issue node IDs,
numbers, and canonical URLs through a metadata-only GraphQL connection. It does
not request REST issue bodies, titles, current issue-field snapshots, or other
repository text. Its checkpoint selection retains only the issue identities
needed to scope native timeline reads.

Native event pagination requests metadata before historical values. Its durable
checkpoint rows contain only:

```json
{
  "subject": { "id": "I_SYNTHETIC", "url": "https://github.com/synthetic-owner/repository/issues/1" },
  "event": { "id": "E_SYNTHETIC", "createdAt": "2026-10-01T00:00:00Z" },
  "issueField": { "id": "IF_SYNTHETIC", "dataType": "TEXT" }
}
```

No field name, value, option label, color, actor login, or intent is included in
these event checkpoint rows. The record is selected explicitly; an unexpected
cached property is rejected. Historical values are obtained through a fresh
detail request and never enter a durable event scan.

A fresh metadata scan establishes that each event belongs to the requested
issue. When a scan resumes or returns completed checkpoint rows, the reader first
directly probes all retained identities and then obtains fresh issue membership
before loading any event values. A well-shaped cached row naming a different
public event and field is insufficient: that event must appear in the fresh
issue-scoped membership result with exactly the retained metadata.

Each value hydration is bracketed by direct scope probes. The detail response
must reproduce the issue-field and event metadata, and the final probe must still
show the same public scope. Synchronous host authorization is checked throughout;
the underlying read client also enforces it around transport operations.

Stored-fact normalization repeats this process even when an earlier SQL
normalization exists. The runtime creates one fresh opaque
`issueFieldHistoryBatch` object per normalization batch. A module-private cache
can share a single fresh metadata membership scan for several events on the same
issue in that batch. It binds the token, actual client scope, source, repository,
and issue identities. It stores no values and is never serialized. Every event
still receives its own field/event probes and detail read. A new batch refreshes
membership; standalone normalizer calls are always fresh.

## Scan time bounds

The collector captures each native request's time bounds before awaiting source
I/O. It requires a valid UTC upper bound and a lower bound that is explicitly
null or an earlier valid UTC instant. Native transitions are included from the
lower bound through the upper bound, both inclusively, matching `CollectionStore`
admission. Filtering
precedes output pagination, so excluded events cannot produce empty advancing
pages or offset the selected transitions. The native event time and revision
remain unchanged.

Time filtering does not bypass fresh public-scope or issue-membership checks.
Retained metadata is still revalidated before value hydration, including when
the eventual event falls outside the requested range. History counts remain
unknown. This bounded history traversal does not claim a selective upstream
change feed or complete historical coverage.

## Supported historical value profiles

GitHub independently declares `previousValue` and `newValue` as nullable strings
and `previousOptions` and `newOptions` as nullable lists. The schema does not imply
that scalar and option representations are mutually exclusive. All four queried
properties must be present; explicit null is supported, while omission or a
malformed type is unavailable.

The private revision tuple retains both actual representations on each side:
the nullable scalar and the nullable array of historical option names. Metric
comparison is separately defined as follows.

| Native data type         | Supported comparison                                                                                                                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TEXT`, `NUMBER`, `DATE` | Compare the actual nullable strings. Option lists must be explicitly null. No numeric or date coercion is performed.                                                                                                                                                        |
| `MULTI_SELECT`           | Compare deterministically sorted historical option-name arrays. Preserve actual scalar text and original option ordering in the revision tuple. Null options are supported only with a null scalar. A nonnull scalar without option evidence remains unavailable.           |
| `SINGLE_SELECT`          | A scalar with explicit null options is supported. A zero- or one-name historical list is supported only when compatible with the scalar: an empty list requires null; one name accepts null or the same scalar text. Conflicting mixtures and larger lists are unavailable. |

Null, an empty string, the string `"0"`, an empty option array, and an omitted
property are distinct states. Duplicate option names are rejected as ambiguous;
the reader does not invent option IDs or silently deduplicate them. The native
timeline option schema supplies names and nullable colors, with no stable option
ID.

For multiple selection, array-order changes and scalar display-text changes alone
do not create edit credit. An actual supported before/after membership change
does. Field names, current option definitions, and colors are not queried or
scored. A color-only or current-snapshot change cannot manufacture a field-edit
unit.

The revision hash binds the native issue, event, field, type, actor, time, and
both historical representations, as well as the semantic comparison. A later
value or actor drift cannot be accepted under the earlier source revision.
Collected actor and occurrence-time fields must independently agree with the
fresh native evidence; a valid content hash does not excuse altered attribution.

## Durable facts and runtime denial

Collection facts retain the native event as `subjectId`, the issue as
`historySubjectId`, the field as `issueFieldId`, the source URL, revision hash,
nullable numeric actor identity, original occurrence time, and evidence state.
The collection store explicitly selects these properties and discards adapter
extras. Field names, values, options, and batch tokens are not source facts.

`isIssueFieldSourceScopeFailure(error, family)` recognizes confirmed loss only
for `issue_field_history`. The native error codes are:

- `issue_field_public_scope_unverified`
- `issue_field_subject_identity_unverified`
- `issue_field_event_unavailable`

Actual typed transport outcomes `authentication_required`, `permission_denied`,
and `not_found_or_hidden` are also treated as scope loss for this family.
Malformed schema, duplicate records, unsupported value profiles, transient
failures, and rate limiting are not permanent privacy-denial classifications.
A plain error string or an HTTP status guessed outside the actual classifier is
not sufficient. In particular, a classified rate-limited 403 remains a retryable
source failure.

The collector reports the native reason `issue_field_scope_unavailable`. Runtime
controls and the independent SQL `issue_field_scope_denial` receipt make the
denial durable across restart, cached normalizations, current and pinned boards,
and final discovery admission. A failed controls-store write does not erase the
SQL denial. Fresh administrative source approval is required for a later build;
old pinned publications remain denied under their original approval binding.
The established Project denial keys and checks remain separate.

## Code and validation boundaries

The new reader is in `packages/github/src/issue-field-history.ts`. The native
collector is in `apps/pipeline/src/github-source.mjs`, and the collection
normalizer is in `packages/github/src/normalizers.ts`. Stable fact identities and
the family registry are in `packages/ingestion/src/collection.ts`; runtime privacy
is in `apps/pipeline/src/runtime.mjs`. The observed-source allowlist recognizes
the separate native family without enabling an installed capability.

Focused synthetic coverage is split across:

- `packages/github/test/issue-field-history.test.mjs`: actual client pagination,
  resume, private-scope changes, poisoned completed checkpoints, and authorization.
- `packages/github/test/issue-field-normalizer.test.mjs`: native artifact and
  attribution binding, scalar/option profiles, revision integrity, no-op handling,
  and actual normalizer batch freshness.
- `apps/pipeline/test/issue-field-source.test.mjs`: collector and durable fact
  admission boundaries, captured time ranges, and filtering before pagination.
- `apps/pipeline/test/issue-field-privacy.test.mjs`: runtime denial, SQL retention,
  restart, cached outputs, and final public admission.

The GitHub tests use a real `GithubReadClient` with a synthetic HTTP transport and
a private in-memory repository checkpoint seam. Runtime and storage tests use
the existing pipeline harness and SQL implementation. These tests establish
software behavior under controlled source responses; they are not evidence of
a real installation's field visibility, supported payload prevalence, or
historical completeness. The existing `timeline-history.ts` reader and #347's
generic reconciliation-window policy remain separate from this native adapter.
