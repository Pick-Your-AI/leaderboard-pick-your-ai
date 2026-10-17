# Independent runtime follow-up review

This candidate follows merged PR #148 on main `f9ac516e`. It references partial
implementation work only; none of the 133 issue gates is closed by these changes.

## Reviewed corrections

- Authenticated webhook body shape, rather than unsigned event header alone,
  determines installation/repository restriction scope. Child deletions cannot
  broaden scope; full installation and enterprise-compatible payloads are retained.
- Export serialization minimizes fields, retains page-specific source provenance,
  versions and diagnostics, neutralizes spreadsheet formulas, and bounds text,
  structure, cells and total bytes. Empty CSV still carries snapshot metadata.
- Metric preparation retains unknown historical qualification, uses contract actor
  enums, requires positive automation evidence and exact safe-integer line counts,
  and refuses conflicting per-unit measurements. Equivalent duration timestamps
  compare as instants. None of this activates an unapproved policy.
- Configuration activation rechecks source-verification expiry inside its final
  synchronous transaction, after asynchronous authorization work.
- Immutable snapshot insertion must succeed before head/receipt advancement;
  historical A/B/A content reuse cannot claim a newer revision for older bytes.
- Running collection pins its approved configuration and rechecks repository authority
  around asynchronous work, inside source transactions, and immediately before each
  HTTP request/retry. Durable private confirmation fences cross-store publication;
  legacy snapshots fail closed until an authorized run reconfirms them.
- A read-only browser workflow now runs the existing synthetic Playwright/axe suite
  on pull requests and main, retaining bounded seven-day evidence.
- Refreshed dependency heads #140–146 are preserved through normal local merges.
  React/runtime/types and Vite/plugin updates are coordinated, standalone ingestion
  lock data is aligned, and browser preview resolves Vite through its workspace.

Each correction has synthetic regression coverage and independent review. The
lifecycle review also caught and corrected compatibility assumptions about nullable
installation accounts, optional repository metadata and enterprise context. Export
review exercised malicious formulas/content, unsafe URLs and structural limits.
Metric review caught an equivalent timestamp encoding false-conflict and verified
its correction. Actual source/configuration approval is not inferred from fixtures.

## Validation boundaries

The dependency slice passed clean root and standalone ingestion installs, build,
format/typechecks, 270 runtime tests, 20 Python tests and generated-plan checks.
The core lifecycle/export/metric slice passed 294 tests before the final pipeline,
configuration and dependency integration. Final exact-head evidence belongs in the
PR description and accompanying validation report, not those intermediate counts.

Seven real-PostgreSQL-dependent tests require another execution environment;
embedded PGlite does not establish multi-connection correctness. Installed Chromium
could not create a local socket in the restricted environment, and the supported
escalation path failed during environment bootstrap. Browser assertions therefore
remain unverified here. No browser/system security restrictions were changed.

Hosting, installed source permissions, policy approvals, real devices/assistive
technology, deployment/release and operational acceptance remain open. The domain
recorded by the repository is configuration context, not authorization to provision
DNS, incur hosting costs or publish a service.
