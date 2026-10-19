# Default-branch integration scope

The GitHub normalizer uses the enriched observation's repository identity and
`repository.defaultBranch` as the repository scope for integration evidence.
A witness whose `targetBranch` and `defaultBranch` agree is insufficient if that
branch is different from the repository's actual default.

## Delivery evidence

Both commit integration and physical-change delivery require a nonblank
`repository.defaultBranch`, an exactly matching `integration.defaultBranch`,
and an `integration.targetBranch` equal to that default. Branch names are
case-sensitive; a previous default does not establish integration into the
current observed default. A missing repository default remains unknown and
cannot be supplied by the integration witness itself.

The existing evidence checks continue to apply:

- A commit must have a pinned SHA that appears in the integration's commit list.
- A physical diff must match the integration's before and after identities and
  have a nonblank canonical change identity. Complete classification is still
  required before line and file quantities are emitted.
- Existing proof, actor and event-time requirements determine whether a fact
  can be emitted. A branch match does not supply missing source evidence.

Rejected commit scope retains `default_branch_integration_unverified`.
Rejected physical scope retains
`physical_change_is_not_verified_default_branch_integration`.

## Attribution and intermediate branches

An observation retains its raw participation even when integration scope is
unverified. Commit authors and committers remain separate. A merged PR retains
its ordinary PR-author and maintainer-merge facts; these facts do not establish
default-branch line or file delivery.

A PR may first merge into an intermediate feature branch and later reach the
repository default through a verified integration. The normalizer therefore
checks the integration target against the repository default without requiring
the PR's original base branch to be the default. Existing canonical integration
identities continue to keep valid replayed facts stable.

## Synthetic regression coverage

After building the contracts and GitHub packages, run:

```bash
npm run build --workspace @pick-your-ai/contracts
npm run build --workspace @pick-your-ai/github
node --test packages/github/test/default-integration-scope.test.mjs
```

The fixtures cover matching `main` and `trunk` defaults, a different branch,
a previous default, branch casing, empty or whitespace-only defaults, absent
repository metadata, stable replay, retained attribution and later integration
of an intermediate-branch PR. All fixture identities and observations are
synthetic.

This guard is scoped progress on
[commit and collaboration attribution](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/66).
Whole-package acceptance still includes the remaining lineage, deduplication
and source-reconciliation evidence in the
[delivery plan](DELIVERY_PLAN.md#lb-0703-deliver-commit-and-collaboration-attribution).
Synthetic tests do not establish a real backfill, source authorization or
public-service acceptance.
