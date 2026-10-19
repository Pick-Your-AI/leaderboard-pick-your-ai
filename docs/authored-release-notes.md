# Reviewed authored release-notes purpose

Refs #77 (LB-07.05). This versioned policy qualifies authored release notes within
the existing documentation contribution. Review and merge adopt its bounded
engineering semantics. A deployment separately needs approved source access,
path policy, metric policy, current participant intake and an independent reviewer.

## Meaning and unchanged unit

An authored note is a reviewed contribution to documentation. Its original source
is a public, merged documentation PR with a verified default-branch integration,
a complete immutable physical diff and an actual source author. The source path
selects a candidate; the current independent review accepts the authored purpose.

The unit is the existing PR/documentation-category/contributor unit. Multiple
files, versions of a claim, receipt aliases or caller-supplied bulk changesets
cannot add a second unit. Its occurrence stays the actual PR merge time, while
acceptance keeps its later independent timestamp. Notes can be authored before
a release is published. No release object or publisher is substituted for the PR.

Raw release publication, CI success, labels, titles and merge operators supply
no authored-notes authority. A source bot remains a bot. User-account identity
does not prove human-operated work, and this policy does not quantify effort.
Coauthor, reviewer, external tutorial and release-coordinator adapters remain
separate; this bounded source requires the original observed PR author.

## Two explicit selections

The protected documentation path policy may add a nonempty `releaseNotesPaths`
array. It accepts at most 100 distinct safe relative file paths or directory
prefixes ending in `/`, each at most 500 characters, within the configured
`documentationPaths`. Every array element must exist. There are no globs, parent
traversals, absolute paths or purpose inference from filenames without that policy.

For example, an approved fictional policy might select `docs/releases/` within
`docs/`. The existing physical-diff and research/generated/imported exclusions
apply before the candidate is emitted, including both sides of a rename.
Substantive additions or deletions can establish participation; a zero-change
move cannot. The normalizer adds only the private candidate reason
`documentation_purpose_candidate:release_notes`, keeping source facts and units
unchanged. This reason is not a public authorship claim.

A protected recognition binding must separately opt in:

```json
{
  "category": "other",
  "scope": "repository:2:documentation:release-notes",
  "policyVersion": "authored-notes-review-v1",
  "metricId": "documentation",
  "sourceMetricId": "documentation",
  "repositoryId": "2",
  "reviewerIds": ["202"],
  "documentationPurpose": "release_notes"
}
```

These identities are fictional. The binding also needs the complete existing
`domainEvidence` configuration described in [domain recognition](domain-recognition.md).
The metric policy retains canonical grouping, `rankedStates: ["qualified"]` and
`dateBasis: "occurredAt"`, together with the existing definition, unit and source
approval. No metric definition, contribution role, route, form field or public
source is added or enabled.

## Exact current private review

Use the supported `category: "other"` evidence request, its selected scope, current
terms and participant consent. Its private `detail` may hold this closed record:

```json
{
  "schemaVersion": "documentation-purpose/v1",
  "purpose": "release_notes",
  "targetFactId": "exact-observed-documentation-fact",
  "sourceRevision": "cccccccccccccccccccccccccccccccccccccccc",
  "pathPolicyVersion": "authored-notes-paths-v1",
  "details": {
    "authorship": "authored",
    "category": "documentation",
    "substantiveReview": true
  }
}
```

The whole record fits the existing 2,000-character private detail bound. Its
target, immutable merge revision and path-policy version must exactly match the
single original source proof. The three detail values must agree with the
existing current `domain-evidence/v1` record for that request, version, decision
and source. The current accepted `sourceUseReview.references` must contain the
exact same-repository commit URL and full 40- or 64-character lowercase SHA.
A general permission to use another reference does not approve this source.

The reviewer must independently inspect the notes contribution and its substantive
authorship conclusion. Current request version, policy, owner, reviewer, audit
entry, terms, participant consent and reviewed-input digest remain prerequisites.
The reviewed source cannot be a qualified copy, fabricated actor role, synthetic
fact, mutable branch, unknown pin or later source clock. Known metadata must
agree with the observed merge and its original unaccepted source state.

This binds a protected review to a verified source and private statement; it does
not fetch or attest the contents of review references, certify authorship from a
path, or infer release coordination. The existing trusted enrichment boundary
retains responsibility for source visibility, revision and physical diff.

An unselected binding or ordinary non-JSON narrative has no purpose claim and
keeps generic documentation behavior. Omission means unknown. Object/array JSON
supplied under the opt-in must parse and satisfy the entire schema; malformed,
unsupported or contradictory records fail before the host receipt callback.
The direct trusted receipt API can carry `documentationPurpose: "release_notes"`
only with the exact original documentation source and reviewed `sourceRevision`;
that API continues to require independently authenticated host receipts.

## Currentness, aliases and stored history

Every current request and source passes qualification before canonical duplicate
selection. Accepted-time ordering retains the earliest valid canonical receipt;
later aliases do not union purposes or add units. A later malformed alias is
still rejected. Amend the existing claim and obtain fresh review to replace it.
Pending, declined, withdrawn, appealed or stale inputs cannot retain an accepted
overlay. SQLite/database reopen does not restore revoked authority.

Only bindings with this defined purpose opt-in add the
`documentation-purpose/v1` recognition-authority marker. Unsupported destinations
or values fail before a saved fingerprint is issued, even with no current
requests. Generic documentation and all unselected bindings preserve their exact
prior authority encoding.

An explicitly configured notes path also versions the normalization generation.
This reprocesses an older cache whose complete configuration already contained
the optional field while its adapter ignored the field. The previous plain and
release-wrapped generations, including review/discussion and default-delivery
wrappers, remain available for source-bound historical identity and migration
hints. They cannot supply fresh facts. Historical normalization rows, snapshot
bytes and frozen previews are retained; fresh output uses a distinct generation.
This changes no source observation or merge timestamp and initiates no automatic
release collection beyond the separately selected existing release contract.

## Public proof and display

The complete accepted explanation retains the fixed documentation metric,
merge-clock and authored labels, the path-policy version, and
`documentation_purpose:release_notes`. It never copies private detail, paths,
review references, reviewer or receipt IDs, intake digests or arbitrary rationale.
The shared proof display describes authored release notes as the same counted
documentation contribution and explicitly leaves missing purpose unknown.

Primary, accepted portfolio, current, pinned and exported copies of a contribution
must agree on this purpose, classification, original merge time and immutable
same-repository source pin. Missing or conflicting purpose in one copy is not
repaired from another. Unsupported or duplicate purpose codes, nonaccepted proof,
wrong roles, differing pins and conflicting clocks fail closed. Entirely generic
legacy evidence remains readable without invented purpose.

## Verification and remaining work

The regression fixtures exercise actual source normalization, direct receipts,
current HTTP review/amendment/withdrawal, engine unit conservation, public API and
JSON/CSV projection, and real disposable SQLite/PGlite reopen. They preserve
literal prior authority for all 98 unselected metrics, reject invalid aliases
before callbacks, and retain prior plain/release-wrapped normalization history.
The shared TSX display is checked directly; this is not a browser accessibility
audit or a live participant observation.

Source-bound execution receipts preserve the original negative controls and all
later corrected results. No actual contributor classification, enrolled reviewer,
deployed source, published release or live ranking accuracy is asserted.
Release publication, released-change membership, independently reviewed release
coordination/stewardship, deployment work and the remaining literal #77 gates
retain their separate source and acceptance requirements.
