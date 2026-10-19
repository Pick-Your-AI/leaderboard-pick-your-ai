import test from "node:test";
import assert from "node:assert/strict";
import { createPipeline } from "../src/index.mjs";
import { issueTransferDigest } from "../src/issue-transfer-store.mjs";
import { harness, boardUrl } from "./harness.mjs";
import { issueTransferHarness } from "./issue-transfer-harness.mjs";

for (const { typed, optionalPolicyLink = false } of [
  { typed: false },
  { typed: true },
  { typed: false, optionalPolicyLink: true },
])
  test(`unchanged ${typed ? "typed-transfer" : "ordinary"}${optionalPolicyLink ? " with explicit undefined policyLink" : ""} publication recovery retains its original observation input`, async (t) => {
    const cutoff = new Date().toISOString();
    let observationTime = Date.now() + 30_000;
    const now = () => new Date(observationTime).toISOString();
    let h;
    if (typed) {
      const original = await issueTransferHarness(t);
      await original.runtime.stop();
      const runtime = await createPipeline({ ...original.options, now });
      t.after(() => runtime.stop());
      h = { ...original, runtime };
    } else
      h = await harness(t, {
        now,
        configure(config) {
          if (optionalPolicyLink) config.policies[0].policyLink = undefined;
        },
      });

    h.controlsStore.db.exec(
      "CREATE TRIGGER synthetic_recovery_failure BEFORE INSERT ON pipeline_aggregate_explanations BEGIN SELECT RAISE(ABORT, 'synthetic_recovery_failure'); END",
    );
    await assert.rejects(h.runtime.runOnce({ cutoff }), /synthetic_recovery_failure/);
    const saved = (
      await h.db.query("SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.frozen_inputs")
    ).rows;
    assert.equal(saved.length, 1, "The failed confirmation leaves one committed immutable SQL input");
    const original = saved[0];
    assert.equal(
      issueTransferDigest(original.document),
      original.document_hash,
      "The frozen hash must bind the exact JSON document persisted by SQL",
    );
    if (optionalPolicyLink) {
      assert.equal(Object.hasOwn(h.config.policies[0], "policyLink"), true);
      assert.equal(h.config.policies[0].policyLink, undefined);
      assert.equal(Object.hasOwn(original.document.policies[0], "policyLink"), false);
      assert.equal(original.document.identityAuthorization.configurationHash, issueTransferDigest(h.config));
    }
    assert.equal(original.document.frozen.cutoff, now());
    assert.equal(original.document.identityAuthorization.issueTransferEvidence.bindings.length > 0, typed);
    const snapshotId = original.snapshot_id;
    const readFrozen = async () =>
      (
        await h.db.query(
          "SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1",
          [snapshotId],
        )
      ).rows[0];
    const receipts = (
      await h.db.query(
        "SELECT operation_key,document,document_hash FROM leaderboard_pipeline.receipts WHERE kind='snapshot_published'",
      )
    ).rows;
    assert.equal(receipts.length, 1);
    const publicationReceipt = receipts[0];
    h.controlsStore.db.exec("DROP TRIGGER synthetic_recovery_failure");
    observationTime += 5_000;
    const recovered = await h.runtime.runOnce({ cutoff });
    const publication = recovered.publications.find((entry) => entry.snapshotId === snapshotId);
    assert.ok(publication);
    assert.equal(publication.changed, false);
    const explanation = h.controlsStore.db
      .prepare("SELECT document FROM pipeline_aggregate_explanations WHERE snapshot_id=?")
      .get(snapshotId);
    const confirmed = JSON.parse(explanation.document);
    t.diagnostic(
      JSON.stringify({
        typed,
        snapshotId,
        retainedObservationCutoff: original.document.frozen.cutoff,
        retriedObservationClock: now(),
        confirmedExplanationCutoff: confirmed.cutoff,
      }),
    );
    assert.equal(confirmed.cutoff, original.document.frozen.cutoff);
    assert.deepEqual(await readFrozen(), original);
    assert.deepEqual(
      (
        await h.db.query(
          "SELECT operation_key,document,document_hash FROM leaderboard_pipeline.receipts WHERE operation_key=$1",
          [publicationReceipt.operation_key],
        )
      ).rows[0],
      publicationReceipt,
    );
    const path = typed ? `${boardUrl}&context=current` : boardUrl;
    const visible = await h.runtime.app.inject(`${path}&snapshot=${snapshotId}`);
    assert.equal(visible.statusCode, 200, visible.body);
    assert.equal(visible.json().snapshotId, snapshotId);

    if (!typed) {
      // Model lost private confirmation in this disposable fixture. The SQL
      // publication, original frozen input and receipt are still the originals;
      // recovery must verify them before writing any private replacement.
      const key = h.controlsStore.read().pipelinePublications[snapshotId].scopeKey;
      h.controlsStore.transaction((state) => {
        delete state.pipelinePublications[snapshotId];
        delete state.pipelineHeads[key];
        h.controlsStore.db.prepare("DELETE FROM pipeline_aggregate_explanations WHERE snapshot_id=?").run(snapshotId);
      });
      const controlsBefore = h.controlsStore.read();
      const previewsBefore = h.controlsStore.db.prepare("SELECT * FROM policy_preview_inputs ORDER BY id").all();
      const assertUnconfirmed = () => {
        assert.deepEqual(h.controlsStore.read(), controlsBefore);
        assert.deepEqual(
          h.controlsStore.db.prepare("SELECT * FROM policy_preview_inputs ORDER BY id").all(),
          previewsBefore,
        );
        assert.equal(
          h.controlsStore.db.prepare("SELECT count(*) AS n FROM pipeline_aggregate_explanations").get().n,
          0,
        );
      };
      const changed = structuredClone(original.document);
      changed.frozen.cutoff = now();
      await h.db.query(
        "UPDATE leaderboard_pipeline.frozen_inputs SET document=$2::jsonb,document_hash=$3 WHERE snapshot_id=$1",
        [snapshotId, JSON.stringify(changed), issueTransferDigest(changed)],
      );
      await assert.rejects(h.runtime.runOnce({ cutoff }), /retained_publication_input_conflict/);
      assertUnconfirmed();
      await h.db.query(
        "UPDATE leaderboard_pipeline.frozen_inputs SET document=$2::jsonb,document_hash=$3 WHERE snapshot_id=$1",
        [snapshotId, JSON.stringify(original.document), original.document_hash],
      );
      const changedReceipt = {
        ...publicationReceipt.document,
        comparisonInputHash: "f".repeat(64),
      };
      await h.db.query(
        "UPDATE leaderboard_pipeline.receipts SET document=$2::jsonb,document_hash=$3 WHERE operation_key=$1",
        [publicationReceipt.operation_key, JSON.stringify(changedReceipt), issueTransferDigest(changedReceipt)],
      );
      await assert.rejects(h.runtime.runOnce({ cutoff }), /retained_publication_input_conflict/);
      assertUnconfirmed();
    }
  });
