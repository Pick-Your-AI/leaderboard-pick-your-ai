# Repository review routing

Refs #30. `.github/CODEOWNERS` routes metric, ingestion, UI/API, security and operations changes to the existing verified repository maintainer `@CompleteDotTech`. Repository admin permission for that account was read back on 2026-10-18. No other person or team is assigned by inference.

This is repository review routing, not a grant of access, an on-call assignment, production policy approval, accepted operational ownership or a response-time commitment. The maintainer can obtain specialist review before a decision. A review request is not an approval, and the author's own changes still require independent review. Do not represent a self-authored change as independently approved merely because its author is listed here.

## Coverage

- Metrics: `packages/metrics`, `packages/contracts`, canonical metric definitions and coverage mappings
- Ingestion: GitHub adapters, ingestion, pipeline and worker
- UI/API: public browser and service workspaces
- Security: protected controls and security reporting guidance
- Operations: infrastructure and repository configuration, including CODEOWNERS itself

The fallback covers every other repository path. Explicit specialty paths make review responsibilities discoverable without inventing unverified teams. Existing issue assignees and native ownership relationships remain authoritative for delivery work.

GitHub uses CODEOWNERS from the pull request's **base branch**, and automatically requests listed owners on eligible ready-for-review changes. Drafts do not trigger automatic owner requests. GitHub's normal author/reviewer restrictions still apply; routing does not create another independent reviewer account. Branch rules and required approvals are separate and are not changed by this file. See [GitHub's CODEOWNERS documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).

Before changing a handle or adding a team, verify that it exists and has repository write access; teams must also be visible. Preserve an owner for the review configuration itself. `tests/test_review_routing.py` checks the deliberately limited pattern syntax and representative specialty paths offline. A source test is not a claim that an actual review notification was delivered; after merge, inspect GitHub's CODEOWNERS errors and the next eligible PR's requested reviewers.
