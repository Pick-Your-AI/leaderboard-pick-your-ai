# Local operator replay and applied-exclusion drill

Refs #93 and #101. This is one bounded local operating journey using the existing controls, pipeline, and public API. It adds no role, authentication system, production grant, or correction-acceptance endpoint.

## Source and authority

The separate fixture `tests/fixtures/operator-operating-drill.json` names synthetic numeric identities, repository/installation scope, and an independently stored specialist approval. The harness hashes the exact fixture bytes. It uses the existing synthetic GitHub reader, real loopback controls HTTP, private SQLite store, on-disk PGlite database, production pipeline, and mounted browser application. Browser route bridges send requests to those real local handlers using explicitly established synthetic sessions; they are not a deployed browser-cookie or OAuth-installation test.

The specialist approval is derived from the actual pending request and collected contribution: exact owner, locator, reason, request version, fact ID, revision/state, operator ID, and fixture hash. Repeated normalized copies must agree. The separately retained approval is bounded in time and must match the complete operation. A denied, changed, or unapproved operation fails the existing host authorization hook. This is synthetic capability evidence, not proof of a real GitHub grant or human review.

## One coherent journey

1. An anonymous page has no operator controls. Actual HTTP denies an anonymous caller, a non-operator, a foreign repository, wrong CSRF, absent confirmation, and a stale delivery revision. The mounted operator form queues the current quarantined delivery only after scoped confirmation and keyboard activation.
2. The SQL replay receipt records operator identity, reason, repository and before/queued revisions. The journey closes and reopens the real SQL and private SQLite stores with an expired worker lease. The stale worker cannot complete it; the fresh lease completes once. Actual dispatch creates its durable processing result and both configured publication references. The mounted readback must show those exact SQL references. A queued receipt alone is not publication evidence.
3. The contributor uses the actual correction form. Its request remains pending and the original pinned public board remains unchanged. The generic reviewer endpoint continues to reject acceptance; the mounted administration view states that specialist handling is required. The drill then invokes the existing **host-only** `applyCorrection` capability with the separately derived approval. It does not invent a browser Apply control.
4. An injected exception inside the real SQL transaction before commit leaves corrections, receipts, private state and the pinned board unchanged. A second interruption inside private SQLite publication occurs after the SQL exclusion and its receipt have committed: the private request is still pending, while the public overlay already withholds the affected contribution. After physical store reopen, exact retry acknowledges the original applied exclusion without duplicating its SQL receipt or private history. A changed retry fails.
5. The contributor sees the actual applied request version and receipt in the mounted account UI. The pinned historical board retains the complete unaffected contributor row. A fresh publication preserves every field except the three coverage clocks, which must equal its exact new cutoff; partial/unknown coverage remains partial/unknown. The mounted public board omits the excluded contributor and private reason/approval identifiers.

The fault hooks observe the actual transaction boundaries and throw before their commits; they do not replace SQL/SQLite persistence with fixture responses. The original transaction implementation decides rollback. Workers run explicitly through the existing lease and dispatch interfaces, with no timing-based success inference.

## Execution and evidence

After building the current workspace with its pinned repository toolchain, run the existing browser suite against `apps/web/browser/operator-operating-drill.spec.ts`. Its one test retains the ordinary 45-second case budget, zero retries, and the current browser runner. No workflow or timeout is changed by this slice.

The test attaches exact JSON checkpoints of durable state, host decisions, denial responses, faults, reopens and observed HTTP statuses, plus screenshots of the verified replay result and applied request receipt. Those region captures establish only their visible contents. They do not claim whole-page layout, screen-reader participation, a physical-device session, production deployment, or real source authorization. Final observations and owned resources are collected/closed even when a journey assertion fails.

The local execution receipt is separate from this source description; no pass is implied by adding the scenario. Existing configuration operating evidence, #320 focus work and the separately owned operator-generation/confirmation work remain unchanged. This slice supplies replay/exclusion operating evidence within its stated local scope; it does not close every requirement of #93, #101, or source-capability #53 by itself.
