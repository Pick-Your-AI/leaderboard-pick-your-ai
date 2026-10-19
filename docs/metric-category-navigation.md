# Metric category navigation

Refs #111. This is the public API catalog's definition navigation, using the
registry already fetched and validated for the current read. It does not modify
the overview, approved metric definitions or contribution source selection.

The catalog retains its search form and department selector. Its category links
use the exact served department IDs, labels and order, including departments with
no matching definitions. The active link has `aria-current="page"`; the links are
ordinary URL navigation, not a tab widget that hides an unrelated data panel.
Search text, exact public scope, actor filters, dates, display timezone and the
selected snapshot stay in the URL. Catalog-only filters are still discarded when
opening a board or method sheet, and do not enter API source queries.

At most twelve department links and the All departments link are rendered at
once. Larger inventories have previous/next category pages; each page gesture
focuses its status text. A copied URL starts on the page containing its selected
department. Unknown registry metadata leaves an explicit unavailable explanation
and the existing complete metric catalog. No empty department is a measured zero.
There is no additional network request, local storage, inferred source grant or
unbounded Show all action.

This bounded navigation does not choose a top-N rank cutoff or a small-cohort
threshold. Those remain separate from the existing approved API ranking and
bounded contributor cursor pages. It also does not infer LOC classification,
sample sizes or excluded work from a partial evidence page. The remaining #111
measurement/policy interfaces and whole #107/#117 acceptance retain their actual
source and receiving gates.

Focused render and browser cases cover exact served names, selected links,
scope/search preservation, bounded category pages, keyboard navigation, copied
URLs, unknown metadata, narrow layout and no source reads. Their actual execution
and immutable source identity must be reported with the delivery; authored tests
alone do not establish a user journey or assistive-technology acceptance.
