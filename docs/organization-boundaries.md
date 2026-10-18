# Organization boundaries and ownership

This dated inventory records the existing delivery boundaries for [LB-01.03](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/23). The public organization has six repositories and six open Projects. Its complete paginated repository collections reconcile to **463 issues and 615 pull requests**, including **430 open issues and 45 open pull requests**, during the observation window **2026-10-18 09:22:45–09:23:20 UTC**. These counts describe that window; implementation and review continue afterward.

The [structured inventory](../planning/organization-inventory-2026-10-18.json) records repository database and node IDs, Project database and node IDs, all **116 configured field definitions**, page receipts, issue ownership and the exact heads of every PR open in that window. The [original planning audit](SOURCE_AUDIT.md) remains an unchanged historical record from 2026-10-17.

## Repository responsibilities

Each source below is pinned to the revision actually reviewed. Those pins establish the basis of the boundary map; they are not a claim that all repositories stopped changing at the same revision or time.

| Repository | Responsibility and existing work | Reviewed boundary source |
| --- | --- | --- |
| [Research](https://github.com/Pick-Your-AI/pick-your-ai-research) | Canonical tier research, market research, catalog and pricing evidence, compatibility policy, saved/shared build contracts and consumer handoffs. Research decisions and the frozen builder `contracts/v1` stay here. | [README at f038763](https://github.com/Pick-Your-AI/pick-your-ai-research/blob/f0387630f00a95d3a78dfedba54abc96c8b833d0/README.md) |
| [Website](https://github.com/Pick-Your-AI/pickyour.ai) | Builder presentation, interaction and provider interfaces. Its documented production target is a static Vite/React SPA on cPanel Apache/PHP/SSH hosting without a Node.js runtime. This host constraint must be respected when proposing a separate service. | [Architecture at dc66a9e](https://github.com/Pick-Your-AI/pickyour.ai/blob/dc66a9e269917ab7241c7d08fd0e7f2a2f039872/docs/ARCHITECTURE.md) |
| [Android](https://github.com/Pick-Your-AI/pick-your-ai-android) | Kotlin/JVM domain code and an unsigned native diagnostic application, including local storage, transfer and catalog consumers. Architecture and shared-service integration have their own delivery decisions. | [README at f01685d](https://github.com/Pick-Your-AI/pick-your-ai-android/blob/f01685d943b0cefd8537ed05f812033d0b02be48/README.md) |
| [Apple](https://github.com/Pick-Your-AI/pick-your-ai-apple) | Swift domain code and an unsigned SwiftUI iPhone/iPad application, including local SQLite storage, transfer and catalog consumers. The native application boundary follows the recorded Swift/SwiftUI architecture decision. | [README at a12ab32](https://github.com/Pick-Your-AI/pick-your-ai-apple/blob/a12ab324e499907bd15abf4b80709d0f02667ae1/README.md) |
| [Leaderboard](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard) | Contributor-recognition policy and separate versioned contracts, public and protected APIs, browser UI, worker/pipeline/controls applications, source collection and projection packages. The repository contains tested local implementation; production source admission and public-service acceptance remain tracked work. | [Runtime foundation at 90deab1](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/blob/90deab1aba84f479d1c1de04789f58db3e2b155d/docs/runtime-foundation.md) |
| [Community `.github`](https://github.com/Pick-Your-AI/.github) | Organization profile, community navigation and shared guidance. Platform implementation status is established by each platform's current README, decision records and acceptance evidence. Older profile planning descriptions must not override those sources. | [Profile at 533a94b](https://github.com/Pick-Your-AI/.github/blob/533a94b85c5167a0cb8755a38e2ecdd6a5138764/profile/README.md) |

The research tree at its reviewed pin contains research, catalog, contracts, evidence and validation tooling; it has no leaderboard `apps`, `packages` or root `package.json`. The leaderboard service remains in its dedicated repository. Android and Apple consume shared research policy through their native adapters. Package tests, unsigned builds, simulator or emulator results, physical-device acceptance and released applications are separate evidence stages; this map does not promote one stage into another.

## Repository coverage and pagination

| Repository | Database ID | Page sizes | Issues | Open issues | PRs | Open PRs |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `.github` | 1422014674 | 6 | 1 | 0 | 5 | 0 |
| `pickyour.ai` | 1422238606 | 39 | 16 | 13 | 23 | 4 |
| `pick-your-ai-research` | 1421934086 | 100, 100, 80 | 55 | 55 | 225 | 3 |
| `pick-your-ai-leaderboard` | 1422874501 | 100, 100, 36 | 133 | 109 | 103 | 10 |
| `pick-your-ai-apple` | 1422897390 | 100, 100, 37 | 129 | 124 | 108 | 21 |
| `pick-your-ai-android` | 1422897313 | 100, 100, 80 | 129 | 129 | 151 | 7 |
| **Total** | | **1,078 records** | **463** | **430** | **615** | **45** |

Repository search returned six results on page 1 and none on page 2. Each repository's issue collection was requested with `state=all`, creation order ascending and `per_page=100`, continuing through its first short page. GitHub includes PRs in this collection: the counts above separate objects with a `pull_request` property from issues. The full collection contained no duplicate object IDs. Each repository's separate open-PR collection terminated on its first page and exactly matched the open-PR number set in its issue collection.

The manifest retains the request URLs, page sizes and first/last issue numbers, along with each open PR's URL, title, head SHA, head branch, base branch and draft state. Closed PRs are not assumed merged. Number gaps can follow transfers or deletions and do not establish missing collection pages. Refresh a PR's current head, base, review threads, applicable checks and integration overlap before changing or merging it; a dated inventory is not a merge authorization for a later revision.

All six repositories were public, unarchived, used `main` and had Discussions disabled when read. Five product repositories reported the MIT license; the community repository's license field was null. The website and community repositories are included as integration context. This inventory does not modify their implementation or settings.

## Project identities and fields

The organization Project listing showed six open Projects and zero closed Projects. Each Project's public settings page and its embedded document metadata supplied the exact opaque node ID, numeric database ID and configured field definitions.

| Project | Database ID | Node ID | Fields |
| --- | ---: | --- | ---: |
| [1 · AI Builder Research](https://github.com/orgs/Pick-Your-AI/projects/1) | 27085351 | `PVT_kwDOFHg4Xc4BnUon` | 20 |
| [2 · Market Research & Competitive Intelligence](https://github.com/orgs/Pick-Your-AI/projects/2) | 27089046 | `PVT_kwDOFHg4Xc4BnViW` | 22 |
| [3 · Website Implementation](https://github.com/orgs/Pick-Your-AI/projects/3) | 27098526 | `PVT_kwDOFHg4Xc4BnX2e` | 14 |
| [4 · Android Application Delivery](https://github.com/orgs/Pick-Your-AI/projects/4) | 27112201 | `PVT_kwDOFHg4Xc4BnbMJ` | 20 |
| [5 · Apple/iOS Application Delivery](https://github.com/orgs/Pick-Your-AI/projects/5) | 27112492 | `PVT_kwDOFHg4Xc4BnbQs` | 20 |
| [6 · Contributor Leaderboard Delivery](https://github.com/orgs/Pick-Your-AI/projects/6) | 27113479 | `PVT_kwDOFHg4Xc4BnbgH` | 20 |

The structured inventory includes every built-in and custom field, with its exact name, data type, database ID and separately named UI ID. There are 116 distinct field database IDs. These are not synthesized GraphQL field node IDs or a write-ready field-option configuration.

Preserve each Project's own single-select fields:

| Project | Existing single-select field names |
| --- | --- |
| Research | Status, Priority, Tier, Readiness, Work Type, Research Confidence, Dependency Status |
| Market | Status, Priority, Research Area, Workstream, Work Type, Evidence Confidence, Research Readiness, Opportunity Impact, Effort |
| Website | Status |
| Android and Apple | Status, Priority, Phase, Workstream, Readiness, Acceptance Gate, Level |
| Leaderboard | Status, Priority, Readiness, Level, Phase, Workstream, Acceptance Gate |

Do not replace research confidence, market opportunity or platform acceptance semantics with leaderboard status. Built-in Assignees, Parent issue and Sub-issues progress remain native relationships. A Project's rendered hierarchy or initial document page can contain only a filtered/top-level subset, so this inventory makes no Project membership or historical-activity total claim from those rows.

## Existing accountable roles

The following roles come from the actual issue Assignees in the captured collection. A README lead table, a review author or repository administration permission does not supersede those assignments.

| Work | Existing source issue | Assignees at observation |
| --- | --- | --- |
| T0 Configuration | [Research #1](https://github.com/Pick-Your-AI/pick-your-ai-research/issues/1) | tynamite, appletechie |
| T1 Model Selection | [Research #4](https://github.com/Pick-Your-AI/pick-your-ai-research/issues/4) | zwright8, Mattycodes69 |
| T2 Infrastructure | [Research #8](https://github.com/Pick-Your-AI/pick-your-ai-research/issues/8) | zwright8, Mattycodes69 |
| T3 Knowledge & Retrieval | [Research #12](https://github.com/Pick-Your-AI/pick-your-ai-research/issues/12) | Mattycodes69, zabyxc01 |
| T4 Agents & Integrations | [Research #24](https://github.com/Pick-Your-AI/pick-your-ai-research/issues/24) | CompleteDotTech, appletechie |
| T5 Training & Fine-Tuning | [Research #29](https://github.com/Pick-Your-AI/pick-your-ai-research/issues/29) | Mattycodes69, appletechie |
| T6 Deployment & Operations | [Research #34](https://github.com/Pick-Your-AI/pick-your-ai-research/issues/34) | appletechie, PUSHINGSQUARES |
| Cost estimate | [Research #39](https://github.com/Pick-Your-AI/pick-your-ai-research/issues/39) | appletechie, PUSHINGSQUARES |
| Component schema and compatibility | [Research #40](https://github.com/Pick-Your-AI/pick-your-ai-research/issues/40) | zwright8, tynamite |
| Catalog sources and freshness | [Research #41](https://github.com/Pick-Your-AI/pick-your-ai-research/issues/41) | tynamite, PUSHINGSQUARES |
| Saved, shared and compared builds | [Research #42](https://github.com/Pick-Your-AI/pick-your-ai-research/issues/42) | tynamite, appletechie |
| Market program | [Research #47](https://github.com/Pick-Your-AI/pick-your-ai-research/issues/47) | tynamite, appletechie |

The manifest also records all twelve market workstream receiving roles and each repository's complete assignee-to-issue grouping. The leaderboard, Android and Apple issues had no GitHub Assignees in this snapshot; a proposed owner role is not a named assignment. This map retains that state and adds no staffing, response-time or operational commitments. Future delivery must use current issue ownership and the affected repository's review process.

## Integration and overlap routing

Shared schema or compatibility changes go through research #40; catalog proposals and freshness through #41; price assumptions through #39; and save/share/compare behavior through #42. Use the existing [research workflow](https://github.com/Pick-Your-AI/pick-your-ai-research/blob/f0387630f00a95d3a78dfedba54abc96c8b833d0/docs/RESEARCH_WORKFLOW.md) and consumer handoffs instead of recreating research decisions in application repositories. The market program and its native children remain in the research repository and Project 2.

Native shared-service adoption routes through [Android #35](https://github.com/Pick-Your-AI/pick-your-ai-android/issues/35) and [Apple #23](https://github.com/Pick-Your-AI/pick-your-ai-apple/issues/23). Those applications own platform storage, interaction and native verification. Website interfaces retain their documented hosting boundary. The leaderboard owns its [separate contracts and architecture](ARCHITECTURE.md); source collection can reference accepted research and delivery evidence without modifying imported builder contracts or upstream issue/Project state.

The 45 open PRs in the manifest are the overlap index for this observation. Preserve existing source branches and reviews, compare unique changes with current `main`, and coordinate existing receiving work before starting an overlapping implementation. Implementation merged after the observation window must be read at its own accepted revision.

## Acceptance and remaining boundaries

LB-01.03's deliverable is the reconciled coverage inventory, existing-work boundary map, stable identifiers, current owner roles and integration references above. Creating this inventory performed read-only source inspection and changed no upstream assignees, parents, labels, Project fields or status. Its adoption does not declare other repositories' deliverables complete.

Public visibility establishes discoverability. Collector installation, authorized event and field coverage, individual evidence consent, source history, independent acceptance and release each retain the gates in the [evidence and contributor-rights policy](evidence-contributor-rights.md), [ingestion plan](INGESTION.md) and [operations plan](OPERATIONS_PLAN.md). Recheck source access and identity before onboarding; retain unknown coverage as unknown.
