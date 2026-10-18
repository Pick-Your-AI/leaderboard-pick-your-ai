# Historical stacked-PR regression fixture

`packages/github/test/fixtures/historical-stack.json` is a test-only structural
projection of public research repository data at the source-audit cutoff
2026-10-17T02:24:58Z. It is not a scoring input, accepted recognition receipt,
or source onboarding approval. Refs #72, ORG-CASE-03.

Read-only GitHub GraphQL pagination selected merged PR numbers, target branches,
merge times, typed author/merger node identities, and commit OIDs with typed
linked author/committer identities. Filtering by the cutoff reproduced 34 PRs,
107 PR commit entries, 92 distinct commit identities, and 11 intermediate-target
merges. Every PR commit connection was checked for truncation. A separately
paginated history of the recorded default-branch head (included in provenance)
contains 112 commits: 86 of the 92 candidate identities occur there; six lack
that ancestry proof. Absence does not prove non-delivery: squash/rebase changes
identities. Neither 86 nor 92 is a count of credited contributions.

The retained JSON contains public PR links and a digest of the local allowlisted
readback. Raw downloads are not committed. Typed actor IDs were replaced with
sequential fixture-only numeric aliases, preserving equality, role associations,
and null values. These aliases are not GitHub database IDs. Commit OIDs were
replaced with deterministic fixture-only SHA-shaped aliases preserving equality.
Names, logins, emails, bodies, and commit messages were not queried. The source
head remains public provenance, not a candidate actor or commit alias.

The normalizer tests adapt the projection to a synthetic repository and URLs.
They verify author/merger separation for all 34 PRs, stable commit identity across
107 observations, and preservation of unknown integration times. The historical-observation tests provide
no integration envelope: ancestry alone cannot establish the exact integration
transition, its before/after range, or a physical diff. Therefore these inputs
must emit no `commits_integrated` facts. No synthetic LOC is represented as a
historical measurement. A separate test constructs explicitly invented one-line diff overlays for all 11
intermediate targets, checks their LOC exclusion, and uses a main-target positive
control. These overlays are not in the historical JSON. All normalized outputs
remain synthetic and unaccepted.

Run `npm run test --workspace @pick-your-ai/github` after installing dependencies.
Other #72 criteria and external source acceptance gates remain open; these tests
do not certify the entire work package.
