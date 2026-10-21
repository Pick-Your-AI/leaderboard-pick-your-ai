# Integrated collection and publication runtime

`apps/pipeline` composes the actual ingestion, GitHub, metric, public API and contributor-control components. It is a host-neutral application factory with real read-only GitHub REST collection, durable SQL progress/receipts, immutable public snapshots and current privacy/source controls. It defaults to unavailable until protected configuration is explicitly approved. No installed GitHub App, operator approval, live deployment, notification destination or source capability is invented.

## Build and run

The root workspace must include `packages/ingestion` explicitly alongside contracts/GitHub/metrics and `apps/*`. After merging sibling packages, regenerate the root lock with `npm install --package-lock-only`, then run `npm ci`, `npm run build`, `npm run typecheck` and `npm test`. The app declares its ingestion/contracts/GitHub/metrics/service/controls/pg dependencies and PGlite test dependency. Its own build/typecheck scripts check the JavaScript entry points. Runtime imports use compiled `dist` boundaries; the controls package deliberately publishes native `.mjs` modules.

The production host performs these steps:

1. Provision an approved private Postgres database and apply ingestion SQL migrations `001_ingestion`, `002_snapshots`, `003_collection`, `004_outbox_dispatch` and `006_delivery_payload_expiry`, using the ingestion migration procedure. The [delivery expiry migration](delivery-payload-expiry.md) supports explicit unavailable replay and durable operator counts without enabling an expiry job. Call `migratePipeline(db)` to add only the pipeline schema.
2. Open the real `ControlStore` at an absolute private SQLite path with suitable directory ACLs. Configure its authenticated provider/roles separately. It is not a mock or public JSON file.
3. Construct `GithubReadClient` with a protected installation-token provider and a private `FileCheckpointStore` or transactional replacement. Bind `sourceId` to that authorization/quota pool; absent/invalid installation credentials must not silently inherit another pool's scope. A production token provider must fail when its configured authorization is unavailable.
4. Supply protected approved configuration and `verifyConfiguration`, which checks the actual source/metric/configuration approval receipts and policy signatures. This callback defaults to denial. It must not trust a public request or repository text to approve itself. To enable pipeline-backed named-window discovery, also supply the pure synchronous `configurationAuthorityEpoch(binding)` read from that same authoritative host approval state. Its exact configuration hash/version/data-mode binding, non-reused transition epoch and current-expiry rules are specified in [the discovery host contract](public-date-windows.md#discovery-host-approval-capability). It must not manufacture approval from the async callback result, refresh remote state, or mutate authority during the read. Without this explicit capability, discovery is unavailable while ordinary board/worker behavior remains unchanged.
5. Create the runtime, call `start` with approved bind addresses, and invoke `runOnce` for a bounded batch or `run` for the periodic loop. Call `stop` on shutdown, then close externally owned SQL pools and the controls store.

```js
import { createPipeline, loadPipelineComponents, migratePipeline } from './apps/pipeline/src/index.mjs';

const components = await loadPipelineComponents();
// db, controlsStore, githubClient and approvedHostOptions are protected host inputs
// constructed above. They are intentionally not fixture credentials or approvals.
await migratePipeline(db);
const runtime = await createPipeline({
  components, db, controlsStore, githubClient,
  sourceId: installationAuthorizationScopeId,
  ...approvedHostOptions,
});
await runtime.start({ public: { host: '127.0.0.1', port: 3000 } });
void runtime.run({ intervalMs: 60000 });
process.once('SIGTERM', async () => { await runtime.stop(); });
```

`start` can also bind the actual signed ingestion webhook server and authenticated controls server on separate approved addresses. Webhook startup requires real active secrets and the approved installation/repository map; the actual durable inbox worker starts and drains received deliveries. Periodic collection reconciles current source facts into recognition snapshots; a webhook receipt alone does not award credit. Controls startup requires the host's verified identity provider, roles, approved policy catalog and CSRF/origin settings. Those settings and external database lifetimes remain host-owned. No service starts automatically on import.

## Explicit configuration

The protected configuration has this shape:

- `version`, `organization`, `approvalReceipt`.
- `repositories`: reviewed numeric `id`, numeric `installationId`, canonical `owner/repo` `slug`, approved `families`, and `approvalReceipt`.
- Optional `reconciliation`: the exact approved `lookbackMs`, `overlapMs` and `fullAuditsPerCycle` policy described in [bounded reconciliation](reconciliation-windows.md). It is absent by default; it does not create a schedule or source grant.
- `policies`: an actual `MetricPolicy`, its exact `metrics.stableJSON(policy)` signature, an independent `approvalReceipt`, and optional public `policyLink`.
- `scopes`: exact public API scopes `{organization,repository,workstream,start,end}`. Repository IDs are numeric strings or null. Date bounds are both explicit UTC instants or both null. Null bounds mean the API's all-time lens; a last-30-day view must use explicit reviewed dates. Unknown/unmaterialized scopes are unavailable rather than reconstructed by summing overlapping aggregates.

A policy's definition version must match the retained metric registry, and its aggregation/unit/evidence class must pass the actual engine's validation. The snapshot's methodology sidecar discloses each metric policy version and SHA-256 signature; the computation identifier binds all approved signatures. Per-path file counts and per-head review rounds require canonical-unit grouping, and decided ratios require one artifact denominator. Conflicting lifecycle decisions are unavailable until a trusted selected-as-of cohort proves their state; the pipeline does not silently select an earlier decision. No public metric is enabled by merely existing in the 98-definition registry. Approved host configuration is the additional publication gate around engine candidates, which remain `publicEnabled:false` internally.

The server-side `configurationOverlay` is read from current private controls state for every run/read, including pinned snapshots. It can restrict approved repository IDs and disable metrics; it cannot expand the protected static scope. Disabled metrics retain a public machine-readable explanation and policy reference and cannot render as zero. Free-form reviewed control explanations remain in the controls publication; the pipeline maps them to `metric_disabled_by_approved_configuration` for the API's bounded machine-code contract. Repository removal invalidates affected projections entirely rather than subtracting overlapping totals.

Each serialized run pins the controls configuration revision. Collection rechecks it before and after page reads, after repository probes and normalization, inside the fact-write transaction, and inside snapshot publication. Remove/reapprove cycles require a new run instead of accepting stale in-flight results. The default collection adapter and GitHub normalizer pass a per-operation synchronous authorization callback into the read client. It is checked immediately before each HTTP attempt, after checkpoint, quota, concurrency and token awaits, including retries; denial is sanitized and non-retryable. No global mutable credential/client setting is changed. Already issued network work cannot be recalled, and previously authorized retained data is not erased.

After PostgreSQL commits, publication requires a second **private controls confirmation**. One synchronous SQLite transaction rechecks the pinned configuration revision, captures the private policy-preview input, records `pipelinePublications[snapshotId]`, and advances `pipelineHeads[scopeKey]` only monotonically. Both records bind the immutable snapshot ID/revision, scope, complete configuration hash/version and data mode. PostgreSQL's head allocates revisions; the private confirmed head alone authorizes public availability. A failed second confirmation leaves the previous confirmed head available, while the newly committed SQL snapshot remains unavailable. A delayed older confirmation or dispatch acknowledgment cannot rewind either head.

Public reads fetch only the confirmed head and requested immutable pin, validate both documents' integrity and strong confirmation markers, and recheck configuration approval after awaited SQL work. They retain current repository-access locks while applying artifact/correction and private contributor/configuration overlays. If confirmation advances during the read, it retries with the new head (at most three attempts, then unavailable). Boards, evidence, exports and update notices therefore share one confirmed revision; no notice advertises an unconfirmed SQL head. Confirmation pointers, markers and preview/audit inputs are absent from `/controls/public` and public API documents. Current legitimate metric, repository and contributor-privacy overlays still apply to historical pins; reads do not impose blanket equality with the current controls revision.

For upgrades and recovery, legacy snapshots without strong confirmation or the private head fail closed, including older version-only markers. An authorized collection/recomputation run can reconfirm the identical latest SQL snapshot after current source checks, without adding a revision; do not blindly backfill private authority from SQL rows. A delayed historical dispatch cannot initialize missing head authority when a newer SQL publication exists. A dispatch recovering its own unconfirmed SQL commit reconstructs the exact frozen input and captures it in the same confirmation transaction. Its private SQL publication receipt binds the complete input, engine scope, policies, aggregate audit, snapshot and authorization by canonical digest; public content equality alone is insufficient. Changed or legacy-unbound replay inputs fail closed instead of fabricating preview provenance, even when an excluded/future correction leaves public totals unchanged. Strongly confirmed operation retries retain their original snapshot and cannot rewind a newer head. Missing or corrupt head documents/markers remain unavailable rather than falling back to arbitrarily older data.

Confirmations and last-known availability survive reopening both stores. An authorized exact rerun recovers a failed confirmation, while a later fresh successful publication advances beyond the failed SQL revision. Back up both stores under the approved recovery policy. Recovery of lost authority requires a currently authorized latest publication; these checks do not claim monotonicity across arbitrary restoration of older backups or mixed old/new publisher deployments.

SQLite controls and PostgreSQL commits are not one atomic transaction. Revocation during a final SQL commit can leave retained source facts or an unconfirmed snapshot; the in-transaction fence cannot undo a COMMIT already in flight. The confirmation boundary prevents public exposure and false run success in this case, without claiming atomic source retention/deletion. Production shared-storage, retention and recovery decisions remain separate release gates.

## Actual data path

The default `createGithubCollectionSource` performs read-only requests through `GithubReadClient.rest` and resumable `scanRest`. It supports repository issues, pull requests, commits, issue comments and releases. It verifies current public repository identity and uses stable API object IDs, revision timestamps/SHAs and public source URLs. Repository issue lists exclude embedded PR objects. Scan cursors and expected counts are fixed to one bounded operation; completed scans remain durable. Each collection run persists accepted facts/pages and progress through the actual `CollectionStore`.

The default source has guarded branches for `reviews`, `discussions`, `project_current`, `project_history` and `relationships`; using one requires current repository/family authorization and the required client capabilities, with explicit approved Project scope for either Project branch. Unsupported families fail closed instead of manufacturing history. A host can provide the same `ReadOnlySource` interface for a supported reviewed adapter. `sourceFamilies` is a catalog, not proof that the default source adapter implements every family.

`createGithubEvidenceNormalizer` hydrates authoritative source details and verifies subject/revision/public repository identity. Lossy current snapshots cannot become a guessed actor, field editor, first readiness, transition or accepted outcome. Real author/actor numeric database IDs and source node IDs are retained separately. `ControlStore` authenticated actor IDs are numeric GitHub database IDs; the pipeline requires the normalizer's explicit authoritative numeric mapping before constructing public actor contracts. A webhook node ID is never guessed to equal a controls database ID. User accounts remain account classes, not a claim of manual execution.

Canonical facts are deduplicated by stable fact ID only when semantic fields agree; the earliest observation timestamp survives. Conflicts fail publication. All raw source observations and normalization receipts remain durably separate. Public evidence IDs and actor/artifact/metric references must agree with the actual metric facts and configured repository URL. Qualified/reviewed values still require the engine's independent receipt rules.

Private normalizations also retain declared assistance as artifact ID, model and nullable version, and existing author/committer/coauthor participation as artifact ID, actor ID, role and conserved unit. Each list is capped at 100 entries; model/version labels are capped at 100 characters and exclude email, angle brackets and control-character content. References must bind to the collected artifact or normalized evidence, and participation must bind to a normalized actor. Extra fields, including trailer emails, are discarded. These records do not create actors, execution classifications, credit or public snapshot fields. The normalization document version invalidates older lossy caches on the next authorized run; exact legacy hashes remain usable only for already-bound frozen identity replay under the same policy/source/mode checks.

Normalization caches also bind the complete documentation path, locale and research policies, separately from metric aggregation signatures. Changing or removing classification rules recomputes the source facts on the next authorized run, including edits within an unchanged policy version; unchanged rules reuse the cache after restart. Active documentation policies require `documentation-locales/v2`, so retained projections from before the future-merge check, locale emission or substantive rename-origin classification are recomputed. An older projection, including the exact `v1` locale format, remains eligible only for frozen identity replay when its signature binds every active classification policy. In particular, a documentation-only historical signature is eligible only without an active research policy, and an unclassified signature cannot authorize classified source replay. Fresh classification uses the current combined key.

The normalization boundary preserves its 100 ordinary fact/proof limit while
allowing at most one additional paired slot for each eligible configured
locale/category unit, bounded by 32. It does not raise the actor or attribution
budgets. Accepted locale portfolio activity uses the exact original source unit
once, retaining its observed fact privately for audit and recomputation.

Recognition publication authority binds current evidence requests, suppression,
the relevant complete private audit entries and exact configured recognition
bindings. Its `localization-review-target/v1` fingerprint invalidates earlier
unbound authority on current and pinned reads. Locale recognition requires the
reviewer's actual acceptance target, exact current request/decision version and
source revision, and acceptance no earlier than the merge. Missing legacy targets
cannot become acceptance through a configuration change. A fresh authorized run
can publish the remaining observed participation; it never fabricates a new
review to restore an old qualified result.

The metric event-window cutoff is captured before collection. A separate observation cutoff is frozen after collection, so newly observed records are included without substituting ingestion time for occurrence/acceptance time. Each source's generation is captured before normalization and compared under the final publication lock. A remove/reverify race cannot publish facts from a prior access generation.

Snapshots are published with an SQL transaction: the document, monotonically advancing scope head and publication receipt commit together under a scoped advisory lock. Canonical hashing makes JSONB field order and replay irrelevant. Cached normalization and full snapshot documents also retain integrity hashes, checked before reuse or public projection. Replaying the same frozen event window/evidence/configuration does not advance the head. Source observations and pipeline receipts survive process restarts; a source-scan checkpoint is not confused with a downstream accepted contribution.

Bounded reads prove observed progress, not complete historical capability. Coverage remains explicitly partial with a fixed limitation until the independent capability/history gates can certify completeness. The pipeline does not convert unknown history into measured zero, and it never sums incompatible metrics or gives descriptive ratios/durations a personal rank. Diagnostic rows retain the engine's numerator/denominator, sample count, censoring, missing readiness and p75 sidecar through the public API.

## Current privacy, corrections and source revocation

`PublicSnapshotSource.read` uses one SQL transaction with current repository-access locks and checks, then reads current private controls state as its final synchronous action. The public API revalidates and allowlists every returned snapshot. Actor display suppression, unavailable/deleted artifacts, applied correction overlays and current metric disables apply to boards, profiles, evidence, CSV/JSON exports and live/polling endpoints, even for historical snapshot pins. Internal normalized documents, raw payloads, audit details and private request reasons are never returned as public snapshots.

A negative authoritative visibility/installation probe persists unavailable state, an incremented access generation and a fixed audit receipt before failing. A missing webhook cannot leave an old public snapshot accessible after a later probe discovers the repository is private. Unknown probe failures also fail closed until fresh authorized verification. Signed lifecycle revocation uses the actual ingestion receipt store and blocks current and historical projections; a revoked installation cannot be reopened by a stale public probe. Suppression signals from authoritative normalization become current artifact overlays rather than discarded empty results.

`applyCorrection` is a protected application capability, default-denied through `authorizeCorrection`. It supports an evidenced exclusion only; it does not invent identity merges or subjective recognition. A correction request must exist in the real controls store, match the exact public evidence locator/version, and have independent operator authorization and a real approval receipt. It first commits the durable SQL exclusion overlay/receipt under the repository write gate, then marks the controls request applied with an audit event. If the SQLite acknowledgement fails, the SQL overlay already prevents affected public aggregates from leaking. Retrying the identical approval tuple returns its original receipt; changing fact, version or operator cannot reuse another correction's receipt. Recalculation applies the actual engine revision, while old snapshot rows affected by the exclusion remain unavailable rather than having ratios or sums guessed by subtraction.

Postgres and SQLite are separate stores: this app provides fail-closed exclusion before acknowledgement and an idempotent recovery path, not a fictitious cross-database atomic commit. Multi-host deployments require the approved shared database/locking and controls-state architecture; the local controls store is not an arbitrary distributed cache.

## Synthetic separation and operational signals

`dataMode` defaults to `public`. Synthetic fixture labels/namespaces in protected configuration, source pages or normalized actors/facts are rejected before evidence publication; the default public configuration rejection writes no fixture facts, normalizations or snapshots. Tests must opt into `dataMode:'synthetic'`. Synthetic HTTP listeners are restricted to loopback and snapshot computation identifiers are visibly marked synthetic.

Collection run identities include their data mode; post-collection mode labels can only bind facts first written by that same run. Mode labels are durably bound to raw source fact keys, normalization cache keys/documents and snapshots. A public runtime cannot reuse a synthetic snapshot or cached/raw fixture facts merely by changing configuration text or restarting against the same database. Unlabeled prior source facts are unproven, not silently adopted into public rankings. Keep synthetic and production state paths/databases separate; migrate old source provenance through an explicitly reviewed import, not by relabeling rows.

An optional host-injected `OperationalMonitor` records actual collection, normalization and publication successes with measured latency and fixed failure stages/codes/trace IDs. It accepts no raw exception strings, source text, URLs or credentials. No monitor means unknown operational telemetry. No approved sink means no delivered alert claim. The pipeline does not select a destination, send a notification, invent an operational owner or advertise an SLA.

## Verification and remaining gates

`apps/pipeline/test/pipeline.test.mjs` runs the real `CollectionStore` against disposable PGlite, real durable control SQLite, actual `GithubReadClient`, the actual GitHub normalizer/metric engine and the real public API. Only network/provider responses and protected synthetic approval callbacks are injected. The tests cover all-time evidence older than 30 days, late duplicate normalization, deterministic replay, current/pinned suppression, evidence/profile/export/live behavior, correction receipt/recalculation/retry binding, signed source revocation, negative visibility probes, config metric disables, fixture isolation and host start/stop.

Run `node --test apps/pipeline/test/*.test.mjs` after building all integrated components. During isolated review only, `PIPELINE_COMPONENT_ROOTS` may explicitly map component names to already-built sibling checkouts; production defaults use this checkout exclusively. The test checkout root and default loader paths are the same repository boundary.

These integration checks establish actual connected execution, not an installed App, approved source families, production capability/retention evidence, finalized policies/sample thresholds, a public deployment, operational drills, real touch/screen-reader usability or owner acceptance. Those issue-specific external gates remain open until their actual evidence is supplied. The app adds no closing keywords or fabricated approvals for them.


## Historical publication identity conflicts

A repeated materialization of the current content is unchanged. A historical
snapshot ID continues to own its original document and revision, even if current
privacy or configuration controls change its effective public view. Returning to
that historical content at the same explicit cutoff must not attach a newer head
revision to the old stored document. If the snapshot insert finds such an existing
ID, publication fails with `pipeline_snapshot_identity_conflict` and the transaction
leaves the current head and receipts unchanged. Re-materialize at a fresh cutoff
to create a new publication; never update the historical document in place.

The supported SQL provider checks the stored document digest, ID and revision
before applying live controls. A corrupted stored total is unavailable on current,
pinned and export reads. Current contributor suppression, configuration disabling,
correction and source-access overlays remain independent of that integrity check;
no private contributor payload is retained in an API hash cache. This covers the
supported pipeline producer/provider, not an arbitrary third-party provider that
violates the public-source contract. Synthetic PGlite tests exercise corruption
rejection, A-to-B-to-A publication conflict, unchanged historical records and
recovery at a fresh cutoff; they are not PostgreSQL concurrency or production proof.

## Synthetic webhook dispatch

The opt-in [durable outbox bridge](webhook-dispatch.md) connects signed issue-creation
fixtures to the existing collector, enriching normalizer and confirmed atomic
publisher. It remains disabled by default and rejects public-mode dispatch. The
linked document records migration, recovery, validation and remaining acceptance
limits for #54, #58, #62 and #84.

## Native Project curation

`project_curation_history` is a separate explicit source grant for native
issue/PR Project add/remove events. It uses full null-lower-bound observations,
a fixed upper cutoff, digest-bound output pages and fresh native rehydration even
for a completed collection or cached normalization. The existing four recent
source families and all status/field checkpoint keys remain unchanged.

The [native curation contract](NATIVE_PROJECT_CURATION.md) defines the exact
repository/subject/Project/event unit, automation and unknown-actor treatment,
bounded source/test evidence and persistent privacy/reapproval behavior.
This capability enables no collection or public policy by default and establishes
no installed grant, complete history, manual-work claim or public activation.
