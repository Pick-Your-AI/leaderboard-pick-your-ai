# GitHub source capability verification candidate

**Status:** research matrix for #41, with bounded client primitives relevant to #45. Documentation is a source for probe design, not proof of installed-app support. Every family below remains **unprobed / not enabled** until an approved canary produces a sanitized, actor-bearing payload and records the actual installation permissions and pagination behavior.

| Capability family | Relevant evidence path | Documentation-supported method | Minimum access to verify (not a grant request) | Current status | Probe evidence required before enablement | Owner role and test boundary |
| --- | --- | --- | --- | --- | --- | --- |
| Repository metadata and visibility | REST repository representation; visibility is explicit metadata | REST response and `Link` pagination | Repository metadata read | Unprobed | Sanitized public repo payload; private/inaccessible comparison; visibility transition and cache suppression receipt | Data / application engineering probe; Operations / security review |
| Issues, comments, labels, milestones and timeline actors | REST Issues, issue timeline, webhook events | REST endpoints, webhook action payloads and `Link` pagination; no historical actor assumed without event evidence | Issues read; verify each endpoint/event separately | Unprobed | One sanitized payload per exact action; actor ID, action, event time, source revision and pagination receipt | Data / application engineering probe; source/metric owner review |
| Pull requests, reviews, review comments and review actors | REST Pull Requests and reviews; webhook events | REST and webhooks; follow `Link` pages, including review collections | Pull requests read | Unprobed | Multi-page review canary with stable actor IDs and timestamps; distinguish submitted/edited/dismissed events | Data / application engineering probe; metric owner review |
| Content edit history | Commit/content endpoints and issue/body edit event families | Must verify the exact endpoint or event subtype; current text alone does not establish editor or edit time | Contents read only if selected evidence path requires it; Issues / Pull requests read for relevant webhook events | Unprobed | Before/after sanitized payload or actor-bearing event, including missed/deleted/reverted edit behavior | Data / application engineering probe; Operations / security review |
| Native issue fields and issue types | Issue events and GraphQL typed objects | Keep native issue field/type change families distinct from Project item fields | Issues read; verify GraphQL field access independently | Unprobed | Exact typed event/actor/time coverage and supported API-version behavior | Data / application engineering probe; metric owner review |
| Project item custom fields | Projects v2 item/field events and GraphQL objects | Snapshot reads may show current state but do not establish change-author evidence | Projects read, then verify the exact webhook/API subtype | Unprobed | Actor-bearing field edit with before/after values; no-op and automated updates distinguished | Data / application engineering probe; Operations / security review |
| Project item status transitions | `ProjectV2ItemStatusChangedEvent` or an exact supported equivalent | Treat as its own event family, separate from issue fields and Project snapshots | Projects read only after exact event support is identified | Unprobed | Actor/time-bearing status transition and repeated/reversal semantics | Data / application engineering probe; metric owner review |
| Project progress-update posts | Project status update objects/events | Verify separately from item status and current Project metadata | Projects read; probe exact object/event | Unprobed | Public sanitized post plus stable author, timestamp, edit/deletion semantics | Data / application engineering probe; privacy review |
| Native sub-issues and dependency changes | Issue relationships, relevant webhooks or GraphQL objects | Current relationship snapshot is not actor-backed history | Issues read; test each relationship source separately | Unprobed | Add/remove/reparent/reorder action with actor, time, parent/child identities and pagination | Data / application engineering probe; metric owner review |
| GitHub App permission and installation behavior | App configuration and installation-scoped API responses | Permission docs inform least privilege; actual endpoint behavior is authoritative | No permission change in this candidate | Unprobed; no app installed by this work | Owner-approved read-only canary records granted scopes, endpoint status, visibility, quota headers and sanitized request IDs | Accountable App owner grants/reviews; Operations / security records probe |

## Probe and promotion rules

1. Keep the initial result `unprobed`; documentation, a repository snapshot, a mock payload or a successful call from a personal token cannot promote a family.
2. Record the exact app installation, repository scope, permission set, API version, endpoint/event subtype, sanitized payload, response status and relevant pagination/quota headers. Remove tokens, private fields, emails and customer content.
3. Mark a family enabled only after its actor, source action, occurrence time, stable object identity and pagination completeness are demonstrated for the intended scope. If one element is missing, report partial/unknown coverage and keep that attribution path disabled.
4. Distinguish 401/403 authorization outcomes from 404 not-found-or-hidden outcomes. A 404 is not evidence of public absence. A GraphQL HTTP 200 with an `errors` array is not a complete result.
5. Keep Project snapshots, webhook transitions and approved human receipts as separate evidence classes. Project snapshots alone do not prove who changed a field or when.
6. Do not request organization administration or write scopes to fill a leaderboard gap. Installation, broader permission requests and real probes require the accountable owner and their separate delivery acceptance.

## Implementation covered here

Current [source adapters](GITHUB_SOURCE_ADAPTERS.md) include bounded REST and GraphQL collection, retained scan checkpoints, exact event hydration and explicit public-source checks. Their synthetic tests establish implementation behavior separately from installed-App acceptance. The external-reader observations below did not execute that production client, its checkpoint/retry paths or a webhook receiver, and enable no row in this matrix.

## Public REST observations from an existing connected reader

A bounded read on **2026-10-19, 04:46:12–04:50:21 UTC** supplies actual public-source examples for #41. The [sanitized observation manifest](evidence/github-rest-observation-2026-10-19.json) records the selected fields, source endpoints, comparison counts and explicitly checked omissions. These are real repository observations, kept outside synthetic fixtures and ranking inputs.

The reader accessed only public resources in `Pick-Your-AI/pick-your-ai-leaderboard`, repository ID `1422874501`. Its responses did not expose credential kind, application/installation identity, granted installation permissions, requested API version, HTTP response status, `Link` or quota headers. The returned connection-relative repository role object does not establish the separately installed product App's grant. **The installed-App matrix above remains unprobed / not enabled.** No App registration, permission change, webhook delivery or deployment is established by this observation.

### What the returned records establish

| Exact observed source | Retained evidence | Boundary |
| --- | --- | --- |
| [Issue-type event 33498902149](https://api.github.com/repos/Pick-Your-AI/pick-your-ai-leaderboard/issues/events/33498902149) | `issue_type_added`; actor account `5861166`; event time `2026-10-17T02:42:38Z`; issue ID `5894072060`; target type ID `906513009` | A real issue-type transition example. It does not establish native issue-field changes or any Project field family. Collection and exact hydration had identical inputs to the current timeline revision function; no production normalization or metric eligibility was exercised. |
| [Project item status event 33498905106](https://api.github.com/repos/Pick-Your-AI/pick-your-ai-leaderboard/issues/events/33498905106) | Event ID, actor and occurrence time were present | Project identity, previous/new status and automation flag were absent from the returned event. These REST fields cannot satisfy the existing typed Project-status adapter. This does not determine whether a separately authorized GraphQL read could supply them. |
| [Parent event 33498902326](https://api.github.com/repos/Pick-Your-AI/pick-your-ai-leaderboard/issues/events/33498902326) and [blocker event 33499563027](https://api.github.com/repos/Pick-Your-AI/pick-your-ai-leaderboard/issues/events/33499563027) | Actor/time-bearing actions, exact subject ID, linked issue numbers and public repository identity | Linked endpoints omitted their issue database and node IDs. No historical endpoint identity was filled from current snapshots. These REST representations are distinct from the adapter's GraphQL typed-history contract; removals and reorder history remain unprobed. |
| [Issue #41 current metadata](https://api.github.com/repos/Pick-Your-AI/pick-your-ai-leaderboard/issues/41) and native relationship endpoints | Current type, empty `issue_field_values`, no current sub-issues, and one listed blocker whose current state was closed | Current membership/state supplies no historical actor or change time. The empty field list does not establish that native issue fields are unsupported. The dependency summary's zero open blockers and one total blocker describe different quantities. |
| [PR #337 reviews](https://api.github.com/repos/Pick-Your-AI/pick-your-ai-leaderboard/pulls/337/reviews?per_page=100&page=1) | Twenty stable review IDs with submission times, commit pins and one actor account | All observed states were `COMMENTED`. They are neither twenty distinct humans nor an `APPROVED` review. GitHub `User` identifies an account, without proving its operator or manual work. Edit, dismissal and thread-resolution histories were not qualified. |

The raw issue-event collection and timeline share the same twelve stable event IDs in order. Eleven additional timeline records were cross-references without a top-level event ID; none received an invented identity. A label-application event also occurred, but the returned label target contained its name without an ID. This is not label-definition or rename history, and the current issue's label ID was not used to repair the historical event.

### What the page comparison establishes

Each collection was read using explicit `per_page=10&page=N` requests, including an empty final page, then compared with a separate `per_page=100&page=1` response. The full concatenated **parsed JSON values before sanitization** matched the comparison read exactly.

| Collection | Observed page sizes | Separate comparison count |
| --- | --- | --- |
| Issue #41 timeline | 10, 10, 3, 0 | 23 |
| Issue #41 events | 10, 2, 0 | 12 |
| PR #337 reviews | 10, 10, 0 | 20 |

This proves agreement within these bounded reads. It does not exercise HTTP `Link` traversal, histories larger than 100 records, concurrent-change recovery, checkpoint reuse, rate limits or the product collector. Later public activity can change those same endpoints.

The separate `/repos/Pick-Your-AI/pick-your-ai-leaderboard/issues/events` route was readable, with only its first two-row page inspected; no repository-wide completeness is claimed. The reader rejected `/repos/Pick-Your-AI/pick-your-ai-leaderboard/events` as outside its supported routes, returning `INVALID_ARGUMENT` before exposing any GitHub response. **That connector limit is not a GitHub authorization denial, 404 or proof that the GitHub endpoint is unsupported.**

### Remaining capability evidence

Native issue-field changes, Project item custom-field changes, Project progress-update posts, content edits, label/milestone definition changes, public moderation, relationship removals/transfers/reordering and Project configuration changes remain separately unprobed by this read. A current Project snapshot must never supply a field editor or transition timestamp. No generic GraphQL capability was exposed by this reader; its absence is a tool boundary, not a GitHub API finding.

The next product-App canary needs the actual installation/repository scope and permission grant, explicit API version and response/pagination/quota metadata, and an exact actor-bearing payload for each proposed enabled subtype. Real webhook subscription/delivery and inaccessible/private-source outcomes need their own observations. Existing project authorization permits implementation work; it does not supply those missing source facts. #41 remains open for that evidence and its literal acceptance criteria.

## Official references

- [Choose permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/choosing-permissions-for-a-github-app)
- [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [REST pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
- [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GraphQL pagination](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api)
- [GraphQL rate and query limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)
- [REST troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#404-not-found-for-an-existing-resource)

## Review trace

- #41 owns source and permission verification, including separate Issue fields, Projects v2 fields, Project status transitions and Project progress-update posts.
- #45 owns pagination and quotas; the bounded external-reader page comparison above is separate from production client, checkpoint, retry and installed-App execution.
- #39 owns the threat model and test-owner mapping; this candidate records mitigations and remaining proof explicitly.
- #108 owns safe public rendering, URL handling and optional export protections; this candidate describes requirements and test ownership but does not claim a renderer/export exists.
