# Leaderboard contract candidate

Status: implementation candidate for review under LB-03.01, LB-03.02, LB-03.03, LB-03.05 and LB-03.06. It is separate from the frozen research `contracts/v1` and does not alter that repository.

The TypeScript package `@pick-your-ai/contracts` exports strict runtime schemas and inferred types for `Actor`, `Artifact`, `SourceEvent`, `Attribution`, `Coverage`, `Contribution`, `MetricResult` and `Snapshot`. The package accepts only stable GitHub IDs for resolved identity. Login and display name are mutable display fields; email is not part of the contract. Actor kind and execution mode are separate, and the contract has no `manual` execution claim.

Unknown, ambiguous, unavailable, partial and zero are distinct states. A zero metric result is valid only with complete coverage for its stated scope and half-open time window. Missing event time stays `null`; observation time remains required. Private, unknown, deleted and unavailable artifacts cannot carry a public URL. Strict schemas reject unmodeled fields such as email.

An event observation does not itself create a contribution. Contributions name one canonical event, an artifact, participant roles, qualification state and the metric definitions they may appear in. There is no shared numeric score field. Metric values are scoped per metric, and category or cross-project measures are not implicitly additive.

Identity alias, merge and split corrections carry evidence and review fields; an accepted correction cannot validate without a reviewer and evidence. Artifact lineage records same-change, squash, cherry-pick, mirror or imported relationships as evidence-bearing facts. These primitives do not themselves allocate fractional credit or count imported copies as new work.

The versioned registry copies all 98 canonical metric definitions from `planning/metrics-and-ingestion.json` without rewriting their meanings. It marks policy version `candidate-0.1.0`; registry presence does not enable a metric. Registry-wide UI fields that lack approved values in the planning source (department, synonyms, maturity, supported states and date bases, and lead view) are marked unresolved and must be supplied by product and metric owners before enablement.

## Candidate compatibility rules

- `leaderboard/v1` and `leaderboard-metrics/v1` are independent leaderboard versions. The research builder contract remains owned by its repository.
- A published version is immutable. A breaking field or semantic change gets a new major contract version and explicit migration notes. Additive optional fields can be considered within a minor release only after all consumers tolerate them; the current strict parsers intentionally reject extras.
- Persisted observations retain source IDs, action, actor role, event time, observation time, visibility, source revision, dedupe key and source provenance. Corrections and eligibility decisions remain separate from observations.
- Dedupe joins require an explicit key and matching actor, action, role, artifact and event time. Missing keys remain unknown. Conflicting matches remain ambiguous for review, not a guessed merge.
- Coauthor participation is represented by distinct roles on a shared artifact. No fractional allocation is inferred. PR, commit and line measures remain separate metric results.
- A source gap, incomplete page, missing permission or unresolved actor cannot be represented as a measured zero or verified identity.

## Decisions still required

- Approve the evidence, identity-link, opt-out, correction and retention policies before public recognition or account-link workflows are enabled.
- Approve the source capability matrix after installation and canary evidence. Current package types do not establish endpoint permission or historical completeness.
- Review each metric's source adapter, actor rule, dedupe key, qualification gate and verification example before enabling it.
- Choose and approve department mapping, synonyms, maturity, supported state/date bases, lead-view metadata and tie presentation from accountable product and metric owners.
- Establish migration and historical recomputation procedures for persisted production data before a production schema is declared stable.

## Validation limits

Automation verifies structural fields, runtime invariants, registry parity and deterministic handling of synthetic duplicate, ambiguous and missing-source examples. It does not establish that a real GitHub source is complete, that a permission is available, that an identity link is correct, or that policy owners accepted a metric. Those remain evidence and review gates.
