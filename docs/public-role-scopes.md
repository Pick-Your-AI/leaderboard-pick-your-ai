# Public contribution-role scopes

This implements the public role-filter backend portion of [LB-11.02 / #91](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/91). The [existing metric engine](../packages/metrics/src/engine.ts) selects contribution facts by role before aggregation. This extension carries that selection through approved public materializations, their immutable identities, every read and export, and retained comparison evidence.

## Meaning and admission

The optional `role` query parameter is a comma-separated union of contribution roles: `author`, `coauthor`, `reviewer`, `merger`, `triager`, `reporter`, `resolver`, `nominator`, or `automation`. The bounded input accepts at most nine entries, sorts them and removes duplicates. Empty entries, repeated query parameters, unknown values, sparse configuration arrays and malformed values fail before a provider is read. Omitting the parameter means all roles admitted by each metric's approved policy. `unknown` is unresolved attribution; it is not an affirmative contribution-role filter.

A contribution must satisfy both its metric policy's role predicate and the selected role union. A role filter cannot enable a role excluded by that metric's policy. A contributor can have several evidenced roles; the selection neither assigns a job title nor infers a role from a profile or account kind. These are contribution roles, separate from the [protected service's server-side authority roster](contributor-controls.md). For example, selecting `reviewer` grants no review, moderation, publication or operator capability.

The role union combines with organization, repository, workstream, Project membership and the date window. The producer evaluates the selected underlying facts once under the existing metric grouping rule; it does not add overlapping role or Project totals. Existing [actor filtering](../packages/contracts/src/actor-filter.ts) remains a separate whole-actor projection. Account type and unknown execution mode do not establish manual activity.

The approved configuration must explicitly list each desired combination in `config.scopes`. The existing maximum of 100 approved materializations includes role selections; there is no automatic Cartesian expansion. Canonical aliases cannot allocate duplicate heads. A syntactically valid but unapproved combination returns `503 public_snapshot_unavailable`; a differently scoped historical pin returns `410 snapshot_expired_refetch`. Requests cannot create materializations or initiate source collection. The exact approved configuration bytes and authorization hash remain unchanged by detached scope canonicalization.

## Version and identity

Default scopes and membership-only scopes preserve their previous serialized fields and keys. A nonempty role set uses a new version, including when its membership basis is event context with no selected Projects:

```json
{
  "organization": "Pick-Your-AI",
  "repository": null,
  "workstream": null,
  "start": null,
  "end": null,
  "schemaVersion": "public-scope/v3",
  "context": "event",
  "projects": [],
  "roles": ["author", "reviewer"]
}
```

This is synthetic contract syntax, not an approved deployment configuration. Versioned v3 documents require explicit context, Projects and a nonempty role set. A v2 document cannot carry a `roles` member, even an empty one. An unversioned configuration with `roles: []` canonicalizes to its existing default or membership-only scope; retained versioned documents are not upgraded or rewritten.

| Boundary | Default event scope | Membership selection without roles | Nonempty role selection |
| --- | --- | --- | --- |
| Scope | Original five fields | `public-scope/v2` | `public-scope/v3` |
| API JSON and update envelope | `leaderboard/v1` | `public-read/v2` | `public-read/v3` |
| Nested snapshot, actor, contribution and metric contracts | Existing versions | Existing versions | Existing versions |
| JSON/CSV export envelope | `public-export/v1` | `public-export/v2` | `public-export/v3` |
| CSV scope metadata | Original columns | Additional version, context and Projects | Same v2 columns followed by `roles` |

The complete v3 storage key is the original five-element tuple followed by `["public-scope/v3", context, projects, roles]`. Canonical role order and duplicate spellings identify one scope. Omitting, widening or narrowing roles selects a different head and cannot reuse its pin. The filter key retains every selection dimension while excluding only comparison-window bounds. Cursors bind the actual version and a SHA-256 digest of that complete key; the existing default and v2 cursor bindings remain unchanged.

The API routes remain under `/api/v1`. New scope and envelope versions are explicit. The JSON export's `schemaVersion` still identifies the nested snapshot; `exportSchemaVersion` identifies its export format. In CSV v3, `roles` and `projects` are quoted JSON arrays and every metadata/data record repeats the exact selected values, including an empty export. Existing CSV v1 and v2 bytes, formula protection and response budgets are preserved.

## Projection, history and privacy

A provider must return the complete matching versioned scope. It cannot omit the version or roles, substitute a wider selection, mutate the authoritative request, or satisfy a v3 request with a v1/v2 document. Projection detaches role and Project arrays before exposing them.

Primary, portfolio and pending evidence must match at least one selected contribution role. If a published aggregate depends on evidence that fails that scope or current privacy checks, the whole aggregate is withheld. The service never subtracts proof counts to manufacture a new total, ratio or weight. Missing out-of-role pending proof yields an unknown pending count. An empty view under incomplete coverage does not prove zero activity.

Current membership keeps its [frozen observation-cutoff semantics](public-membership-scopes.md). A role pin survives an ordinary database reopen with the same immutable scope and document. Source privacy, suppression and revocation remain current for that historical pin; a role selection does not bypass them.

Rank comparisons require the exact role union in each public projection and its own retained engine receipt, alongside the existing membership, source, policy, window, cohort and proof checks. A changed public selection or a retained receipt with missing, widened or narrowed roles cannot supply rank movement. Shared board links, contributor cards, update polling and both export formats preserve the complete selection. HTML/SVG cards explicitly name the contribution roles.

## Verification and remaining delivery

The dedicated contract and HTTP cases cover old scope bytes, detached canonical unions, strict version admission, every public JSON route, provider mutation, cursor identity, contribution/pending proof, current suppression, links, cards, updates, JSON/CSV metadata and retained rank comparison. Embedded PostgreSQL integration uses real collection SQL, normalization, the metric engine, frozen inputs, public heads and controls with explicitly synthetic source fixtures. It checks role exclusion, Project overlap, configuration-hash preservation, a database reopen, cross-scope pins, current privacy loss, unapproved combinations and admission before collection.

```bash
npm run build
node --test --test-concurrency=1 packages/contracts/test/public-scope.test.js packages/contracts/test/public-role-scope.test.js apps/service/test/public-scope.test.mjs apps/service/test/public-role-scope.test.mjs apps/pipeline/test/public-scope.test.mjs apps/pipeline/test/public-role-scope.test.mjs
```

The current browser's v1 reader requires a coordinated v2/v3 integration before these selectors are exposed. That work must preserve the full versioned scope through every navigation, comparison, proof, download and history action. It receives the canonical comparison and timestamp/error work in [#270](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/270) / [#118](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/118), and the existing prototype work in [#277](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/277).

Named publication periods, the initial 30-day browser experience, selected timezone presentation and full browser acceptance remain coordinated #91 work. These synthetic tests establish the tested implementation boundaries; real-source completeness and public release retain their own gates. This slice changes no metric definition or underlying attribution algorithm.
