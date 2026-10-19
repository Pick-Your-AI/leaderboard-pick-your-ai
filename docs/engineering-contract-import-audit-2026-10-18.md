# Frozen contract import and physical-line audit — 18 October 2026

Refs [issue #86](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/86).

This follow-up audits a real accepted contract import and corrects a confirmed Gradle dependency-lock counting defect. It supplements the [earlier four-PR source reconciliation](engineering-source-reconciliation-2026-10-18.md); the earlier observations and their limitations remain historical evidence. The [minimized companion data](engineering-contract-import-audit-2026-10-18.json) records source pins, all 45 imported file identities, the three generator/output mappings, and the separate physical-count comparisons. It contains no package payloads, contributor emails, raw downloads or session receipts.

**Issue #86 remains open.** Mechanical exclusion results do not establish individual authorship, effort, a contributor score or engineering-metric launch acceptance. The actual historical import and the explicitly synthetic formatting experiment below are separate evidence.

## Accepted source and exact import boundary

| Source | Immutable identity and role |
| --- | --- |
| [Android PR #133](https://github.com/Pick-Your-AI/pick-your-ai-android/pull/133) | Published head `8b4197a3023fc1d1fd53684b3e29bba28bcf390e`; accepted merge `ad0cc3a3eaf7f36bba722bee3254db2b8c1e5bb6`. Both have tree `9790162ff90a1557c11f47b4b719b1e69112e323`. |
| Actual Android integration comparison | Accepted merge's sole main parent `1a8610607774201b2f6428038a069d2a1e33a820` → accepted merge `ad0cc3a3eaf7f36bba722bee3254db2b8c1e5bb6`. The published source head separately has parent `5b2b235e555f12a40f4c03008f590ebc0f43ed75`. |
| [Research PR #44](https://github.com/Pick-Your-AI/pick-your-ai-research/pull/44) | Accepted source `9769fcd9ea380b1211669b2753181c7782444178`; frozen `contracts/v1` subtree `b1c4eaa4037f2a1e02103849064a947e758a2b40`. |
| Accepted classifier before this correction | Leaderboard `7f3cc5273e95b185382c39cda0a68808bf267ddf`, `packages/github/src/physical-diff.ts`, blob `31510c0e383983659e5c77ef3d5f400284b82861`. |
| Corrected classifier in this change | Same path; blob `8b1f060088b236f7d01f8097d9639a5f70867b47`, SHA-256 `ccbf9c158eef1d701f66c412657a6507a06b073a1d71075fe94c45cc37d439e0`. |

All 73 paths and physical line counts from the complete GitHub PR file manifest match the actual bounded Git comparison: **18,050 added and two deleted lines**. The comparison uses the actual integration parent; it does not substitute the PR head's earlier parent or count unrelated main-branch history.

Exactly 45 Android files match the accepted Research source by path, Git mode/blob, byte length and SHA-256: all 43 payload entries plus `IMPORT_MANIFEST.json` and `UPSTREAM_SHA256SUMS`. Every original payload checksum also matches its manifest entry. The two supplied top-level documentation names are followed through the manifest's explicit destination mapping. Research has one additional adoption document in its 46-leaf subtree; it is outside these 45 imported paths and is not silently included through a directory-prefix claim.

The imported manifest SHA-256 is `ef6d5801eec10f3169e2bf84653e7026b33088e305a987991ec52faadcd7f554`; the checksum-file SHA-256 is `0587a133436268bc03684ad61ff29f3bd1a12eb83db8a497eabdbb8fd8803e15`. Together with the exact per-file records, these prove the downstream copy. They do not identify who originally authored the supplied package or generators.

## Actual generator reproduction

The three generator scripts were read from the pinned Research commit, hash checked, and executed with Python 3.12.14 in a separate temporary copy with initially empty output directories. Every resulting output was compared byte for byte with its accepted Research blob and the matching Android import. All three processes exited successfully.

| Pinned generator under `contracts/v1/reference/` | Exactly reproduced outputs |
| --- | ---: |
| `generate_schemas.py` | 15 schemas/registry files |
| `create_examples.py` | 12 example and baseline files |
| `generate_component_docs.py` | One component document |
| Total | **28 files** |

The companion data identifies every output and the generator's exact source blob and checksum. All 28 outputs are within the 45-file import. The accepted example `examples/evaluation-report.json` is not produced by these three invocations and is not counted as a reproduced output. The example/baseline payloads remain synthetic fixtures; successful regeneration supplies no model, vendor, capacity, quality or deployment evidence.

## Physical accounting and corrected discrepancy

The actual `readPinnedGitDiff` and `classifyPhysicalDiff` functions ran with Node 24.19.0 against the same pinned Android comparison in three modes. The reader kept its default 3,000-file, 8 MiB and 30-second bounds. Each comparison was complete and preserved the same raw counts.

| Explicit provenance supplied to the classifier | Before correction: mechanically eligible files / additions / deletions | Corrected classifier: mechanically eligible files / additions / deletions |
| --- | --- | --- |
| None | 72 / 18,050 / 2 | 71 / 18,010 / 2 |
| Exactly the 28 reproduced generated paths | 44 / 4,943 / 2 | 43 / 4,903 / 2 |
| Exactly the 45 imported paths and 28 generated paths | 27 / 2,064 / 2 | **26 / 2,024 / 2** |

Raw counts remain **73 changed paths, 18,050 additions and two deletions** in all six evaluations. The 45 proven imported files account for **15,986 additions and zero deletions**, all excluded with the explicit `imported` reason. Import provenance retains precedence when a file is also a reproduced generated output. The generated-only comparison independently verifies that all 28 specified generated paths are excluded.

The remaining discrepancy was `core/gradle.lockfile`: its 40 lines were classified as eligible source, although the file's header identifies it as Gradle-generated dependency-lock state and the accepted [metric policy](METRICS.md) excludes lockfiles by default. This change adds only the exact `gradle.lockfile` basename to the existing lockfile rule. Replaying all 73 file records before and after the correction changes only this file's class, eligibility and reason. Its raw counts and every other file's record remain identical.

The corrected 26-file remainder is still **mechanically eligible, without an authorship certification**. Gradle wrappers, dependency-verification metadata and other provenance need their own assessment. Supplying an independently verified import list to this experiment does not add automatic upstream-provenance discovery to production ingestion.

## Regression and synthetic formatting control

The new `packages/github/test/physical-diff-gradle-locks.test.mjs` constructs isolated Git repositories and imports the built public package. With the accepted classifier unchanged, two tests pass and the lockfile regression fails specifically because a Gradle lockfile is reported as `source` instead of `lock`. With the one-line correction and identical test bytes, all three cases pass. The existing real-Git Unicode/path and output-bound suite also passes: **10 related cases, zero failures or skips**.

The regression includes added, changed and removed root/module Gradle lockfiles alongside substantive source, and preserves source names that only share a prefix, suffix or directory segment. A separate constructed batch changes indentation in 40 valid TypeScript files and adds one substantive source file. Its actual Git result preserves 41 added and 40 deleted raw lines while counting only the one substantive addition as eligible. All 40 formatting paths retain their raw churn and the explicit `formatting_only` exclusion.

This formatting experiment is synthetic and checks the existing whitespace comparator. It is not a sampled historical mass-formatting PR or a semantic-equivalence detector. It cannot certify formatting changes beyond the reader's actual whitespace comparison.

## Reproduction and remaining acceptance

1. Obtain the exact Android, Research and evaluator commits above in separate checkouts. Read the 73-path PR manifest and use the accepted Android merge's actual main parent for the physical comparison.
2. Read both frozen import manifests from each accepted source, verify their checksums, and compare exactly the 45 companion-data paths, modes, blobs, lengths and SHA-256 values. Keep the Research-only adoption document outside the import set.
3. Copy the three pinned generator scripts into a separate temporary `contracts/v1/reference` directory with empty `schemas`, `examples`, `baseline` and `docs` siblings. Execute each with Python and compare exactly the listed 28 output bytes with accepted source blobs. Do not run generators in the evidence checkout.
4. Build the evaluator package and call `readPinnedGitDiff` for the pinned Android before/after pair, first without provenance lists, then with the generated list, then with both exact lists. Pass each result to `classifyPhysicalDiff`; compare the complete counts with the companion data. Repeat using the corrected classifier. Keep the original and corrected executions separate.
5. Run `node --test packages/github/test/physical-diff-gradle-locks.test.mjs packages/github/test/physical-diff-utf8.test.mjs` after building the package to reproduce the explicitly synthetic controls.

The earlier source/reviewer reconciliation still needs the outstanding author/committer/coauthor and source-identity evidence, a real historical mass-formatting sample where applicable, and metric-specific review sign-off. Neither this import proof nor the narrow lockfile correction authorizes public engineering rankings or closes all acceptance criteria in issue #86.
