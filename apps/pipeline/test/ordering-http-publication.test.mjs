// Actual protected localhost HTTP plus public handlers and disposable stores.
// The source/identity provider is synthetic; this is not live GitHub evidence.
import test from "node:test";
import assert from "node:assert/strict";
import {
  orderingSource,
  orderingEnvelope,
  orderingControls,
  orderingReview,
  orderingBinding,
  orderingAt,
  orderingPolicyVersion,
} from "../../../tests/fixtures/ordering.mjs";
import { recognitionFingerprint } from "../src/recognition-adapter.mjs";

test("ordering HTTP acceptance reaches public count/proof/export and withdrawal revokes current and pinned reads", async (t) => {
  const { harness, components, publicScope } = await import("./harness.mjs");
  const input = orderingSource(),
    binding = orderingBinding();
  const publicationCutoff = "2026-10-19T04:00:00.000Z";
  const h = await harness(t, {
    markerFreeConfig: true,
    dataMode: "public",
    payloads: [orderingEnvelope().payload],
    normalizerFactory: () => async () => structuredClone(input),
    defaultDeliveryNormalizationVersion: components.github.defaultDeliveryNormalizationVersion,
    configure(config) {
      config.recognitionBindings = [binding];
      const policy = {
        ...config.policies[0].policy,
        metricId: "issue_ordering",
        version: orderingPolicyVersion,
        unit: components.metrics.getMetricDefinition("issue_ordering").definition.unit,
        dateBasis: "acceptedAt",
        rankedStates: ["qualified"],
        groupBy: "canonical",
        roles: ["reporter"],
        minimumSamples: 1,
        rank: false,
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "fixture-approval" },
      ];
    },
  });
  const controls = await orderingControls(t, { store: h.controlsStore });
  const owner = await controls.login("101"),
    reviewer = await controls.login("202"),
    request = await controls.submit(owner);
  const accepted = await controls.call(`/controls/requests/${request.id}/review`, {
    user: reviewer,
    input: orderingReview(request, input),
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  const acceptedRequest = h.controlsStore.read().requests[request.id];
  assert.equal(acceptedRequest.status, "accepted");
  assert.ok(acceptedRequest.history.at(-1).ordering);
  assert.equal(new Date(acceptedRequest.history.at(-1).at).toISOString(), orderingAt);
  const publication = await h.runtime.runOnce({ cutoff: publicationCutoff });
  assert.equal(publication.state, "published");
  const snapshotId = publication.publications[0].snapshotId;
  const read = await h.runtime.source.read(publicScope, snapshotId, new AbortController().signal);
  assert.equal(read.selected.rows[0].result.value, 1);
  const proof = read.selected.evidence.find((entry) => entry.contribution.metricIds.includes("issue_ordering"));
  assert.ok(proof);
  assert.equal(proof.occurredAt, orderingAt);
  const paths = [
    `/api/v1/boards?metric=issue_ordering&snapshot=${snapshotId}`,
    `/api/v1/contributors/101?metric=issue_ordering&snapshot=${snapshotId}`,
    `/api/v1/evidence/${proof.contribution.contributionId}?snapshot=${snapshotId}`,
    `/api/v1/exports?metric=issue_ordering&format=json&snapshot=${snapshotId}`,
    `/api/v1/exports?metric=issue_ordering&format=csv&snapshot=${snapshotId}`,
  ];
  for (const path of paths) {
    const response = await h.runtime.app.inject(path);
    assert.equal(response.statusCode, 200, response.body);
    assert.doesNotMatch(response.body, /PRIVATE_ORDERING_DETAIL|CHILD_1|ordering-review\/v1|ordering_contributor/);
  }
  const fingerprint = recognitionFingerprint(h.controlsStore.read(), [binding]);
  const withdrawn = await controls.call(`/controls/requests/${request.id}/withdraw`, {
    user: owner,
    input: { version: acceptedRequest.version },
  });
  assert.equal(withdrawn.status, 200);
  assert.notEqual(recognitionFingerprint(h.controlsStore.read(), [binding]), fingerprint);
  for (const pin of [null, snapshotId])
    assert.equal(await h.runtime.source.read(publicScope, pin, new AbortController().signal), null);
  for (const path of paths) {
    const response = await h.runtime.app.inject(path);
    assert.equal(response.statusCode, 410, response.body);
    assert.match(response.headers["cache-control"], /no-store/);
  }
});
