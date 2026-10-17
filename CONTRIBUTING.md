# Contributing

This repository owns the Pick Your AI contributor-recognition delivery plan and future service. Read the [product scope](docs/PRODUCT.md), [delivery plan](docs/DELIVERY_PLAN.md) and your issue before starting. The repository currently contains planning and validation tools; runtime delivery remains tracked work.

## Choose and own work

Use GitHub Assignees as the source of truth. Agree an owner and confirm prerequisites before moving an issue from Backlog to Ready. The initial plan is unassigned; a proposed owner role is not an assignment. Preserve existing assignees, triage and source decision-record paths across the organization.

The native hierarchy is Program → Epic → Work package. Program and epics use the Feature issue type; work packages use Task. Keep small steps in the package checklist. Open another sub-issue only for an independently owned or reviewable deliverable. Do not duplicate native children as a second checklist.

Status, Priority, Phase, Workstream, Readiness, Level and Acceptance Gate are the seven Project fields. Native Assignees and relationships remain authoritative. Use labels selectively for kinds and topics such as documentation, questions, security and accessibility; do not duplicate status, priority or ownership in labels. Do not invent dates, estimates or iterations.

## Readiness and dependencies

- **Needs owner:** the package can be scoped but has no accepted owner.
- **Needs input:** a named prerequisite deliverable is missing.
- **Awaiting decision:** a stated choice requires the accountable role to accept it.
- **Ready:** an owner has accepted work and all required inputs are usable.
- **Blocked:** an active impediment prevents progress; state the blocker and next action.

Use native blocked-by links for genuine delivery prerequisites. Information inputs, related sources and optional integration relationships belong in contextual body links. Do not turn compatibility or information cycles into delivery blockers. Preserve native parent links when editing issue text.

## Plan and implementation changes

Create a branch and pull request against `main`. Reference the work-package issue, describe the resulting behavior or decision and supply its required evidence. Use `Refs #n` for partial progress; use `Closes #n` only when the full acceptance gate is satisfied. Repository creation does not close engineering foundation, installation or deployment work by itself.

The canonical baseline is [planning/project-backlog.json](planning/project-backlog.json). When scope changes, update metric/UI mappings, decision and release records, then regenerate documentation. Match existing stable LB IDs to native issues rather than publishing duplicates. GitHub carries live execution state; the baseline must not reset assignees or progress.

```bash
python scripts/sync_baseline.py
python scripts/render_docs.py
python scripts/validate_plan.py
python -m unittest discover -s tests -v
python scripts/render_docs.py --check
```

The synchronizer updates derived counts and the UI mapping's backlog fingerprint after an intentional edit. It does not repair missing references or change delivery scope. Review generated diffs, including changed counts and metric meanings.

CI checks structure, references, dependency cycles, mapping agreement, safe source URL shape, local Markdown links and generated-document drift. It does not fetch or certify source claims, prove API permissions, validate production metric accuracy, certify accessibility or deploy the app. Report these limits and supply the appropriate independent evidence.

## Evidence, source rights and privacy

Keep real contribution evidence public, attributable, dated and source-linked. Do not invent missing actors, event times, acceptance states, prices, measurements or permissions. Unknown and unsupported are meaningful states. Synthetic examples belong under `tests/fixtures/` and must never enter real rankings.

Do not commit credentials, private GitHub payloads, commit emails, customer data, raw datasets, full assistant sessions, model weights or large downloads. Use small sanitized manifests for external evidence. Review public Markdown, filenames and URLs as untrusted content in the future app.

Changes to research findings or imported builder contracts belong in the [research repository](https://github.com/Pick-Your-AI/pick-your-ai-research), following its workflow and central contract review. Leaderboard contracts are separate and versioned here. Ingestion must not mutate upstream labels, ownership or Project fields.

## Review and completion

Request review from the affected metric, source, UI, security or operations roles. Acceptance requires the package's stated evidence, not only passing automated checks. Mark Done after the reviewed deliverable is merged and its gate is met. Public release additionally requires approved hosting, real deployment, independent anonymous readback, fresh source activity and a functioning correction receipt. Proposed operators and response commitments must be accepted before they are advertised.
