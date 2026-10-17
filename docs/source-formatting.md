# Source formatting

Prettier is pinned to **3.9.10** in the root development dependencies. The version and package integrity were verified against the official npm registry before selection. `.prettierrc.json` uses two-space indentation, semicolons, double quotes, trailing commas, a 120-column target and LF newlines.

Run from a checkout with installed dependencies:

```sh
npm run format
npm run format:check
```

`format` writes formatting changes; `format:check` reports drift and exits nonzero without writing files. Both call `scripts/format-source.mjs`, which enumerates Git-tracked files with NUL separators and passes file content directly to the pinned Prettier API. It does not invoke a shell with filenames or fetch tools at execution time.

Only `.ts`, `.tsx`, `.mjs` and `.css` files under `apps/`, `packages/`, `tests/`, `infra/` and `scripts/` are eligible. Untracked files, planning data, documentation, JSON registries, dependency/build/generated directories, Git metadata, workflows and browser reports are excluded. Eligible symlinks and paths resolving outside the eligible source tree are rejected. Syntax errors, missing tracked files and Git/tool errors also fail the check; they are not silently ignored. Tests written as `.js`, Python tests and SQL migrations are outside this deliberately narrow formatting scope.

The initial formatter commit does not reformat existing sources or change workflows. Apply it to the final composed tree, regenerate the root lockfile for the pinned dependency, run `npm run format`, review the formatting delta, then run `npm run format:check` and the existing build/type/test suites. A source-format check should become part of standard package validation; the separately blocked workflow publication still needs its existing authorization/access resolution. No CI activation or branch-control change is claimed by these commands.

A temporary tracked malformed TypeScript source is used during implementation verification to demonstrate that checking fails, writing formats it and a repeated check passes. The temporary fixture is removed before committing. This verifies the real formatter without adding tests that duplicate its implementation.
