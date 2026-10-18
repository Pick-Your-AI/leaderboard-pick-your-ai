# API-backed contribution proof

Partial implementation evidence for [#116](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/116), not issue closure or public-release authorization.

## Behavior

Board proof links open an API-backed evidence panel without leaving the selected board. The URL carries `proof`, the displayed snapshot and the exact organization/repository/workstream/time selection, metric, page size and cursor. Back, Forward, Close and Escape preserve that board page. A copied drawer URL requires a snapshot; an unpinned or non-board drawer request fails validation rather than choosing a different publication. “Open as a full page” opens the permanent contribution route with the same snapshot and source scope, dropping only board pagination and drawer state.

`remote/proof.ts` reads and validates the same evidence endpoint for both surfaces. `remote/Evidence.tsx` uses one `EvidenceProof` renderer for both permitted evidence projections. It does not import the prototype, raw provider payloads, private audit logs or fixtures. Unknown and unsupported facts remain explicit. React text nodes render supplied reason codes and identifiers literally. Public source and revision links use the existing restricted public-link validator.

At 1024 CSS pixels and wider, the panel is a non-modal dialog. Below 1024 pixels it is a full-height modal dialog, rendered outside the inert application background, with document scrolling held and keyboard focus contained. The media-query listener changes these semantics on resize. Focus enters the panel heading; dismissal restores the originating proof link when still present, otherwise the stable page heading. Back from a permanent proof route can reconstruct and restore the equivalent opener link. The close control remains mounted when a privacy check removes the proof.

A drawer always uses its opening snapshot. Publication following and “Apply new snapshot” cannot replace an open proof. The existing 20-second visible-page, window-focus and visibility rechecks also revalidate the drawer. A manual permission recheck is available inside the modal. Hiding the page clears the displayed proof until a fresh read. Failed evidence reads, suppressed actors/artifacts and revoked snapshots remove the old proof, including under a historical pin; they never substitute stored evidence. API responses are not stored in browser history.

## Contract limits and remaining acceptance

The optional strict [`leaderboard-evidence/v1` metadata projection](public-evidence-metadata.md) supplies bounded as-collected titles, credited-fact actions, separate source/collection clocks, receipt-qualified acceptance time, and explicitly public partial revision/correction records. Legacy or unprovided data remains visibly unknown. It does not equate eligibility, collection or snapshot publication with acceptance, and does not say that missing correction history means “none.” Generated/imported/reverted exclusions are explained only to the extent the API supplies qualification/reason codes.

The default hydration adapter does not invent historic titles or public revision/correction records. Real-source verification, permitted public history/receipt provenance, two representative assistive-technology walkthroughs, real mobile-device interaction and participant/owner acceptance remain open. This change does not alter publication, privacy or acceptance policies. No issue is claimed closed.

## Reproducible checks

- `apps/web/test/proof-client.test.mjs`: pinned scope/cursor URLs, bounded proof selection, separation of UI query state from API/permanent links, and drawer-only history transitions.
- `apps/web/browser/evidence-drawer.spec.ts`: real Fastify handler with synthetic provider input; identical drawer/permanent proof; scope and cursor continuity; held heads; 320px keyboard, modal/inert, focus restoration, resize and axe checks; Close/Back/Forward; focused proof withdrawal for actor/artifact suppression, revocation and provider failure; hostile literal text; unknown fields; and unavailable-source deep links.
- `apps/web/browser/remote.spec.ts`: existing permanent-route, current privacy, pinned navigation, directory and export regressions.

Run the documented repository toolchain (`npm run build`, `npm run typecheck`, `npm test`, `npm run test:browser`) and planning validation. Synthetic checks are not a deployed-source or accessibility acceptance record. Browser execution status must be reported separately from successful browser test compilation.
