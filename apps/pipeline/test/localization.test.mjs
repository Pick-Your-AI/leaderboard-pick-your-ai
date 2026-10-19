import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createPipeline } from "../src/index.mjs";
import { normalizationDocumentVersion } from "../src/private-attribution.mjs";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { record as recordControlsDecision } from "../../controls/src/store.mjs";
import { localizationReviewRequest } from "../../controls/src/localization-review.mjs";
import { components, harness, publicScope } from "./harness.mjs";

async function localizationHarness(t, configure = () => {}, enrich = (value) => value) {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const ago = (days) => new Date(now - days * 86_400_000).toISOString();
  const before = "b".repeat(40),
    after = "c".repeat(40),
    mergedAt = ago(1);
  const mergeWindow = { ...publicScope, start: ago(1.5), end: ago(0.75) };
  const reviewWindow = { ...publicScope, start: mergeWindow.end, end: ago(0.25) };
  const payload = {
    id: 1001,
    node_id: "SYNTHETIC_PR_LOCALE",
    number: 1,
    html_url: "https://github.com/synthetic-org/synthetic-repo/pull/1",
    created_at: ago(2),
    updated_at: mergedAt,
    merged_at: mergedAt,
    closed_at: mergedAt,
    state: "closed",
    merged: true,
    draft: false,
    merge_commit_sha: after,
    base: { ref: "main" },
    user: { id: 101, node_id: "U_SYNTHETIC_A", login: "synthetic-alice", type: "User" },
  };
  const h = await harness(t, {
    payloads: [payload],
    configure(config) {
      config.repositories[0].families = ["pull_requests"];
      config.documentationPolicies = [
        {
          repositoryId: 2,
          version: "synthetic-locales-v1",
          documentationPaths: ["docs/"],
          researchPaths: [],
          generatedPaths: ["docs/fr/generated/"],
          importedPaths: [],
          localizationPaths: [
            { locale: "fr", category: "documentation", paths: ["docs/fr/"] },
            { locale: "de", category: "documentation", paths: ["docs/de/"] },
          ],
        },
      ];
      const policy = {
        ...config.policies[0].policy,
        metricId: "localization",
        unit: components.metrics.getMetricDefinition("localization").definition.unit,
        rankedStates: ["qualified"],
        dateBasis: "occurredAt",
        roles: ["author"],
        groupBy: "canonical",
        rank: false,
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-localization-policy" },
      ];
      config.recognitionBindings = [
        {
          category: "other",
          scope: "repository:2:locale:fr:documentation",
          policyVersion: policy.version,
          metricId: "localization",
          sourceMetricId: "localization",
          repositoryId: "2",
          reviewerIds: ["202"],
          localization: { locale: "fr", category: "documentation", policyVersion: "synthetic-locales-v1" },
        },
      ];
      config.scopes = [publicScope, mergeWindow, reviewWindow];
      configure(config);
    },
    enrichmentFactory(client, slug) {
      return async (input) =>
        enrich({
          repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
          proof: { verified: true, source: "github_rest", revision: input.fact.sourceRevision, isSynthetic: true },
          family: "pull_request",
          observedAt: input.observedAt,
          payload: { pull_request: await client.rest("installation:1", `/repos/${slug}/pulls/1`) },
          integration: {
            before,
            after,
            targetBranch: "main",
            defaultBranch: "main",
            canonicalChangeId: "synthetic-locales-merge",
            commitShas: [after],
            diff: {
              before,
              after,
              complete: true,
              files: [
                { path: "docs/fr/first.md", additions: 1, deletions: 0 },
                { path: "docs/fr/second.md", additions: 1000, deletions: 0 },
                { path: "docs/de/first.md", additions: 0, deletions: 2 },
                { path: "docs/fr/generated/api.md", additions: 10000, deletions: 0 },
              ],
            },
          },
        });
    },
  });
  return { ...h, ago, after, mergedAt, mergeWindow, reviewWindow, payload };
}

test("the configured locale budget publishes a supported 62-file PR with all 32 locale/category units", async (t) => {
  const h = await localizationHarness(
    t,
    (config) => {
      config.documentationPolicies[0].localizationPaths = Array.from({ length: 32 }, (_, index) => ({
        locale: "en",
        category: `category_${index}`,
        paths: [`docs/category_${index}/`],
      }));
      config.recognitionBindings = [];
    },
    (envelope) => {
      envelope.integration.diff.files = Array.from({ length: 62 }, (_, index) => ({
        path: `docs/category_${index % 32}/file_${index}.md`,
        additions: 1,
        deletions: 1,
      }));
      return envelope;
    },
  );
  const publication = await h.runtime.runOnce();
  assert.equal(publication.state, "published");
  const normalized = (await h.db.query("SELECT document FROM leaderboard_pipeline.normalizations")).rows[0].document;
  assert.equal(normalized.facts.length, 101);
  assert.equal(normalized.evidence.length, 101);
  const read = await h.runtime.source.read(
    publicScope,
    publication.publications[0].snapshotId,
    new AbortController().signal,
  );
  assert.equal(
    read.selected.portfolioEvidence.filter((entry) => entry.contribution.metricIds.includes("localization")).length,
    32,
  );
});

test("locale slots cannot expand the existing ordinary normalization record budget", async (t) => {
  const h = await localizationHarness(
    t,
    (config) => {
      config.recognitionBindings = [];
    },
    (envelope) => {
      envelope.integration.diff.files = Array.from({ length: 94 }, (_, index) => ({
        path: `docs/fr/file_${index}.md`,
        additions: 1,
        deletions: 0,
      }));
      return envelope;
    },
  );
  await assert.rejects(h.runtime.runOnce(), /invalid_normalized_evidence/);
  assert.equal(
    Number((await h.db.query("SELECT COUNT(*) AS count FROM leaderboard_pipeline.normalizations")).rows[0].count),
    0,
  );
});

async function acceptLocale(h, { id = "synthetic-locale-cache-request", at = h.ago(0.5) } = {}) {
  const binding = h.config.recognitionBindings[0];
  let normalized = (await h.db.query("SELECT document FROM leaderboard_pipeline.normalizations")).rows[0]?.document;
  if (!normalized) {
    await h.runtime.runOnce();
    normalized = (await h.db.query("SELECT document FROM leaderboard_pipeline.normalizations")).rows[0].document;
  }
  const proof = normalized.evidence.find(
    (entry) =>
      entry.contribution.metricIds.includes("localization") && entry.contribution.reasonCodes.includes("locale:fr"),
  );
  assert.ok(proof, "the reviewer must select actual normalized locale proof");
  return h.controlsStore.transaction((state) => {
    const request = {
      id,
      version: 0,
      kind: "evidence",
      status: "accepted",
      owner: "101",
      category: binding.category,
      scope: binding.scope,
      policyVersion: binding.policyVersion,
      locator: h.payload.html_url,
      collaborators: {},
      history: [],
    };
    recordControlsDecision(state, request, "202", "accepted", Date.parse(at), {
      policyVersion: binding.policyVersion,
      localization: {
        ...binding.localization,
        targetFactId: proof.contribution.contributionId,
        sourceRevision: proof.sourceRevision,
      },
      evidenceRequest: localizationReviewRequest(request),
    });
    state.requests[request.id] = request;
    return { request, decision: request.history.at(-1) };
  });
}

async function localeReviewClient(t, h, at = h.ago(0.5)) {
  const origin = "https://controls.example.test";
  let currentTime = Date.parse(at);
  const server = components.controls.createControlsServer({
    store: h.controlsStore,
    origin,
    approvedPolicyVersions: [h.config.policies[0].policy.version],
    now: () => currentTime,
    rolesForActor: (actorId) => ({ roles: actorId === "202" ? ["reviewer"] : [], version: "v1" }),
    provider: {
      authorizationURL: ({ state }) => `https://github.com/login/oauth/authorize?state=${state}`,
      exchange: async ({ code }) => ({ actorId: code }),
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, user, input) {
    const response = await fetch(base + path, {
      method: input ? "POST" : "GET",
      redirect: "manual",
      headers: {
        ...(user ? { cookie: user.cookie, origin, "x-csrf-token": user.csrf } : {}),
        ...(input ? { "content-type": "application/json" } : {}),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    return {
      response,
      data: response.headers.get("content-type")?.includes("application/json") ? await response.json() : null,
    };
  }
  async function login(actorId) {
    const start = await call("/controls/auth/login");
    const state = new URL(start.response.headers.get("location")).searchParams.get("state");
    const response = await call(`/controls/auth/callback?state=${state}&code=${actorId}`, {
      cookie: start.response.headers.getSetCookie()[0].split(";")[0],
    });
    assert.equal(response.response.status, 303);
    const cookie = response.response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-controls_session="))
      .split(";")[0];
    const session = await call("/controls/session", { cookie });
    assert.equal(session.response.status, 200);
    return { cookie, csrf: session.data.csrf };
  }
  const owner = await login("101"),
    reviewer = await login("202");
  return {
    call,
    login,
    owner,
    reviewer,
    setTime(value) {
      currentTime = Date.parse(value);
    },
  };
}

test("actual controls locale acceptance survives restart but cannot be retargeted by changed configuration", async (t) => {
  const h = await localizationHarness(t);
  const first = (await h.runtime.runOnce()).publications[0];
  const read = await h.runtime.source.read(publicScope, first.snapshotId, new AbortController().signal);
  const proof = read.selected.portfolioEvidence.find((entry) => entry.contribution.reasonCodes.includes("locale:fr"));
  const binding = h.config.recognitionBindings[0];
  const client = await localeReviewClient(t, h);
  const submitted = await client.call("/controls/requests", client.owner, {
    kind: "evidence",
    locator: h.payload.html_url,
    category: binding.category,
    scope: binding.scope,
    collaborators: [],
    consent: true,
    detail: "Synthetic French source proof for independent review",
  });
  assert.equal(submitted.response.status, 201);
  const target = {
    ...binding.localization,
    targetFactId: proof.contribution.contributionId,
    sourceRevision: proof.sourceRevision,
  };
  const accepted = await client.call(`/controls/requests/${submitted.data.id}/review`, client.reviewer, {
    version: submitted.data.version,
    decision: "accept",
    reason: "Reviewed the exact synthetic locale merge",
    conflict: false,
    sourceReviewedPublic: true,
    policyVersion: binding.policyVersion,
    localization: target,
  });
  assert.equal(accepted.response.status, 200);
  const published = (await h.runtime.runOnce()).publications[0];
  assert.equal((await h.runtime.app.inject("/api/v1/boards?metric=localization")).json().rows[0].result.value, 1);
  await h.runtime.stop();
  await h.reopenDatabase();
  const restarted = await createPipeline(h.options);
  const current = await restarted.source.read(publicScope, published.snapshotId, new AbortController().signal);
  assert.equal(current.selected.rows[0].result.value, 1);
  await restarted.stop();
  const retargetedConfig = structuredClone(h.options.config);
  retargetedConfig.version = "synthetic-locale-retargeted-binding";
  retargetedConfig.recognitionBindings[0].localization.locale = "de";
  const retargeted = await createPipeline({ ...h.options, config: retargetedConfig });
  t.after(() => retargeted.stop());
  assert.equal(await retargeted.source.read(publicScope, published.snapshotId, new AbortController().signal), null);
  const next = (await retargeted.runOnce()).publications[0];
  const result = await retargeted.source.read(publicScope, next.snapshotId, new AbortController().signal);
  assert.ok(result.selected.rows.every((row) => row.result.value == null || row.result.value === 0));
  const localeProof = result.selected.portfolioEvidence.filter((entry) =>
    entry.contribution.metricIds.includes("localization"),
  );
  assert.equal(localeProof.length, 2);
  assert.ok(localeProof.every((entry) => entry.activityState === "observed"));
  const decision = h.controlsStore.read().requests[submitted.data.id].history.at(-1);
  assert.deepEqual(decision.localization, target);
});

test("locale collaborator consent returns changed attribution to review and permits a new exact acceptance", async (t) => {
  const h = await localizationHarness(t);
  const initial = (await h.runtime.runOnce()).publications[0];
  const read = await h.runtime.source.read(publicScope, initial.snapshotId, new AbortController().signal);
  const proof = read.selected.portfolioEvidence.find((entry) => entry.contribution.reasonCodes.includes("locale:fr"));
  const binding = h.config.recognitionBindings[0];
  const client = await localeReviewClient(t, h);
  const collaborator = await client.login("303");
  const submitted = await client.call("/controls/requests", client.owner, {
    kind: "evidence",
    locator: h.payload.html_url,
    category: binding.category,
    scope: binding.scope,
    collaborators: ["303"],
    consent: true,
    detail: "Synthetic locale work with declared collaborator",
  });
  assert.equal(submitted.response.status, 201);
  const target = {
    ...binding.localization,
    targetFactId: proof.contribution.contributionId,
    sourceRevision: proof.sourceRevision,
  };
  const review = async (version) =>
    client.call(`/controls/requests/${submitted.data.id}/review`, client.reviewer, {
      version,
      decision: "accept",
      reason: "Reviewed exact merged source and current attribution",
      conflict: false,
      sourceReviewedPublic: true,
      policyVersion: binding.policyVersion,
      localization: target,
    });
  assert.equal((await review(submitted.data.version)).response.status, 409);
  const consented = await client.call(`/controls/requests/${submitted.data.id}/consent`, collaborator, {
    version: submitted.data.version,
    consent: true,
  });
  assert.equal(consented.response.status, 200);
  assert.equal(consented.data.status, "pending");
  let accepted = await review(consented.data.version);
  assert.equal(accepted.response.status, 200);
  const published = (await h.runtime.runOnce()).publications[0];
  assert.equal((await h.runtime.app.inject("/api/v1/boards?metric=localization")).json().rows[0].result.value, 1);
  const oldDecision = h.controlsStore.read().requests[submitted.data.id].history.at(-1);
  const changed = await client.call(`/controls/requests/${submitted.data.id}/consent`, collaborator, {
    version: accepted.data.version,
    consent: false,
  });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.data.status, "pending");
  const request = h.controlsStore.read().requests[submitted.data.id];
  assert.equal(request.policyVersion, undefined);
  assert.deepEqual(
    request.history.find((entry) => entry.id === oldDecision.id),
    oldDecision,
  );
  assert.equal(request.history.at(-1).reviewRequired, true);
  assert.equal((await client.call("/controls/public")).data.claims.length, 0);
  assert.equal(await h.runtime.source.read(publicScope, published.snapshotId, new AbortController().signal), null);
  const pending = (await h.runtime.runOnce()).publications[0];
  const pendingRead = await h.runtime.source.read(publicScope, pending.snapshotId, new AbortController().signal);
  assert.ok(pendingRead.selected.rows.every((row) => row.result.value == null || row.result.value === 0));
  assert.equal(
    pendingRead.selected.portfolioEvidence.filter((entry) => entry.contribution.metricIds.includes("localization"))
      .length,
    2,
  );
  assert.equal((await review(changed.data.version)).response.status, 409);
  const renewed = await client.call(`/controls/requests/${submitted.data.id}/consent`, collaborator, {
    version: changed.data.version,
    consent: true,
  });
  assert.equal(renewed.response.status, 200);
  assert.equal(renewed.data.status, "pending");
  assert.equal((await client.call("/controls/public")).data.claims.length, 0);
  accepted = await review(renewed.data.version);
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.data.status, "accepted");
  const unchanged = await client.call(`/controls/requests/${submitted.data.id}/consent`, collaborator, {
    version: accepted.data.version,
    consent: true,
  });
  assert.equal(unchanged.response.status, 200);
  assert.equal(unchanged.data.status, "accepted");
  assert.equal(unchanged.data.version, accepted.data.version);
  await h.runtime.runOnce();
  assert.equal((await h.runtime.app.inject("/api/v1/boards?metric=localization")).json().rows[0].result.value, 1);
});

test("actual controls cannot preapprove a future merge and unbound historical publication authorization is revoked", async (t) => {
  const h = await localizationHarness(t);
  const initial = (await h.runtime.runOnce()).publications[0];
  const source = await h.runtime.source.read(publicScope, initial.snapshotId, new AbortController().signal);
  const proof = source.selected.portfolioEvidence.find((entry) => entry.contribution.reasonCodes.includes("locale:fr"));
  const binding = h.config.recognitionBindings[0];
  const target = {
    ...binding.localization,
    targetFactId: proof.contribution.contributionId,
    sourceRevision: proof.sourceRevision,
  };
  const client = await localeReviewClient(t, h, h.ago(1.5));
  const requestInput = {
    kind: "evidence",
    locator: h.payload.html_url,
    category: binding.category,
    scope: binding.scope,
    collaborators: [],
    consent: true,
    detail: "Synthetic locale proposal before final merge",
  };
  const submitted = await client.call("/controls/requests", client.owner, requestInput);
  assert.equal(submitted.response.status, 201);
  const reviewInput = {
    version: submitted.data.version,
    decision: "accept",
    reason: "Synthetic review before source merge",
    conflict: false,
    sourceReviewedPublic: true,
    policyVersion: binding.policyVersion,
    localization: target,
  };
  const premature = await client.call(`/controls/requests/${submitted.data.id}/review`, client.reviewer, reviewInput);
  assert.equal(premature.response.status, 200);
  const rejected = (await h.runtime.runOnce()).publications[0];
  const result = await h.runtime.source.read(publicScope, rejected.snapshotId, new AbortController().signal);
  assert.ok(result.selected.rows.every((row) => row.result.value == null || row.result.value === 0));
  assert.equal(
    result.selected.portfolioEvidence.filter((entry) => entry.contribution.metricIds.includes("localization")).length,
    2,
  );
  // An actual owner amendment returns the receipt to review before a later
  // reviewer action can qualify the now-merged source.
  client.setTime(h.ago(0.5));
  const refreshedOwner = await client.call("/controls/session", client.owner);
  // Sessions intentionally expired across the synthetic day; use a fresh client
  // instead of bypassing current session/role checks.
  assert.equal(refreshedOwner.response.status, 401);
  const laterClient = await localeReviewClient(t, h, h.ago(0.5));
  const amended = await laterClient.call(`/controls/requests/${submitted.data.id}/amend`, laterClient.owner, {
    version: premature.data.version,
    reason: "Review the actual merged revision",
    locator: requestInput.locator,
    category: requestInput.category,
    scope: requestInput.scope,
    detail: "The synthetic source has now merged",
    collaborators: [],
  });
  assert.equal(amended.response.status, 200);
  const reviewed = await laterClient.call(`/controls/requests/${submitted.data.id}/review`, laterClient.reviewer, {
    ...reviewInput,
    version: amended.data.version,
    reason: "Reviewed the exact source after merge",
  });
  assert.equal(reviewed.response.status, 200);
  const accepted = (await h.runtime.runOnce()).publications[0];
  assert.equal((await h.runtime.app.inject("/api/v1/boards?metric=localization")).json().rows[0].result.value, 1);
  h.controlsStore.transaction((state) => {
    const request = state.requests[submitted.data.id],
      decision = request.history.at(-1);
    delete decision.localization;
    delete decision.evidenceRequest;
    state.audit = state.audit.map((entry) => (entry.id === decision.id ? structuredClone(decision) : entry));
    const requests = Object.values(state.requests)
      .filter((item) => item.kind === "evidence")
      .sort((a, b) => a.id.localeCompare(b.id));
    state.pipelinePublications[accepted.snapshotId].recognitionFingerprint = createHash("sha256")
      .update(JSON.stringify([requests, []]))
      .digest("hex");
  });
  assert.equal(await h.runtime.source.read(publicScope, accepted.snapshotId, new AbortController().signal), null);
  const legacy = (await h.runtime.runOnce()).publications[0];
  const legacyRead = await h.runtime.source.read(publicScope, legacy.snapshotId, new AbortController().signal);
  assert.ok(legacyRead.selected.rows.every((row) => row.result.value == null || row.result.value === 0));
  assert.equal(
    legacyRead.selected.portfolioEvidence.filter((entry) => entry.contribution.metricIds.includes("localization"))
      .length,
    2,
  );
});

test("localization keeps raw portfolio separate from exact independently accepted locale units and current suppression", async (t) => {
  const h = await localizationHarness(t);
  const { ago, after, mergedAt, mergeWindow, reviewWindow, payload } = h;
  const publication = await h.runtime.runOnce();
  assert.equal(publication.state, "published");
  const snapshotId = publication.publications[0].snapshotId;
  const response = await h.runtime.app.inject(`/api/v1/boards?metric=localization&snapshot=${snapshotId}`);
  assert.equal(response.statusCode, 200, response.body);
  const board = response.json();
  assert.ok(
    board.rows.every((row) => row.result.value === undefined || row.result.value === null || row.result.value === 0),
  );
  const read = await h.runtime.source.read(publicScope, snapshotId, new AbortController().signal);
  const observed = read.selected.portfolioEvidence.filter((entry) =>
    entry.contribution.metricIds.includes("localization"),
  );
  assert.equal(observed.length, 2);
  assert.ok(observed.every((entry) => entry.activityState === "observed"));
  for (const {
    contribution: { contributionId: id },
  } of observed) {
    const detail = await h.runtime.app.inject(`/api/v1/evidence/${id}?snapshot=${snapshotId}`);
    assert.equal(detail.statusCode, 200, detail.body);
    const proof = detail.json();
    assert.equal(proof.sourceRevision, after);
    assert.equal(proof.evidenceMetadata.acceptedAt, null);
    assert.ok(proof.contribution.reasonCodes.some((reason) => /^locale:(fr|de)$/.test(reason)));
  }
  const { decision } = await acceptLocale(h, { id: "locale" });
  const accepted = (await h.runtime.runOnce()).publications[0];
  const acceptedResponse = await h.runtime.app.inject(
    `/api/v1/boards?metric=localization&snapshot=${accepted.snapshotId}`,
  );
  assert.equal(acceptedResponse.statusCode, 200, acceptedResponse.body);
  const acceptedBoard = acceptedResponse.json();
  assert.equal(acceptedBoard.rows.length, 1);
  assert.equal(acceptedBoard.rows[0].result.value, 1);
  assert.equal(acceptedBoard.rows[0].rank, null);
  assert.equal(acceptedBoard.rows[0].evidenceIds.length, 1);
  const acceptedProof = await h.runtime.app.inject(
    `/api/v1/evidence/${acceptedBoard.rows[0].evidenceIds[0]}?snapshot=${accepted.snapshotId}`,
  );
  assert.equal(acceptedProof.statusCode, 200, acceptedProof.body);
  assert.equal(acceptedProof.json().evidenceMetadata.acceptedAt, new Date(decision.at).toISOString());
  assert.ok(acceptedProof.json().contribution.reasonCodes.includes("locale:fr"));
  assert.equal(acceptedProof.json().sourceRevision, after);
  assert.equal(acceptedProof.json().occurredAt, mergedAt);
  assert.equal(acceptedProof.body.includes(decision.id), false);
  const activity = await h.runtime.app.inject(`/api/v1/activity?category=localization&snapshot=${accepted.snapshotId}`);
  assert.equal(activity.statusCode, 200, activity.body);
  assert.equal(
    activity.json().groups.reduce((total, group) => total + group.factCount, 0),
    2,
  );
  assert.equal(activity.json().groups.find((group) => group.activityState === "accepted").factCount, 1);
  assert.equal(activity.json().groups.find((group) => group.activityState === "observed").factCount, 1);
  const originalFrench = observed.find((entry) => entry.contribution.reasonCodes.includes("locale:fr"));
  assert.equal(acceptedProof.json().contribution.canonicalEventId, originalFrench.contribution.canonicalEventId);
  const mergedPeriod = await h.runtime.app.inject(
    `/api/v1/boards?metric=localization&start=${mergeWindow.start}&end=${mergeWindow.end}`,
  );
  assert.equal(mergedPeriod.statusCode, 200, mergedPeriod.body);
  assert.equal(mergedPeriod.json().rows[0].result.value, 1);
  const reviewedPeriod = await h.runtime.app.inject(
    `/api/v1/boards?metric=localization&start=${reviewWindow.start}&end=${reviewWindow.end}`,
  );
  assert.equal(reviewedPeriod.statusCode, 200, reviewedPeriod.body);
  assert.deepEqual(reviewedPeriod.json().rows, []);
  await h.runtime.runOnce();
  assert.equal((await h.runtime.app.inject("/api/v1/boards?metric=localization")).json().rows[0].result.value, 1);
  h.controlsStore.transaction((state) => {
    state.requests.locale.status = "withdrawn";
  });
  assert.equal(await h.runtime.source.read(publicScope, accepted.snapshotId, new AbortController().signal), null);
  const withdrawn = (await h.runtime.runOnce()).publications[0];
  const restoredActivity = await h.runtime.app.inject(
    `/api/v1/activity?category=localization&snapshot=${withdrawn.snapshotId}`,
  );
  assert.equal(restoredActivity.statusCode, 200, restoredActivity.body);
  assert.equal(
    restoredActivity.json().groups.reduce((total, group) => total + group.factCount, 0),
    2,
  );
  assert.ok(restoredActivity.json().groups.every((group) => group.activityState === "observed"));
  assert.ok(
    (await h.runtime.app.inject("/api/v1/boards?metric=localization"))
      .json()
      .rows.every((row) => row.result.value === undefined || row.result.value === null || row.result.value === 0),
  );
  h.setPrivate(true);
  await assert.rejects(h.runtime.runOnce(), /public_source_not_verified/);
  assert.equal(
    (await h.runtime.app.inject(`/api/v1/boards?metric=localization&snapshot=${withdrawn.snapshotId}`)).statusCode,
    410,
  );
  assert.equal((await h.runtime.app.inject("/api/v1/boards?metric=localization")).statusCode, 503);
  assert.equal(await h.runtime.source.read(publicScope, snapshotId, new AbortController().signal), null);
});

test("restarted normalization reclassifies changed and removed documentation policies while unchanged rules reuse cache", async (t) => {
  const h = await localizationHarness(t);
  const localeEvidence = (read) =>
    read.selected.portfolioEvidence.filter((entry) => entry.contribution.metricIds.includes("localization"));
  const locales = (read) =>
    localeEvidence(read)
      .flatMap((entry) => entry.contribution.reasonCodes.filter((reason) => reason.startsWith("locale:")))
      .sort();
  const first = (await h.runtime.runOnce()).publications[0];
  const initial = await h.runtime.source.read(publicScope, first.snapshotId, new AbortController().signal);
  assert.deepEqual(locales(initial), ["locale:de", "locale:fr"]);
  const original = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows[0];
  await h.runtime.stop();
  await h.reopenDatabase();
  const revised = structuredClone(h.options.config);
  revised.recognitionBindings = [];
  for (const step of ["new_version", "same_version_rules", "removed_policy", "unchanged_policy"]) {
    revised.version = `synthetic-configuration-${step}`;
    if (step === "new_version") {
      revised.documentationPolicies[0].version = "synthetic-locales-v2";
      revised.documentationPolicies[0].localizationPaths = revised.documentationPolicies[0].localizationPaths.filter(
        (entry) => entry.locale === "de",
      );
    } else if (step === "same_version_rules") {
      revised.documentationPolicies[0].generatedPaths.push("docs/de/");
    } else if (step === "removed_policy") {
      revised.documentationPolicies = [];
    }
    const restarted = await createPipeline({ ...h.options, config: revised });
    try {
      const publication = (await restarted.runOnce()).publications[0];
      const read = await restarted.source.read(publicScope, publication.snapshotId, new AbortController().signal);
      assert.deepEqual(locales(read), step === "new_version" ? ["locale:de"] : [], step);
      for (const entry of localeEvidence(read))
        assert.ok(entry.contribution.reasonCodes.includes("documentation_path_policy:synthetic-locales-v2"));
      if (["removed_policy", "unchanged_policy"].includes(step))
        assert.ok(
          read.selected.portfolioEvidence.every((entry) => !entry.contribution.metricIds.includes("documentation")),
        );
      const rows = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows;
      const expectedRows = { new_version: 2, same_version_rules: 3, removed_policy: 4, unchanged_policy: 4 };
      assert.equal(rows.length, expectedRows[step], step);
      assert.deepEqual(
        rows.find((row) => row.policy_signature === original.policy_signature),
        original,
      );
    } finally {
      await restarted.stop();
    }
  }
});

test("a fully classified cache from before locale emission is retained for frozen history and reprojected after restart", async (t) => {
  const h = await localizationHarness(t, (config) => {
    config.recognitionBindings = [];
  });
  await h.runtime.stop();
  h.options.authorizePolicyPreview = async () => true;
  // The earlier adapter accepted the full policy object but only interpreted
  // documentation paths. Model that source projection through the real
  // normalizer with locale interpretation disabled, retaining the full host config.
  const oldProjection = await createPipeline({
    ...h.options,
    normalizer: components.github.createGithubEvidenceNormalizer({
      client: h.options.githubClient,
      source: h.options.sourceId,
      allowedRepositoryIds: [2],
      isSynthetic: true,
      documentationPolicies: h.config.documentationPolicies.map(({ localizationPaths, ...policy }) => policy),
      enrich: h.options.githubEnrich,
    }),
  });
  const cutoff = h.ago(0);
  const publication = (await oldProjection.runOnce({ cutoff })).publications[0];
  const saved = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows[0];
  assert.ok(saved.document.facts.some((fact) => fact.metricId === "documentation"));
  assert.equal(
    saved.document.facts.some((fact) => fact.metricId === "localization"),
    false,
  );
  const legacySignature = comparisonHash([
    normalizationDocumentVersion,
    comparisonHash([
      "current-state-selection-v2",
      "synthetic",
      h.config.policies.map((entry) => entry.signature),
      { documentation: h.config.documentationPolicies, research: [] },
    ]),
  ]);
  await h.db.query(
    "UPDATE leaderboard_pipeline.normalizations SET policy_signature=$1 WHERE fact_key=$2 AND policy_signature=$3",
    [legacySignature, saved.fact_key, saved.policy_signature],
  );
  await oldProjection.stop();
  await h.reopenDatabase();
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  const preview = () =>
    restarted.previewPolicy({
      snapshotId: publication.snapshotId,
      policy: { ...h.config.policies[0].policy, version: "synthetic-before-locale-preview", rank: false },
      operatorId: "201",
    });
  const historic = (await preview()).comparison.before;
  // A fresh run gets its own event cutoff; exact historical dispatches cannot
  // replace an earlier explanation when newly classified inputs have changed.
  const freshCutoff = new Date(Date.parse(cutoff) + 1).toISOString();
  const current = (await restarted.runOnce({ cutoff: freshCutoff })).publications[0];
  const read = await restarted.source.read(publicScope, current.snapshotId, new AbortController().signal);
  const localeEvidence = read.selected.portfolioEvidence.filter((entry) =>
    entry.contribution.metricIds.includes("localization"),
  );
  assert.equal(localeEvidence.length, 2);
  assert.ok(localeEvidence.every((entry) => entry.activityState === "observed"));
  const rows = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find((row) => row.policy_signature === legacySignature).document, saved.document);
  assert.equal(
    rows
      .find((row) => row.policy_signature !== legacySignature)
      .document.facts.filter((fact) => fact.metricId === "localization").length,
    2,
  );
  assert.deepEqual((await preview()).comparison.before, historic);
});

for (const withMergePins of [false, true])
  test(`a retained v1 rename cache ${withMergePins ? "with verified merge pins " : ""}preserves its frozen destination while a restarted run classifies both locales`, async (t) => {
    const h = await localizationHarness(
      t,
      (config) => {
        config.recognitionBindings = [];
      },
      (envelope) => {
        envelope.integration.diff.files = [
          {
            path: "docs/de/moved.md",
            previousPath: "docs/fr/original.md",
            additions: 1,
            deletions: 1,
          },
        ];
        return envelope;
      },
    );
    await h.runtime.stop();
    h.options.authorizePolicyPreview = async () => true;
    const normalize = components.github.createGithubEvidenceNormalizer({
      client: h.options.githubClient,
      source: h.options.sourceId,
      allowedRepositoryIds: [2],
      isSynthetic: true,
      documentationPolicies: h.config.documentationPolicies,
      enrich: h.options.githubEnrich,
    });
    // The earlier v1 classifier ignored a substantive rename's original locale.
    // Retain its exact destination-only projection as an actual stored snapshot.
    const oldProjection = await createPipeline({
      ...h.options,
      normalizer: async (input) => {
        const output = await normalize(input);
        const omitted = new Set(
          output.evidence
            .filter(
              (entry) =>
                entry.contribution.metricIds.includes("localization") &&
                entry.contribution.reasonCodes.includes("locale:fr"),
            )
            .map((entry) => entry.contribution.contributionId),
        );
        return {
          ...output,
          facts: output.facts.filter((fact) => !omitted.has(fact.id)),
          evidence: output.evidence.filter((entry) => !omitted.has(entry.contribution.contributionId)),
        };
      },
    });
    const cutoff = h.ago(0);
    const publication = (await oldProjection.runOnce({ cutoff })).publications[0];
    const locales = (read) =>
      read.selected.portfolioEvidence
        .filter((entry) => entry.contribution.metricIds.includes("localization"))
        .flatMap((entry) => entry.contribution.reasonCodes.filter((reason) => reason.startsWith("locale:")))
        .sort();
    assert.deepEqual(
      locales(await oldProjection.source.read(publicScope, publication.snapshotId, new AbortController().signal)),
      ["locale:de"],
    );
    const saved = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows[0];
    const oldDocumentationSignature = comparisonHash([
      "documentation-locales/v1",
      comparisonHash([
        normalizationDocumentVersion,
        comparisonHash([
          "current-state-selection-v2",
          "synthetic",
          h.config.policies.map((entry) => entry.signature),
          { documentation: h.config.documentationPolicies, research: [] },
        ]),
      ]),
    ]);
    const oldSignature = withMergePins
      ? comparisonHash(["verified-default-branch-merge-pins/v1", oldDocumentationSignature])
      : oldDocumentationSignature;
    await h.db.query(
      "UPDATE leaderboard_pipeline.normalizations SET policy_signature=$1 WHERE fact_key=$2 AND policy_signature=$3",
      [oldSignature, saved.fact_key, saved.policy_signature],
    );
    await oldProjection.stop();
    await h.reopenDatabase();
    const restarted = await createPipeline(h.options);
    t.after(() => restarted.stop());
    const preview = () =>
      restarted.previewPolicy({
        snapshotId: publication.snapshotId,
        policy: { ...h.config.policies[0].policy, version: "synthetic-rename-cache-preview", rank: false },
        operatorId: "201",
      });
    const historical = (await preview()).comparison.before;
    const freshCutoff = new Date(Date.parse(cutoff) + 1).toISOString();
    const current = (await restarted.runOnce({ cutoff: freshCutoff })).publications[0];
    assert.deepEqual(
      locales(await restarted.source.read(publicScope, current.snapshotId, new AbortController().signal)),
      ["locale:de", "locale:fr"],
    );
    const rows = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.find((row) => row.policy_signature === oldSignature).document, saved.document);
    assert.deepEqual((await preview()).comparison.before, historical);
  });

for (const withResearch of [false, true])
  test(`frozen locale identities require every active classification policy with research ${withResearch ? "enabled" : "absent"}`, async (t) => {
    const h = await localizationHarness(t, (config) => {
      if (withResearch)
        config.researchPolicies = [
          {
            repositoryId: 2,
            version: "synthetic-research-cache-v1",
            recordPaths: ["research/"],
            generatedPaths: [],
            importedPaths: [],
            syntheticPaths: [],
          },
        ];
    });
    await acceptLocale(h);
    h.options.authorizePolicyPreview = async () => true;
    const cutoff = h.ago(0);
    const publication = (await h.runtime.runOnce({ cutoff })).publications[0];
    const saved = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows[0];
    const policySignatures = h.config.policies.map((entry) => entry.signature);
    const unclassified = comparisonHash(["current-state-selection-v1", "synthetic", policySignatures]);
    const documentationOnly = comparisonHash([
      normalizationDocumentVersion,
      unclassified,
      h.config.documentationPolicies,
    ]);
    const missingBindings = [
      ["unclassified original format", unclassified],
      ["unclassified attribution format", comparisonHash([normalizationDocumentVersion, unclassified])],
    ];
    if (withResearch) {
      missingBindings.push(["documentation-only format omits research", documentationOnly]);
      const researchOnly = comparisonHash([
        "current-state-selection-v2",
        "synthetic",
        policySignatures,
        { documentation: [], research: h.config.researchPolicies },
      ]);
      missingBindings.push(
        ["research-only format omits documentation", researchOnly],
        [
          "research-only attribution format omits documentation",
          comparisonHash([normalizationDocumentVersion, researchOnly]),
        ],
      );
    }
    await h.runtime.stop();
    await h.reopenDatabase();
    const restarted = await createPipeline(h.options);
    t.after(() => restarted.stop());
    const preview = () =>
      restarted.previewPolicy({
        snapshotId: publication.snapshotId,
        policy: { ...h.config.policies[0].policy, version: "synthetic-locale-cache-preview", rank: false },
        operatorId: "201",
      });
    assert.equal((await preview()).comparison.before.rows.find((row) => row.actorId === "101").value, 1);
    let currentSignature = saved.policy_signature;
    async function replaceSignature(signature) {
      await h.db.query(
        "UPDATE leaderboard_pipeline.normalizations SET policy_signature=$1 WHERE fact_key=$2 AND policy_signature=$3",
        [signature, saved.fact_key, currentSignature],
      );
      currentSignature = signature;
    }
    // Identical normalized bytes and a recorded hash cannot replace omitted
    // classification authority, in either pre-attribution cache generation.
    for (const [name, signature] of missingBindings) {
      await replaceSignature(signature);
      await assert.rejects(preview(), /identity evidence unavailable/, name);
    }
    await replaceSignature(saved.policy_signature);
    assert.equal((await preview()).comparison.before.rows.find((row) => row.actorId === "101").value, 1);
    if (!withResearch) {
      // This exact standalone locale format did bind the complete active docs
      // policy. Historical replay stays valid while fresh runs use the joint key.
      await replaceSignature(documentationOnly);
      assert.equal((await preview()).comparison.before.rows.find((row) => row.actorId === "101").value, 1);
      await restarted.runOnce({ cutoff });
      const rows = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows;
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.find((row) => row.policy_signature === documentationOnly).document, saved.document);
      assert.deepEqual(rows.find((row) => row.policy_signature === saved.policy_signature).document, saved.document);
      assert.equal((await preview()).comparison.before.rows.find((row) => row.actorId === "101").value, 1);
      const board = (await restarted.app.inject("/api/v1/boards?metric=localization")).json();
      assert.equal(board.rows[0].result.value, 1);
      const proof = await restarted.app.inject(
        `/api/v1/evidence/${board.rows[0].evidenceIds[0]}?snapshot=${board.snapshotId}`,
      );
      assert.equal(proof.statusCode, 200, proof.body);
      assert.equal(proof.json().occurredAt, h.mergedAt);
      assert.ok(proof.json().contribution.reasonCodes.includes("locale:fr"));
      assert.equal(proof.body.includes("synthetic-locale-cache-request"), false);
    }
  });
