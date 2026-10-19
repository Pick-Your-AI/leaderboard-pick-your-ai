# Canonical objects and local-only physical diffs

Refs [#76](https://github.com/Pick-Your-AI/leaderboard-pick-your-ai/issues/76).

The [bounded Git fallback](../packages/github/src/physical-diff.ts) compares the
literal Git objects named by its full before/after SHAs. Both the ordinary and
whitespace-insensitive commands disable replacement objects and lazy fetching.
The caller must supply an authorized repository with all required objects
already available locally. Missing objects cause the read to fail; they do not
produce an empty complete manifest or trigger an implicit repository download.

Each invocation captures its repository path, revision pins and resource limits
before awaiting Git, and copies the imported/generated path lists. Reusing or
editing the caller's options while the read is in flight cannot switch the second
comparison, relabel the returned pins, or change those classification inputs.

Git normally honors local replacement references even when a caller supplies a
full object ID. A replacement for a commit, tree or blob can therefore alter the
reported physical changes without changing the requested SHA strings. The
[`--no-replace-objects` option](https://git-scm.com/docs/git-replace) prevents that
substitution for this read. Existing replacement references and the working tree
are left intact.

In a partial clone, a local read can otherwise ask a promisor remote for missing
objects. Git's [`--no-lazy-fetch` option](https://git-scm.com/docs/git) disables
that on-demand operation. This fallback requires a Git version supporting the
option; an unsupported option fails instead of silently relaxing the boundary.
Any separately authorized object preparation belongs to the caller, before the
fallback is invoked.

The [Git regression suite](../packages/github/test/physical-diff-object-boundary.test.mjs)
uses disposable synthetic repositories to verify commit, tree and blob
replacement handling; retained formatting exclusions; missing-blob failure
without object-store hydration; successful reads after explicit fixture
hydration; and stable inputs while a caller reuses its options. It contacts no
external service and modifies no contribution source.

Full SHA syntax alone does not establish the correct PR merge base, default-branch
integration boundary, source authorization or imported/generated provenance.
Those requirements remain with the [source normalizer](github-normalizers.md)
and [engineering reconciliation](engineering-source-reconciliation-2026-10-18.md).
The existing byte, time, file, UTF-8 and safe-integer bounds remain enforced.
This correction does not enable a metric, public source or release.
