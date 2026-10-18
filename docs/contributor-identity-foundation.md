# Contributor identity foundation

This describes the automated identity boundary for #36. The leaderboard distinguishes
source identity, its stable serving alias, mutable display labels, source availability,
and protected privacy controls. None of these establishes a person's effort or the
quality of their work.

## Provider identity and serving aliases

The source-event contract and `canonicalizeObservations` prefer the opaque GitHub
node ID when it is available. A database-only identity belongs to a separate
namespace; a node containing numeric text is not the corresponding database ID.
Explicit provider bindings and known account kinds must agree across the supplied
resolved observations. Ambiguous bindings withhold their affected groups rather than
joining unrelated deduplication keys. This helper does not establish a persistent
account registry or apply a correction.

The production collection pipeline has its own identity boundary. Its REST/GraphQL
adapters hydrate the approved subject and verify the collected source revision.
Normalized facts retain the safe positive database ID as the stable serving alias,
with its authoritative node binding kept alongside the actor. Existing numeric
aliases are part of frozen source, aggregate and public contracts; they do not become
login-based identities merely because they are not literal node strings.

The normalizer rejects contradictory node/database bindings and provider kinds in
one normalization. The pipeline's retained actor join and the metric engine check
bindings across independently normalized rows before preparing an aggregate or
writing a publication. Frozen private identity restoration requires the exact
authorized normalization/source bindings. The pipeline does not call the standalone
canonical-observation helper, and the two checks must not be presented as one call path.

## Renames and unavailable source actors

A newer login replaces an earlier display label only when both provider identifiers,
account metadata and the retained source/run ordering establish the same actor.
Conflicting labels from one scan or tied observation times remain ambiguous. Original
contribution IDs, clocks, source records and credit do not change. Earlier pins retain
their original labels. The complete ordering and replay boundary is described in
[verified source aliases](verified-actor-renames.md).

A missing API actor, or a record containing only matching login/name/email labels,
cannot be resolved by looking up a previously seen display label. Its new normalization
retains an explicit unknown attribution with null actor and subject IDs. The unavailable
subject supplies no current named credit. Another independently verified subject for
the same account can remain eligible; one missing occurrence does not tombstone the
whole account.

Earlier verified evidence and its original pinned publication remain intact until
the applicable source or privacy authority withdraws their visibility. Protected
account-wide suppression is a separate decision. Current controls are reapplied to
current and pinned boards, contributor directories/profiles, evidence and JSON/CSV
exports, including after a database reopen. Suppressing one account must preserve the
successful, accurate responses for unrelated eligible contributors.

The public actor projection admits only public, resolved actors. Explicit deleted,
suspended, unavailable and unresolved identity states, and hidden/deleted/unlinked
public states, cannot publish named rows or evidence. Conflicting copies are rejected
before filtering. A null API response alone cannot diagnose deletion versus suspension;
the normalizer does not invent either diagnosis or a global account deletion event.

## Emails, account links and corrections

Login, display name and commit-email text cannot establish a stable actor identity.
Public actor schemas reject email fields. Normalizers produce allowlisted records and
do not publish raw commit text or emails. A coauthor mapping requires an explicitly
supplied verified stable account and protected verification receipt; a trailer name
alone is unresolved. Model declarations do not create contributor identities.

[Verified identity proposals and decisions](verified-identity-corrections.md) define
voluntary account links, exact contribution split/merge scope, control/consent evidence,
independent review and reversal. The definition is separately versioned and does not
rewrite frozen `leaderboard/v1`. Parsing does not authenticate evidence or apply a
mapping. The protected request, authorization, durable application and delivery process
remains #94; no public form, inbox or operational service is asserted here.

## Automated evidence and limits

The normalizer and contract suites check stable identities, unverified labels, strict
email rejection, roles and private coauthor inputs. The canonical provider-binding
suite checks both identifier namespaces and contradictions across observation groups.
`actor-renames.test.mjs` exercises retained credit, source ordering and frozen replay.
`service-account-publication.test.mjs` rejects both cross-observation provider-binding
directions before SQL snapshot or private preview publication.

`retained-ledger-rebuild.test.mjs` rebuilds an initially unknown actor through cache
loss and database reopen. `actor-lifecycle.test.mjs` changes an actually hydrated subject
after publication, retaining all original source rows. It covers absent and label-only
actors, both input orders, a separate still-verified subject, historical pins, and
account-wide suppression with successful unrelated board/directory/export controls
before and after restart. `public-actor-ambiguity.test.mjs` exercises explicit lifecycle
states and contradictory public copies.

These are synthetic behavior checks against the actual source, database and service
handlers. They do not certify a live GitHub lifecycle event, installed-App permission,
production collection, an operational identity-correction service or a deployed
privacy-request destination. Source capability and public-release gates remain separate.
