# Repository and governance shell

Scope: [LB-02.01](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/27).
This review adopts the existing dedicated repository, MIT license, contribution
policy and repository security-reporting route under the project owner's
delegated engineering authority. It establishes this repository's governance
shell; source installation, operational response and public release have their
own evidence gates.

## Dedicated boundary and provenance

The public repository is
[Pick-Your-AI/pick-your-ai-leaderboard](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard),
stable repository ID **1422874501**, node ID `R_kgDOVM9XhQ`, with default branch
`main`. The repository was already created in the authorized delivery stage;
this decision does not create a duplicate.

[README](../README.md) and the [product scope](PRODUCT.md) state its purpose:
public, attributable contributor discovery and independent recognition boards.
The [architecture](ARCHITECTURE.md) records the intended module boundaries, and
the [runtime guide](runtime-foundation.md) identifies the local implementations
and their synthetic validation. The API, web, worker, controls and source/metric
packages remain in this repository. Runtime existence is separate from a
deployed service or proven source coverage.

[planning/concept.json](../planning/concept.json) preserves the prepared local
concept and the scope/provenance record; [the UI concept](../planning/ui/ui-concept.json)
retains its design consultation attribution and the master policy corrections.
Those historical inputs explain the plan. They are not new live-source receipts,
current execution status or authority to publish real contributor data.

The research repository continues to own its research, catalog, contracts and
evidence workflow. Its [contribution boundary](https://github.com/Pick-Your-AI/pick-your-ai-research/blob/b7c3056c1d99bcc2661d590e5cc790ecc5225641/CONTRIBUTING.md)
and [recognition cross-link](https://github.com/Pick-Your-AI/pick-your-ai-research/blob/b7c3056c1d99bcc2661d590e5cc790ecc5225641/README.md)
explicitly place leaderboard implementation here. The reviewed research tree
at that revision contains no leaderboard application/workspace or the
leaderboard's versioned runtime namespace. This change writes no research file
and imports no leaderboard runtime into that repository. Existing source owners,
native parents and Assignees are preserved.

The known dedicated boundary and reviewed repository examples are usable inputs
from [#23](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/23).
That package's complete paginated organization/Project inventory and live field
readback remain its own acceptance; this repository-shell decision does not
claim to complete them.

## Adopted governance files

| File | Adopted purpose and limit |
| --- | --- |
| [LICENSE](../LICENSE) | Retain the existing MIT license without altering its text or attribution. Source admission, evidence consent and upstream rights remain governed separately. |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Use the documented contributor setup, real local fixture journey, module boundaries, evidence requirements and review/completion workflow. |
| [AGENTS.md](../AGENTS.md) | Preserve native ownership and scope, regenerate derived documents, keep fixtures synthetic and report evidence at its actual acceptance level. |
| [Governance](GOVERNANCE.md) | Apply versioned recognition, correction, privacy and release decisions without inventing source facts, human consent or operating acceptance. |
| [Review routing](review-routing.md) and [CODEOWNERS](../.github/CODEOWNERS) | Route metric, source, UI, security and operations changes to the existing verified repository maintainer. Routing grants no new access and does not establish an independent approver. |
| [SECURITY.md](../SECURITY.md) | Provide the enabled private reporting route and safe fallback, with no invented email address, response deadline or public disclosure. |

## Actual repository readback

The following observations were made on **2026-10-18** through the repository
API and the authenticated GitHub settings interface. They describe actual
configuration, not a promise that every broader CI or operational criterion has
been tested.

| Boundary | Observed state |
| --- | --- |
| Repository identity | Public, non-archived, enabled; ID `1422874501`; default branch `main`. |
| Existing review authority | GitHub's collaborator-permission read returned `admin` for the existing `CompleteDotTech` account. No person/team access was added or broadened. |
| Protected main | A pull request, successful `checks` and `validate` from GitHub Actions, an up-to-date branch and resolved review conversations are required. Linear history is required; administrator bypass, force pushes and branch deletion are disabled. |
| Review settings | A required separate approval count, required Code Owner approval and required signed commits are not configured in the classic rule. Project work still follows the owner's explicit reviewed-PR mandate and the contribution workflow. A COMMENT review is not an independent GitHub account approval. |
| Private vulnerability reporting | The Security overview initially reported Disabled. The repository-specific control was enabled, then the overview independently read back **Private vulnerability reporting • Enabled**. |
| Private-report receiving scope | Existing repository administrators/security authority receive reports through GitHub's private advisory workflow. No report was submitted, advisory published, recipient added or private finding copied into the repository. |

The branch rule was inspected without modifying it. The review checked the
actual classic rule, not merely the empty ruleset list. Its required check
contexts are `checks` and `validate`; browser and encrypted-recovery workflows
provide additional receiving evidence and are not misrepresented as protected
required contexts. Repository identity, visibility, branch rules and existing
collaborator permission were preserved.

GitHub's [configuration instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)
describe repository-level private reporting and the dependence of notifications
on recipient preferences. Its [reporting instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately)
distinguish the reporter form from an administrator's draft advisory. Enabling
the route establishes a private contact mechanism; it does not prove delivery of
a real notification, appoint an incident responder or promise an acknowledgement
time. Actual security and operations acceptance remain separately tracked.

## Completion boundary

This package's reviewed evidence consists of the existing repository/governance
files, their dedicated source boundary, adopted license and contribution policy,
enabled private reporting mechanism, and actual visibility/default-branch/access
readback. Review and protected merge record adoption of this bounded shell.
The separate full organization inventory, source installation, CODEOWNERS
notification observation, complete CI acceptance, incident drills and public
deployment are not supplied by this decision.
