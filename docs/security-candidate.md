# Security candidate: source and content trust boundaries

**Scope:** source-backed threat model for #39 and renderer review under #108.
The repository now contains a webhook receiver, credential-scoped GitHub client,
durable ingestion/publication, anonymous query and export handlers, protected
contributor/operator controls, and browser renderers. The earlier statements that
these modules did not exist described the initial planning baseline.

This revision maps implementation at main
[`0b01891`](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/tree/0b01891d07ddce3776f30e2dd26e77978787626a).
Linked tests identify executable mitigation evidence; their presence alone does
not establish a passing run. Review the exact change and its reported checks.
Local synthetic tests do not establish deployed controls, real source permissions,
accepted incident operators or production security acceptance.
No app installation or permission grant is authorized by this document.

## Assets and implemented boundaries

Protected assets include source authorization and credentials; stable evidence,
actor and publication identities; private claims and correction receipts; consent
and suppression decisions; and service availability. An attacker may control
source text, an account, a URL, a delivery/header, an evidence submission, a
browser query or an expired session. A valid signature or login grants only its
specific capability. It does not establish public visibility, independent review,
complete history or authority to change policy.

| Flow | Implemented stage and boundary |
| --- | --- |
| Internet delivery to retained observation | The [HTTP host](../packages/ingestion/src/runtime.ts) bounds routing, bodies and concurrency; the [webhook handler](../packages/ingestion/src/webhook.ts) authenticates raw bytes and minimizes approved event shapes; the [store](../packages/ingestion/src/store.ts) commits the receipt. Receipt and publication remain separate stages. |
| Authorized read to normalized evidence | The [GitHub client](../packages/github/src/client.ts) owns token use, allowed API origin and bounded scans. The [source adapter](../apps/pipeline/src/github-source.mjs), [normalizers](../packages/github/src/normalizers.ts) and [pipeline](../apps/pipeline/src/runtime.mjs) bind approved repository, source revision and actor evidence. |
| Retained publication to anonymous response | The [public projection](../apps/service/src/public-source.ts) reconstructs allowlisted output under current controls. The [API](../apps/service/src/app.ts) binds exact query, cursor, snapshot and actor scope before rendering or conditional response. |
| Browser identity to protected mutation | The separate [OAuth provider](../apps/controls/src/github.mjs) establishes stable account identity. The [controls server](../apps/controls/src/server.mjs) applies session, role, origin, CSRF and ownership checks. The [store](../apps/controls/src/store.mjs) commits the private receipt and applicable public change together. |
| Public data to browser/card/download | [Browser validation](../apps/web/src/remote/client.ts), [React views](../apps/web/src/remote/App.tsx), [cards](../apps/service/src/cards.ts) and [exports](../apps/service/src/exports.ts) validate or encode data for their output context. They receive no ingestion credential. |

## Threat model and mitigation ownership

The **test and owner role** column identifies responsibility for mitigation
review. It does not assign a GitHub user, configure production roles, promise
response times or certify an operational drill. Native Assignees and actual
configured decision authorities remain authoritative.

| Boundary and threat | Mitigation and implementation package | Test and owner role | Remaining decision or acceptance evidence |
| --- | --- | --- | --- |
| **T01 — Forged delivery, replay or misleading event header.** Fabricated bytes or a relabeled signed child deletion could create false activity or suppress an entire installation. | [Intake](../packages/ingestion/src/webhook.ts) checks HMAC-SHA256 over bounded raw bytes before JSON parsing, binds configured installation/repository IDs and explicit public visibility, and validates signed lifecycle shapes separately from the event header. The [store](../packages/ingestion/src/store.ts) distinguishes identical redelivery from conflicting bytes. Trace: #39, #49, #73. | [Webhook tests](../packages/ingestion/test/webhook.test.mjs): published HMAC vector, altered bytes, key rotation, unsupported/private/out-of-scope inputs and lifecycle header spoofing. [HTTP tests](../packages/ingestion/test/runtime.test.mjs): actual sockets, duplicate security headers, slow/oversized bodies and capacity. Data / application engineering owns regressions; Operations / security owns signature/deployment review. | #41/#44 require authorized real event/installation receipts. #42 requires actual secret custody, rotation and proxy preservation of signed bytes. Synthetic key rotation is not an operational drill. |
| **T02 — Credential exfiltration, SSRF or upstream mutation.** Hostile URLs, redirects, pagination links or GraphQL documents could cross source authority. | [GithubReadClient](../packages/github/src/client.ts) accepts only its configured HTTPS API origin, rejects URL credentials/fragments and redirects, validates pagination/checkpoint identity, and accepts read-only GraphQL operations. It rechecks authorization after token/checkpoint/backoff awaits. REST collection uses GET; GraphQL queries use POST. No collector method mutates issues or Projects. Trace: #45, #41. | [Client tests](../packages/github/test/client.test.mjs): cross-origin/credential URLs, redirects, mutation documents, corrupted checkpoints and authorization loss between awaits. [Primitive tests](../packages/github/test/primitives.test.mjs): bounded pagination. Data / application engineering owns transport tests; Operations / security reviews configured authority. | API origin is trusted deployment configuration, not a public evidence URL. Approved Enterprise origins, DNS/network egress, credential scope and real canaries still require review. This is not a claim of a network firewall. |
| **T03 — Quota exhaustion, incomplete collection or stale-worker replay.** Outage, poison events or duplicate processing could consume resources and create false counts. | The [client](../packages/github/src/client.ts) bounds requests/bytes/pages/retries, persists source-scoped pauses and rejects error-bearing GraphQL results. [Ingestion](../packages/ingestion/src/store.ts) uses current lease tokens, bounded attempts and quarantine; [outbox dispatch](../packages/ingestion/src/outbox.ts) separates acknowledgment from publication. Replay is scoped and recorded. Trace: #45, #73, #85, #102. | [Client](../packages/github/test/client.test.mjs), [store](../packages/ingestion/test/store.test.mjs), [operator](../packages/ingestion/test/operator.test.mjs) and [replay CLI](../packages/ingestion/test/replay-cli.test.mjs) tests cover persisted pauses, stale leases, rollback, bounded replay and argument rejection before connection. Data / application engineering owns recovery tests; Operations owns replay authority and limits. | Real quotas, observable collector disconnect/recovery, publication-delay monitoring, capacity and deployed recovery remain open. Unknown webhook lag must not become measured zero or proof of connectivity. |
| **T04 — Private or revoked source escapes through historic snapshots.** Access success, 404, cached output or an old cursor could disclose withdrawn evidence. | [Source lifecycle](../apps/pipeline/src/github-source.mjs) and [public projection](../apps/service/src/public-source.ts) require current eligibility, remove suppressed actors/artifacts and dependent aggregates, reject revoked snapshots, and bind exact scope. Conditional responses and downloads obtain current projection before returning public bytes. Trace: #49, #50, #74, #94, #108. | [Project privacy](../apps/pipeline/test/project-privacy.test.mjs), [confirmed availability](../apps/pipeline/test/confirmed-availability.test.mjs), [API](../apps/service/test/read-api.test.mjs), [exports](../apps/service/test/exports.test.mjs) and [browser](../apps/web/browser/remote.spec.ts) tests cover current/pinned suppression and source failures. Data / application engineering owns projection; Operations / security owns source-policy review. | #50 requires approved inventory and real visibility transitions. Display suppression does not prove erasure of private audit, backups or a reader's saved download. Retention/deletion remain #95/#103 work. |
| **T05 — Impersonation, identity collision or unsupported assistance inference.** Mutable names, emails, service accounts or self-authored claims could become another person's credit. | [Normalizers](../packages/github/src/normalizers.ts) and [contracts](../packages/contracts/src/index.ts) separate stable source IDs, display login, actor kind and execution. [Checkpoint minimization](../packages/github/src/client.ts) removes structured author/committer emails. [Private attribution](../apps/pipeline/src/private-attribution.mjs) retains assistance inputs outside public output; [projection](../apps/service/src/public-source.ts) allowlists public metadata. Trace: #36, #40, #66. | [Service accounts](../packages/github/test/service-accounts.test.mjs), [email minimization](../packages/github/test/checkpoint-minimization.test.mjs), [private attribution](../apps/pipeline/test/private-attribution.test.mjs), [restart persistence](../apps/pipeline/test/assistance-persistence.test.mjs) and [API](../apps/service/test/read-api.test.mjs) tests. Data / application engineering owns mapping; the configured privacy role and Operations / security review disputes. | Complete linking/splitting, renamed/deleted/unlinked identities and real corrections retain #36/#94 gates. Structured-email removal does not sanitize free-form text. User-account type and unknown execution do not establish human effort. |
| **T06 — XSS, unsafe links, SVG or CSV formula injection.** Source content could execute in HTML, an image or a spreadsheet. | [Public URLs](../apps/service/src/public-source.ts) use the approved GitHub HTTPS locator form; arbitrary evidence is not fetched. React renders data as text. [HTML/SVG cards](../apps/service/src/cards.ts) encode text; generated SVG has no scripts or external assets. [Exports](../apps/service/src/exports.ts) quote cells, escape quotes, neutralize formula prefixes and bound bytes/cells. The [API](../apps/service/src/app.ts) supplies download/HTML/SVG CSP and framing headers. Trace: #108, #123. | [Export tests](../apps/service/test/exports.test.mjs): formula/separator/multiline/HTML attacks, unsafe URLs, suppression and size limits. [Card/API tests](../apps/service/test/read-api.test.mjs): escaped text/passive SVG. [Browser tests](../apps/web/browser/remote.spec.ts): actual public handlers and proof navigation. UI / application engineering owns renderers; Operations / security owns output/egress policy. | Public source Markdown/HTML and arbitrary avatars/images are not enabled. Adding them requires a sanitizer/image policy and malicious fixtures. SPA-host CSP, deployed headers, supported spreadsheet-client behavior and anonymous readback remain separate #108/#113 evidence. |
| **T07 — Session theft, login CSRF or privilege escalation.** A contributor could become an operator/reviewer, read another person's receipt or continue after revocation. | [Controls](../apps/controls/src/server.mjs) use browser-bound one-use state/PKCE, host-only secure HTTP-only cookies, bounded lifetime, current role/version checks, exact origin/CSRF/JSON validation and record ownership. [OAuth](../apps/controls/src/github.mjs) uses fixed endpoints with redirect/size limits; its identity token exists within one exchange and is revoked afterwards. Trace: #53, #93, #94. | [Controls tests](../apps/controls/test/controls.test.mjs): callback shape, session rotation/expiry/revocation, duplicate cookies, cross-origin writes, private receipt roles and logout during streamed mutation. [Browser tests](../apps/web/browser/controls.spec.ts): anonymous/expired states and service receipts. Data / application engineering owns authorization; Operations / security owns provider/role configuration. | Actual OAuth registration, HTTPS hosting, accepted role owners and incident operation require acceptance. OAuth's narrow token-revocation DELETE is separate from collection and grants no issue/Project mutation capability. |
| **T08 — False evidence, self-review, duplicate recognition or coercive attribution.** A claim could use private locators, self-approval or withdrawn collaborator consent. | [Submission/review](../apps/controls/src/server.mjs) restricts locators and visibility, requires approved policy and independent review, restricts public collaborator attribution to accepted consent, records versions/history, and removes recognition after withdrawal/suppression. [Editorial selection](../apps/controls/src/editorial.mjs) requires opt-in and current accepted evidence. Source narratives grant no authority. Trace: #55, #60, #69, #94. | [Controls](../apps/controls/test/controls.test.mjs) and [editorial](../apps/controls/test/editorial.test.mjs) tests: unsafe URLs without fetching, self/collaborator review, alternate appeal reviewer, duplicate acceptance, stale versions, renewed consent and atomic withdrawal. Data / application engineering owns transitions; configured independent reviewer/privacy roles own decisions. | Public forms are not a private identity/security channel. Moderation staffing, dispute/consent examples and policy-owner acceptance remain #26/#55/#60/#113 work. An account name or passing test does not establish reviewer independence. |
| **T09 — Stale or forged policy/configuration/replay authority.** An expired preview or receipt could enable unapproved data or publish an old calculation. | [Configuration](../apps/controls/src/configuration.mjs), [comparison](../apps/controls/src/policy-comparison.mjs), [preview authority](../apps/controls/src/policy-preview-authority.mjs) and [operations](../apps/controls/src/operations.mjs) bind exact scope, current authority, versions/digests, source tests and independent approval. Defaults deny activation; previews grant no publication authority. Trace: #101, #115, #122. | [Configuration/operations](../apps/controls/test/controls.test.mjs), [comparison](../apps/controls/test/policy-comparison.test.mjs) and [authority](../apps/controls/test/policy-preview-authority.test.mjs) tests: revocation between awaits, serialization expiry, source drift, bounded capacity and rollback. Data / application engineering owns transactions; Operations / security and designated policy roles own activation. | Approved real source/metric receipts and configured decision owners remain necessary. Source text, synthetic accepted receipts and this threat model cannot activate policy or expand source scope. |
| **T10 — Public query/resource abuse or false freshness.** Expensive inputs, oversized output or stale notices could exhaust capacity or display old data as live. | The [API](../apps/service/src/app.ts) validates bounded queries before source I/O, retains slots until noncooperative work settles, binds cursors to scope/controls and requests full refetch after expired notices. [Live transport](../apps/service/src/live-client.ts) bounds response/event bytes, rejects health-response redirects, pauses when hidden and treats failed health as unknown. Trace: #92, #99, #106, #127, #129. | [API](../apps/service/test/read-api.test.mjs), [response bounds](../apps/service/test/live-response-bounds.test.mjs), [health races](../apps/service/test/live-health-race.test.mjs) and [export limits](../apps/service/test/exports.test.mjs) cover malformed/oversized input, overload, stale callbacks and conditional failures. Data / application engineering owns budgets; UI / application engineering owns truthful freshness. | Current source freshness differs from a selected historic snapshot and connection state. End-user integration, extended soak/load behavior and deployed limits require their exact reviewed runs; helper tests alone are insufficient. |

## Source text and unsafe submissions

Repository titles, bodies, descriptions, filenames, narratives, review comments
and URLs remain **untrusted data**. They are not executable instructions for a
shell, SQL statement, browser script, operator action or assistant reviewing this
project. A source document asking for a token, authorizing a new source, naming a
reviewer or claiming a test passed supplies no such authority. Contracts and
configured controls decide eligibility.

The current public projection has no arbitrary source body/Markdown renderer.
Keep that restriction when adding detail. Any future approved Markdown subset
needs output-context sanitization, explicit link/image policy and actual renderer
attack tests. A parser accepting Markdown is not a security boundary. A validated
public locator is not a generic server-side fetch permission.

Private identity evidence, tokens, emails, raw private payloads and exploit
details must not enter public corrections, forms, exports or test receipts.
Use the verified private route described in [SECURITY.md](../SECURITY.md).
Internal source text and protected audit still require access/retention decisions
after structured-email removal. Track storage and backup deletion separately from
display withdrawal; do not promise erasure of copies already downloaded.

## Review record and remaining release decisions

This engineering map identifies concrete mitigation/test owners by role. It
changes no native owner, configured role, source grant or production setting.
The exact PR review is the receiving record for this revision. #39 acceptance
must assess the complete map and usable #32/#26 contracts/rights decisions; #108
additionally requires actual renderer and enabled-export evidence. Neither gate
is inferred merely from this file.

| Release decision | Accountable review role | Required evidence |
| --- | --- | --- |
| Source authorization and credentials (#41/#42/#44/#50) | App owner and Operations / security | Approved installation/repository/event scope, secret lifecycle, real permission canaries and visibility/revocation behavior. |
| Hosting and egress (#48/#108/#113) | Operations / security and UI / application engineering | Deployed HTTPS/headers/CSP/origins, approved outbound authority/image policy, anonymous malicious-content readback and correction behavior. |
| Roles, privacy and retention (#26/#53/#60/#94/#95) | Configured privacy/reviewer authority and Operations / security | Accepted decision owners, protected receiving route, real consent/dispute receipts and audit/backup retention/deletion decisions. |
| Recovery and sustained operation (#73/#102/#103/#127/#129/#130) | Operations and Data / application engineering | Controlled recovery without duplicate credit, current progress, relevant resource/soak measurements and durable operational receipts. |

These are remaining acceptance conditions, not evidence that a deployment or
human operator exists. An unavailable source or authority retains its
unknown/unavailable meaning and current privacy restrictions; it cannot become
zero activity or a reused stale authorization.

## Primary source basis

Primary GitHub documentation was checked on 2026-10-18 for the following limited
protocol claims. Repository code and exact runs establish implementation behavior;
documentation does not prove a particular installation.

- [Webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
  describes raw-payload HMAC-SHA256 verification with a server-held secret and
  constant-time comparison. Payload authentication does not approve a repository
  or independently authenticate every HTTP header.
- [REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
  describe conditional requests and quota backoff. This implementation deliberately
  rejects redirects at its credential boundary; general redirect guidance does
  not authorize forwarding a token to a different authority.
- [REST troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#404-not-found-for-an-existing-resource)
  explains that inaccessible private resources can return 404. Absence, public
  visibility and permission failure remain separate facts.
- [GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)
  describe resource limits and partial error responses. The collector rejects
  error-bearing results instead of certifying incomplete data as complete.
