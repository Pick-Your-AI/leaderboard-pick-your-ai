# Checked web build preparation

The [site preparation workflow](../.github/workflows/prepare-site.yml) retains
the web output of an exact, successfully checked main-push revision. It supplies
a downloadable build candidate for the existing [hosting work](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/48)
and [release transition](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/131).

## Source and artifact identity

The workflow admits only a successful `Runtime scaffold checks` run whose event
is a push to this repository's `main`. It checks out that run's `head_sha`,
verifies the checkout, installs the locked dependencies with Node.js 24 and
npm 12.2.0, and runs the repository's production build.

Each retained artifact name contains the source commit, Runtime run ID and
attempt, and preparation run ID and attempt. The artifact contains:

- `public/`: the built web files, including the required `index.html`.
- `build-provenance.json`: the source and both run identities, the preparation
  workflow's own revision and ref, and every web file's relative path, byte
  count and SHA-256.

The preparation workflow revision is recorded separately because GitHub's
[`workflow_run` event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
uses the default branch's workflow rather than treating its own `GITHUB_SHA` as
the triggering run's source. The workflow begins triggering after this file is
accepted onto the default branch. Existing PR checks alone do not execute this
new event path.

The preparation rejects a missing or empty `index.html`; empty ancillary files
are allowed. The upload has seven-day retention and cannot overwrite an existing
artifact. Hidden files, links and special files are rejected before
copying, so the explicit manifest covers the uploaded public file set. A failed
build or provenance step prevents the upload. The pinned
[`upload-artifact` action](https://github.com/actions/upload-artifact) also records
the artifact ID and archive digest in the run.

An older Runtime run may finish after a newer one. Both may retain independently
named candidates. Completion order selects no deployment, and there is no mutable
`latest` artifact, shared cancellation group, deployment-branch push or overwrite.
A future release receiver must select and verify the exact source, artifact and
appropriate run evidence; it must not choose whichever run finished last.

## Hosting and release handoff

This workflow has read-only repository permissions and publishes no Git branch
or hosted site. It creates no Apache configuration or `/api/` rejection rule.
The frontend's default `/api/v1` requests still require the same-origin service
in the accepted [hosting architecture](hosting-architecture.md). A static build
does not supply that gateway, the Node runtime, durable stores or protected
controls.

The selected gateway and protected host still need implementation and staging
verification under #48. Deployment additionally requires the exact environment,
enabled-capability manifest, accepted rollback target, receiving authority and
evidence specified by the [release policy](release-decision.md) and
[release manifest](../planning/release-manifest.json). Automatic production
publication remains disabled until that transition is accepted. Retaining this
candidate supplies no host, source activation, operator acknowledgement,
anonymous API readback or public-release acceptance.
