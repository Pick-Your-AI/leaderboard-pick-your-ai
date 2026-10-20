# Revision-bound documentation participation

Refs #81 (LB-09.04). This implements documentation and explicitly configured locale participation. Separate [documentation reviewer participation](documentation-review-participation.md) is an optional protected specialization of the existing evidence-review metric. External tutorial consent, actual reviewer enrollment, affected-owner acceptance and live-source gates remain separate.

## Source and runtime wiring

The trusted host may supply `githubEnrich(input)` to `createPipeline`. It is the existing `GithubEvidenceNormalizerOptions.enrich` boundary exposed through the runtime, not an HTTP request field or user-submitted evidence payload. The host must independently verify repository visibility, source identity/revision and immutable default-branch integration. The callback must honor its approved source scope; it grants no new permission and must not mutate upstream data. The pipeline checks current authorization before and after normalization and rejects changed source configuration before publication.

A verified pipeline configuration may include `documentationPolicies`, each containing:

- `repositoryId` and immutable classification policy `version`;
- explicit `documentationPaths` (nonempty), `researchPaths`, `generatedPaths` and `importedPaths` arrays;
- exact relative paths or directory prefixes ending in `/`, with no glob, traversal, absolute path or inferred locale semantics;
- optional `releaseNotesPaths`, a nonempty bounded subset of documentation paths that supplies only an authored-notes source candidate. The [separate current purpose review](authored-release-notes.md) is required before it becomes a public label.

No policy or no trusted diff enrichment means no documentation fact. All configured policies are copied and validated when the normalizer is built. Duplicate repository policies are rejected. Changing classification requires a newly reviewed/versioned pipeline configuration; it must not silently reuse an old configuration or mutate a frozen publication.

Normalization cache identity binds the complete documentation and research
classification policies, including locale rules. Changing or removing a rule
invalidates the cache for the next authorized run, even if a policy version was
mistakenly left unchanged. A frozen identity replay still requires its exact
document hash and matching source, mode and complete classification signature.
The earlier documentation-only cache format remains eligible for that historical
replay only when no research policy is configured; its signature cannot stand in
for an omitted research classification. Unclassified legacy signatures cannot
authorize replay under active documentation or research policies. Fresh runs use
the current combined classification key and preserve retained historical bytes.
When documentation policies are active, the current key also identifies the
`documentation-locales/v2` projection. This recomputes earlier caches that lacked
the future-merge check, locale emission or substantive rename origins. The exact
policy-bound `v1` and pre-locale documents remain eligible for frozen history;
historical snapshots do not acquire newly classified units retroactively.

### Explicit locale rules

Optional `localizationPaths` entries contain `locale`, `category`, and nonempty
`paths`. The locale is a canonical language tag with optional script/region/variant;
extensions, private-use additions and `und`/`mul`/`zxx` language tags are not
accepted. The category is an explicit lowercase identifier. No language or content
category is guessed from filenames, text, PR labels or reviewer names.

For example, a synthetic policy may map `docs/fr/` to `fr` / `documentation` and
`locales/fr/` to `fr` / `interface`. At most 32 locale/category pairs and 256 total
paths are accepted, with at most 100 paths per pair. Duplicate pairs and overlapping
paths across different pairs are rejected, so one file cannot silently establish
several language/category units. The existing generated/imported/research and
physical-diff exclusions apply, including the original path of a renamed file.

Each eligible PR/language/category/actor creates one observed `localization` fact.
Additional files, strings or lines in that pair do not increase its value. Empty
renames create no unit; substantive deletions can establish observed participation.
A substantive move between configured pairs records both its original and current
locale/category, once each. A move out of configured locale paths can still record
the eligible original pair. The source and destination exclusions both apply.
The source merge revision, locale, category and policy version remain in the public
proof. The observation does not certify translation quality or human authorship.
Independent recognition must target that exact fact and an authorized reviewer
different from the credited actor; acceptance of one language does not accept the
other languages. Its proof retains the classification after acceptance. Localization
count policies must select `qualified` or `reviewed` evidence, canonical grouping,
and the source merge clock (`occurredAt`), as declared by the frozen metric registry;
raw merged observations remain descriptive portfolio activity, not accepted counts.
The engine rejects policies that would label raw work as accepted or collapse
different locale/category units. Bulk acceptance changeset IDs cannot replace a
locale contribution's original canonical identity. Acceptance is required but its
later review date cannot move a merged contribution into a different period.
The candidate registry view supports this qualified source-clock projection. It
does not enable production publication. Current portfolio/activity shows an
accepted representation in place of that exact locale's observed representation;
the immutable raw fact remains stored for audit and recomputation. Unaccepted
languages remain observed, and withdrawing acceptance restores the observed view.
This configuration enables no
source or public ranking by itself.

An existing private controls recognition binding for localization must target the
`localization` source metric and include an exact `localization` selector with
`locale`, `category`, and the documentation classification `policyVersion`.
The configured request category/scope identifies the expected review selection.
An authenticated independent reviewer must also record a private `localization`
target through the actual acceptance API or reviewer form: the exact observed
`targetFactId`, immutable merge `sourceRevision`, canonical `locale`, `category`,
and documentation classification `policyVersion`. This field is rejected on
submission and on other review actions; the server does not infer it from a
claim, provider response or current configuration. The acceptance audit records
the reviewed request owner, locator, category and scope alongside the target.

Materialization requires the current request version and receipt ID, exactly one
unchanged private audit entry, the exact recorded request fields and target, and
a reviewer decision no earlier than the source merge. The current protected
selector must still agree. Changing a selector cannot retarget an earlier review;
changing a source revision requires a new review of that revision. Legacy generic
receipts without the recorded target retain observed participation but supply no
locale acceptance. A multilingual PR can therefore receive an independent decision
for one language without accepting its other languages. The existing owner,
reviewer, metric policy, public-source and withdrawal checks still apply. Missing selectors,
ambiguous candidates and malformed labels fail closed; a selector without a
matching contribution supplies no credit. Private receipt IDs and internal reason
strings are removed from primary, portfolio and pending proof; only bounded
classification labels and fixed public state reasons survive.

The normalization budget retains the existing maximum of 100 ordinary facts and
proofs per collected source record, with one additional paired slot for each
eligible configured locale/category unit, up to 32. This allows a previously
supported diff to emit its locale units without increasing the ordinary record
budget. Actor and private attribution limits remain unchanged.

The enrichment supplies the existing `GithubEvidenceEnvelope.integration` contract: distinct pinned before/after Git SHAs, default/target branch, canonical change identity and a complete `PinnedPhysicalDiff`. `readPinnedGitDiff` is an existing bounded read-only local source implementation; a deployment must explicitly configure and verify its repository source, not discover arbitrary mounted repositories. This change neither clones repositories nor enables that filesystem access automatically.

## Counting and evidence

The adapter requires a public merged PR, proven merge time no later than its observation, merge commit matching the diff's `after` SHA, matching diff before/after, and target/default branch agreement. A reported future merge produces no documentation or locale unit, even with otherwise matching revision pins. Enriched repository and source revision must match the collected fact. Incomplete diffs never produce documentation participation. The resulting evidence links to the PR and immutable merge commit revision.

Known generated/imported/vendor/binary/lock/formatting-only content is excluded. Explicit research paths are excluded even when nested within configured docs paths. Renames from excluded research/generated/imported paths remain excluded. A substantive addition or deletion can establish participation; a zero-change move cannot. Eligible path count, line count and assertion count never determine the metric value: one canonical PR/category/actor unit is emitted, regardless of how many eligible files or lines changed.

The state is **observed merged documentation participation**, not accepted quality, authored-prose certification or completed research. The merger is not substituted for the PR author; reviewer participation is not inferred. Independently authenticated acceptance can later qualify the same metric through the existing receipt path, retaining the raw observed fact separately. No `accepted_findings` or research completion is emitted. Generated/imported exclusion reasons are retained as internal normalization diagnostics rather than credits.

## Criterion mapping and remaining gates

| #81 criterion | This implementation | Remaining gate |
| --- | --- | --- |
| Classify merged docs, examples, guides and translated content | Explicit documentation and locale/category paths with complete revision-bound merged PR diff | Actual language-specific policy and classification acceptance |
| Count accepted artifacts/substantive revisions under reviewed policy | Stable observed PR/category unit; existing independent receipt can separately qualify it | Actual classification/acceptance policy approval and real reviewed examples |
| Author and reviewer participation separate | Stable PR author plus separate opt-in reviewer/head/checklist qualification; no reviewer or merger credit inferred | Actual reviewer enrollment, approved checklist, source permission and policy acceptance |
| External tutorials require consent/public evidence | External tutorials are not collected by this adapter | Consent and verified public-artifact intake |
| Generated docs cannot masquerade as authored prose | Known generated/imported content excluded and diagnosed; observation does not certify prose authorship | Actual configured classification completeness review |
| Recognition does not depend on code LOC | One PR/category unit; source-diff size never weights the result | Metric-owner acceptance |

## Validation evidence

Synthetic normalizer tests cover one-unit conservation across widely differing line/file counts, raw/accepted separation, pinned source URLs, missing policy, revision mismatch, generated/imported/research exclusions, incomplete diff, unmerged PR, branch/merge-SHA mismatch, unsafe paths and duplicate policies. A pipeline regression exercises synthetic GitHub transport through collection, trusted enrichment, normalization, metric computation, public readback and privacy-loss suppression. These tests are not real contributor evidence, source permission certification or public deployment acceptance.

Locale regressions additionally cover independent language/category units, unsafe
or ambiguous mappings, noncanonical and undetermined language tags, rename exclusions,
separate acceptance, policy freezing and current suppression of pinned public
proof. The tests use synthetic sources and do not establish real translation
quality, reviewer language proficiency or an approved production locale policy.

Database-restart regressions cover both documentation-only and combined
documentation/research configurations. They retain exact historical document
bytes, reject signatures missing either active classification, and verify that a
fully bound historical documentation cache can be replayed before a fresh run
recomputes it under the current combined key. Accepted locale proof continues to
use the source merge clock and bounded public labels after migration.
Another restart regression models the earlier documentation projection, verifies
that fresh normalization adds the configured observed locale units, and preserves
the historical document and policy-preview result unchanged.
A destination-only `v1` rename projection receives the same historical guarantees,
while the next authorized run emits both eligible source and destination pairs.
Actual controls HTTP tests exercise validated reviewer input, exact audited target
binding, request amendment, approval chronology and restart/configuration changes.
They verify that older unbound publication authority is revoked, that accepted
activity contains one current unit per locale, and that the ordinary normalization
budget is preserved when 32 configured locale pairs add their bounded units.
