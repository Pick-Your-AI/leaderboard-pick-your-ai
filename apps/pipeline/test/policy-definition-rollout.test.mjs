import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { harness, components, getBoard, publicScope, fiveAuthorIssuePayloads } from "./harness.mjs";
import { createPipeline } from "../src/index.mjs";
import { createConfigurationManager } from "../../controls/src/configuration.mjs";

// This is an explicit synthetic protected-host composition. Sessions, source
// permission and external notes publication are fixture authority. Policy review,
// configuration receipts, runtime replacement, SQL publication and public reads
// use the actual implementation. It is not a production policy approval.
test("a protected host reviews, replaces and reverses a metric definition without rewriting its frozen history", async (t) => {
  const stable = components.metrics.stableJSON;
  const hash = (value) => createHash("sha256").update(stable(value)).digest("hex");
  const baselineGrants = new Set();
  const noteURL = (version) => `https://github.com/synthetic-org/synthetic-repo/blob/main/policies/${version}.md`;
  const h = await harness(t, {
    // Keep this definition-rank transition above the separate display threshold.
    // The ordinary two-author fixture still exercises small-cohort presentation.
    transformPayloads: fiveAuthorIssuePayloads,
    configure(config) {
      config.policies[0].policyLink = noteURL(config.policies[0].policy.version);
      baselineGrants.add(stable(config));
    },
    verifyConfiguration: async (config) => baselineGrants.has(stable(config)),
    authorizePolicyPreview: async ({ operatorId }) => operatorId === "201",
    authorizePolicyRelease: async ({ operatorId, approvalReceipt }) =>
      operatorId === "202" && ["synthetic-release-forward", "synthetic-release-rollback"].includes(approvalReceipt),
    policyApproverIds: ["202"],
  });
  const originalPolicy = structuredClone(h.config.policies[0].policy);
  const nextPolicy = { ...originalPolicy, version: "synthetic-policy-v2", rank: false };
  const definitions = new Map([
    [originalPolicy.version, originalPolicy],
    [nextPolicy.version, nextPolicy],
  ]);
  const hostNotes = new Map();
  const transitionReceipts = new Map();
  const sourceReports = [];
  const role = { roles: ["operator"], version: "synthetic-operator-v1" };
  const sessions = new Map(
    ["201", "202"].map((actorId) => [
      actorId,
      {
        sid: `synthetic-session-${actorId}`,
        actorId,
        roles: role.roles,
        roleVersion: role.version,
        csrf: `synthetic-csrf-${actorId}`,
        expires: Date.now() + 120_000,
      },
    ]),
  );
  h.controlsStore.transaction((state) => {
    for (const session of sessions.values()) state.sessions[session.sid] = structuredClone(session);
  });
  const manager = createConfigurationManager({
    store: h.controlsStore,
    knownMetricIds: [originalPolicy.metricId],
    approvedPolicyVersions: [...definitions.keys()],
    rolesForActor: (id) => (sessions.has(id) ? role : { roles: [], version: "0" }),
    configurationAuthorityCurrent: (binding) =>
      sessions.get(binding.actorId)?.roleVersion === binding.roleVersion &&
      sessions.get(binding.approverId)?.roleVersion === binding.approverRoleVersion,
    now: () => Date.now(),
    sourceVerifier: async ({ document, digest, baseRevision, phase }) => {
      const target = document.metrics[0];
      const prior = h.controlsStore.read().configuration?.active?.document.metrics[0].policyVersion;
      let policyEvidence = "synthetic-bootstrap-policy-review";
      if (prior !== undefined && prior !== target.policyVersion) {
        const release = transitionReceipts.get(`${prior}->${target.policyVersion}`);
        assert.ok(release, "synthetic host requires a reviewed definition transition");
        const saved = (
          await h.db.query(
            "SELECT document,document_hash,kind FROM leaderboard_pipeline.receipts WHERE receipt_id=$1",
            [release.receiptId],
          )
        ).rows[0];
        assert.equal(saved.kind, "policy_release_reviewed");
        assert.deepEqual(saved.document, { comparisonId: release.comparisonId, manifest: release.manifest });
        assert.equal(saved.document_hash, hash(saved.document));
        assert.equal(release.manifest.previousVersion, prior);
        assert.equal(release.manifest.targetVersion, target.policyVersion);
        assert.equal(release.manifest.targetSignature, stable(definitions.get(target.policyVersion)));
        assert.equal(release.manifest.publicEnabled, false);
        const note = hostNotes.get(target.policyLink);
        assert.ok(note, "synthetic host requires its published notes artifact");
        assert.equal(note.receiptId, release.receiptId);
        assert.equal(note.text, release.manifest.releaseNotes);
        policyEvidence = release.receiptId;
      } else {
        assert.equal(target.policyVersion, originalPolicy.version);
        assert.equal(target.policyLink, noteURL(originalPolicy.version));
      }
      const repo = await h.options.githubClient.rest("installation:1", "/repos/synthetic-org/synthetic-repo");
      assert.equal(repo.id, 2);
      assert.equal(repo.private, false);
      const verifiedAt = Date.now();
      sourceReports.push({ phase, baseRevision, digest, policyEvidence, policyVersion: target.policyVersion });
      return {
        receiptId: `synthetic-source-${baseRevision}-${phase}`,
        digest,
        baseRevision,
        verifiedAt,
        validUntil: verifiedAt + 60_000,
        repositories: [
          {
            id: "2",
            installationId: "1",
            slug: repo.full_name,
            approved: true,
            public: true,
            capabilities: [
              {
                id: "issues",
                tested: true,
                permissionVerified: true,
                permission: "synthetic-issues-read",
                schemaVersion: "synthetic-rest-v1",
                evidenceId: "synthetic-repository-source-observation",
              },
            ],
          },
        ],
        projects: [],
        metrics: [
          {
            id: target.id,
            policyVersion: target.policyVersion,
            policyLink: target.policyLink,
            policyApproved: true,
            sourceTested: true,
            evidenceId: policyEvidence,
          },
        ],
      };
    },
  });
  const invoke = async (path, input, actorId = "201") => {
    const session = structuredClone(sessions.get(actorId));
    const result = await manager({
      path,
      method: "POST",
      input,
      session,
      refreshSession: async () => structuredClone(sessions.get(actorId)),
    });
    result.beforeSend?.();
    return result.data;
  };
  const configurationDocument = (policy) => ({
    repositories: [{ id: "2", installationId: "1", slug: "synthetic-org/synthetic-repo", capabilities: ["issues"] }],
    projects: [],
    metrics: [
      { id: policy.metricId, enabled: true, policyVersion: policy.version, policyLink: noteURL(policy.version) },
    ],
  });
  const propose = async (version, policy, rollbackOf) => {
    const baseRevision = h.controlsStore.read().configuration?.revision ?? 0;
    return invoke(`/controls/configuration/${rollbackOf ? "rollback" : "proposals"}`, {
      baseRevision,
      version,
      ...(rollbackOf ? { targetDigest: rollbackOf } : { document: configurationDocument(policy) }),
    });
  };
  const activate = async (proposal) => {
    const path = `/controls/configuration/proposals/${proposal.id}`;
    const preview = await invoke(path + "/preview", { version: proposal.versionNumber });
    await assert.rejects(
      invoke(path + "/approve", {
        version: preview.versionNumber,
        previewDigest: preview.preview.digest,
        conflict: false,
      }),
      /Independent operator approval required/,
    );
    const approved = await invoke(
      path + "/approve",
      {
        version: preview.versionNumber,
        previewDigest: preview.preview.digest,
        conflict: false,
      },
      "202",
    );
    const active = await invoke(path + "/activate", {
      version: approved.versionNumber,
      approvalId: approved.approval.id,
    });
    assert.equal(active.status, "activated");
    assert.equal(active.approval.actor, "202");
    return active;
  };
  const frozenRows = async () =>
    (
      await h.db.query(
        "SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.frozen_inputs ORDER BY snapshot_id",
      )
    ).rows;
  const bootstrap = await activate(await propose("synthetic-controls-v1", originalPolicy));
  let runtime = h.runtime;
  const initial = (await runtime.runOnce()).publications[0];
  const before = await getBoard(runtime);
  assert.equal(before.methodology[0].policyVersion, originalPolicy.version);
  assert.equal(before.rows.length, 5);
  assert.deepEqual(new Set(before.rows.map((row) => row.actorId)), new Set(["101", "102", "103", "104", "105"]));
  assert.ok(before.rows.every((row) => row.rank === 1));
  const originalFrozen = await frozenRows();
  const initialFacts = originalFrozen[0].document.frozen.facts;
  const snapshots = [initial.snapshotId];

  const release = async (snapshotId, policy, direction, notes) => {
    const headBefore = (await h.db.query("SELECT snapshot_id FROM leaderboard_pipeline.heads")).rows;
    const preview = await runtime.previewPolicy({ snapshotId, policy, operatorId: "201" });
    assert.equal(preview.comparison.before.datasetId, preview.comparison.after.datasetId);
    assert.equal(preview.comparison.before.cutoff, preview.comparison.after.cutoff);
    assert.equal(preview.comparison.changes.length, 5);
    await assert.rejects(
      runtime.approvePolicyComparison({
        comparisonId: preview.comparisonId,
        operatorId: "201",
        approvalReceipt: `synthetic-release-${direction}`,
        releaseNotes: notes,
      }),
      /policy_release_not_authorized/,
    );
    const result = await runtime.approvePolicyComparison({
      comparisonId: preview.comparisonId,
      operatorId: "202",
      approvalReceipt: `synthetic-release-${direction}`,
      releaseNotes: notes,
    });
    assert.equal(result.manifest.publicEnabled, false);
    assert.equal(result.manifest.targetVersion, policy.version);
    assert.equal(result.manifest.releaseNotes, notes);
    assert.deepEqual((await h.db.query("SELECT snapshot_id FROM leaderboard_pipeline.heads")).rows, headBefore);
    assert.deepEqual(
      await runtime.approvePolicyComparison({
        comparisonId: preview.comparisonId,
        operatorId: "202",
        approvalReceipt: `synthetic-release-${direction}`,
        releaseNotes: notes,
      }),
      result,
    );
    transitionReceipts.set(`${result.manifest.previousVersion}->${policy.version}`, result);
    // The external notes publisher is explicit synthetic host behavior; the
    // actual configuration verifier and public methodology bind its exact URL.
    hostNotes.set(noteURL(policy.version), Object.freeze({ receiptId: result.receiptId, text: notes }));
    return result;
  };
  const replaceBaseline = async (active, policy) => {
    const previousRuntime = runtime;
    const next = structuredClone(h.config);
    next.version = active.version;
    next.approvalReceipt = `synthetic-baseline-${active.digest}`;
    next.policies = [
      {
        policy,
        signature: stable(policy),
        approvalReceipt: active.source.metrics[0].evidenceId,
        policyLink: active.document.metrics[0].policyLink,
      },
    ];
    // Configuration activation does not choose executable metric definitions.
    // The protected host explicitly revokes/stops the old baseline and admits
    // the exact independently source-tested replacement before starting it.
    baselineGrants.clear();
    await previousRuntime.stop();
    assert.equal(await previousRuntime.source.read(publicScope, snapshots.at(-1), new AbortController().signal), null);
    baselineGrants.add(stable(next));
    runtime = await createPipeline({ ...h.options, config: next });
    const startedRuntime = runtime;
    t.after(() => startedRuntime.stop());
    const publication = (await runtime.runOnce()).publications[0];
    snapshots.push(publication.snapshotId);
    const board = await getBoard(runtime);
    assert.equal(board.methodology[0].policyVersion, policy.version);
    assert.equal(board.methodology[0].policySignature, hash(policy));
    assert.equal(board.methodology[0].policyLink, noteURL(policy.version));
    return board;
  };

  const forwardProposal = await propose("synthetic-controls-v2", nextPolicy);
  await assert.rejects(
    invoke(`/controls/configuration/proposals/${forwardProposal.id}/preview`, {
      version: forwardProposal.versionNumber,
    }),
    /synthetic host requires a reviewed definition transition/,
  );
  const forward = await release(
    initial.snapshotId,
    nextPolicy,
    "forward",
    "Synthetic release: retain observed totals without ranking.",
  );
  const next = await replaceBaseline(await activate(forwardProposal), nextPolicy);
  assert.equal(next.rows.length, 5);
  assert.ok(next.rows.every((row) => row.rank === null));
  assert.deepEqual(
    (await frozenRows()).find((row) => row.snapshot_id === initial.snapshotId),
    originalFrozen[0],
  );

  const rollbackProposal = await propose("synthetic-controls-v3", originalPolicy, bootstrap.digest);
  await assert.rejects(
    invoke(`/controls/configuration/proposals/${rollbackProposal.id}/preview`, {
      version: rollbackProposal.versionNumber,
    }),
    /synthetic host requires a reviewed definition transition/,
  );
  const rollback = await release(
    snapshots.at(-1),
    originalPolicy,
    "rollback",
    "Synthetic reversal: restore the prior dense-ranking definition.",
  );
  const restored = await replaceBaseline(await activate(rollbackProposal), originalPolicy);
  const semanticRows = (board) =>
    board.rows.map((row) => {
      const { coverage, ...result } = row.result;
      return { actorId: row.actorId, rank: row.rank, result };
    });
  assert.deepEqual(semanticRows(restored), semanticRows(before));
  for (const row of restored.rows) {
    const prior = before.rows.find((candidate) => candidate.actorId === row.actorId).result.coverage;
    const {
      sourceWatermark: priorWatermark,
      lastSuccessfulSync: priorSync,
      windowEnd: priorEnd,
      ...priorCoverage
    } = prior;
    const { sourceWatermark, lastSuccessfulSync, windowEnd, ...coverage } = row.result.coverage;
    assert.deepEqual(coverage, priorCoverage);
    assert.equal(coverage.knownStart, null);
    assert.equal(coverage.state, "partial");
    assert.deepEqual(coverage.sourceErrors, ["source_collection_failed"]);
    for (const [current, previous] of [
      [sourceWatermark, priorWatermark],
      [lastSuccessfulSync, priorSync],
      [windowEnd, priorEnd],
    ]) {
      assert.equal(typeof current, "string");
      assert.equal(typeof previous, "string");
      assert.ok(components.contracts.compareSourceInstants(current, previous) >= 0);
    }
  }
  assert.equal(new Set(snapshots).size, 3);
  const frozen = await frozenRows();
  assert.equal(frozen.length, 3);
  assert.ok(frozen.every((row) => stable(row.document.frozen.facts) === stable(initialFacts)));
  assert.deepEqual(
    snapshots.map((snapshotId) => frozen.find((row) => row.snapshot_id === snapshotId).document.policies[0].policy),
    [originalPolicy, nextPolicy, originalPolicy],
  );
  assert.ok(
    frozen.every((row) =>
      row.document.frozen.coverage.every(
        (entry) =>
          entry.state === "partial" &&
          entry.knownStart === null &&
          entry.sourceErrors.includes("historical_capability_not_certified"),
      ),
    ),
  );
  assert.deepEqual(
    frozen.find((row) => row.snapshot_id === initial.snapshotId),
    originalFrozen[0],
  );
  assert.equal(forward.manifest.previousVersion, originalPolicy.version);
  assert.equal(rollback.manifest.previousVersion, nextPolicy.version);
  assert.equal(rollback.manifest.targetSignature, forward.manifest.previousSignature);
  const releases = (await runtime.receipts()).filter((row) => row.kind === "policy_release_reviewed");
  assert.equal(releases.length, 2);
  assert.deepEqual(new Set(releases.map((row) => row.receipt_id)), new Set([forward.receiptId, rollback.receiptId]));
  assert.equal(sourceReports.filter((row) => row.policyEvidence === forward.receiptId).length, 2);
  assert.equal(sourceReports.filter((row) => row.policyEvidence === rollback.receiptId).length, 2);
  const reopened = new components.controls.ControlStore(join(h.directory, "controls.sqlite"));
  try {
    const state = reopened.read().configuration;
    assert.equal(state.revision, 3);
    assert.equal(state.active.rollbackOf, bootstrap.digest);
    assert.equal(state.active.document.metrics[0].policyVersion, originalPolicy.version);
    assert.equal(state.history.filter((row) => row.action === "activated").length, 3);
  } finally {
    reopened.close();
  }
});
