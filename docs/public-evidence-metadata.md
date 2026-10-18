# Versioned public evidence metadata

Partial executable evidence for [#116](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/116) and [#121](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/121). This does not close either accessible-journey gate or authorize public release.

## Producer and trust boundary

`PublicEvidence.evidenceMetadata` is an optional, strict `leaderboard-evidence/v1` projection. Legacy evidence remains readable with explicitly unknown title, action, collection and acceptance data. Both the service projector and API client validate the same schema; unknown object keys, unsafe record URLs, contradictory acceptance and malformed clocks fail closed. A metadata object is bounded to 8 KiB of serialized UTF-8. Export contracts remain minimized and do not gain the new metadata.

The GitHub normalizer takes only actual source title/name fields, normalizes whitespace/control and directional formatting characters and limits the label to 200 UTF-16 code units. It does not take commit messages, bodies, comments or arbitrary payload strings as titles. The title carries `basis: as_collected` and its collection time. A later recollection can update the selected label deterministically without claiming it was the title at the historical event. Equal-time conflicting metadata fails closed. React renders labels literally, without HTML or Markdown interpretation.

`sourceAction` identifies the actual credited fact. A PR snapshot can independently produce `artifact_created` and `pull_request_merged`; its envelope action is not copied onto every fact. First-readiness/review facts require the existing milestone proof. Metadata/field transitions keep their validated exact action, and unsupported or unproved actions remain `unknown`. The contract is descriptive, not an additional metric policy or quality claim.

`sourceOccurredAt` preserves the source clock separately from the existing evidence-period clock. `observedAt` retains the fact's collection clock, never a title, publication or ingestion-time replacement. `acceptedAt` is exposed only for a qualified/reviewed fact with an independently validated receipt, a distinct reviewer and an actual acceptance time. The public action is then `recognition_accepted`. The materializer rechecks the selected fact rather than trusting a prefilled metadata clock. Observed closed-unmerged and merged PR ratio decisions have an internal decision clock named `acceptedAt`; that internal name never authorizes a public acceptance time. Private receipt IDs, reviewer IDs and supporting private evidence IDs are not serialized into this projection. Recognition reason codes no longer include the private receipt identifier.

## Revision and correction records

Existing source revision and URL fields remain separate. A commit's current source revision link is populated only when the observed immutable SHA matches the verified source revision. Other links are not reconstructed from a timestamp or current PR head.

A protected normalizer enrichment can supply `publicHistory: { approvedPublic: true, history }` only after verifying each record is public and appropriate for this artifact. Each strict minimized record contains its kind (`source_revision` or `correction`), public GitHub URL, nullable actual record time, and a revision identifier for source revisions. No reviewer narrative, before/after body, private request, correction receipt or actor email is supported. Source payload history fields and the private corrections table are not public history inputs.

Coverage is either `not_supplied` with an empty list, or `partial` with 1–20 explicit public records, also subject to the byte budget. Version 1 deliberately cannot claim complete history or an empty history proving that no correction occurred. Recollection does not construct a history by comparing titles, source revisions or snapshot heads. The default REST hydration adapter has no public history reader and therefore supplies `not_supplied`; an authorized enrichment must provide real records before they appear.

## Surfaces and privacy

Drawer, permanent contribution route and activity proof detail use the same `Receipt` component. The activity response advertises `correctionHistory: per_proof`, meaning bounded records and coverage on each proof, not a complete correction-event feed or extra counted contribution. The new client also accepts the previous `not_supplied` envelope for legacy servers. Deploy API and UI together; the earlier strict client does not recognize `per_proof`.

Existing exact scopes, metric/category authorization, pins, signed cursors, current actor/artifact suppression and snapshot revocation are unchanged. The new metadata travels only with evidence that passes those controls. A pinned old snapshot cannot recover a withdrawn label or history link. Activity byte-bounded pagination still applies.

## Checks and remaining acceptance

- Normalizer tests distinguish multiple credited facts from one snapshot, bounded hostile labels, source/collection clocks, raw decision versus receipt acceptance, and explicit public histories versus payload/private fields.
- Lightweight pipeline tests connect real normalization and materialization to Fastify evidence and activity detail, check strict schema/privacy rejection and deterministic recollection.
- The existing PGlite actual transport → collection → normalization → metrics → publication → API replay test also asserts title/action/clocks/history metadata.
- API-client tests reject malformed/private fields and inconsistent state. A static-render test exercises the actual shared TSX component and verifies escaping, clock distinctions and legacy unknown states without requiring a browser. Browser regressions compare the same rendered metadata across drawer, permanent route and activity detail at 320px, test literal hostile text and current suppression. Browser compilation is distinct from browser execution.

Still required: deployed real-source canaries and public history/receipt provenance, permitted retention/rights review, genuine source revision/correction reconciliation where those records exist, accepted grouping policy, two representative assistive-technology walkthroughs, real mobile-device interaction, and affected-owner acceptance. Complete correction-event chronology, historical event-time titles and unavailable historic fields are not implemented or inferred. No scope baseline, enabled metric, approval, upstream source state or deployment authorization changes here.
