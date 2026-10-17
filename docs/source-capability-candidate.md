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

`packages/github` offers bounded REST `Link` traversal and GraphQL cursor traversal, rate-limit classification and explicit unknown visibility. Its fixtures are synthetic. It does not call GitHub, checkpoint a real scan, verify installed permissions, prove more than one page of live history, or enable any row in this matrix. The runtime transport, persistence/checkpointing and authorized canary remain later acceptance work under #41 and #45.

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
- #45 owns pagination and quotas; the present package is a bounded helper candidate, without live checkpoint or retry execution.
- #39 owns the threat model and test-owner mapping; this candidate records mitigations and remaining proof explicitly.
- #108 owns safe public rendering, URL handling and optional export protections; this candidate describes requirements and test ownership but does not claim a renderer/export exists.
