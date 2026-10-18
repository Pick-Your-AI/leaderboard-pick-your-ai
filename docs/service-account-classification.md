# Reviewed service-account classification candidate

Refs [#40](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/40).
This change adds a concrete service-account distinction to the existing
identity, role and declared-assistance boundary. It does not detect whether a
person wrote code manually or used AI, and does not enable a source or metric.

## Evidence and trust boundary

`serviceAccountClassificationSchema` and `ServiceAccountClassification` use
`leaderboard-service-account/v1`. Each private record requires a classification
ID, positive safe integer GitHub database ID, optional GitHub node ID, source
(`reviewed_source` or `reviewed_configuration`), nonempty evidence IDs, reviewer
actor ID and review time. Evidence IDs reference reviewed records; they are
not raw payloads, credentials, emails or user-facing URLs.

The authorized collector supplies `reviewedServiceAccounts` and
`authorizedClassifierIds` to `normalizeGithubObservation`, or as protected
`createGithubEvidenceNormalizer` options for hydrated and enriched observations.
The host must authenticate the reviewer and evidence, select one current
reviewed classification per stable account, and pin this configuration in its
normalizer/policy revision. Well-formed strings and an allowlist are structural
checks, not proof that the host authenticated a real review. Public requests,
API object properties, commit trailers and login patterns cannot supply these
trusted inputs. No default service-account list or heuristic is installed.

The normalizer requires a matching numeric source ID and, when the review
includes it, a matching node ID. REST and GraphQL observations with the same
IDs retain the same actor/canonical fact identity after login changes. A
GraphQL actor lacking the required numeric ID remains unresolved in this
adapter; this does not claim universal source-field coverage. Conflicting
numeric/type signals remain unresolved. Across every actor role in one
observation, a node ID cannot bind to two database IDs and a database ID cannot
bind to two node IDs, even when the review omitted its optional node ID or the
conflicting account is visited first. A conflicting observation fails as a
whole; no identity is remapped and no earlier role silently wins. Duplicate classifications, conflicting
node/database references, unsupported versions, unauthorized or self-review,
future reviews and conflicts with a source Bot/App/Organization fail closed.
An unrelated account with a similar login never inherits a classification.

The contract's `reviewedAt` accepts explicit ISO offsets and arbitrary fractional
precision. Cutoff checks compare that validated source instant exactly: an
equivalent offset or zero-padded endpoint is valid, while a review one nanosecond
after the observation is still future evidence. This does not widen the existing
UTC, millisecond observation and metric clocks or round/rewrite the review time.

A reviewed classification specializes only a known source `User` into
`service_account`. Native `bot` and `github_app` kinds remain distinct where
source evidence supports them. Missing classification leaves `user` as a
GitHub User-account type, not a claim that a human or manual work was proven.
Execution mode remains `unknown` unless separately evidenced as `automated`;
model/version assistance remains artifact metadata. Author, coauthor,
committer and merger assignments remain separate. Release service accounts
use the existing automation role without acquiring release-note authorship.

## Engine, privacy and exports

Normalized actors retain the private `serviceAccountClassification` record.
The engine requires it for `service_account`, matches its database ID to the
actor ID and any supplied node ID, and rejects evidence later than the frozen
cutoff or attached to a relabeled non-service account. Frozen input also
rejects conflicting node/database bindings across separately normalized
observations; filtering cannot hide a conflicting identity. The trusted source boundary still authenticates
that evidence. Both ranking and portfolio `user` scopes exclude service
accounts; `automation` and `all` scopes can retain their actual supported
facts. These filters distinguish account types and evidenced automation, not
human effort. User accounts with explicit automated execution can still appear
in both user-account and automation views.

The pipeline's existing allowlisted Actor construction omits classification
receipts. The public Actor schema rejects embedded private receipt fields;
board/profile projections retain `kind: service_account` and the separate
execution mode. JSON exports now include `actorKind` and `executionMode`, with
CSV `actor_kind` and `execution_mode` columns. Missing export actor metadata is
`unknown`, never `user` or `manual`. Reviewer IDs and classification evidence
are not public export fields. The current web export validator accepts these
additive labels and validates their values against the shared enums. Legacy
exports may omit either label; a present invalid label rejects the download,
and absence never becomes a human/manual claim. No UI rendering changes are
included.

## Compatibility and migration

- The repository still labels `leaderboard/v1` an implementation candidate.
  The `service_account` enum extension is a coordinated candidate change,
  not a claim that an immutable published contract can change silently. A
  stabilized deployment must use a new major Actor contract or explicitly
  reviewed version negotiation before this new enum is emitted.
- Old records remain readable. Do not mass-convert old `user` actors to
  service accounts, humans or manual execution. Classification requires
  stable-ID evidence and review. A removed or unavailable review is not
  permission to silently restore a known service account to a human ranking;
  quarantine it pending an explicit reviewed correction.
- Older strict readers reject the new kind. Roll out contracts, normalizers,
  engine, pipeline and public readers together before enabling classification.
  Never downcast `service_account` to `user` for compatibility. Unsupported
  readers must return unavailable or withhold the affected publication.
- Preserve immutable source observations and historical snapshots. Pin the
  reviewed classification set, evidence version and normalizer revision;
  invalidate/recompute derived normalization and aggregate caches under a new
  reviewed revision. Reuse the original actor IDs, keep classification receipt
  history, and rerun public projection/exports. The existing pipeline rejects
  conflicting actor metadata, so mixed old/new caches must be reconciled
  rather than selecting the more convenient classification.
- Frozen replay cannot use a classification reviewed after its observation or
  engine cutoff. An explicit reviewed correction/recomputation can publish a
  new snapshot; it must not rewrite what an older snapshot claimed to know.
  Rollback must preserve the reviewed exclusion or withhold affected rows,
  never erase the distinction to make a legacy reader succeed.

## Publication and private preview boundary

Publication passes full normalized provider bindings to the engine, after
rejecting conflicting repeated canonical IDs. The engine rejects node aliases
across distinct actor IDs before aggregation or portfolio selection. Privacy
projection happens only after these checks.

Private preview inputs keep only actor ID, login, kind, public state and
execution mode. Their authorization binds a versioned list of exact restricted
normalization-document hashes. Under the existing source-generation read locks,
configuration and reviewer authority fences, preview replay loads and verifies
those documents from the private normalization store and restores provider IDs
and reviewed classification transiently for the engine. Retained preview input,
results, private-preview HTTP responses and public exports never contain those
private fields. Public board/profile Actor contracts retain their already-public
stable provider IDs, but never gain classification receipts.
Missing, changed, conflicting or over-budget evidence makes the preview
unavailable; it never downgrades an actor. The original public-state overlay is
preserved when rehydrating identities. Legacy minimal previews without a binding
retain their previous behavior, but cannot replay service accounts without valid
reviewed evidence. Classification-enabled replay requires this coordinated
pipeline/controls integration; the engine has no bypass flag.

Cached publication and frozen identity restoration also validate the private
classification against each immutable source row's observation time before
joining actor evidence. Both hash-only and source-bound historical inputs obey
this check, including identical documents retained for multiple source rows. A
later metric cutoff or valid retained copy cannot repair an earlier source-time
violation. An affected publication or preview is withheld without changing its
normalization signature, source/cache/frozen hashes, or published head. Retained
bytes remain available for an explicit reviewed correction; this check does not
invent a replacement classification or claim to have recomputed old snapshots.

## Verification and remaining acceptance

Synthetic contract, normalizer, engine, public read and JSON/CSV export tests
cover version/evidence requirements; REST/GraphQL rename identity; ignored
login/payload/model hints; unknown and conflicting actors; Bot/App separation;
protected hydrated/enriched configuration; separate author/merger/release
roles; user/automation/all filtering; missing/future/downcast evidence; and
private provenance exclusion. Existing role/coauthor/model-trailer tests
continue to apply. Tests are not real contributor evidence or source canaries.

The classification-time cases cover REST/GraphQL and protected hydrated/enriched
normalization, independent aggregation and portfolio selection, exact and offset
endpoints, sub-millisecond future reviews, and strict observation/metric clocks.
Actual disposable PGlite/PostgreSQL and SQLite pipeline cases exercise cached
publication and both frozen identity binding formats, database reopen, unchanged
historical bytes on denial, and a valid copy alongside an earlier invalid source.

Completed in this slice: service-account representation, reviewed source
normalization, engine filter enforcement and safe public labels. Public API
and UI actor-kind filtering, authenticated production classification review
and correction procedures, live source subtype/permission probes, owner
acceptance and release/migration execution remain separate gates. This change
does not close #40 by itself and does not claim deployment or a human ranking.

### Reviewed source-runtime integration

Both optional SQLite comparison inputs and SQL frozen policy inputs retain only projected actor labels plus provider-normalization hashes. Identity restoration queries the same versioned current-state normalization signature used by collection. Hash bindings are captured before transient recognition overlays are appended; those overlays cannot masquerade as persisted provider evidence. SQL policy preview reuses the current-source identity verifier and the same transaction for its publication/privacy guard. Tests exercise both preview paths with recognition configured and absent, and assert that neither store nor preview result retains provider IDs or private classification receipts.
