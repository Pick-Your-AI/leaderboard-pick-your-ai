# Repository, Project and workstream context

This is the implementation contract and automated-evidence guide for [LB-03.04 / #37](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/37). Project membership provides a view of a contribution. It does not create another contribution, identify an editor, prove an event time, or determine organization-wide eligibility. Eligible unboarded work remains included.

## Stable identities and configuration

The approved runtime configuration pins each repository's numeric database ID, current slug, installation and allowed source families. `allowedProjectIds` contains explicit Project V2 **node IDs**. The current reader verifies the repository ID and public visibility at the source, the native issue or pull-request node ID, its type and exact source URL, and every approved Project's public visibility. Project and repository names do not supply identity.

The host can provide `projectWorkstreamMappings`, with at most one versioned mapping per approved repository. A mapping selects a Project node ID, single-select field node ID, option ID and semantic workstream ID. Field/option names, display positions, assignees and owner-role text are not mapping keys. A renamed label with the same ID preserves its mapping; a replacement field or option requires a reviewed configuration change.

The following is **synthetic configuration syntax**, for tests only. It is not an installation, a production mapping or a source readback:

```json
{
  "projectWorkstreamMappings": [
    {
      "repositoryId": 37,
      "version": "synthetic-project-mapping/v1",
      "projects": [
        {
          "projectId": "PVT_synthetic_project",
          "fields": [
            {
              "fieldId": "PVTSSF_synthetic_workstream",
              "options": [
                {
                  "optionId": "synthetic_option",
                  "workstreamId": "engineering"
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

Runtime construction validates the whole configured mapping against approved repository and Project IDs, rejects duplicate or ambiguous identities and unknown keys, and retains a canonical detached copy. Mapping changes require a new approved configuration version. The complete mapping, including its own version, participates in normalization cache identity. Knowing a Project database ID or a field's UI database ID is not evidence of its GraphQL node ID; the [dated organization inventory](organization-boundaries.md) and [native configuration work](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/33) remain the source for actual bindings. Missing bindings remain unknown.

## Current snapshots and observed history

| Evidence | Meaning | Limits |
| --- | --- | --- |
| Complete native-subject current snapshot | Current membership within the explicit approved public Project scope, with selected single-select IDs | Does not prove prior membership, an editor or an assignment time |
| Explicit empty current snapshot | The native subject has no membership in that approved Project scope during the read | Says nothing about Projects outside the approved scope |
| Native Project status event | The source identifies that event's Project, timestamp and actor when available | Does not prove other Project membership or a historical semantic workstream |
| Ordinary issue, PR or other action without event-context evidence | The action retains its verified source identity and normal counting eligibility | Historical Project/workstream membership remains unknown |
| Missing, null or unmapped single-select value | Current Project membership can still be known | Workstream absence is not inferred without proof of the relevant field/schema state |

The reader follows GitHub's documented [Issue Project connection](https://docs.github.com/en/graphql/reference/issues#issue), [PullRequest Project connection](https://docs.github.com/en/graphql/reference/pulls#pullrequest) and [Project V2 item and single-select value fields](https://docs.github.com/en/graphql/reference/projects#projectv2itemfieldsingleselectvalue). Both native subject connections are read with `includeArchived: true`; field hydration requests field/option IDs and avoids labels and free text. The Project item archive state is retained as source state, not treated as deletion.

The reader takes a complete membership inventory, hydrates approved items, reads the membership inventory again, and verifies public scope again. Every membership/field connection is paginated and checked against its source `totalCount`. Duplicate identities, changed counts, mismatched item/content bindings, malformed values and changing item revisions fail closed. A membership read is a bounded observation window, not an atomic GitHub transaction. A changed source state during later normalization must match the collected fingerprint before it can be used. An item updated after the source observation cutoff is not eligible for that context.

The source adapter emits **one row per native issue or PR**, including an empty membership row. `projectSubjectId` binds that row to its native subject and is accepted by the collection store only for a matching `project_current` current-state fact. It cannot appear on ordinary activity or observed transitions. Current snapshots retain no actor or event time. The GitHub adapter fingerprints the minimized complete snapshot and approved scope, and binds its collected revision to the scan. The legacy item-based Project snapshot helper retains its original schema and fingerprint and remains observation-only.

The full subject inventory and expected count stay fixed through a scan's checkpoint. The collector hydrates only the subjects on the requested output page, rather than hydrating the entire inventory again for every page. Current limits include 100 approved Projects per repository, 10,000 native subjects and bounded complete pagination; the existing frozen dataset and transport budgets remain enforced. Exhaustion is a source failure, not evidence of absence.

## Persistence and counting

Only the latest **completed** Project collection run per repository at the frozen observation cutoff supplies current contexts. Membership in that run is determined by `collection_items`; `first_run_id` continues to mean the source fact's first observation. Thus an unchanged fact retained in a later completed inventory keeps its context without rewriting its original source row. A partial, failed or later-completing scan cannot replace the selected inventory. Equally recent competing completed runs are rejected instead of combined.

A complete later inventory replaces the earlier one. An explicit empty subject snapshot clears that subject's last scoped membership. A subject absent from the later complete inventory does not inherit an older context. This differs from treating the union of all previously observed Project items as current membership, which would leave removed memberships behind.

Normalization persists a private `github-current-project-context/v1` receipt bound to repository, native subject kind/ID, exact source URL, collected revision, observation time, approved Project scope and mapping version. It contains no new metric action or actor credit. The cache validator also checks that a claimed workstream belongs to a Project actually present in the context; a Project-free subject cannot acquire a workstream from another configured Project. Hash-consistent but incorrectly bound cached contexts are rejected.

The `project-membership-context/v1` cache generation applies to retained data even after active Project collection is disabled. Earlier normalization documents stay available under their original keys for frozen identity checks. A changed mapping gets a separate cache entry, and new context is overlaid on **copies** of deduplicated metric facts. Source facts, prior normalization documents and earlier frozen records remain immutable.

The join uses exact repository ID and native artifact/subject ID. It does not guess a parent from a URL, title or assignee. An issue and its comments are distinct native objects; a comment without a proved parent join does not inherit the issue's context. PR-related facts whose normalized artifact is the verified native PR can use that PR's context.

The metric engine's explicit `context: "current"` mode can filter these frozen copies. Each action still has its original metric/canonical identity, so a contribution in two Projects counts once in the organization total and once when the two Projects are selected together. Current Project/workstream filters do not change event time, acceptance receipts or actor attribution.

Historical filtering continues to use `eventContext`. A missing event context emits `unknown_membership_context`. A native Project event proves only its named Project scope and leaves `workstreamsKnown: false`. For either context basis, a positive proved match remains usable; an unmatched request outside the proved Project scope or with incomplete workstream knowledge is unknown, rather than a known zero.

The public pipeline's existing query basis remains event context. Selecting and explaining a public current-versus-event view remains [#91](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/91). The new current context is available to the engine and retained private frozen inputs; this change does not silently reinterpret existing workstream-filtered public URLs.

## Repository lifecycle and inherited history

| Change | Required behavior |
| --- | --- |
| Repository rename | Retain stable numeric repository identity; accept the new slug only through a fresh approved binding and matching public-source read. Every collection probe requires the REST `full_name` to match the approved slug, case-insensitively. Missing, malformed or different current locations fail before collection. Historical source URLs are not rewritten into guessed new evidence. |
| Repository transfer | Reverify the repository ID, installation access and approved current slug/organization binding. A redirect that retains the numeric ID does not approve a different current owner/name. Transfer does not imply membership in a destination Project. |
| Repository archive | Preserve already observed source facts and current associations while the source remains public and approved. Archiving does not fabricate a deletion or an earlier archive time. |
| Fork | Require a separate explicitly approved repository ID. Do not copy the parent's Project associations or infer additional effort from shared commit history. |
| Imported or backfilled history | Preserve the existing explicit import/backfill lineage and original fact times. Current Project state does not fill unknown historical membership, organization-adoption dates or missing actors. |
| Removed/private/unavailable source | Apply the existing current source/Project privacy gate before publication and pinned readback. Lost access is not a known empty membership. |

These rules preserve existing native issue types, assignees, parents, blocker links and Project fields. Source collection is read-only and never changes upstream metadata.

GitHub documents case-insensitive owner/repository parameters and moved-repository responses in [Get a repository](https://docs.github.com/en/rest/repos/repos#get-a-repository), and location redirects in [Transferring a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository). `repository-location-source.test.mjs` exercises the actual client/collector boundary with synthetic metadata, including a reviewed new location retaining the same numeric ID. It does not claim a live transfer or installation was exercised.

## Automated evidence and remaining delivery boundaries

The new reader tests exercise pagination, visibility and identity loss, scope checks, archived items, item drift, minimized fingerprints, mapping validation and unknown field values. The actual transport → collection → normalization → metric tests cover issues and closed PRs, explicit empty snapshots, two-Project deduplication, mapping changes, detached configuration, unknown historical/unapproved context, mismatched/future revisions and bounded output-page hydration.

The database tests use the actual collection ledger, normalization cache, frozen input store and metric runtime. They cover completed versus partial/failed/future scans, empty and missing later memberships, stable facts shared by successive completed runs, conflicting completion timestamps, separate mapping generations, immutable previous receipts and cache binding validation. Existing Project privacy/history and identity-cache migration tests remain part of validation. All fixtures are explicitly synthetic; they do not establish a live installation, historic source completeness or public release.

Run from the repository root after building:

```bash
npm run build
node --test --test-concurrency=1 packages/github/test/project-context.test.mjs apps/pipeline/test/project-current-source.test.mjs apps/pipeline/test/project-context-storage.test.mjs apps/pipeline/test/project-context-cache-transition.test.mjs apps/pipeline/test/project-pr-history.test.mjs apps/pipeline/test/project-privacy.test.mjs
python scripts/validate_plan.py
python -m unittest discover -s tests -v
python scripts/render_docs.py --check
```

The automated acceptance scenarios for #37 are traceable to these tests. Production source authorization, actual approved field bindings and UI exposure retain their own [configuration](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/33), [source capability](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/41) and [query semantics](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/91) gates. The complete 98-metric plan and ownership baseline are unchanged.
