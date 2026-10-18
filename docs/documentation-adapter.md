# Revision-bound documentation participation

Refs #81 (LB-09.04). This slice implements a documentation-specific source adapter. It does not close localization, external tutorial consent, reviewer-participation, affected-owner acceptance or live-source gates.

## Source and runtime wiring

The trusted host may supply `githubEnrich(input)` to `createPipeline`. It is the existing `GithubEvidenceNormalizerOptions.enrich` boundary exposed through the runtime, not an HTTP request field or user-submitted evidence payload. The host must independently verify repository visibility, source identity/revision and immutable default-branch integration. The callback must honor its approved source scope; it grants no new permission and must not mutate upstream data. The pipeline checks current authorization before and after normalization and rejects changed source configuration before publication.

A verified pipeline configuration may include `documentationPolicies`, each containing:

- `repositoryId` and immutable classification policy `version`;
- explicit `documentationPaths` (nonempty), `researchPaths`, `generatedPaths` and `importedPaths` arrays;
- exact relative paths or directory prefixes ending in `/`, with no glob, traversal, absolute path or inferred locale semantics.

No policy or no trusted diff enrichment means no documentation fact. All configured policies are copied and validated when the normalizer is built. Duplicate repository policies are rejected. Changing classification requires a newly reviewed/versioned pipeline configuration; it must not silently reuse an old configuration or mutate a frozen publication.

The enrichment supplies the existing `GithubEvidenceEnvelope.integration` contract: distinct pinned before/after Git SHAs, default/target branch, canonical change identity and a complete `PinnedPhysicalDiff`. `readPinnedGitDiff` is an existing bounded read-only local source implementation; a deployment must explicitly configure and verify its repository source, not discover arbitrary mounted repositories. This change neither clones repositories nor enables that filesystem access automatically.

## Counting and evidence

The adapter requires a public merged PR, proven merge time, merge commit matching the diff's `after` SHA, matching diff before/after, and target/default branch agreement. Enriched repository and source revision must match the collected fact. Incomplete diffs never produce documentation participation. The resulting evidence links to the PR and immutable merge commit revision.

Known generated/imported/vendor/binary/lock/formatting-only content is excluded. Explicit research paths are excluded even when nested within configured docs paths. Renames from excluded research/generated/imported paths remain excluded. A substantive addition or deletion can establish participation; a zero-change move cannot. Eligible path count, line count and assertion count never determine the metric value: one canonical PR/category/actor unit is emitted, regardless of how many eligible files or lines changed.

The state is **observed merged documentation participation**, not accepted quality, authored-prose certification or completed research. The merger is not substituted for the PR author; reviewer participation is not inferred. Independently authenticated acceptance can later qualify the same metric through the existing receipt path, retaining the raw observed fact separately. No `accepted_findings` or research completion is emitted. Generated/imported exclusion reasons are retained as internal normalization diagnostics rather than credits.

## Criterion mapping and remaining gates

| #81 criterion | This implementation | Remaining gate |
| --- | --- | --- |
| Classify merged docs, examples, guides and translated content | Explicit configured documentation paths and complete revision-bound merged PR diff | Locale classification and language-specific policy |
| Count accepted artifacts/substantive revisions under reviewed policy | Stable observed PR/category unit; existing independent receipt can separately qualify it | Actual classification/acceptance policy approval and real reviewed examples |
| Author and reviewer participation separate | Stable PR author only; no reviewer or merger credit inferred | Dedicated reviewed documentation reviewer participation |
| External tutorials require consent/public evidence | External tutorials are not collected by this adapter | Consent and verified public-artifact intake |
| Generated docs cannot masquerade as authored prose | Known generated/imported content excluded and diagnosed; observation does not certify prose authorship | Actual configured classification completeness review |
| Recognition does not depend on code LOC | One PR/category unit; source-diff size never weights the result | Metric-owner acceptance |

## Validation evidence

Synthetic normalizer tests cover one-unit conservation across widely differing line/file counts, raw/accepted separation, pinned source URLs, missing policy, revision mismatch, generated/imported/research exclusions, incomplete diff, unmerged PR, branch/merge-SHA mismatch, unsafe paths and duplicate policies. A pipeline regression exercises synthetic GitHub transport through collection, trusted enrichment, normalization, metric computation, public readback and privacy-loss suppression. These tests are not real contributor evidence, source permission certification or public deployment acceptance.
