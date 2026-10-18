# GitHub source adapter coverage

Refs #45, #46, #59, #63, #67. This is implementation evidence, not installation,
source-owner acceptance, real-data reconciliation, or launch approval.

The default collection adapter reads complete paginated issue, PR, comment,
commit and release lists. Review inventory first traverses every PR, then every
review connection; a failed nested scan prevents publishing a partial count.
All requests retain the configured authorization fence and transport quotas.
The 10,000-record and configured page limits fail closed.

Review snapshots use a SHA256 fingerprint of source identity, submission time,
state, commit, author and body. Text influences revision identity but is not
retained in collection facts. A scan-identity suffix distinguishes later observations
of restored state (A → B → A) while same-scan replay stays idempotent. Hydration
must reproduce the payload fingerprint. A
complete review cohort establishes first reviewer/PR participation and first
reviewer/PR/head submission; duplicate IDs, unknown earlier actors, unknown
heads, unsupported states or missing submission clocks prevent that proof.
Self reviews, bots and review quality retain the existing independent policy
rules. A submitted review does not establish first-ready review-wait history.

Discussion collection uses the read-only GraphQL repository connection, checks
repository identity, public visibility and enabled capability on every page,
and preserves disabled/unreadable sources as unavailable rather than zero.
It imports public Discussion identities, not arbitrary external support content.
The Discussion fingerprint includes native answer selection and removal, even
when the Discussion updatedAt field is unchanged. Hydration credits creation to
the author. Native accepted answers retain the answer author, selector and
selection clock separately and remain observed evidence rather than independent
quality review. Answer metrics require the trusted host's selectedCurrentState
flag: the host must exclude superseded subject snapshots at its frozen cutoff.
Otherwise answer credit stays unavailable. Raw comment volume is never counted
as helpfulness. Unknown authors and clocks remain unknown.

Schema references: [GitHub Discussions API guide](https://docs.github.com/en/graphql/guides/using-the-graphql-api-for-discussions)
and [Discussion fields](https://docs.github.com/en/graphql/reference/discussions).

Remaining source work includes actor-backed timeline/event adapters, selectively
supported Project history and relationship collectors, verified readiness
cohorts, and live installation permission/reconciliation evidence. Current Project
fields must not be used to reconstruct historic editors. Real source approval,
public permission probes, independent evidence review and launch gates remain
external acceptance prerequisites. None of these issues is closed by synthetic
tests alone.
