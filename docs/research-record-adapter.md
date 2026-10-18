# Research record versions and independent review

Refs #80 (LB-09.01), #58 and #115. This implements one research-specific
normalization path and its protected review/publication integration. It does not
close the research package, adopt a research conclusion, or change any contract
owned by the research repository.

## Source boundary

An approved pipeline configuration can supply `researchPolicies`, one per
repository. Each names a numeric `repositoryId`, immutable classification policy
`version`, nonempty `recordPaths`, and explicit `generatedPaths`, `importedPaths`
and `syntheticPaths`. Paths are exact relative files or directory prefixes ending
in `/`; there are no globs, URL selectors or arbitrary filesystem reads. Policies
are copied and validated before use. Duplicate repository policies are rejected.

The existing protected `githubEnrich(input)` callback may supply `researchRecords`
on a PR evidence envelope. Each record must carry:

- `verified: true`, `kind: "decision_record"` and the exact repository ID;
- the canonical record `path`, immutable merge `sourceRevision` and exact Git
  `blobSha` for that file at that revision;
- `presentAtRevision: true` and the verified provenance classification `original`.

The host must read and validate the actual record and its blob identity under the
approved source scope. A filename, note header, claimed semantic version, issue
closing keyword or successful JSON validator is insufficient. The adapter does
not parse or import research-owned schemas and does not assume all Markdown files
are decision records. Canonical record selection can follow the research
repository's reviewed component-to-note mapping; this adapter does not write that
mapping, alter native issue relationships or infer an issue's completion.

`original` distinguishes the verified source record from generated/imported or
synthetic material. It does not establish manual authorship or classify whether
someone used AI assistance. Those actor and assistance boundaries remain separate.

No records are inferred from public PR payload fields. Both explicit path policy
and trusted enrichment are necessary. Current source/configuration authority is
checked before and after collection, enrichment and publication through the
existing pipeline fences.

## Revision and classification checks

The source must be a public merged PR with a known merge time no later than its
observation. The PR's target branch, repository default branch and trusted
integration's default branch must agree. The PR merge SHA, integration SHA and
complete diff's after SHA must match, and the diff must have distinct pinned
before/after SHAs.

Each record must identify the same repository and after revision and an actual
changed path. Its Git blob SHA supplies content-version identity; the adapter
does not invent a semantic version field in the research documents. Missing,
malformed or conflicting path/blob/provenance bindings fail closed. Repeated
identical record entries collapse to one candidate. Known generated, imported,
synthetic, vendor, binary, lock and formatting-only files are excluded. Exclusions
apply to a rename's previous path too. A zero-change move supplies no new
record-version candidate. A removed record cannot be supplied as present at the
after revision; verifying existence is part of the host's blob read.

The canonical record-version artifact is keyed by repository, exact record path
and blob SHA. Line counts, JSON keys and unrelated changed files add no units.
Conflicting provenance for one version is not reconciled by guessing an earlier
introduction time. Existing pipeline/engine semantic-conflict checks withhold
ambiguous duplicates rather than inflating credit. Rename lineage across different
canonical record paths still requires its own reviewed mapping.

## Pending and accepted states

The adapter creates a **pending decision-record version**, attributed only to the
verified PR author. It does not emit an accepted finding or an accepted research
issue. A PR merger is not substituted for the record author. Unknown author
identity remains unknown. The public evidence link opens the exact record at its
commit, with a separate immutable commit revision link. The PR title/history is
not copied onto the record artifact.

Acceptance uses the existing private controls evidence request, audited independent
review, approved metric binding and exact locator matching. A review of the PR
URL or another pinned note revision cannot qualify this candidate. A self-review,
collaborator conflict, unauthorized reviewer or missing audit entry remains
invalid. Accepted receipt IDs and review deliberations remain private; public
proof retains the exact record revision and accepted state. Withdrawal and privacy
changes invalidate previous publication authority, including historical pins.

The private pipeline `source_artifacts` table retains the immutable source fact
key for each derived artifact. Its dependencies accumulate across normalization
cache reuse and classification changes; they do not replace the record-version
identity or appear in public responses. A suppression naming the source PR also
suppresses every derived record in current and pinned evidence, accepted totals,
pending counts, exports and contributor work. Private policy replay/comparison
and aggregate explanations apply the same expansion. Publication filters those
dependencies and checks again under the repository read lock before committing.
The mapping survives a database restart and cannot be restored to visibility by
recollecting the same suppressed source. It is retained private provenance, not a
source-content purge implementation; the separate retention boundary still
requires coordinated removal and recovery policy.

For this adapter, a configured `decision_records` policy must use count
aggregation, `occurredAt` (the registry's merge clock), `actor_artifact` grouping,
and only qualified/reviewed ranked states. The independent acceptance clock is
still retained and checked against the frozen cutoff. Pending work uses the same
record-version artifact, so acceptance takes precedence without adding a second
pending unit. Incomplete coverage does not become a measured zero after acceptance.
Other recognition metrics keep their existing acceptance-time rules.

Normalization cache identity now includes configured research and documentation
classification policies whenever either is present. A newly reviewed path or
provenance configuration therefore recomputes its source normalization even if
metric arithmetic is unchanged. Private frozen identity restoration uses the same
cache signature; old configuration cannot silently certify the new classification.
Existing configurations without these source policies retain their earlier key.

## Verification and remaining acceptance

`packages/github/test/research.test.mjs` covers explicit provenance, pinned
record/merge identity, policy freezing, line/file independence, untrusted payload
fields, synthetic/imported exclusion, renamed exclusions, incomplete diffs,
unknown/future merge times, private sources, conflicting blobs and independent
review attribution.

`apps/pipeline/test/research-records.test.mjs` exercises actual collection,
normalization, PostgreSQL-compatible PGlite storage, SQLite control decisions,
metric selection and public API projection. It verifies pending proof, exact note
revision acceptance, the merge clock, one accepted unit, repeat/restart stability,
withdrawal and private-source removal from old pins. Source-PR suppression is
tested for both pending and accepted records through public proof, private policy
preview, aggregate explanation, database reopen and fresh collection replay.
It also verifies incompatible policies are rejected before ingestion and changed
classification policies cannot reuse old normalization cache entries.

These fixtures are explicitly synthetic. Real installed source capability,
affected research-owner acceptance, record-to-issue relationships, accepted
finding/negative-finding/assumption-specific adapters, real reviewed samples and
deployment acceptance remain separate work. This implementation does not declare
a merged partial PR to be a completed research issue or production functionality.
