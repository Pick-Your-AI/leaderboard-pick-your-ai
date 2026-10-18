# Public membership scopes

This is the bounded backend contract for the current-versus-event and Project-filter portions of [LB-11.02 / #91](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/91). It connects the [reviewed native Project context](project-workstream-contexts.md) to explicitly approved public materializations. It does not enable ad-hoc collection or authorize a source, configuration, historical completeness claim or release.

## Selection and compatibility

The default membership basis is **event context**. Existing organization/repository/workstream/start/end scopes keep exactly their original five-field object, five-element storage key and public response/export format. `context=event` is an alias for that default when no Projects are selected. A configured explicit `context: "event", projects: []` is also canonicalized to the original publication scope; approved configuration bytes and their authorization hash are retained separately.

The API accepts two additional query parameters:

| Parameter | Meaning | Bounds |
| --- | --- | --- |
| `context` | `event` or `current`; omission means `event` | One value; other values fail before provider access |
| `project` | Comma-separated native Project V2 node IDs; membership in any selected Project matches | At most 100 IDs of 1–128 allowed opaque-ID characters; canonical sorted set; the full request remains bounded to 4,096 characters |

Repeated query parameters, empty Project entries and malformed IDs are rejected. Project node IDs may include `=`; ordinary URL encoding preserves them. Repository and workstream filters combine with the Project union. The producer evaluates the underlying contribution facts once; it never adds together per-Project totals.

For example, this is **synthetic syntax**, not a source or production configuration:

```text
/api/v1/boards?organization=Pick-Your-AI&metric=issues_opened&context=current&project=PVT_synthetic_A,PVT_synthetic_B
```

Any current-context selection or nonempty Project set has this explicit scope shape:

```json
{
  "organization": "Pick-Your-AI",
  "repository": null,
  "workstream": null,
  "start": null,
  "end": null,
  "schemaVersion": "public-scope/v2",
  "context": "current",
  "projects": ["PVT_synthetic_A", "PVT_synthetic_B"]
}
```

Current scopes without a Project filter still include `projects: []`. Event scopes with a Project filter explicitly include `context: "event"`. A provider may not return an unversioned extended scope; the service rejects it rather than silently reinterpreting an older document. The canonical scope participates in the immutable snapshot digest, publication/control identity, scope equality, signed cursors, paired comparison selection, shared links, contributor-card links, update polling URLs and exports.

Legacy scope keys stay `JSON.stringify([organization, repository, workstream, start, end])`. Extended keys append the tagged tuple `["public-scope/v2", context, projects]`. Equivalent Project orderings and repeated IDs share one key. Different bases or Project sets cannot share a materialized head or a pinned read. New cursors bind a SHA-256 digest of that complete scope key so a bounded Project list cannot make a valid cursor too large; existing default cursor bindings are unchanged.

## Explicit materialization and source fences

The host must add each desired scope to its reviewed `config.scopes` list. The existing maximum of **100 approved materializations** remains in force, and canonical duplicate scopes are rejected. Selected Project IDs must belong to the explicit approved Project sets of the selected repositories. A Project selected across several repositories does not make membership outside a repository's proved Project scope known.

Queries read only exact configured publications. A missing current or Project materialization returns `503 public_snapshot_unavailable`; a missing or differently scoped pin returns the existing `410 snapshot_expired_refetch`. Neither request falls back to another basis, allocates a new head, starts collection, or expands source authorization. Private, revoked or unavailable source state continues to withhold pinned history under the existing current authorization fence.

The approved configuration remains detached and unmodified. Its exact bytes continue to supply configuration and private authorization hashes. Only query/publication scope objects are canonicalized. A real configuration change still requires its own approved version and receipt; canonical scope equality does not grant configuration approval.

## Time, counting and unknown membership

`current` means membership from the latest eligible **completed inventory at the frozen observation cutoff**. It does not mean a live GitHub read at request time. A later completed empty inventory removes the current match in a new publication; an earlier pinned current snapshot retains its own frozen membership. Source privacy and suppression controls remain current even when the membership snapshot is historical.

`event` uses only the membership evidence known for the action. A current association never fills missing event-time history. Workstream mappings, incomplete native subject context, and Project scope limits retain the engine's existing unknown semantics. An unknown match is not a known zero. The public evidence/privacy projection may leave no public cohort when no scoped proof exists, so an empty page with incomplete coverage is also not proof of zero activity or complete history.

One native contribution in two selected Projects counts once. Eligible unboarded work remains in the organization total when no Project/workstream filter is applied. Changing the context basis does not create an action, actor credit, acceptance receipt or event timestamp. The existing metric policy, pending-work rules and coverage predicate remain unchanged.

Rank movement requires matching membership basis, Project set, workstream and repository selection in addition to the existing window, policy, actor-cohort, source-coverage and retained-evidence checks. Each retained engine receipt must match its own public scope. Mismatches remain unavailable with an explicit reason; the API does not subtract displayed ranks across incomparable scopes.

## Versioned responses and exports

| Boundary | Legacy event scope | Extended scope |
| --- | --- | --- |
| Public scope object | Original five fields | `public-scope/v2`, explicit context and Projects |
| API JSON envelope and update payload | Existing `schemaVersion: "leaderboard/v1"` | `schemaVersion: "public-read/v2"`, plus `snapshotSchemaVersion: "leaderboard/v1"` |
| Nested snapshot, metric, actor and evidence contracts | Existing versions | Existing versions; only the containing scope/envelope changes |
| JSON/CSV export envelope | `public-export/v1`, unchanged bytes | `public-export/v2`, full versioned scope |
| CSV scope metadata | Existing columns | Additional `scope_schema_version`, `context`, `projects` columns after `workstream` |

The export `schemaVersion` continues to identify the nested snapshot contract; `exportSchemaVersion` identifies the export envelope. In CSV v2, `projects` is a quoted JSON array and every metadata/data record repeats all scope fields. Formula protection, byte limits, public-proof minimization, policy metadata, pending proofs and comparison metadata remain enforced. HTML/SVG contributor cards name the frozen membership basis and selected Projects and preserve that selection in their portfolio links. The API routes remain under `/api/v1`; unsupported selectors were previously rejected, and the new opt-in payloads carry their own explicit versions.

Browser integration is a separate coordinated delivery after [the canonical comparison UI](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/270). Before exposing these selectors, a consumer must validate the complete `public-read/v2` envelope and `public-scope/v2` identity, support both v2 export formats, and preserve context/Projects through every navigation, pin, cursor and comparison action. Comparing only the original five scope fields is insufficient. Existing strict v1 export consumers must continue rejecting v2 until that support is implemented.

## Automated evidence and remaining #91 work

The dedicated contracts and HTTP cases verify legacy byte compatibility, canonical detached Project sets, all JSON routes, provider-version rejection, malformed inputs, current privacy projection, fixed-size scope-bound cursors, links, cards, updates, both export formats and retained rank-history binding. PGlite integration uses real collection SQL, normalization, immutable frozen inputs, publication/control heads and the metric engine with an explicitly synthetic Project adapter. It covers overlapping Projects, eligible unboarded work, unknown historical membership, frozen pins after a completed empty inventory, privacy loss, unmaterialized views and bounded admission.

```bash
npm run build
node --test --test-concurrency=1 packages/contracts/test/public-scope.test.js apps/service/test/public-scope.test.mjs apps/pipeline/test/public-scope.test.mjs
```

These tests do not certify live GitHub source capability or complete historical coverage. Calendar/named-period controls, user-selected timezone presentation, role/actor selector delivery, browser v2 integration, and the remaining full #91 acceptance evidence retain their existing owners and gates. This backend change alone does not close #91 or alter the 98-metric plan.
