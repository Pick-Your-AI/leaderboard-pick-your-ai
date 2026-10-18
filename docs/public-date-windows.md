# Published date windows

This describes the public date selection and confirmed-window discovery for [LB-11.02](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/91). A date choice identifies one approved, already confirmed snapshot of the complete filter. Reading the menu does not collect source data or publish a new snapshot.

## Reader entry and retained links

Use `/start` for a new browsing entry. It resolves **Last 30 days** before loading a board, health subscription or live stream. The optional `period` parameter selects another named default. If that exact choice is unavailable, the entry stays open and offers the available choices; the reader must explicitly choose one. An empty menu can lead to the measures catalog and its existing custom UTC fields. The catalog requires only the metric registry until the reader opens the date-window panel or selects a board.

The **Browse** and brand links open this entry with the current organization, repository, Project, workstream, membership basis, role, actor, metric and display-zone selection. They remove old dates, snapshot, cursor, proof and comparison baseline. New-entry links reject retained selectors and reject links above their complete 49,152-character admission budget.

Existing undated routes keep their existing meaning. Existing dated links, pinned snapshots, cursors and proofs are not redirected to a new default. On a board or the measures catalog, **Choose a published date window** opens the optional selector. Choosing a window preserves the complete filter, actor kind, metric and display zone, uses the confirmed scope and snapshot from discovery, and clears the old page cursor and proof. A compatible board comparison selection keeps its existing explicit baseline. Navigation preserves the previous displayed pin so Back can return to that exact publication.

## Request capacity and preview hosting

The entry, browser client and HTTP service admit a complete canonical request target up to 48 KiB (49,152 bytes for the percent-encoded ASCII target). This covers all 100 distinct maximum-length Project identities together with the other supported scope fields and selectors. The independent response envelope and client response-byte limits still apply.

Use the configured preview command, for example `npm run preview --workspace @pick-your-ai/web -- --host 127.0.0.1 --port 4187 --strictPort`. Its launcher starts the installed Vite CLI with Node's `--max-http-header-size=66560` parser budget. The preview server separately enforces a 48 KiB request target, 16 KiB of parsed Latin-1 ordinary headers plus normal field framing, and 1,000 header fields, retaining one additional field to detect overflow. Node normalizes optional whitespace before this header accounting; the 16 KiB check is not an exact wire-byte ceiling. For requests admitted by Node's parser, the preview middleware returns 414 for targets above 48 KiB and 431 for ordinary headers above their independent bounds, with no-store before static handling or proxy requests. The normal, recognition and soak browser configurations use this same preview command.

## UTC membership and display

All membership windows are half open: an event at the start is included, and an event at the end is excluded. Public date inputs use exact canonical whole-second UTC instants, such as `2026-10-18T12:00:00.000Z`. A custom public interval requires both bounds, a strictly later end, and the existing maximum of 366 days. Selecting an IANA display timezone changes the labels, local offsets and displayed dates; it does not change UTC membership, selected evidence, snapshot identity or export values.

The server resolves named periods at the publication's frozen event cutoff, using the existing metric resolver:

| Public choice | Inclusive UTC start | Exclusive UTC end |
| --- | --- | --- |
| Last 7 days (`7d`) | Cutoff minus 7 × 24 hours | Frozen cutoff |
| Last 30 days (`30d`) | Cutoff minus 30 × 24 hours | Frozen cutoff |
| Last 90 days (`90d`) | Cutoff minus 90 × 24 hours | Frozen cutoff |
| Month to date (`month`) | First day of the cutoff's UTC month, 00:00 | Frozen cutoff |
| Quarter to date (`quarter`) | First day of January, April, July or October for the cutoff's UTC quarter, 00:00 | Frozen cutoff |
| Year to date (`year`) | January 1 of the cutoff's UTC year, 00:00 | Frozen cutoff |
| All time (`all`) | No public date bound | No public date bound; the snapshot still has a frozen dataset cutoff |

At an exact UTC calendar opening, a calendar period can be empty. That valid empty period produces no publication or menu entry; other nonempty choices continue. If every approved period is empty, a new webhook notice stays pending without binding an operation or consuming an attempt. One second later, the nonempty calendar interval can be published normally. A retained nonempty operation can still retry at a later calendar opening without changing its cutoff. Invalid dates, explicitly supplied subsecond named cutoffs and ambiguous configuration still fail closed.

Different explicitly approved named labels can coincide. For example, October month to date and quarter to date identify the same interval. The producer materializes that complete scope once and confirms all its approved labels atomically with the same snapshot and revision. Its retained metric-window label is deterministic: year, quarter, month, 90 days, 30 days, 7 days, then all time. This is a choice among actually approved matching labels, and does not rewrite earlier snapshot metadata. An unlabeled or custom scope never acquires a preset merely because its duration happens to match.

## Discovery contract

`GET /api/v1/windows` accepts only the existing `organization`, `repository`, `workstream`, `context`, `project` and `role` query fields. Project and role unions use their canonical query spellings. Dates, actor kind, metric, timezone, snapshot, cursor and comparison parameters are not discovery filters. Actor, metric and timezone selections remain browser or subsequent board selectors.

The response is a detached `public-windows/v1` envelope with the complete undated `scope` and at most seven `windows`, in the table's fixed order. Each entry contains only `period`, its complete concrete `scope`, `snapshotId` and positive safe-integer `revision`. Legacy, membership and role scope versions retain their established identities. Equal scopes may carry different approved labels only when they point to the same snapshot and revision.

An approved selection with no confirmed named entry returns a valid empty menu. An unapproved selection, missing provider, unavailable source, invalid authority or a conflicting concurrent change is unavailable. The endpoint does not infer a choice from arbitrary snapshot history, silently broaden filters or substitute all time. It returns `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`; discovery does not serve a conditional 304 response. Ordinary board and retained-pin error semantics still apply if a chosen publication later becomes unavailable.

## Publication and recovery

Named templates are explicit opt-ins in the host's approved `config.scopes`. For example, a default event-context template can be:

```json
{
  "organization": "Pick-Your-AI",
  "repository": "2",
  "workstream": null,
  "start": null,
  "end": null,
  "period": "30d"
}
```

A host must approve each desired period and complete filter. The template-only `period` field is not part of a public scope. Existing concrete configurations remain valid and readable. Existing configuration approval, repository installation binding, source collection rights, policy signatures, worker continuation and event-versus-observation cutoffs remain required.

Explicit named event cutoffs must be whole-second UTC values. When a new implicit worker scan or dispatch operation includes any bounded named template, the producer selects the validated clock's preceding whole second as its shared event cutoff. The worker selects its authoritative value under the continuation row lock. Legacy, custom and all-only configurations retain their existing millisecond event precision; source, probe and observation clocks always retain their full precision. Retried operations and pending scans keep their persisted event and observation cutoffs. This precision policy does not choose a collection schedule or modify source event timestamps.

The private window index is namespaced by exact configuration version, configuration digest and data mode. It stores bounded pointers to existing confirmations. The index changes inside the same synchronous controls-store transaction that records the publication confirmation and advances its private head. A PostgreSQL allocation alone cannot make a choice public. A failed confirmation leaves the prior index and head intact; an exact authorized replay can confirm the already allocated snapshot. A delayed older cutoff cannot rewind a newer preset even when both concrete scopes independently have revision one.

Discovery reads the finite index, reuses one source transaction for all distinct concrete windows, and checks current repository access and installation binding. After all awaited authority reads, it rechecks the exact index, approved configuration, private heads, publication confirmations, suppression sets, recognition state and retained explanation bindings before returning the captured projections. A concurrent authority change can require a fresh request. There is no history scan, fallback publisher or repair on GET. Persisted index entries survive a normal database restart; pre-index history becomes discoverable only through an actual approved publication confirmation.

## Validation boundary

The dedicated contract and HTTP suites cover strict query/envelope validation, scope and alias binding, privacy projection, unavailable providers, complete request bounds and cache behavior. Index and resolver tests cover explicit approvals, aliases, ordering, rollback, retained scope identity, calendar openings, leap years and UTC boundaries. The real pipeline integration suite exercises collection, normalization, metrics, PostgreSQL-compatible storage, SQLite confirmations, restart, failure/replay, delayed publication and changes after individual authorized reads.

The browser journeys use the actual service and metric engine over a finite set of synthetic publications. They cover the new entry, missing default, all seven choices, aliases, retained links and Back, custom spring/fall DST boundaries, display-only timezone changes, exact JSON export bytes, rejected entries, withdrawn snapshots, deferred-entry failure and same-click cancellation of a held export while the next entry document is held. Maximum-capacity journeys preserve all 100 maximum-length Project identities through default selection, picker navigation, copied pinned links and registry-first custom navigation. Real HTTP tests exercise the complete maximum-capacity discovery response and independent request-target and header limits. Synthetic evidence does not establish production source completeness, real historical membership, live collection rights or a long-duration soak.

Related contracts: [membership scopes](public-membership-scopes.md), [role scopes](public-role-scopes.md), [reviewed pipeline inputs](pipeline-reviewed-inputs.md), and [rank comparison](public-rank-comparison.md).
