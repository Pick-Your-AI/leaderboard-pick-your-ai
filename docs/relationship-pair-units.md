# Conserved reference and closing relationships

This source correction contributes to [LB-19.01 / #72](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/72) and [LB-08.03 / #87](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/87). It implements the existing [metric-definition decision](metric-definition-review.md) for `reference_links` and `closing_links`. Both metrics remain definition-only. Synthetic regression results do not establish a native reference/closing collector, approved source capability, public activation, or either work package's full acceptance.

## Event evidence and measured units

An independently identified source event remains an observation with its actual actor, occurrence time, observation time, source revision and endpoint view. Observation replay, a second mention, removal and reconnection are different from the unit being measured.

| Metric | Conserved unit | Attribution |
| --- | --- | --- |
| `reference_links` | One ordered source/target endpoint pair | The first orderable reference in the authorized known history |
| `closing_links` | One typed pull-request/issue pair, regardless of endpoint-view order | The first orderable connection in the authorized known history |

A repeated reference cannot create another unit for the same directed pair. A disconnect is retained as history and supplies no new connection credit. A reconnect cannot change the selected relationship's actor or move it into a later reporting window. Reversing a reference's direction identifies a different pair; reversing the representation of the same closing pair does not.

The private `relationship-pair-units/v1` descriptor binds the relationship kind, action, native event identity and both typed endpoints. Each endpoint has a stable artifact identity, repository binding and issue/pull-request kind. The protected enrichment provider must verify those bindings and public endpoint access. Prefixes in an opaque identifier, issue text, a current snapshot or an unverified URL cannot supply them. The current source view must agree with a verified endpoint. The descriptor is a source/calculation contract, not a public response field or collection permission.

The supported enriched actions are `referenced`/`cross_referenced`, `connected` and `disconnected`. These simple native event forms cannot bind one event identity to contradictory pairs, directions, actions or actors. Generic body-edit projections that add several links need a separately specified source contract and remain unsupported here. A text edit does not become a verified reference merely by using this descriptor.

## Selection, ambiguity and partial history

The engine retains its existing revision and canonical-event conflict checks. It conserves these two pair units before actor, role, repository selection, Project/workstream and date filters. Filters therefore apply to the selected contribution; they do not elect a later contributor or connection. Identifiable unresolved earlier facts prevent a later event from silently taking their place. An admitted later reviewed revision resolves its own older rejected revisions. An unresolved same-fact revision cannot restore credit by removing its relationship descriptor or changing its clock. Earlier admitted bindings supply only uncertainty context when a reviewed current value becomes unbound; they cannot restore an old contribution. A valid reviewed endpoint correction instead uses the corrected pair.

The supported calculation selects observed triager activity, canonical pair grouping and the source occurrence clock. An alternative artifact grouping or acceptance clock cannot silently change the unit. The calculation's grouping policy is explicitly pinned to `relationship-pair-units/v1`.

Missing clocks or an ambiguous first actor stay unavailable. Agreeing earliest endpoint views may share one unit when they agree on actor, time and attribution scope. Different verified endpoint artifact identities can supply alternate views of that same unit. Project and workstream membership order does not change a set's meaning, while unknown and known membership remain distinct. Conflicting repository or Project/workstream attribution remains unknown; the engine does not invent a cross-repository ownership rule or choose a scope by sorting IDs. The raw observations remain available to the existing protected evidence path.

The selected event is first in the frozen, authorized **known history**, not necessarily first-ever. The accepted [recognition policy](metric-recognition-policy.md) permits known positive partial counts with explicit coverage limits. This correction adds no global completeness requirement and cannot turn missing history into a measured zero. Reporting windows retain their half-open bounds and use the selected source occurrence time.

## Repository selection and private authority

Repository display selection does not narrow the authority needed to establish a pair. A selected issue-side observation can require a pull-request endpoint in another configured repository, even when that repository has no collected observation of the relationship. Both repositories must have their own approved configuration, matching installation, current public access and source generation. The endpoint descriptor cannot grant that access or add a repository to the configuration.

The pipeline retains related, currently normalized peer history before the engine conserves the pair and applies the display selection. An earlier peer event therefore cannot disappear merely because the user selects the later event's repository. The private frozen input binds the required source repositories, exact normalization source keys, document hashes, current generation signatures and selected pair-fact hashes. Retained historical wrappers provide withdrawal identity; they cannot replace current calculation facts or supply missing current authority.

Dependency-only normalizations contribute only the required pair facts and their actors to the calculation. Frozen restoration applies the same bound projection. An unrelated resource author or alias in the full retained document cannot change the selected contributor's identity during replay. An identical historical wrapper may coexist with the captured current row, but removing that current row still makes replay unavailable. Dependency-only actors do not become public members of the selected repository unless selected public evidence independently includes them.

Repository revocation, typed endpoint deletion and existing whole-artifact corrections also withdraw dependent pair evidence from current and pinned public projections. A legacy correction expands through its verified issue-transfer aliases and the same pair, native event and fact history. Derived evidence removals do not recursively become new endpoint removals for unrelated pairs. Existing effective-correction exemptions remain unchanged. These are current privacy overlays: retained normalizations and frozen inputs are not rewritten.

## Retained data and publication

An older calculation policy without the required grouping-version pin must be explicitly revised through the existing configuration/review workflow. Its policy signature and configuration hash change; this code does not silently upgrade an approved policy or rewrite its approval. Earlier publications under that configuration retain their historical identity and cannot authorize current output through the existing configuration guard.

The relationship normalization version has its own cache generation. It composes with the existing review, Discussion, typed-history and default-delivery generations without changing their meanings. Affected claims can originate in protected enrichment for any collected family; selecting only the native `relationships` family is insufficient.

A source with an affected legacy fact or evidence claim is rehydrated into the new generation. Once assigned, that generation remains assigned even if corrected output contains no relationship facts. Restart cannot restore an older positive result. Earlier normalization documents, their hashes and earlier snapshots remain immutable.

The loaded contracts, metric engine and built-in normalizer must export the matching version. A replacement normalizer must explicitly accept the same provider contract. A label in its output or an unrelated host option cannot qualify an older built-in normalizer, engine or contract module. These version checks supply no independent source evidence.

Current and pinned publication reads, private comparisons, replay recovery and operator confirmation must bind the applicable generation to the actual retained source documents. A new confirmation marker cannot upgrade old semantics. Corrected-empty results retain their generation even when there are no displayed relationship references. Existing source access, privacy, independent approval and immutable-publication checks continue to apply.

Recovery uses the existing authorized replay and publication workflow. Reprocessing must use the retained verified source or newly authorized evidence; missing typed endpoint evidence stays unavailable. No source deletion, live reprocessing, public enablement or completed operational recovery is implied by merging this source change.

## Regression boundary

The original failures are preserved separately from the corrected runs: connect/disconnect/reconnect produced three units for one closing pair, and two independently identified references produced two units for one directed pair. The corrected fixtures supply explicit synthetic endpoint bindings. They must exercise repeated events, replay and input order, distinct pairs, endpoint mirrors, conflicting attribution, missing identities and clocks, original-window ownership, and partial coverage.

Pipeline regressions must additionally cover affected enrichment outside the native relationship family, unchanged-source migration, restart after corrected-empty output, immutable old rows, component/provider version checks and retained public/private/replay authority. Integrity-valid synthetic pre-generation caches under the current version-pinned policy test the source-generation fence separately from policy approval; they do not prove an implicit upgrade of an older unpinned policy. Unrelated metrics retain their existing source and counting rules. Native hierarchy/blocker collection and the separate target-branch feature are outside this correction.

The repository-authority suite uses the actual collector, built-in normalizer, SQL storage and private comparison path for both metrics. It covers an independently approved endpoint with no peer source row, unapproved and unavailable peers, revocation, collector-recorded endpoint deletion, earlier peer history, exact actor projection across database reopen, identical legacy wrappers, loss of the captured current row and ordinary approved peer corrections. JSON and CSV exports share the current and pinned withdrawal requirements. All source identities, access assertions and receipts in these tests are synthetic.
