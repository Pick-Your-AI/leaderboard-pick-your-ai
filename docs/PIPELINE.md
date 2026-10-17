# Integrated collection and publication runtime

`apps/pipeline` composes the actual ingestion, GitHub, metric, public API and contributor-control components. It is a host-neutral application factory with real read-only GitHub REST collection, durable SQL progress/receipts, immutable public snapshots and current privacy/source controls. It defaults to unavailable until protected configuration is explicitly approved. No installed GitHub App, operator approval, live deployment, notification destination or source capability is invented.

## Build and run

The root workspace must include `packages/ingestion` explicitly alongside contracts/GitHub/metrics and `apps/*`. After merging sibling packages, regenerate the root lock with `npm install --package-lock-only`, then run `npm ci`, `npm run build`, `npm run typecheck` and `npm test`. The app declares its ingestion/contracts/GitHub/metrics/service/controls/pg dependencies and PGlite test dependency. Its own build/typecheck scripts check the JavaScript entry points. Runtime imports use compiled `dist` boundaries; the controls package deliberately publishes native `.mjs` modules.

The production host performs these steps:

1. Provision an approved private Postgres database and apply ingestion SQL migrations `001_ingestion`, `002_snapshots` and `003_collection`, using the ingestion migration procedure. Call `migratePipeline(db)` to add only the pipeline schema.
2. Open the real `ControlStore` at an absolute private SQLite path with suitable directory ACLs. Configure its authenticated provider/roles separately. It is not a mock or public JSON file.
3. Construct `GithubReadClient` with a protected installation-token provider and a private `FileCheckpointStore` or transactional replacement. Bind `sourceId` to that authorization/quota pool; absent/invalid installation credentials must not silently inherit another pool's scope. A production token provider must fail when its configured authorization is unavailable.
4. Supply protected approved configuration and `verifyConfiguration`, which checks the actual source/metric/configuration approval receipts and policy signatures. This callback defaults to denial. It must not trust a public request or repository text to approve itself.
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
- `policies`: an actual `MetricPolicy`, its exact `metrics.stableJSON(policy)` signature, an independent `approvalReceipt`, and optional public `policyLink`.
- `scopes`: exact public API scopes `{organization,repository,workstream,start,end}`. Repository IDs are numeric strings or null. Date bounds are both explicit UTC instants or both null. Null bounds mean the API's all-time lens; a last-30-day view must use explicit reviewed dates. Unknown/unmaterialized scopes are unavailable rather than reconstructed by summing overlapping aggregates.

A policy's definition version must match the retained metric registry, and its aggregation/unit/evidence class must pass the actual engine's validation. The snapshot's methodology sidecar discloses each metric policy version and SHA-256 signature; the computation identifier binds all approved signatures. Per-path file counts and per-head review rounds require canonical-unit grouping, and decided ratios require one artifact denominator. Conflicting lifecycle decisions are unavailable until a trusted selected-as-of cohort proves their state; the pipeline does not silently select an earlier decision. No public metric is enabled by merely existing in the 98-definition registry. Approved host configuration is the additional publication gate around engine candidates, which remain `publicEnabled:false` internally.

The server-side `configurationOverlay` is read from current private controls state for every run/read, including pinned snapshots. It can restrict approved repository IDs and disable metrics; it cannot expand the protected static scope. Disabled metrics retain a public machine-readable explanation and policy reference and cannot render as zero. Free-form reviewed control explanations remain in the controls publication; the pipeline maps them to `metric_disabled_by_approved_configuration` for the API's bounded machine-code contract. Repository removal invalidates affected projections entirely rather than subtracting overlapping totals.

## Actual data path

The default `createGithubCollectionSource` performs read-only requests through `GithubReadClient.rest` and resumable `scanRest`. It supports repository issues, pull requests, commits, issue comments and releases. It verifies current public repository identity and uses stable API object IDs, revision timestamps/SHAs and public source URLs. Repository issue lists exclude embedded PR objects. Scan cursors and expected counts are fixed to one bounded operation; completed scans remain durable. Each collection run persists accepted facts/pages and progress through the actual `CollectionStore`.

Reviews, nested discussion/history, Project transitions and other advanced families require their separately reviewed read-only adapter; the default refuses them instead of manufacturing history. A host can provide the same `ReadOnlySource` interface for a supported reviewed adapter. `sourceFamilies` is a catalog, not proof that the default source adapter implements every family.

`createGithubEvidenceNormalizer` hydrates authoritative source details and verifies subject/revision/public repository identity. Lossy current snapshots cannot become a guessed actor, field editor, first readiness, transition or accepted outcome. Real author/actor numeric database IDs and source node IDs are retained separately. `ControlStore` authenticated actor IDs are numeric GitHub database IDs; the pipeline requires the normalizer's explicit authoritative numeric mapping before constructing public actor contracts. A webhook node ID is never guessed to equal a controls database ID. User accounts remain account classes, not a claim of manual execution.

Canonical facts are deduplicated by stable fact ID only when semantic fields agree; the earliest observation timestamp survives. Conflicts fail publication. All raw source observations and normalization receipts remain durably separate. Public evidence IDs and actor/artifact/metric references must agree with the actual metric facts and configured repository URL. Qualified/reviewed values still require the engine's independent receipt rules.

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
