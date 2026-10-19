# Persisted review identity migration

This is the persistence counterpart to [review source identity validation](review-source-identity.md), contributing to [LB-07.04 / #67](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/67). The evidence below is synthetic local implementation evidence. It does not establish production source coverage, accepted review outcomes, or the work package's complete acceptance gate.

## Cache and publication behavior

The pipeline wraps the existing normalization signature with `review-source-identity/v1` only for retained source rows whose family is `reviews`. The resulting document also records that version. Older normalization rows remain available for audit and retain their original hashes; replaying an unchanged review source observation creates a separate normalization under the corrected semantics. The review wrapper applies only to reviews. The separate [default-delivery migration](default-delivery-cache-migration.md) can wrap an affected source signature, including a review with enriched physical-change facts; unrelated issue-only caches retain their existing signatures.

The built-in GitHub normalizer exports the version it implements. Hosts supplying either `normalizer` or `githubEnrich` must explicitly provide the same `reviewSourceNormalizationVersion` pipeline option. An enrichment callback can supply a complete observation without traversing the built-in REST cohort checks, so it is also a custom review provider. The assertion makes the host responsible for the versioned source semantics; a pipeline option is not independent source verification. An unasserted custom provider cannot populate or reuse a versioned review cache.

Any newly materialized publication containing review sources binds the version into its content identity and private confirmation. Its private inputs bind exact normalization source pairs, including sources which produced no eligible review credit. These private fields are not added to public boards or exports.

## Retained authority

Both the actual selected snapshot and the confirmed current head must qualify before a public read succeeds. Current and pinned boards, JSON exports, CSV exports, and other consumers of the same source reader share the check. It validates the exact private aggregate explanation, its source binding, the retained normalization documents, and the matching frozen input hash, scope, dataset, cutoff, backfill revision, configuration, and source identities.

An old public confirmation cannot upgrade an old review document. A missing, obsolete, or inconsistent review dependency withholds the publication. A valid newer head does not restore an obsolete historical pin, and a valid historical selection cannot bypass an invalid current head. Review normalization hashes remain eligible for private identity restoration only when their actual source family and version agree; the same rule applies to retained policy comparisons and aggregate explanations. A dispatch retry cannot acknowledge a previously committed publication with obsolete review authority or repoint the current head to it. A fresh verified publication and newly processed dispatch can recover normally.

Applicability comes from retained source observations, rather than a public flag. A public view with no review observation in its admitted repository/cutoff scope preserves the earlier frozen-read behavior, including when unrelated normalization dependencies are no longer available. Hash-only legacy inputs still require their bound hashes to resolve; any matching review dependency must meet the new version. An entirely unbound legacy private input cannot disambiguate review sources or prove the absence of enriched default-delivery facts. The combined private-input authorization boundary rejects such captures and requires replay/recapture. New review captures bind exact source pairs and do not acquire this ambiguity.

These reads keep the existing repository access locks, approval checks, privacy overlays, confirmed-head fence, and permanent retirement rules. Supported source-fact erasure requires a nonpublic repository under a conflicting access lock and the retirement fences; erasure therefore cannot make a review publication appear unrelated while the public reader still holds valid source authority. No source facts, old snapshots, or old normalizations are deleted by this migration.

## Local regression evidence

`apps/pipeline/test/review-cache-migration.test.mjs` creates real disposable PGlite and SQLite databases and closes/reopens both. It reconstructs integrity-valid pre-upgrade normalization and private authority records, then checks:

- Exact, hash-only, and unbound legacy review inputs are unavailable through current/pinned boards, JSON/CSV, private comparison inputs, and aggregate explanations. A version flag on the confirmation alone does not restore them.
- The unchanged retained source observation is hydrated under the new generation. An inconsistent cohort retains raw feedback while losing first-participation and head-round credit. Corrected newly observed source evidence restores valid credit, while the obsolete pin and old cache rows retain their original identity.
- Unrelated nonreview cache signatures, public responses, and private policy comparisons survive restart unchanged. Earlier nonreview public reads remain available after normalization dependencies are removed or a later review observation arrives.
- Custom normalizer and enrichment providers are denied before invocation without their explicit version assertion, then can supply their asserted semantics.
- A selected historical review snapshot binds its own frozen input; corrupting its scope, dataset, cutoff, backfill revision, source generation, or exact normalization source cannot be hidden behind a valid head. Corrupting the head also withholds a valid historical selection.
- A dispatch interrupted after publication cannot acknowledge legacy review authority after restart. A fresh verified publication and dispatch recover without exposing the obsolete pin.

Run the migration regression with:

```sh
node apps/pipeline/test/review-cache-migration.test.mjs
```

The package's standard test glob also includes this file. The adapter regression in `packages/github/test/review-cohort-identity.test.mjs` separately exercises exact parent/target identity, conflicting cohort actor and review identities, mutable optional-link fingerprints, and source recovery.
