# Contributor-recognition repository instructions

Read CONTRIBUTING.md, docs/DELIVERY_PLAN.md and the issue's acceptance gate before editing. This repository contains the delivery baseline and a tested local runtime. Remaining implementation and public-service acceptance are tracked separately; merged synthetic implementation does not establish a live service.

- Preserve live GitHub Assignees, issue types, native hierarchy, blocker links and contextual Project fields. Never infer ownership from the plan's owner-role text.
- Use planning/project-backlog.json as the scope baseline, and update metric/UI mappings when changing scope. GitHub remains authoritative for execution status. Do not reset progress from the initial baseline.
- Regenerate documents with `python scripts/render_docs.py`. Run `python scripts/validate_plan.py`, `python -m unittest discover -s tests -v` and `python scripts/render_docs.py --check` before reporting validation complete.
- Keep all 98 planned metric definitions and the full task map traceable unless an explicitly reviewed scope change alters them. Derived counts are generated; do not patch a count to hide missing work.
- Keep raw activity, accepted outcomes and reviewed recognition distinct. Unknown actors, timestamps, permissions and unavailable sources remain unknown. Never fabricate contribution evidence or a universal productivity score.
- Keep tests synthetic and separate from real evidence. Do not commit credentials, commit emails, private/customer content, raw downloads, assistant session receipts or large datasets.
- Research and imported builder contracts remain owned by the research repository. The leaderboard owns separate versioned contracts. Source collection must not mutate upstream issue or Project state.
- Runtime scaffold, GitHub App installation, hosting and deployment each have their own acceptance work. A planning CI pass is not a claim that the app exists or is live.
- Inherit machine-wide safety rules: never shut down or terminate WSL to recover this project. Preserve unrelated sessions and workloads.
