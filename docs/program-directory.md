# Program directory and exact scope navigation

The public API frontend exposes `/programs?ui=api` and
`/programs/:program?ui=api`. The directory names the five configured delivery
programs, links their native GitHub Projects and contributor/activity scopes,
and exposes every category in the served registry. Android and Apple are
separate program records with their own native IDs. The existing
`/projects/:id` route remains a workstream-board alias; it is not reinterpreted
as a native GitHub Project ID.

## Display configuration

[`apps/web/public/program-directory.json`](../apps/web/public/program-directory.json)
is a versioned, deployed display configuration. Its initial names, native IDs,
numbers and per-Project Status and custom field names preserve the dated, immutable
[organization inventory](../planning/organization-inventory-2026-10-18.json).
The JSON also pins that inventory's GitHub commit. The observation is a date;
the separately recorded issue/PR collection clock is not a Project metadata
collection timestamp.

The four repository links describe the reviewed program boundaries. Research
and Market share the research repository. These links do not place every
repository event into a Project, prove historical membership or approve a
public materialization. No collector source configuration or existing Project
field schema is written by this directory. Recorded Status and custom field names remain each
Project's vocabulary; custom field options are not flattened into a shared
status, workstream or leaderboard category.

The decoder requires exact supported keys/version, unique native identities,
bounded valid display text and known repository references. It rejects decoded
duplicate JSON keys, malformed dates, unsupported references and input beyond
128 KiB. The same-origin asset uses an eight-second abortable read, strict
UTF-8, no credentials/cache/redirect following, and bounded stream cleanup.
Records and arrays are detached and immutable. Empty configuration is explicit;
failed or malformed configuration renders the existing bounded failure state,
without substituting the prototype or cached personal data.

## Membership, overlap and evidence

Each program offers separate event-time and current-at-snapshot-cutoff links.
The existing public scope contract carries native Project IDs, contribution
roles, dates and optional repository ID to the service. Program navigation
keeps dates, account-type filter and roles while clearing an unrelated
workstream, repository, comparison, cursor and snapshot/proof pin. An explicit
repository link combines that repository with the chosen Project; it does not
infer contribution membership from the display configuration.

The all-program link requests one canonical Project union. The frontend does
not sum independent program totals: one contribution may occur in multiple
program views without earning duplicate organization credit. The organization
link deliberately clears Project selection so eligible unboarded work remains
discoverable. The directory itself has no contributor counts. Each selected
contributor/activity/category view must independently receive an approved
publication and remains subject to current privacy controls. Missing historical
membership, unapproved scopes and unavailable source data remain unknown.

All registered category links remain discoverable and retain their definition
and publication status. Listing a category does not activate a metric or claim
measured work. Display configuration cannot change source admission, materialized
membership, native planning hierarchy, metric definitions or role qualification.

## Verification and remaining acceptance

The focused unit suite checks the deployed five-record identity/vocabulary
against the dated inventory, immutable configuration, malformed/duplicate and
oversized input, exact v1/v2/v3 scope transitions, overlap, unknown references,
route compatibility and stream cleanup. Browser cases use explicit synthetic
display configuration and the actual service projection to exercise keyboard
navigation at 320 px, category/program discovery, scope/pin transitions,
overlapping contributor views, current suppression and failure states. Those
fixtures are not a fresh GitHub inventory or production membership receipt.

This implements the missing discovery/navigation portion of #117. Full issue
acceptance still requires review of the delivered exact tree and its actual
accessible-journey evidence, together with the approved source scopes used for
any real contribution claim. The existing native field vocabularies and Project
hierarchy stay authoritative; no new leaderboard planning schema is installed
by this frontend change.
