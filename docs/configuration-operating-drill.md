# Local configuration operating drill

This bounded drill connects the mounted administration and public browser views to the existing controls HTTP server, SQLite store, pipeline, PGlite database and public HTTP API. It supplies a separate synthetic source provider and synthetic browser-identity provider through the existing host interfaces. It does not call GitHub or claim an actual installation permission, human policy decision, deployed OAuth callback, or production operating approval.

The source observations live in `tests/fixtures/configuration-operating-source.json`. The test hashes the exact bytes. Its independent provider derives repository membership, capability permission, response-schema checks, Project field types and policy/source eligibility from that fixture. Proposal input supplies only the digest and revision that bind a returned observation. An unknown repository, mismatched Project type and removed permission each reject the preview. No proposed permission or approval boolean is echoed as evidence.

## Run the coherent journey

Use the repository's Node/npm toolchain and installed browser prerequisites. Build the current receiving checkout before the browser test so every compiled component matches its source:

```bash
npm run build
node --test apps/controls/test/configuration-canonical-reproposal.test.mjs
npx playwright test --config apps/web/playwright.config.ts configuration-operating-drill.spec.ts --workers=1
```

The test uses disposable local databases and binds its HTTP listeners to loopback. It keeps the ordinary browser action and expectation deadlines and uses no retries. The browser route bridge forwards the actual method, path, body and CSRF header to the controls server, and forwards actual public HTTP responses without synthesizing response JSON. The bridge supplies the synthetic session cookie and configured origin; this verifies the mounted client/handler interaction, not production cross-origin deployment or browser Secure-cookie enforcement.

The journey performs these operations in order:

1. Complete the real identity adapter's empty-scope exchange and token-revocation paths through a controlled synthetic fetch provider. Three different numeric identities deliberately share one untrusted login string. Anonymous access, a nonoperator, bad CSRF, a foreign origin, an injected profile actor ID and an arbitrary profile link are denied.
2. Submit all 98 registry entries with two enabled measures and an explicit synthetic reason for the others. Mount a proposal, source-tested preview, independent approval by the second operator, and activation at revision 1. A self-approval and unapproved activation fail.
3. Make the independent source provider unavailable. Use the real Disable form to disable only `issues_opened`, retaining `pr_opened`, repository scope, Project fields and historical policy. The restrictive preview/activation inherits the prior activation without pretending to have obtained a fresh source receipt. The unchanged nonempty PR board still reads successfully; the pinned issue board returns the actual disabled response. The mounted public view shows unavailable values and the historical policy version and link.
4. Stop and recreate the controls HTTP server and pipeline, close and reopen the actual SQLite connection and PGlite database, and verify the entire durable configuration and both pinned public outcomes. Propose restoration of the previous digest. Source verification fails during the outage; restoring the provider enables a fresh preview, independent approval and revision 3. The original board rows return, and the audit preserves every proposal digest, action, actor and revision.
5. Replace the synthetic host OAuth secret. The old adapter fails against the changed provider; recreating the adapter with the replacement succeeds without changing the stable numeric identity. Re-login invalidates the previous session, and a later role-version revocation denies the revoked operator while preserving the independent operator. Raw identity tokens and host secrets are absent from durable controls state.

The JSON attachments contain observed requests, immutable source hashes, source receipts and configuration checkpoints. A screenshot records the disabled historical-policy view. They contain synthetic data only. A passing browser report must identify this exact case, execute it once with no failures or retries, and accompany the exact source hashes; a source-only review or an older browser run cannot substitute for that execution.

## Canonical reason repair

The drill exposed a stored-document round-trip defect. The normalizer represented an omitted enabled reason as the canonical empty string, but then rejected that same value when the Disable form resubmitted the other enabled metrics. The repair accepts that literal empty string only in the enabled branch. Disabled metrics still require a nonempty bounded explanation; whitespace-only, control-character and overlength supplied reasons remain invalid. The small regression suite covers the serialized stored-document round trip, the real form transformation and those denial cases. Registry membership, policy approval, source validation, independent approval and final activation authority remain unchanged.

## Acceptance boundary and next stage

This is local operating evidence for the configuration lifecycle and its adjacent identity/denial boundaries. All provider grants, schemas, policy decisions and identities in this drill are synthetic and remain separate from production source authorization. The existing pipeline baseline and current controls overlay are both enforced; a configuration proposal cannot grant new upstream collection rights.

The drill does not claim full completion of [configuration work](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/101), [moderation and operations](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/93), or [authentication and authorization](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/53). Durable inbox replay and contribution exclusion are a separate next stage through the existing operation and correction interfaces; their earlier independent tests are not relabeled as execution by this journey. Reviewer/privacy workflows, real source-capability receipts and deployed callback/host-secret delivery also retain their own actual acceptance scopes.
