# Visual-system receiving decision (#56)

## Accepted scope — 2026-10-18

Accept the version 1 local visual system for [LB 13.03 / #56](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/56): the existing brand tokens, system typography, semantic components, theme preferences and tested responsive journeys. This is a scoped engineering receiving decision under the project's delegated implementation authority. It does not represent an additional GitHub identity, a participant session or a named external owner's signoff.

The receiving review read the complete token/theme implementation, shared layout, rank table, scope, receipt and status components, application stylesheet, public API visual/proof components, relevant navigation inputs, all native-zoom/contrast cases and the public-route matrix. It also read the pinned website design sources, canonical source reviews and the actual hosted log/report. The reviewer directly inspected all 24 native-zoom viewport captures, all six contrast captures and the two complete 320px light/dark board captures.

### Decisions for this version

- Keep the existing system sans stack for text and system monospace/tabular numerals for measurements and IDs. No custom font is bundled or requested. Instrument Serif remains an optional future proposal; adopting it still requires the recorded license, self-hosted subset, fallback and layout-shift evidence. The current version's font choice is settled without adopting that proposal.
- Keep optional ASCII artwork absent. The [website #32](https://github.com/Pick-Your-AI/pickyour.ai/issues/32) and [#33](https://github.com/Pick-Your-AI/pickyour.ai/issues/33) proposals were still open at this review. Their existing ownership, local-only scope and status are preserved. Their code is not a dependency. Any future integration retains the [bounded, decorative, pausable and reduced-motion requirements](UI.md#design-system).
- Keep the versioned local token update process: update values and their website source SHA together, then verify contrast. Runtime styling never imports the website stylesheet.

## Literal criterion disposition

| #56 requirement | Receiving evidence and disposition |
| --- | --- |
| Teal, slate and amber brand with intentional typography | [Version 1 tokens](../apps/web/src/styles/tokens.css) record website revision `c731bc451d227eac843750418b6de3c3377ea90b`; the primary [design source](https://github.com/Pick-Your-AI/pickyour.ai/blob/c731bc451d227eac843750418b6de3c3377ea90b/docs/DESIGN_SYSTEM.md) and [stylesheet](https://github.com/Pick-Your-AI/pickyour.ai/blob/c731bc451d227eac843750418b6de3c3377ea90b/src/styles/index.css) support the adapted palette and system typography. Accepted. |
| Accessible rank tables, evidence rows, chips and health indicators | [BoardTable](../apps/web/src/components/BoardTable.tsx), [Receipt](../apps/web/src/components/Receipt.tsx), [status components](../apps/web/src/components/status.tsx) and [catalog chips](../apps/web/src/routes/Overview.tsx) retain captions, row/column relationships, units, native controls, textual state and keyboard semantics. Reviewed source, actual route/axe checks and visual observations support this design-system criterion. |
| Light, dark, system and high-contrast needs | The effective-theme selector correction is delivered. Six actual preference/system combinations retain readable text when increased contrast is requested; forced-color journeys retain visible text, controls and focus. Accepted within the tested browser scope. |
| Coordinate optional ASCII proposals | The explicit empty-artwork decision above preserves the existing website proposals and their future integration requirements without importing or modifying that work. Accepted for this version. |
| Versioned token provenance, optional font checks and empty decorative artwork | Local tokens record their version/source and update process. No optional font or artwork is adopted. Their conditional future-adoption requirements remain intact; they are not missing dependencies of this version. |
| Color and icon never carry meaning without text | Evidence, freshness, coverage, loading/error and ranking states retain words; decorative glyphs are hidden from accessibility output. Chips retain textual labels and pressed semantics. Actual light/dark/forced-color captures preserve these meanings. Accepted. |
| 320px layout and 200%/400% zoom preserve content and controls | The actual 31-route matrix passed at five widths in both themes. Native zoom exercised exact-scope submission, snapshot selection and proof navigation/focus at both factors in three media modes. All 26 responsive/zoom captures were visually reviewed; controls remain visible and content reflows or remains reachable by normal vertical scrolling. |
| Fonts blocked, artwork disabled and remote styling isolated | Native-zoom font interception was installed and recorded zero font requests, consistent with the system-font-only source. Artwork is absent. The entrypoint imports local CSS; no remote font/stylesheet is loaded. Source revision and static checks prevent silent website styling changes from entering this build. Accepted. |

## Exact receiving evidence

The original components were delivered in [#136](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/136). The final eight native-zoom/contrast source paths from [#229](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/229), head `1e22cdddf4ff5770cd5ee83e397ed4a00e754852`, were delivered unchanged through [#235](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/235), signed main `e46eb21758029566359c3ab4bc3d033c85e63960`.

The independently inspected [browser run 39115629852, job 117640721036](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/actions/runs/39115629852/job/117640721036) checked out `4059196cf7076cf8fc5e29fee19f295336399883`. Its exact tree `25026344acc398e76f5a9930af1a18a622c6ac5f` became signed receiving main `5f2f86c0c9b53ab996c15281968da29c195d4ae6` through [#230](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/230). The hosted report records **108 passed**, zero failures, retries or skipped cases, including ten width/theme groups with 31 route checks each. This is actual hosted execution; the review did not rerun or relabel the earlier Chrome 155 local evidence.

The [synthetic-browser-evidence artifact metadata](https://api.github.com/repos/Pick-Your-AI/pick-your-ai-leaderboard/actions/artifacts/12132158000) identifies archive `12132158000`, 12,862,870 bytes, SHA-256 `5f985eba56b7ce634185978a54b189d020ff36d9287a0bcc7cb2ad8343793723`. Its downloaded bytes matched that digest before inspection. The workflow retains artifacts for seven days; this dated source, hash and review record identifies the evidence independently of later artifact expiry.

| Actual observation | Retained result |
| --- | --- |
| Browser | Chrome for Testing `156.0.8078.4`, repository-pinned Playwright Chromium revision 1248 |
| 200% native zoom | Automatic per-origin 2× zoom; 640×436 CSS viewport; device-pixel ratio 2 |
| 400% native zoom | Automatic per-origin approximately 4× zoom; 320×218 CSS viewport; device-pixel ratio 4 |
| Other scaling | Root/body CSS zoom 1 and visual viewport scale 1 in every recorded media mode |
| Native viewport captures | 24 actual visible-surface PNGs, each 1280×873 device pixels; layout-height rounding is within the harness's explicit pixel tolerance |
| Contrast matrix | Six combinations, 36 text/surface pairs each; no decreases. Minimum ordinary light contrast 4.996:1, increased light 6.472:1 and dark 5.705:1 |
| 320px visual observations | Complete light and dark prototype boards, 320×2942 pixels; labels, controls, ranked/pending separation and footer content remain visible |

The two `native-zoom-observations.json` files have these SHA-256s: 200% `57b2d67455e6e985ca058b96e2e25f3b18d2ea9262a26e81b79ca6949c4bdae8`; 400% `17c76beb11aef7621e060bc6cc66ea8e0904b0fdb06396fbe97eca789a94b2da`. The 400% closed native snapshot select abbreviates redundant trailing status text while retaining the complete stable snapshot ID, selection operation and separate status notice. The captures show the reader's current scroll position; they do not imply that an entire proof fits into one viewport.

At accepted main `bedd7956fd58e445a8c931ffe971193cc2d52f35`, the complete `apps/web` tree remains `257e2ac587e0fc55e39212afbc0cf276ee774f92`, byte-identical to the inspected receiving execution. Subsequent accepted changes to that point concern the controls server and governance/release documents, not these browser inputs.

## Prerequisites and remaining gates

[#52](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/52)'s canonical routes, scope/snapshot controls and proof navigation are usable inputs for this visual-system decision, evidenced by the exercised journeys. Its native dependency relationship is preserved; this record does not close its broader navigation/discovery acceptance or alter #47/#38.

This accepts #56's scoped visual-system work. It does not certify full WCAG conformance, a production visual baseline, real contributor data or a public deployment. [#61](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/61)'s actual device walkthroughs, [#71](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/71)'s participant sessions and [#128](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/128)'s wider screen-reader/device/manual/protected-route acceptance remain separate. GitHub Assignees, native relationships and other receiving-owner requirements are unchanged.
