# Lifecycle review hardening

Follow-up to merged PR #148, reconciled against main `f9ac516e0a4c4a85de39ac9ea9864e2513605d3c`.
Refs #49 #51 #74. No issue acceptance or live capability is asserted.

GitHub's HMAC covers body bytes, not the event header. A repository deletion could
previously be reclassified as installation deletion by changing only that header.
Child-object deletions could similarly become repository-wide restrictions.
The receiver now requires full signed installation fields (`app_id`, `target_id`,
`repository_selection`, nonempty `target_type`) before installation-wide restriction,
and a closed repository-event shape before repository-wide restriction.
Unknown shapes fail closed and require operator/source reconciliation; no raw body
is retained. Schema-valid nullable accounts, optional repository and enterprise
context remain supported. Tests exercise both confusion paths and legitimate shapes.

Lifecycle actions must be literal strings before any suppression is attempted.
Arrays and nested arrays cannot stand in for `deleted`, `suspend`, `privatized`
or `transferred`; malformed and missing actions retain `unsupported_action` (422).
The signed installation's `repository_selection` must likewise be the literal
string `all` or `selected`, otherwise admission returns `invalid_payload` (400).
HMAC validation still happens first. Rejected shapes invoke neither delivery
insertion nor lifecycle suppression, and valid scalar events preserve their
approved scope, restriction reason and duplicate/conflict acknowledgement.
The synthetic signed-request regressions exercise the actual handler; they do
not establish a real installation, observed GitHub schema drift or live access.

Repository transfer is handled conservatively for an already-approved installation
and repository. GitHub delivers this event to the new owner's installation; this
alone does not guarantee old-installation removal. Installation removal events and
scheduled access reconciliation remain necessary.

Schema references reviewed:
- https://docs.github.com/en/webhooks/webhook-events-and-payloads#repository
- https://github.com/octokit/openapi-webhooks/blob/main/packages/openapi-webhooks-types/types.d.ts

Independent review found and corrected compatibility gaps in the initial guard.
Final dedicated ingestion verification: 71 passed, four real-PostgreSQL tests skipped.
No remote branch, App configuration or publication changed.
