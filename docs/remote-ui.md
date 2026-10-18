# API-backed public UI

The web entry point defaults to public API mode. Set the non-secret build variable `VITE_PUBLIC_API_BASE` to an approved API base URL/path, or use the default same-origin `/api/v1`. The development Vite server proxies that default path to `127.0.0.1:3001`. Production hosting must supply its own reviewed reverse proxy/routing; Vite development proxy configuration is not a public deployment.

`?ui=prototype` explicitly selects the existing synthetic design prototype. `?ui=api` explicitly selects the API UI. The browser remembers that explicit choice in `pyai.ui.mode`; `VITE_UI_MODE=prototype` can explicitly select a prototype build. The prototype retains its persistent synthetic notice and separate fixture routes. Its code is dynamically loaded only after selection. Missing configuration, network errors, invalid responses and unavailable source coverage in API mode never select fixtures.

## Actual read paths

The API UI reads `/metrics`, `/boards`, `/contributors`, `/contributors/:stableActorId`, `/evidence/:contributionId` and `/health`. The metric directory and methodology use returned definitions; board/profile values, qualifications, roles, evidence and safe source/revision links come from the API. Published policy signatures and numerator/denominator/sample/censor/readiness/p75 diagnostics are shown when supplied. A registry definition is not treated as enablement. The browser never computes a cross-metric score, infers an execution mode or fills an unknown value with zero.

Board order, dense tie ranks and descriptive `rank:false` values are rendered exactly as supplied. The contributor directory uses the dedicated organization-scoped `/contributors` endpoint with optional search and category filters, bounded pagination and signed cursors. Profiles use the portfolio endpoint independently of a selected board metric. The activity page remains limited to the selected measure's returned page and evidence IDs; no raw event-stream completeness is claimed. Project routes request the exact workstream ID and selected measure; no project display name or history is invented. Unsupported workflows remain visibly unavailable.

Scope uses one `organization`, `repository`, `workstream`, paired canonical UTC `start`/`end`, `snapshot`, `metric`, `limit` and signed `cursor`. Defaults request the publisher's explicitly materialized all-time scope; no rolling window or overlapping aggregation is guessed. Duplicate, unknown, malformed and unsupported filters are rejected before reading. Metadata must match the requested scope/pin and registry version. Navigating from a board to a profile or evidence pins the displayed snapshot, even when the public head advances. Cursor continuation preserves scope, limit and snapshot.

JSON and CSV downloads request the actual exports endpoint with the displayed snapshot, exact scope, measure, limit and current cursor. They are bounded current-page exports, not organization-wide dumps. Export errors remove the visible data and show an error. Private correction or account content is never included.

## Current controls and updates

Every displayed selection, including a historic pin, is revalidated every 20 seconds while visible, on window focus, and through the explicit recheck button. Same-selection background success preserves keyed DOM and keyboard focus. A suppression/removal response replaces the affected output; a revoked/expired selection, backend error or invalid response clears the old output immediately. Hiding the document clears its personal data and aborts pending reads; returning starts a current check. The browser keeps no response cache or stale-if-error fallback. This is a client revalidation interval, not a claim of instantaneous privacy propagation before a response arrives.

New publication heads remain held until explicitly applied. Optional follow mode waits while either pointer or keyboard focus remains in the evidence region; reduced motion disables automatic following. Applying an update fetches the whole selected snapshot. The UI uses bounded read polling; it does not claim to stream per-event deltas or infer live webhook health. Health labels distinguish recently reconciled from stale/degraded, and unknown lag remains unknown.

Requests omit credentials, reject redirects, impose an eight-second deadline and cap decoded bodies at two megabytes. Responses are checked against the leaderboard contracts and exact selection. Text is rendered as escaped React content; source links allow only bounded public GitHub HTTPS artifact/revision URLs. API bases are public configuration, never credentials. Cross-origin HTTPS bases need the hosting/API's separately approved CORS policy; same-origin routing is the default.

If `VITE_PUBLIC_CONTROLS_BASE` is explicitly configured, the corrections page links to that endpoint's supported `/auth/login` entry. The separate same-origin `/account` and `/admin` UI uses authenticated `/controls/*` routes, never the public API base. See [protected controls UI](protected-controls-ui.md) for implemented flows and remaining gates. A configured link does not certify staffing, approval, storage or a working deployment.

## Reproducible evidence

```sh
npm ci
npm run build
npm run test:browser -- --grep 'real service|current suppression|descriptive policy|new heads|successful same-selection|page exports'
```

The new Playwright tests intercept browser HTTP requests with the actual built Fastify service handler backed by explicitly synthetic source inputs. They exercise its query validation, public projection, signed cursors and error behavior. The pinned board → profile → evidence journey advances the publisher head before opening evidence, asserts the original snapshot and exact scope on actual requests, then verifies current suppression invalidates historical evidence without fixture fallback. Other checks cover dense ties, unranked descriptive values, held updates, safe unavailable states, narrow dark/reduced-motion rendering and axe on API-backed reference routes. They complement the separately explicit prototype matrix; no real account, source grant, production hosting or participant/screen-reader acceptance is established by synthetic tests.
