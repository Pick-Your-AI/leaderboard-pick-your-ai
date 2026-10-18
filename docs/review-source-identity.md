# Review source identity

Refs #67. Review participation and reviewer/head rounds must belong to the
collected pull request and source actor. A successful repository request alone
does not prove those narrower identities.

The default REST normalizer checks the hydrated pull request's database ID,
number and exact public URL before reading review history. The hydrated review
must identify that same pull and its own numeric review ID. Every supplied HTML,
API and nested link must agree. Mismatched parent or target evidence produces no
review facts.

Every history row must identify the same pull and its own review ID. A complete
cohort cannot reuse a database or node review identity, bind one actor node to
different accounts, or give one account conflicting node identities or account
kinds. Unknown submitted-actor kinds withhold the first-submission proof. Pending
reviews supply no submission milestone. Consistent historical login changes do
not change the native actor identity. Invalid history withholds participation
and round credit while retaining independently scoped target feedback as raw
evidence, without treating its length or state as quality.

The collected review fingerprint also binds source links and the actor node.
Missing optional identities remain distinct from explicitly malformed fields.
Drift in those fields requires a new source observation; a matching body, clock,
state and database ID cannot silently authorize a changed source identity.

The [GitHub review API](https://docs.github.com/en/rest/pulls/reviews) documents
the review database/node IDs, public review link, API parent link and linked
parent representation. These checks validate the returned evidence; they do not
assert that the synthetic counterexamples were observed on GitHub itself.

## Regression evidence

`packages/github/test/review-cohort-identity.test.mjs` exercises the actual
collection normalizer with controlled, explicitly synthetic REST/history
responses. The cases cover wrong parents, contradictory source links, review
identity aliases, conflicting actor identities, exact fingerprint drift,
preserved raw feedback, distinct head rounds, pending reviews, historical login
changes and exact recovery. The original accepted normalizer at
`580f43881c8edda904b8eae25799302af6626555` fails 22 of these 25 methods; the corrected
normalizer passes all 25. All 358 methods in the GitHub adapter package pass,
with no failures or skips.

These source and fixture checks do not supply installed-source permission,
complete readiness history, independent review-quality receipts or the broader
work package's receiving acceptance.
