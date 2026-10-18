# Authentication expiry job

Refs #95. `infra/retention/controls-expiry.mjs` removes expired controls sessions and
OAuth handshakes using their existing absolute authentication deadlines. It does
not invent new retention intervals. A protected host calls
`expireControlsAuthentication(store, {receiptId, cutoff, authorize})`; authorization
must return exactly `true`, and a future cutoff is rejected. No scheduler, public
endpoint, credentials or production policy is installed.

Deletion and the minimized receipt commit together through the existing SQLite
transaction. Receipts contain only operation identity, cutoff and counts, never
session IDs, CSRF values, OAuth verifiers or actor identities. Repeating a receipt
ID with the same cutoff returns the original receipt; changing its cutoff fails.
Records refreshed while host authorization is pending are rechecked inside the
transaction. Invalid or missing expiry is unknown and does not authorize deletion.
The public projection, suppression state, evidence, configuration and audit history
remain unchanged. The receipt registry is capped at 10,000 operations and fails
closed when full; archival requires a separately reviewed operator procedure.

Five synthetic tests verify expiry boundaries, no public changes, idempotency,
authorization denial, future-cutoff rejection, concurrent refresh and transactional
rollback, reserved property names and invalid clocks. The root Node test command includes the retention tests.

This is one retention component. Source facts, raw/derived evidence, frozen policy
inputs, comparisons, editorial records, private audit logs, backups and external
search/CDN copies still require accepted retention windows and coordinated purge
and tombstone procedures. The existing authenticated backup-expiry module is
separate. PostgreSQL and SQLite are not a shared transaction; this job does not
claim cross-store privacy deletion, operating ownership or release acceptance.
