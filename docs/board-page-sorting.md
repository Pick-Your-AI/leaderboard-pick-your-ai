# Ordering a public board page

The API board uses one semantic table whose existing responsive styles present
the same rows as cards on narrow screens. **Sort current page** is a native
select above that table, visible at every supported width. The active column's
`aria-sort` and a polite status message describe its display order. The control
stays outside the visually clipped mobile header so keyboard users do not focus
an invisible sorting button.

The initial **Original API order** retains the service's approved metric
ordering. Readers may sort the loaded rows by their published rank, displayed
contributor name or published numeric value in either direction. Rank and value
sorts keep missing entries last in both directions; zero stays numeric, and equal values
retain their API order. Names use the existing display-name/login/ID fallback
with English case-insensitive ordering. No comparison reassigns a rank or
changes an accepted, pending, partial, unknown or unranked state.

This is a display operation on the current bounded page. It neither requests
more contributors nor sorts the complete cohort. The service retains its
default page limit of 50, maximum 100 and existing bounded cursor/export rules.
A tied rank can continue on a later cursor page; a new page, scope or snapshot
resets the display order. Opening a proof keeps the same board order. Exports
retain the original API order and exact selected snapshot/cursor; the page
explains this distinction before the table.

Every row retains its original contributor, proof links, result, pending
disclosure, diagnostics and optional rank movement. Current privacy and source
authority checks remain in the existing reader; failed reads unmount the table
and its sorting state. Sorting does not create a source permission, publish a
metric, infer a missing value or turn LOC into an overall merit score.

This is a bounded slice of [LB-14.02 / #111](../planning/project-backlog.json).
Global search/order semantics, top-N and small-cohort policy, and the complete
LOC classifier/source breakdown retain their separate implementation and
acceptance requirements. Unit cases exercise conservation, ties, missing values
and wide numbers; authored browser cases exercise the actual synthetic service,
keyboard/mobile sorting, exact proof/export/cursor behavior and current
suppression. They do not establish real-source coverage, manual assistive
technology acceptance or a public deployment.
