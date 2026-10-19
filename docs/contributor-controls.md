# Contributor controls candidate

The Node 24 package `apps/controls` implements a protected HTTP namespace, private durable receipts and an actual local public projection for [authentication #53](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/53), [evidence submission #55](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/55), [independent review #60](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/60), [correction/privacy requests #94](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/94), [self profile controls #119](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/119) and [moderation #122](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/122). It has no third-party runtime dependencies. It performs no issue, Project or ingestion mutations.

This is a candidate backend with synthetic HTTP acceptance tests. It has not been connected to an approved identity App, public API, complete product UI, external caches, production storage or staffed privacy operation. Those gates remain open. It does not activate a metric or make a policy decision.

## Integration

Import `ControlStore` from `apps/controls/src/store.mjs`, `createControlsServer` from `src/server.mjs` and `githubOAuthProvider` from `src/github.mjs`. Create the store with an absolute file path in a private service data directory outside every served/static/export directory. Files are created with restrictive POSIX modes; Windows deployment must establish an equivalent service-account ACL on the parent directory before startup. Never commit the SQLite database, its journal, backups or private request receipts. Back up only under the approved privacy/retention policy. Retention and backup deletion intervals are owner decisions, not defaults advertised by this package.

Construct the provider with a **separate browser OAuth** `clientId` and `clientSecret` supplied from the service secret store. It has no ingestion credential argument. Construct the server with `{ store, provider, origin, rolesForActor, approvedPolicyVersions }`. The policy allow-list defaults to empty: even an eligible reviewer cannot qualify evidence using an unapproved policy version. Supply only policy versions accepted by the accountable policy owner; this package provides no browser policy-activation endpoint. `origin` must be the exact approved HTTPS origin with no trailing slash. The registered callback is exactly `${origin}/controls/auth/callback`. The server returns a Node HTTP server; bind it behind the approved TLS reverse proxy and expose `/controls/*` only at that origin. Never expose the private database directory. Enforce deployment concurrency/rate/resource limits and trusted proxy configuration with the broader operations package.

`rolesForActor(stableGitHubId)` returns `{ roles: [], version: 'roster-revision' }`, with optional `reviewer`, `privacy` or `operator` roles from an accepted server-side roster. No browser parameter can grant roles. Re-resolve roles at login, on every request and after reading mutation bodies. Changing the roster version or role set invalidates existing sessions on their next request. Self revocation and logout delete stored sessions. No account ownership is inferred from login names, email, profile text or submitted actor IDs. There is no arbitrary account-link/merge endpoint.

GitHub authorization requests an empty OAuth scope, single-use state bound to a separate HttpOnly browser cookie, and S256 PKCE. The provider exchanges only with fixed GitHub endpoints, uses a ten-second timeout, refuses redirects, bounds response bytes, reads the stable numeric account ID and revokes the transient token before returning identity. A previously authorized broader scope is rejected and revoked. No OAuth access token or email is persisted. GitHub's documented flow supports [state and S256 PKCE](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

The GitHub-specific adapter requires an explicit empty string in the token
response's `scope` field before requesting the account identity. Missing,
non-string and nonempty scope values fail with the fixed `502 Unexpected OAuth
scopes` response. GitHub's documented JSON response includes this scope string;
this adapter does not infer the approved empty scope from absent metadata or
JavaScript truthiness. A parsed access token still reaches the existing revocation
step when its scope is rejected. Failed cleanup also withholds identity, and a
rejected callback consumes only its login state while retaining an existing
session and private/public data.

Nonempty 2xx identity-provider response bodies require well-formed UTF-8 before
JSON parsing. This applies to the token exchange, account lookup and any nonempty
revocation response. Malformed bytes cannot become replacement text and allow a
session to be created. A known token is still revoked after a failed account
lookup; malformed UTF-8 in a token response supplies no trusted token to use or revoke.
Only the documented
[204 token-revocation result](https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-token)
confirms cleanup before identity returns. Other 2xx revocation responses,
including 200 and 202, fail with `502 Identity provider unavailable` under this
GitHub adapter's response contract. A
[202 response](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.3) accepts work
without confirming completion; this does not assert that every HTTP DELETE
endpoint requires 204.
Nonempty unexpected 2xx bodies still pass through the existing bounded decoder
and JSON parser before the final acknowledgment check, retaining their original
malformed-body error classification.
The existing 65,536-byte limit, HTTP error classification and leading-BOM
rejection remain in force. Failed callbacks retain the existing fixed error and
consume their one-time login state without rotating an existing session.

Sessions use random 256-bit identifiers stored only as SHA-256 hashes. Reauthentication deletes the presented old session and creates a new identifier. `__Host-controls_session` has `Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax`, no Domain attribute and a maximum lifetime of fifteen minutes. Mutation requires exact same-origin `Origin`, JSON and a per-session CSRF header. Duplicate cookies, duplicate callback parameters and unexpected fields are rejected. No CORS enablement is supplied. Public reading stays anonymous. All responses use `no-store`, JSON content type, `nosniff` and a restrictive CSP.

Protected JSON mutation bodies require well-formed UTF-8 within the existing
encoded-byte limit. Damaged bytes are rejected with the fixed `400 Invalid JSON`
response before profile, request, audit or public-projection state can change;
they are never replaced with different text and persisted. Authentication,
origin and CSRF checks still precede body parsing, and successful parsing still
rechecks the session before mutation. Valid multilingual text, combining marks,
emoji and a literal replacement character retain their original spelling even
when a client writes the bytes separately. Leading UTF-8 BOMs retain the previous
JSON-parser rejection behavior. This boundary neither changes the stored schema
nor reconstructs original bytes from older already-decoded records.

## Routes

| Route                                  | Behavior                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /controls/public`                 | Anonymous persisted public snapshot, containing only opted-in profiles and accepted eligible claims. No private request/audit fields or named suppression notices.                         |
| `GET /controls/auth/login`             | Starts a browser-bound authorization flow; rejects redirect/query overrides.                                                                                                               |
| `GET /controls/auth/callback`          | Consumes state once, verifies provider identity and rotates the session.                                                                                                                   |
| `GET /controls/session`                | Returns verified stable account ID, current roles, expiry and CSRF token to the authenticated browser.                                                                                     |
| `POST /controls/logout`                | Deletes current session; body `{}`.                                                                                                                                                        |
| `POST /controls/sessions/revoke`       | Deletes all sessions for the verified caller; body `{}`.                                                                                                                                   |
| `POST /controls/profile`               | Saves caller's own `{ bio, highlights, public }`. Plain bio rejects markup/control characters; highlights are bounded GitHub HTTPS locators. No actor override.                            |
| `POST /controls/profile/suppression`   | Applies caller's own `{ suppressed: boolean }` preference, returns a private durable receipt, atomically rebuilds public output.                                                           |
| `POST /controls/requests`              | Stores an authenticated private request and returns `{ id, status, version }`. Storage occurs before success is returned.                                                                  |
| `GET /controls/requests`               | Lists caller-owned requests or requests permitted by the caller's server-side reviewer role.                                                                                               |
| `GET /controls/requests/:id`           | Owner or appropriate reviewer only; unauthorized and unknown receipts both return 404.                                                                                                     |
| `GET /controls/invitations`            | Lists only the caller's proposed collaborator attributions, with public locator, category, scope, version and consent state. Private submission detail is excluded.                        |
| `POST /controls/requests/:id/consent`  | Invited account accepts or declines its own attribution using `{ version, consent }`. Pending/declined collaborators never enter the public projection.                                    |
| `POST /controls/requests/:id/review`   | Eligible independent reviewer accepts/rejects, rolls back or merges a duplicate with optimistic version, explicit conflict declaration and private reason.                                 |
| `POST /controls/requests/:id/appeal`   | Owner appeals an accepted/rejected decision with `{ version, reason }`. Removes the accepted claim until independent appeal resolution.                                                    |
| `POST /controls/requests/:id/amend`    | Owner supplies revised evidence, reason and version. Prior values stay in the private audit; recognition returns to pending and collaborator consent is requested again. Declines persist. |
| `POST /controls/requests/:id/withdraw` | Owner withdraws; public claim is removed in the same transaction.                                                                                                                          |

Evidence submission requires `{ kind: 'evidence', locator, category, collaborators: [stableId], consent: true, detail, scope }`. Categories are `governance`, `deployment_work`, `mentorship`, `reliability`, `project_configuration`, `ordering`, `public_moderation` and `other`. A category records the submitted claim, not qualification, metric enablement or an inferred score. Each receipt identifies one reviewed contribution/change set; changing ten Project children does not become ten automatic outcomes. Locators allow only bounded `https://github.com/...` artifact paths with no userinfo or custom port; the server never fetches user locators. A locator alone does not prove public visibility, actor or event time.

Review requires `{ version, decision, reason, conflict: false }`. Acceptance additionally requires `sourceReviewedPublic: true` and `policyVersion`, expressing an accountable reviewer's actual source/policy review. It cannot be performed by the submitter or a listed collaborator, including someone who declined attribution. An appeal or rollback requires a reviewer who did not make any earlier decision on that receipt. Accepted duplicate evidence with the same owner, locator, category and scope is blocked; use `decision: 'merge'` with `duplicateOf` pointing to an already accepted canonical receipt. Different scopes are not silently merged. No upstream GitHub object is modified.

Locale acceptance also requires an explicit reviewed target in the acceptance input:
`localization: { targetFactId, sourceRevision, locale, category, policyVersion }`.
The reviewer form provides these fields behind its locale-review checkbox. The
target names the actual observed contribution and immutable merge SHA, its
canonical language tag, content category and documentation classification policy.
The classification policy is distinct from the outer accepted metric policy.
Only an authenticated independent acceptance action can record this target;
submission, rejection, rollback and duplicate-merge inputs reject it. All five
fields must be bounded canonical strings, with no extra fields or inferred values.

The real acceptance audit stores that target with the reviewed request owner,
locator, category, scope, current request version and receipt ID. The pipeline
matches it against the current protected locale selector and exact public source,
requires a decision no earlier than the merge, and verifies one unchanged audit
entry. An earlier generic receipt cannot qualify locale work, and changing the
configuration cannot redirect a recorded language or source revision. The owner
must amend changed evidence and an independent reviewer must review it again.
These private audit fields are omitted from `/controls/public` and public evidence.
When a declared collaborator changes consent after locale acceptance, the receipt
returns to pending review and its stale metric policy is cleared in the same
transaction. The earlier target and decision remain in the private audit. The
reviewer can then accept the current version directly; no unrelated owner appeal
or amendment is required. Repeating the same consent leaves an accepted locale
receipt and its version unchanged. Other evidence consent behavior is preserved.

Correction, privacy and identity requests use `{ kind, detail, locator? }`. They are durable **pending** private receipts. Privacy/identity requests are accessible only to their owner or the `privacy` role; ordinary evidence reviewers cannot read them. They cannot be marked accepted/applied by the generic review API because the downstream correction/identity capability has not been integrated. This prevents a stored form from falsely claiming a correction was applied. Self-service suppression has a separate actual application path and receipt. Do not send a privacy request to a public GitHub issue. A safe staffed alternative for someone unable to authenticate still requires an accepted owner and verified private destination; none is invented here.

## Transactional publication

SQLite `BEGIN IMMEDIATE`, full synchronous writes and optimistic receipt versions serialize decisions. A submission is pending; it adds no public claim. Review, amendment, appeal, rollback, withdrawal, collaborator consent and self suppression rebuild `controls_publication` within the same transaction as private state and versioned audit changes. Restart reads the persisted snapshot. Suppression excludes authored claims, optional profile text and collaborator attribution without publishing a named person's privacy choice. Public-source GitHub history and third-party copies cannot be erased by this preference.

An optional `transactionalPublisher({ database, snapshot })` hook can update dependent tables **through that same SQLite database transaction**. It must be synchronous and must not commit, perform network effects or publish to an external cache. Any error rolls back private state, receipt, local snapshot and dependent-table changes together. The external read API, rankings, exports, profiles, caches and metric recalculation must be connected through an independently reviewed publication boundary before #94 or #122 can claim end-to-end product completion. This package's `/controls/public` is the actual local output tested here; it is not the production leaderboard API.

The proposed private state is written before the synchronous publisher runs, so
its same-transaction session revocation cannot be overwritten by an older state
copy. An optional `beforeCommit()` transaction guard runs after private/public
serialization, database writes and publisher work, immediately before `COMMIT`.
It must be synchronous; a thrown error or a returned thenable rolls back the
transaction. Configuration activation uses that boundary for its final authority
check and rejects publisher changes to its expected configuration/audit state.

## Validation and remaining acceptance

Run `node --test apps/controls/test/controls.test.mjs` or the root test command. `npm run build --workspace @pick-your-ai/controls` checks JavaScript syntax; no TypeScript typecheck is claimed. Tests exercise actual loopback HTTP requests and SQLite files with fictional identities/provider responses: callback/state/PKCE/replay, fixation/expiry/revocation, direct role/CSRF bypass attempts, ownership and private receipt boundaries, collaborator declines, independent review/appeal/rollback/duplicate handling, withdrawal, suppression, reopened storage and transactional publisher failure. Provider tests assert exact endpoints, no requested scope, rejection of broader returned scopes, bounded responses, redirect policy and token revocation. Synthetic reviews do not establish real source rights or metric approval.

`node --test apps/controls/test/request-encoding.test.mjs` exercises the protected
UTF-8 boundary with real disposable HTTP listeners and SQLite stores. Its
synthetic pre-authorized sessions test mutation handling, not a live OAuth login.
Six malformed byte families are rejected for both profiles and private requests
without changing the complete private state or public projection. The same
session then accepts valid Unicode. Controls cover separate one-byte writes,
BOM and JSON syntax rejection, authentication/CSRF ordering and the request-byte
limit. These checks do not establish the remaining accessible product journey,
deployed identity or production-storage acceptance for #119/#53.

`node --test apps/controls/test/oauth-response-encoding.test.mjs` covers malformed
provider bytes at all three response stages, valid Unicode delivered in one-byte
stream chunks, literal U+FFFD, BOM/JSON rejection, exact byte limits, unsuccessful
HTTP status handling and empty 204 revocation. Its real disposable HTTP/SQLite
callback cases use fictional injected provider responses: a failed exchange
preserves the complete prior state and public projection, consumes only the new
login nonce, rejects replay, leaves the existing session usable and permits a
fresh valid login. These are synthetic adapter and callback results, not live
GitHub authorization, real token revocation or production identity evidence.

`node --test apps/controls/test/oauth-scope.test.mjs` checks explicit empty-scope
acceptance, missing and malformed scope rejection before account lookup, and
known-token cleanup including a failed cleanup response. Its disposable HTTP and
SQLite cases verify nonce consumption, replay denial, unchanged private/public
data and the existing session, then successful fresh login with session rotation.
These injected responses establish no actual GitHub grant or deployed identity.

`node --test apps/controls/test/oauth-revocation.test.mjs` checks that only the
documented 204 acknowledgment permits identity to return. Empty or well-formed
200/202 responses and other unexpected 2xx statuses withhold identity. The real
disposable HTTP/SQLite callback cases preserve the complete serialized private
state and a populated public projection, consume only the login nonce, deny
replay and keep the old session usable. A fresh 204 exchange then rotates the
session successfully. The encoding suite retains its malformed-response cases;
its two valid revoke200 bodies now reach the fixed acknowledgment failure after
successful decoding. All provider responses are synthetic.

Remaining release evidence includes approved OAuth registration/credentials and exact callback, accepted reviewer/privacy/operator roster, real source/identity probes, production private storage ACL/retention/recovery controls, staffed private alternative verification/destination, accessible UI and real participant journeys, policy recalculation preview/activation, all-public-surface suppression propagation, actual deployed correction readback and affected-owner acceptance. Neither an account role nor a response commitment is accepted by broad repository coding authorization.

## Reviewed repository and metric configuration

The configuration namespace implements the backend flow for [configuration #101](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/101). Only a current server-authorized `operator` can read or mutate it; CSRF, exact origin, session revocation and private storage rules also apply. Pass `knownMetricIds` from the canonical registry and the privileged `sourceVerifier` implementation into `createControlsServer`. Both the metric catalog and approved policy list default to empty. Without a source verifier, new source/permission/policy activation is denied.

| Route                                                 | Behavior                                                                                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /controls/configuration`                         | Private active version, proposals and versioned audit.                                                                                                                                                        |
| `POST /controls/configuration/proposals`              | `{ baseRevision, version, document }` creates an immutable proposal with canonical SHA-256 digest, owner and receipt version.                                                                                 |
| `GET /controls/configuration/proposals/:id`           | Private proposal, actual source-test receipt, changed coverage preview and audit.                                                                                                                             |
| `POST /controls/configuration/proposals/:id/preview`  | `{ version }` runs server-controlled source verification and records before/after repository, Project-field and enabled-metric coverage, bound to digest and base revision.                                   |
| `POST /controls/configuration/proposals/:id/approve`  | `{ version, previewDigest, conflict: false }` requires a different operator from the proposer. Server creates the approval receipt; browser-supplied approval identity is rejected.                           |
| `POST /controls/configuration/proposals/:id/activate` | `{ version, approvalId }` rechecks source permissions/schema tests, preview lifetime, current base revision and approving operator authority, then atomically publishes the version.                          |
| `POST /controls/configuration/rollback`               | `{ baseRevision, version, targetDigest }` proposes an earlier activated document as a new version. It must complete preview, independent approval and activation; rollback cannot bypass current permissions. |

### Current authority at activation and response

Activation additionally requires
`configurationAuthorityCurrent({ actorId, roleVersion, approverId, approverRoleVersion })`
in `createControlsServer`. Pipeline hosts pass the same option through
`controlsAuthentication`. The binding is frozen and names both the activating
operator and the operator who approved the exact proposal. The callback must
synchronously return exactly `true` only while both actor/role-version bindings
still have authoritative operator access. The existing independent-proposer
approval rule is unchanged; an approver may also perform activation.

This is a read-only check over the actual host-owned authority in the same
synchronous turn. Authoritative roster changes must be serialized with it and
the SQLite commit. An eventually consistent mirror or an asynchronous remote
roster lookup cannot supply this guarantee. The callback must not perform
publication, mutate the roster, start a nested transaction or acquire unrelated
locks. It grants no role and does not infer approval from an earlier successful
request. Missing, false, truthy non-boolean, throwing and thenable results deny
activation with a fixed error; unexpected rejected promises are drained without
being awaited or accepted. Other controls routes remain available under their
existing permissions. Restrictive disables and rollback activation require the
same current authority.

After the existing asynchronous source, approver and session refreshes, the
combined check runs inside the activation transaction before mutation and again
after synchronous publication work. The final check then reads the actual
stored session, verifies its actor, role version/set, CSRF binding and expiry,
and checks both source and preview deadlines. A revocation, changed approval,
expired receipt or publication failure rolls back the activation, audit, local
public projection and dependent SQLite writes together.

The activation response repeats the synchronous authority/session/deadline check
after JSON serialization and before HTTP headers are written. If authority
changes after a valid commit, the private response is withheld; that does not
undo the committed activation. An authorized operator can read the original
proposal receipt to distinguish this outcome from a rejected transaction.
Repeating the stale activation request cannot create another activation.

Configuration `document` contains three bounded arrays:

- `repositories`: `{ id, installationId, slug, capabilities }`. IDs are stable numeric GitHub IDs represented as strings, not mutable names. Capability IDs identify the exact source family being tested.
- `projects`: `{ id, fields: [{ key, id, type }] }`. GraphQL Project IDs and field IDs are stable identities. Field types must match the observed source schema.
- `metrics`: `{ id, enabled, policyVersion, policyLink, reason? }`. The document must explicitly include every ID in the server's canonical `knownMetricIds` exactly once; omission cannot silently re-enable a disabled baseline metric. A disabled metric requires a reviewed **public** reason, at most 500 characters, and its historical GitHub HTTPS policy link. Reasons must not contain private request content. Individual disables leave other metrics enabled. Rollback to an older, incomplete catalog is rejected; propose an explicitly migrated complete configuration instead.

`sourceVerifier({ document, digest, baseRevision, phase })` is trusted service code performing authorized **read-only** probes, not browser-provided evidence. It returns `{ digest, baseRevision, receiptId, verifiedAt, validUntil, repositories, projects, metrics }`. Dates are integer epoch milliseconds; evidence is fresh for no more than ten minutes. The package validates the exact digest/revision and stores only the normalized receipt metadata below:

- Each repository report must match the configured ID, installation and slug and assert `approved: true`, `public: true`. Every requested capability needs `{ id, tested: true, permissionVerified: true, permission, schemaVersion, evidenceId }`.
- Each Project report must match the configured Project ID and assert `approved: true`, `public: true`, `permissionVerified: true`, with `fields: [{ id, type }]` covering every mapping and an `evidenceId`.
- Each metric report must match the metric ID, `policyVersion` and `policyLink`, assert `policyApproved: true` and supply `evidenceId`. Enabled metrics additionally need `sourceTested: true` and a version in the server-owned `approvedPolicyVersions` list.

An accepted source verifier must establish these facts from actual installation permission, capability canary and schema receipts for the intended scope. A synthetic test provider demonstrates enforcement only; it grants no production access. Tests cannot promote an unprobed family. No configuration endpoint modifies a GitHub App permission, issue, Project field or other upstream object.

A restrictive overlay that leaves repositories, Project fields and metric policy versions/links unchanged and only disables existing metrics can inherit the preceding tested activation receipt. It still requires a digest-bound preview and independent approval. This lets operators suspend a faulty metric during a source outage without increasing permission or source scope. Re-enabling it, changing a policy/link, adding a repository or changing a field mapping requires fresh verifier evidence. Activation compares current tested permission/schema/policy meaning with the approved preview; changed semantics require a new preview and approval. A failed preview, stale base, expired source receipt, self-approval, revoked approver or publication failure changes no active configuration.

Import `configurationOverlay(state)` from `src/configuration.mjs` (or the dependency-free `src/overlay.mjs`) for runtime integration. It returns `{ revision, version, digest, approvalReceipt, allowedRepositoryIds, disabledMetricIds, disabledMetrics }`; before any activation, IDs/receipts are null and disable lists are empty. The overlay can restrict the pipeline's separately approved baseline; it does not grant collection of a new source. A protected loader must separately validate a newly activated document/digest before expanding its baseline. Current and pinned public reads, exports, live refresh and collection must apply the latest repository restrictions and metric disables. A disabled metric keeps an explanation and historical policy link rather than becoming a measured zero. The local controls public snapshot publishes its current version and reviewed disabled-metric explanations in the same SQLite transaction as activation/audit; integration must preserve that boundary for its own projections.

The HTTP suite also tests absent verifier/role denial, source-tested digest/revision binding, independent approval, private or unapproved sources, incorrect Project fields, untested permissions, unknown metrics/policies, forged receipt binding, fresh activation, restart durability, independent disable during source outage, revoked approval, expired preview, stale configuration, reviewed rollback and publication rollback. Operational acceptance still needs approved operators and actual source probes; no configuration UI, accepted operating commitment or production expansion is claimed by these synthetic tests.

## Frozen policy preview

The pipeline-wired reviewer-only [private policy comparison](private-policy-comparison.md) runs existing metrics against the exact retained input and persists snapshot-bound audit and hashes. It is separate from configuration coverage previews and provides no activation or approval action.
