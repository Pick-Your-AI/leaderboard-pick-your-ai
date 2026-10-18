# Credential scanning in required runtime checks

Refs [#34](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/34),
[#42](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/42) and
[#95](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/95).

The existing `checks` job runs credential scanning before installing application
dependencies or running the runtime suite. It checks both all fetched Git history
(`--all --full-history --diff-merges=first-parent --text --no-ext-diff --no-textconv`)
and the current working tree. Checkout fetches full history and does not persist
its authentication token. A detected value, failed
download, incorrect archive hash, scanner error or incomplete report makes this
existing required job fail. No new branch-rule selection is needed to include the
scanner in `checks`; the other runtime, planning, browser and recovery gates remain.
The explicit merge-diff format detects values introduced only by a merge result,
including values deleted by a later commit. It does not restrict traversal to the
first-parent branch: `--all` still traverses every fetched ref. Without an explicit
merge-diff option, [Git omits merge patches even with `-p`](https://git-scm.com/docs/git-log#_diff_formatting),
and the pinned scanner's [Git source](https://github.com/gitleaks/gitleaks/blob/v8.30.1/sources/git.go)
does not add one to the supplied log options.

Textual patches are required even for Git attributes marked `-diff` and files
containing NUL bytes. External diff and text-conversion helpers are disabled so
the scanner reads original source bytes without invoking configured converters.
The pinned CLI skips ordinary binary diff records; a deleted binary-classified
specimen can otherwise escape both historical detection and the clean working
tree scan. These flags preserve all-ref traversal and merge-result inspection.

The workflow downloads the official Linux x64 [Gitleaks 8.30.1
release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1), verifies its
archive SHA-256
`551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`,
and extracts only the executable. The CLI runs locally with read-only repository
permissions. It uses no repository secret, organizational action license, paid
review service or external upload of scanned content. Version and checksum updates
require ordinary review against the publisher's release assets.

## Rules and reporting

[The repository configuration](../.gitleaks.toml) extends the pinned CLI's default
rules. The only additional exceptions match four exact, visibly synthetic strings
in five named test files, and apply only to `generic-api-key`. These are fictional
cursor/webhook secrets and policy identifiers. An exception never excludes the
file or a provider-specific rule. New credential-shaped values in those same test
files still fail. Review new exceptions with their exact value, path and rule;
do not replace these with a blanket test-directory or baseline exemption.

[The scan runner](../scripts/secret_scan.py) disables inline `gitleaks:allow`
markers, passes a fresh, explicit empty external ignore file, and fails if a
repository-root `.gitleaksignore` exists. The pinned scanner always also loads
[the source-root ignore file](https://github.com/gitleaks/gitleaks/blob/v8.30.1/cmd/root.go),
so changing the external path alone would not prevent suppression. Exact reviewed
exceptions belong in `.gitleaks.toml`. It requests full redaction and reports
only escaped file paths, line numbers and rule IDs. Match text, secret values,
commit messages, account names and email addresses are not printed or uploaded.
Temporary redacted scanner reports are removed at the end of each scan.

Every unexpected stdout/stderr byte also rejects the scan under the explicit
error-only/no-banner configuration. The pinned scanner can return exit zero and
an empty report while logging an unreadable Git source. The runner reports a
fixed incomplete-source error and withholds the captured diagnostic content.
Nonrepository and missing-history-object probes exercise that actual failure
path; exit status and a syntactically valid empty report cannot establish that
the source was fully scanned.

The pinned scanner's inherited rule and file-type limitations still apply. This
is credential-pattern detection, not proof that arbitrary private text, encrypted
data, unfetched Git objects or every possible credential is absent. It does not
rotate credentials, erase historical source evidence, inspect an external secret
store, or establish the operational acceptance of #34, #42 or #95 by itself.

## Local verification and gate probe

Use a verified Gitleaks 8.30.1 executable for the local platform. From the repository:

```bash
python3 scripts/secret_scan.py --gitleaks /path/to/gitleaks --self-test
python3 scripts/secret_scan.py --gitleaks /path/to/gitleaks
```

The first command creates a disposable Git repository containing the accepted
synthetic fixtures, then inserts two generated, never-issued credential specimens
in those same paths. It requires the expected rule, file and exact line for each
specimen despite inline allow comments, requires fully redacted results, deletes
the specimens in a later commit, and requires findings from their exact historical
commit. A second isolated repository introduces the specimens only in a two-parent
merge whose parents contain neither value, deletes them in a later commit, and
must still detect both at the merge commit. A clean current tree does not satisfy
either history probe.
Three more isolated histories require detection at the exact original commit,
file and line after deletion: a `-diff` path, a NUL-bearing file and a path with a
configured text converter. The converter writes a temporary marker if invoked;
that marker must remain absent. Separate nonrepository and deliberately missing
Git-blob fixtures require rejection even when the CLI returns zero. All damaged
Git objects belong exclusively to disposable probe repositories.
Adding matching fingerprints in `.gitleaksignore` must separately fail closed.
Scanner/configuration errors
cannot pass this probe: its exact finding exit code and per-specimen locations are checked.
The temporary repository is removed and no fixture credential enters this project.

The second command scans this checkout. A historical finding must be investigated
even when the current working tree is clean. Follow [the private reporting
policy](../SECURITY.md) for a real credential; do not paste the match into a public
issue or add a broad exception to force a pass. Branch protection, independent
review, deployed secret rotation and incident ownership retain their own evidence.
