# Native Discussion answer chronology

This source qualification contributes to [LB-10.01 / #46](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/46). It does not enable Discussions, establish installed-App permissions, accept moderated support evidence, or complete the source-capability and helpful-feedback gates.

## Source clocks and attribution

The [GitHub GraphQL Discussion reference](https://docs.github.com/en/graphql/reference/discussions) defines creation times on both a Discussion and its answer comment. Native answer selection and its selector are separate, nullable fields. The collector and hydration query request the answer's own `createdAt`, and `githubDiscussionRevision` binds that value alongside the answer identity, author, selection and other existing source fields. A changed creation clock cannot reuse an old collection revision.

The project qualifies current native answer credit only when the source establishes this complete chronology:

```text
Discussion createdAt <= answer createdAt <= answerChosenAt <= source observedAt
```

This inequality is a project evidence rule, not an ordering constraint declared by GitHub's schema. Equal boundaries are valid. All four clocks retain the existing native normalizer profile: calendar-valid UTC `Z` instants with at most millisecond precision. The source observation is immutable; a later engine cutoff does not repair a selection after that observation.

An absent or malformed creation/selection clock produces `discussion_answer_time_unverified` without an answer fact. A known contradiction produces `discussion_answer_chronology_invalid` without an answer fact. An unverified selection retains its existing selection reason. Creation, update and observation times are never substituted for an unknown answer or selection clock. An independently valid Discussion creation can still produce its own raw observation.

A known answer author remains the credited author even when the selector is unavailable; `acceptedBy` remains null. A known selector cannot supply a missing author. An unknown author retains the existing unknown-actor result and does not become the selector. Native selection does not infer effort, answer quality, a moderated-support decision or helpful-feedback acceptance. Disabled or unavailable Discussion capability retains the existing unavailable-source behavior.

## Cached and retained authority

The pipeline uses the exported `discussionSourceNormalizationVersion`, currently `discussion-answer-chronology/v1`, as a separate immutable normalization generation only for source rows in the `discussions` family. Its normalization document carries the same version. Replaying an unchanged retained source observation hydrates it under that generation; old cache rows and their hashes remain available for audit. If the hydrated revision no longer matches the retained source, the new generation cannot claim the changed answer as historical evidence. A newly collected, matching source observation can recover normally.

Hosts supplying a custom `normalizer` or `githubEnrich` must explicitly assert that same pipeline option before any Discussion cache reuse or provider invocation. This is the host's source-semantics assertion, not independent verification of its callback. The built-in provider exports its implemented version. Other source families keep their own generations, including the separate [review identity migration](review-cache-migration.md).

New publications containing Discussion sources bind the version into content identity and private confirmation. Private input identity binds exact normalization source pairs, including observations that yield no eligible answer credit. These private fields are not exposed on public boards or JSON/CSV exports.

The shared public reader validates both the selected snapshot and the confirmed current head against actual source observations, retained normalization documents, their matching private explanation, and the frozen input's hash, scope, dataset, cutoff, backfill revision, configuration and source identities. A marker on the public confirmation cannot promote an old normalization. A valid head cannot restore an obsolete historical pin; an invalid head cannot authorize a valid historical selection.

The same source-generation check protects private policy inputs and aggregate explanations, and prevents an interrupted dispatch from acknowledging or restoring an obsolete committed publication. A verified new publication and newly processed dispatch can recover without rewriting the old source, normalization or snapshot.

Public applicability is limited to actual retained Discussion observations in the admitted repository/cutoff scope. Hash-only legacy input must resolve its actual bound hashes. An entirely unbound private input cannot disambiguate source families; its privileged authorization interface has no bound cutoff, so any retained Discussion observation in its source repositories makes that old private input unavailable. Existing access locks, source approval, privacy projection and retirement fences remain in force. The migration does not erase retained evidence or extend source authorization.

## Synthetic regression coverage

The source tests cover ordered and equal clocks, each missing/malformed clock, known inversions and future selection, separate author/selector behavior, revision changes, and both collection and hydration queries. The persisted regression creates actual disposable PGlite and SQLite databases, then closes and reopens them. It exercises exact, hash-only and unbound legacy inputs, unchanged-source rehydration, source-revision mismatch and recovery, current/pinned boards and exports, private previews/explanations, exact frozen bindings, custom-provider assertions and interrupted dispatch. Unrelated issue cache and publication bytes retain their original identity.

After building the workspace packages, run the focused regressions with:

```sh
node --test --test-isolation=none packages/github/test/discussion-answer-time.test.mjs apps/pipeline/test/discussion-source-time.test.mjs apps/pipeline/test/discussion-cache-migration.test.mjs apps/pipeline/test/review-cache-migration.test.mjs
```

These fixtures demonstrate local source and persistence behavior. They are not collected contribution evidence, a live capability receipt, source-history coverage, a hosting qualification or a public-release claim.
