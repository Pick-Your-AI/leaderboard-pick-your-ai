# Required private aggregate explanations

Refs [#83](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/83), with the confirmation boundary of [#62](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/62). This is executable synthetic implementation evidence, not a source-capability approval, production retention promise, deployment or affected-owner acceptance.

## Required publication dependency

Every confirmed pipeline snapshot has a `private-aggregate-explanation/v1` record in the private controls database. `AggregateExplanationStore` is independent of the optional policy-preview tables, their eight-input capacity, candidate/version registries and seven-day expiry. Required capture and readback happen inside the same synchronous SQLite transaction as the publication confirmation marker. The marker binds the explanation's canonical SHA-256 digest. Failed, ignored or corrupted writes roll back the marker and all private capture writes. PostgreSQL can retain an unconfirmed candidate; that candidate cannot become publicly available. The confirmed-head authority preserves a prior valid publication when a later confirmation fails.

Public reads validate the required explanation of both the selected snapshot and current head. An absent or corrupt record fails closed. Dispatch confirmation/replay also verifies the required record. Exact input reconstruction for an unconfirmed dispatch remains bound by its publication receipt; replay cannot invent a missing explanation from a different input. An existing explanation is immutable: an otherwise content-identical retry can reuse it only if its arithmetic, reasons and fact references still agree. It does not refresh retention or replace the original cutoff/input hash.

## Minimal, versioned arithmetic

The required record binds snapshot ID/revision, public scope key, canonical engine scope, approved configuration hash, source generations, input hash, dataset/backfill identity, cutoff, snapshot computation version and the explicit arithmetic/explanation implementation version. Each independent metric records policy version/hash, definition version, unit, aggregation, date basis, evidence class, sample threshold and ranking eligibility.

Rows retain only the information needed to reconcile arithmetic:

- Count: exact eligible fact IDs, selected revisions and fact hashes; count equals cardinality
- Sum: each eligible quantity, including an explicit missing quantity; finite nonnegative safe-integer sums
- Ratio: decided eligible IDs and outcomes, numerator, denominator and sample count; pending remains separate
- Duration: each eligible ID's measured hours or missing-readiness, invalid-chronology or censored status; sorted samples, n, median and nearest-rank p75
- Pending: distinct prepared fact IDs and count, disjoint from ranked/decided evidence
- Rank: dense ordering from the metric's value alone, with shared ties; diagnostic metrics remain unranked

Every input fact ID for a selected metric must appear in the inclusion/exclusion audit. Valid nonselected observed/qualified/reviewed classes explicitly receive `evidence_class_not_ranked`; observations after the frozen cutoff and unknown ratio outcomes are also accounted for. Canonical duplicates and repeated units retain their existing reasons. Older revisions of the same fact do not become additional earned units. Stable IDs and minimal actor/artifact/repository references allow current privacy enforcement without retaining source payloads.

The record does not retain raw payloads, emails, actor logins, source URLs, classification receipts, acceptance/correction receipt strings, credentials or complete normalized inputs. The input and selected-fact digests bind those upstream inputs without copying them. The arithmetic implementation version must change when interpretation changes; stored explanations are not silently reinterpreted by preview recalculation.

## Private access and lifecycle

`runtime.aggregateExplanations.read(snapshotId)` is a privileged in-process host operation. It is not mounted on a public HTTP route, and deployment must restrict privileged host/database access. It verifies the retained SQL snapshot, current configuration approval, source generations, current controls and required digest. Repository revocation, actor/artifact suppression, disabled metrics, changed configuration or a later correction withholds the entire stale explanation, including IDs and hashes. A fresh calculation can explain an already effective reviewed correction using only an artifact/hash binding; a future-cutoff or unreviewed correction cannot authorize disclosure.

Public boards, contributor/evidence/exports and `/controls/public` never serialize this private explanation, its audit or digest. Current public privacy projection still applies independently to historical snapshot reads.

Required explanations follow the retained snapshots, with no preview TTL and no expiry extension on replay. The current runtime has no snapshot-retirement operation or approved production retention schedule. A future authorized retirement path must remove the corresponding required record and private confirmation authority along with the snapshot; backup/deletion controls remain deployment work. The private reader denies any explanation whose SQL snapshot is no longer retained. No automatic eviction is introduced.

Local per-snapshot bounds are 50,000 input facts and 16 MiB of serialized explanation. Exceeding either bound fails publication confirmation; it never falls back to optional previews or truncates reasons/evidence. Total retained-storage capacity and production limits still require operational review. Storage exhaustion is a failed required write, with the same fail-closed behavior.

## Verification

`apps/pipeline/test/aggregate-explanations.test.mjs` exercises the real pipeline, SQL storage, SQLite confirmation, metric engine and public read boundary with synthetic inputs. It covers 14 accepted plus 3 pending below a 15-accepted rank, eligible sums and duplicate exclusion, decided ratios, duration samples/censoring, exact ID conservation, restart and replay, optional preview exhaustion/expiry, required write/ignored-write/readback/confirmation failures, missing/tampered records, current privacy/source/configuration/correction revocation, fresh post-correction review, canonical multi-repository scopes, and explicit size bounds. Engine tests cover nonselected classes, future observations and unknown ratio outcomes.

The source normalizer remains responsible for proving the input quantities, timestamps, identities and acceptance. Passing these tests does not certify real GitHub history, reviewed source capabilities, production PostgreSQL/multi-host recovery, policy approval, operational retention or external acceptance gates.
