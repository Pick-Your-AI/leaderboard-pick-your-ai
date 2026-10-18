# Bounded public response lifecycle

Refs #108, #118 and #129. The connected browser client's shared `request` path
serves public boards, profiles, contribution evidence and registry requests. Public
JSON/CSV downloads use the same reader and cancellation boundary.
It now releases response readers after successful, interrupted and rejected
reads. An invalid response media type is discarded before consumption; a
misleading media-type parameter does not count as JSON. Invalid UTF-8 is rejected
instead of silently replacing bytes in evidence text.

The existing 2,000,000-byte decoded body limit and eight-second request deadline
remain. An unsupported advertised content length is rejected before reading,
and actual decoded bytes remain bounded when that header is absent or false.
Aborting a superseded selection cancels the active body reader and discards
late headers. Cleanup never waits for an underlying cancellation hook to settle.
The client continues to omit credentials, reject redirects, and expose only
controlled server error codes.

The synthetic regression suite in
[`response-lifecycle.test.mjs`](../apps/web/test/response-lifecycle.test.mjs)
covers advertised and actual byte limits, exact-limit success, split and invalid
UTF-8, media types, syntax and stream failures, cancellation before and after
headers, stalled cancellation, reader release, error-body minimization, and export
media-type, actor-scope and UTF-8 integrity.
This is client resource and failure-behavior evidence; it does not establish
deployed load capacity, accessibility acceptance, source authorization or public
release readiness.
