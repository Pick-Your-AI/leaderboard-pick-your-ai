import assert from "node:assert/strict";
import { harness, components, ago, fixtureId, publicScope } from "./harness.mjs";

export const operatorAllow = async () => ({ policyVersion: "synthetic-operator-policy", revision: "grant-1" });
export const operatorSettings = (configurationCurrent = () => true) => ({
  freshnessBudgetSeconds: 60,
  configurationCurrent,
});
export const operatorScopes = [publicScope, { ...publicScope, repository: "2" }];

export async function operatorHarness(t, extra = {}) {
  const h = await harness(t, {
    source: undefined,
    probeRepository: undefined,
    operatorDiagnostics: operatorSettings(),
    ...extra,
  });
  assert.equal(await h.runtime.collection.verifyPublic(2, 1, null), true);
  return h;
}
export async function insertOperatorDelivery(h, n = 1, occurredAt = ago(2)) {
  return h.runtime.inbox.insert({
    deliveryId: fixtureId(n),
    bodyHash: "a".repeat(64),
    envelope: {
      version: "github-delivery/v1",
      deliveryId: fixtureId(n),
      event: "issues",
      action: "opened",
      installationId: 1,
      repositoryId: 2,
      subjectId: "SYNTHETIC_ISSUE_1",
      sourceUrl: "https://github.com/synthetic-org/synthetic-repo/issues/1",
      actorId: null,
      occurredAt,
    },
  });
}
export async function queueOperatorReplay(h, n = 1) {
  await insertOperatorDelivery(h, n);
  const failing = new components.ingestion.InboxStore(h.db, 1);
  assert.equal(await failing.fail(await failing.claim(), "source_unavailable", true), true);
  const row = (await h.runtime.operations.read(2, operatorAllow)).quarantined.find(
    (entry) => entry.deliveryId === fixtureId(n),
  );
  return h.runtime.operations.replay(
    {
      repositoryId: 2,
      deliveryId: row.deliveryId,
      expectedRevision: row.revision,
      reason: "source_recovered",
      operatorId: "201",
    },
    operatorAllow,
  );
}
export async function publishedOperatorReplay(t, extra = {}) {
  const h = await operatorHarness(t, {
    webhookDispatch: true,
    configure: (config) => {
      config.scopes = operatorScopes;
    },
    ...extra,
  });
  const receipt = await queueOperatorReplay(h);
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  return { h, receipt };
}
