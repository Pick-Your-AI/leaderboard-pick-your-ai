import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ControlStore } from "../src/store.mjs";
import { createControlsServer } from "../src/server.mjs";
import { PolicyComparisonStore, comparisonHash, comparisonLimitsV1 } from "../src/policy-comparison.mjs";
import * as metrics from "../../../packages/metrics/dist/index.js";

// Entirely synthetic, including reviewer identities and source authorizations.
const prefix = "/controls/policy-comparisons";
const origin = "https://synthetic-controls.example.test";
const cutoff = "2026-10-18T00:00:00.000Z";
const policy = (patch = {}) => ({
  metricId: "issues_opened",
  version: "synthetic-policy/v1",
  definitionVersion: "candidate-0.1.0",
  unit: metrics.getMetricDefinition("issues_opened").definition.unit,
  aggregation: "count",
  dateBasis: "occurredAt",
  rankedStates: ["observed"],
  roles: ["reporter"],
  groupBy: "actor_artifact",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: true,
  ...patch,
});
const fact = (id, patch = {}) => ({
  id,
  canonicalKey: `synthetic-action-${id}`,
  metricId: "issues_opened",
  actorId: "101",
  artifactId: "synthetic-artifact-a",
  repoId: "2",
  role: "reporter",
  state: "observed",
  occurredAt: "2026-10-05T00:00:00.000Z",
  acceptedAt: null,
  observedAt: "2026-10-06T00:00:00.000Z",
  revision: 0,
  correctionReceipt: null,
  acceptanceReceipt: null,
  acceptedBy: null,
  subjectActorId: null,
  eventContext: { projects: [], workstreams: [] },
  currentContext: { projects: [], workstreams: [] },
  ...patch,
});
const capture = () => ({
  input: {
    datasetId: "synthetic-frozen",
    cutoff,
    backfillRevision: "synthetic-revision",
    repositoryIds: ["2"],
    actors: ["101", "102"].map((id) => ({ id, login: `synthetic-${id}`, kind: "user", publicState: "visible" })),
    facts: [
      fact("synthetic-fact-a"),
      fact("synthetic-fact-b"),
      fact("synthetic-fact-c", { actorId: "102", artifactId: "synthetic-artifact-c" }),
      fact("synthetic-corrected", { artifactId: "synthetic-artifact-d" }),
      fact("synthetic-corrected", {
        artifactId: "synthetic-artifact-d",
        revision: 1,
        correctionReceipt: "synthetic-review-receipt",
        state: "excluded",
      }),
    ],
    coverage: [
      {
        schemaVersion: "leaderboard/v1",
        state: "complete",
        source: "github_rest",
        scopeId: "2",
        windowStart: "2026-10-01T00:00:00.000Z",
        windowEnd: cutoff,
        knownStart: "2026-10-01T00:00:00.000Z",
        lastSuccessfulSync: cutoff,
        sourceWatermark: cutoff,
        missingPages: 0,
        permissionsMissing: [],
        sourceErrors: [],
      },
    ],
  },
  scope: {
    timezone: "UTC",
    from: "2026-10-01T00:00:00.000Z",
    to: cutoff,
    repos: ["2"],
    projects: [],
    workstreams: [],
    roles: [],
    actors: "all",
    context: "event",
  },
  policies: [policy()],
  snapshot: { snapshotId: "synthetic-snapshot", revision: 1 },
  authorization: {
    configurationHash: "synthetic-config",
    controlsConfigurationRevision: 0,
    dataMode: "synthetic",
    sources: [{ repositoryId: "2", generation: "0" }],
  },
});
async function harness(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "policy-preview-test-")),
    filename = join(directory, "controls.sqlite");
  let store,
    comparisons,
    server,
    base,
    current = Date.parse(cutoff),
    sourceAllowed = true,
    removed = [];
  let hook = async () => {};
  const roles = new Map([
    ["201", { roles: ["reviewer"], version: "1" }],
    ["202", { roles: ["operator"], version: "1" }],
  ]);
  const start = async () => {
    store = new ControlStore(filename);
    comparisons = new PolicyComparisonStore(store, metrics, { now: () => current });
    server = createControlsServer({
      store,
      origin,
      now: () => current,
      provider: {
        authorizationURL: () => "https://github.com/login/oauth/authorize",
        exchange: async () => ({ actorId: "201" }),
      },
      rolesForActor: async (id) => roles.get(id) ?? { roles: [], version: "0" },
      policyComparisons: {
        comparisons,
        withAuthorizedInputs: async (authorizations, work) => {
          assert.ok(authorizations.every((a) => a.configurationHash === "synthetic-config"));
          await hook();
          if (!sourceAllowed) throw Error("synthetic private source detail should never escape");
          return work(removed, { refreshApproval: async () => true, isCurrent: () => true });
        },
      },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  };
  await start();
  const user = (id = "201") => {
    const token = id === "201" ? "a".repeat(43) : "b".repeat(43);
    const sid = createHash("sha256").update(token).digest("base64url");
    store.transaction((state) => {
      state.sessions[sid] = {
        actorId: id,
        csrf: "synthetic-csrf",
        roles: roles.get(id)?.roles ?? [],
        roleVersion: roles.get(id)?.version ?? "0",
        expires: current + 900_000,
      };
    });
    return { cookie: `__Host-controls_session=${token}`, origin, "x-csrf-token": "synthetic-csrf" };
  };
  const headers = user();
  async function call(path, input, auth = headers, method = input === undefined ? "GET" : "POST") {
    const response = await fetch(base + path, {
      method,
      headers: { ...auth, ...(input === undefined ? {} : { "content-type": "application/json" }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, data: await response.json() };
  }
  const input = options.input ?? capture();
  const retained = store.transaction((state) => comparisons.capture(state, input));
  t.after(async () => {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    get comparisons() {
      return comparisons;
    },
    roles,
    user,
    headers,
    call,
    input,
    retained,
    preview: (candidatePolicy = policy({ version: "synthetic-policy/v2", groupBy: "canonical" })) =>
      call(prefix, { inputId: retained.inputId, candidatePolicy }),
    restart: async () => {
      await stop();
      await start();
    },
    source: (allowed) => {
      sourceAllowed = allowed;
    },
    removed: (ids) => {
      removed = ids;
    },
    hook: (fn) => {
      hook = fn;
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

test("authenticated preview executes both policies on identical retained input and restart/replay preserves exact hashes/results", async (t) => {
  const h = await harness(t);
  const originalPublic = h.store.publicSnapshot();
  const listed = await h.call(prefix + "/inputs");
  assert.equal(listed.status, 200);
  assert.equal(listed.data.inputs[0].inputHash, comparisonHash(h.input.input));
  assert.ok(!JSON.stringify(listed).includes("synthetic-fact"));
  const result = await h.preview();
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.data.status, "candidate_preview");
  assert.equal(result.data.publicEnabled, false);
  assert.equal(result.data.activationSupported, false);
  assert.equal(result.data.before.rows.find((r) => r.actorId === "101").value, 1);
  assert.equal(result.data.after.rows.find((r) => r.actorId === "101").value, 2);
  assert.deepEqual(result.data.before.scope, result.data.after.scope);
  assert.equal(result.data.before.datasetId, result.data.after.datasetId);
  assert.equal(result.data.inputHash, comparisonHash(h.input.input));
  const change = result.data.changes.find((c) => c.actorId === "101");
  assert.deepEqual(change.included, ["synthetic-fact-b"]);
  assert.deepEqual(change.causes.included[0].reasons, ["repeated_policy_unit"]);
  assert.ok(
    result.data.after.audit.some(
      (a) => a.reason === "excluded_by_policy_or_correction" && a.factIds.includes("synthetic-corrected"),
    ),
  );
  assert.notEqual(result.data.beforePolicyHash, result.data.afterPolicyHash);
  await h.restart();
  assert.deepEqual(await h.preview(), result);
  assert.deepEqual(await h.call(prefix + "/" + result.data.comparisonId), result);
  assert.deepEqual(h.store.publicSnapshot(), originalPublic);
  assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM policy_previews").get().n, 1);
});

test("preview cannot activate, forge approval, reuse changed version semantics, or mutate public controls", async (t) => {
  const h = await harness(t);
  const snapshot = h.store.publicSnapshot();
  const result = await h.preview();
  assert.equal((await h.preview(policy({ version: "synthetic-policy/v2", minimumSamples: 3 }))).status, 409);
  assert.equal((await h.preview(policy({ groupBy: "canonical" }))).status, 409);
  assert.equal((await h.call(prefix + "/" + result.data.comparisonId + "/activate", {})).status, 404);
  assert.equal(
    (await h.call(prefix, { inputId: h.retained.inputId, candidatePolicy: policy(), approvalReceipt: "fake" })).status,
    400,
  );
  assert.deepEqual(h.store.publicSnapshot(), snapshot);
  assert.equal(h.store.read().configuration, undefined);
  const publicReply = await h.call("/controls/public", undefined, {});
  for (const key of [
    "inputId",
    "comparisonId",
    "synthetic-fact",
    "synthetic-review-receipt",
    "audit",
    "candidatePolicy",
  ])
    assert.equal(JSON.stringify(publicReply.data).includes(key), false);
});

test("anonymous and nonreviewer reads fail; authority revoked while source guard is pending cannot persist", async (t) => {
  const h = await harness(t);
  assert.equal((await h.call(prefix + "/inputs", undefined, {})).status, 401);
  assert.equal((await h.call(prefix + "/inputs", undefined, h.user("202"))).status, 403);
  h.hook(async () => {
    h.roles.set("201", { roles: [], version: "2" });
  });
  assert.equal((await h.preview()).status, 401);
  assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM policy_previews").get().n, 0);
});

test("saved replay and input lists fail closed after source or configuration revocation", async (t) => {
  const h = await harness(t);
  const result = await h.preview();
  h.source(false);
  for (const path of [prefix + "/inputs", prefix + "/" + result.data.comparisonId]) {
    const response = await h.call(path);
    assert.equal(response.status, 500);
    assert.deepEqual(response.data, { error: "Request failed" });
  }
  h.source(true);
  h.store.transaction((state) => {
    state.configuration = { revision: 1, active: null };
  });
  assert.equal((await h.preview()).status, 409);
  assert.equal((await h.call(prefix + "/" + result.data.comparisonId)).status, 409);
});

test("current privacy and artifact removal redact immutable previews on every replay, including in-flight changes", async (t) => {
  const h = await harness(t);
  const original = await h.preview();
  h.hook(async () => {
    h.store.transaction((state) => {
      state.profiles["101"] = { suppressed: true };
    });
  });
  const result = await h.call(prefix + "/" + original.data.comparisonId);
  assert.equal(result.status, 200);
  assert.equal(result.data.redactionsApplied, true);
  assert.equal(result.data.resultHash, original.data.resultHash);
  assert.notEqual(result.data.responseHash, original.data.responseHash);
  const serialized = JSON.stringify(result.data);
  for (const secret of ["synthetic-101", "synthetic-fact-a", "synthetic-fact-b", "synthetic-corrected"])
    assert.equal(serialized.includes(secret), false);
  assert.ok(result.data.after.rows.every((r) => r.rank === null));
  h.removed(["synthetic-artifact-c"]);
  const removed = await h.preview();
  assert.equal(removed.data.after.rows.length, 0);
  assert.equal(removed.data.before.rows.length, 0);
  assert.equal(removed.data.changes.length, 0);
});

test("input integrity, strict policy/body limits, retention and immutable version binding fail safely", async (t) => {
  const h = await harness(t);
  assert.equal((await h.preview({ ...policy(), extra: "raw" })).status, 400);
  assert.equal((await h.preview({ ...policy(), rank: "true" })).status, 400);
  assert.equal((await h.preview({ ...policy(), version: "x".repeat(20_000) })).status, 413);
  const original = await h.preview();
  h.advance(comparisonLimitsV1.retentionMs + 1);
  h.user();
  assert.equal((await h.call(prefix + "/" + original.data.comparisonId)).status, 404);
  assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 0);
  assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM policy_previews").get().n, 0);
  assert.ok(h.store.db.prepare("SELECT count(*) AS n FROM policy_preview_candidate_versions").get().n > 0);
  assert.deepEqual(
    h.store.transaction((state) =>
      h.comparisons.capture(state, { ...h.input, policies: [policy({ groupBy: "canonical" })] }),
    ),
    { state: "unavailable", reason: "frozen_approved_version_conflict" },
  );
  h.store.transaction((state) => h.comparisons.capture(state, h.input));
  h.store.db.prepare("UPDATE policy_preview_inputs SET document=? WHERE id=?").run("{}", h.retained.inputId);
  assert.equal((await h.preview()).status, 409);
});

test("frozen input and retained-count budgets are bounded without altering published controls", async (t) => {
  const h = await harness(t);
  const tooLarge = capture();
  tooLarge.input.facts = Array.from({ length: comparisonLimitsV1.facts + 1 }, () => fact("synthetic-many"));
  const captureInput = (input) => h.store.transaction((state) => h.comparisons.capture(state, input));
  assert.deepEqual(captureInput(tooLarge), { state: "unavailable", reason: "frozen_input_budget_exceeded" });
  for (let n = 1; n < comparisonLimitsV1.inputs; n++) {
    const input = capture();
    input.input.datasetId += n;
    assert.equal(captureInput(input).state, "retained");
  }
  const extra = capture();
  extra.input.datasetId += "over-limit";
  assert.deepEqual(captureInput(extra), { state: "unavailable", reason: "frozen_input_capacity_reached" });
  assert.equal(captureInput(h.input).inputId, h.retained.inputId);
  assert.equal(
    h.store.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n,
    comparisonLimitsV1.inputs,
  );
  assert.equal((await h.call(prefix + "/inputs")).data.inputs.length, comparisonLimitsV1.inputs);
});

test("preview storage capacity is bounded and rejects without partial version or result writes", async (t) => {
  const h = await harness(t);
  for (let n = 0; n < comparisonLimitsV1.previews; n++)
    assert.equal((await h.preview(policy({ version: `synthetic-candidate-${n}` }))).status, 200);
  const versions = h.store.db.prepare("SELECT count(*) AS n FROM policy_preview_candidate_versions").get().n;
  assert.equal((await h.preview(policy({ version: "synthetic-over-limit" }))).status, 503);
  assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM policy_previews").get().n, comparisonLimitsV1.previews);
  assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM policy_preview_candidate_versions").get().n, versions);
  assert.equal((await h.preview(policy({ version: "synthetic-candidate-0" }))).status, 200);
});

test("strict CSRF/origin and concurrent preview bounds preserve authenticated controls behavior", async (t) => {
  const h = await harness(t);
  const input = { inputId: h.retained.inputId, candidatePolicy: policy({ version: "synthetic-next" }) };
  assert.equal((await h.call(prefix, input, { ...h.headers, origin: "https://attacker.invalid" })).status, 403);
  assert.equal((await h.call(prefix, input, { ...h.headers, "x-csrf-token": "wrong" })).status, 403);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started = 0,
    allStarted;
  const ready = new Promise((resolve) => {
    allStarted = resolve;
  });
  h.hook(async () => {
    if (++started === comparisonLimitsV1.concurrent) allStarted();
    await gate;
  });
  const pending = Array.from({ length: comparisonLimitsV1.concurrent }, () => h.preview());
  await ready;
  assert.equal((await h.preview()).status, 503);
  release();
  assert.ok((await Promise.all(pending)).every((reply) => reply.status === 200));
  assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM policy_previews").get().n, 1);
});

test("configuration and session revocation during awaited authorization prevent private persistence", async (t) => {
  const h = await harness(t);
  h.hook(async () => {
    h.store.transaction((state) => {
      state.configuration = { revision: 1, active: null };
    });
  });
  assert.equal((await h.preview()).status, 409);
  assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM policy_previews").get().n, 0);
  h.store.transaction((state) => {
    delete state.configuration;
  });
  h.hook(async () => {
    h.store.transaction((state) => {
      state.sessions = {};
    });
  });
  assert.equal((await h.preview()).status, 401);
  assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM policy_previews").get().n, 0);
});

test("source guard holds protection through response delivery and a pending revocation never returns stale facts", async (t) => {
  const { createPolicyComparisonManager } = await import("../src/policy-comparison.mjs");
  const h = await harness(t);
  const sid = createHash("sha256").update("a".repeat(43)).digest("base64url");
  const session = { ...h.store.read().sessions[sid], sid };
  let locked = false,
    revoked = false;
  const events = [];
  const manager = createPolicyComparisonManager({
    comparisons: h.comparisons,
    withAuthorizedInputs: async (_, work) => {
      if (revoked) throw Error("source revoked");
      locked = true;
      try {
        return await work([], { refreshApproval: async () => true, isCurrent: () => true });
      } finally {
        locked = false;
        events.push("unlocked");
        revoked = true;
      }
    },
  });
  const request = {
    path: prefix,
    method: "POST",
    input: { inputId: h.retained.inputId, candidatePolicy: policy({ version: "synthetic-next" }) },
    session,
    refreshSession: async () => {
      assert.equal(locked, true);
      return session;
    },
    respond: (result) => {
      assert.equal(locked, true);
      assert.equal(result.data.status, "candidate_preview");
      events.push("sent");
    },
  };
  await manager(request);
  assert.deepEqual(events, ["sent", "unlocked"]);
  await assert.rejects(manager(request), /source revoked/);
  assert.deepEqual(events, ["sent", "unlocked"]);
});

test("current suppression also removes unresolved actor IDs from private audit", async (t) => {
  const input = capture();
  input.input.facts.push(fact("synthetic-unresolved", { actorId: "999", artifactId: "synthetic-unresolved-artifact" }));
  const h = await harness(t, { input });
  const original = await h.preview();
  assert.ok(original.data.before.audit.some((entry) => entry.actorId === "999"));
  h.store.transaction((state) => {
    state.profiles["999"] = { suppressed: true };
  });
  const replay = await h.preview();
  assert.equal(replay.status, 200);
  assert.equal(replay.data.redactionsApplied, true);
  assert.ok(replay.data.before.audit.every((entry) => entry.actorId !== "999"));
  assert.doesNotMatch(JSON.stringify(replay.data), /synthetic-unresolved/);
});

test("candidate bindings cannot reserve approved baseline versions or exhaust approved capture", async (t) => {
  const h = await harness(t);
  assert.equal((await h.preview(policy({ version: "synthetic-approved-next", groupBy: "canonical" }))).status, 200);
  const next = capture();
  next.snapshot = { snapshotId: "synthetic-later-approved", revision: 2 };
  next.policies = [policy({ version: "synthetic-approved-next", rank: false })];
  const approvedInput = h.store.transaction((state) => h.comparisons.capture(state, next));
  assert.equal(approvedInput.state, "retained");
  const unchanged = await h.call(prefix, { inputId: approvedInput.inputId, candidatePolicy: next.policies[0] });
  assert.equal(unchanged.status, 200);
  assert.deepEqual(unchanged.data.changes, []);
  const candidateRows = h.store.db.prepare("SELECT count(*) AS n FROM policy_preview_candidate_versions").get().n;
  h.store.transaction(() => {
    for (let i = candidateRows; i < comparisonLimitsV1.candidateVersions; i++)
      h.comparisons.bindCandidate(policy({ version: `synthetic-unapproved-${i}` }));
  });
  const another = capture();
  another.policies = [policy({ version: "synthetic-another-approved" })];
  assert.equal(h.store.transaction((state) => h.comparisons.capture(state, another)).state, "retained");
  assert.equal(
    h.store.db.prepare("SELECT count(*) AS n FROM policy_preview_candidate_versions").get().n,
    comparisonLimitsV1.candidateVersions,
  );
  assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM policy_preview_approved_versions").get().n, 3);
  assert.equal((await h.preview(policy({ version: "synthetic-over-candidate-limit" }))).status, 503);
});

test("approved capture registry capacity degrades without partial bindings or hidden authorization denial", async (t) => {
  const h = await harness(t);
  h.store.transaction(() => {
    for (let i = 1; i < comparisonLimitsV1.approvedVersions; i++)
      assert.equal(h.comparisons.captureBindings([policy({ version: `synthetic-approved-${i}` })]), null);
  });
  const next = capture();
  next.policies = [policy({ version: "synthetic-future-approved" })];
  assert.deepEqual(
    h.store.transaction((state) => h.comparisons.capture(state, next)),
    { state: "unavailable", reason: "frozen_approved_version_capacity_reached" },
  );
  assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 1);
  assert.equal(
    h.store.db.prepare("SELECT count(*) AS n FROM policy_preview_approved_versions").get().n,
    comparisonLimitsV1.approvedVersions,
  );
  h.store.transaction((state) => {
    state.configuration = { revision: 1, active: null };
  });
  assert.throws(() => h.store.transaction((state) => h.comparisons.capture(state, next)), /authorization changed/);
});

async function runtimePreviewHarness(t, { verifyConfiguration, fence, correction } = {}) {
  const { createPipeline } = await import("../../pipeline/src/runtime.mjs");
  const { createPolicyComparisonManager } = await import("../src/policy-comparison.mjs");
  const { configurationOverlay } = await import("../src/configuration.mjs");
  const { createPolicyPreviewAuthority, previewAuthorityLimitsV1 } =
    await import("../src/policy-preview-authority.mjs");
  const h = await harness(t);
  const config = {
    version: "synthetic-config",
    organization: "synthetic-org",
    approvalReceipt: "synthetic-approval",
    repositories: [
      {
        id: 2,
        installationId: 1,
        slug: "synthetic-org/synthetic-repo",
        families: ["issues"],
        approvalReceipt: "synthetic-source-approval",
      },
    ],
    policies: [
      { policy: policy(), signature: metrics.stableJSON(policy()), approvalReceipt: "synthetic-policy-approval" },
    ],
    scopes: [{ organization: "synthetic-org", repository: null, workstream: null, start: null, end: null }],
  };
  let time = Date.parse(cutoff),
    revision = 0;
  const authority = createPolicyPreviewAuthority({ now: () => time });
  const update = (patch = {}) =>
    authority.replace({
      schemaVersion: previewAuthorityLimitsV1.schemaVersion,
      revision: ++revision,
      validUntil: time + 60_000,
      configurationHashes: [comparisonHash(config)],
      reviewers: [{ actorId: "201", roleVersion: "1" }],
      ...patch,
    });
  update();
  const db = {
    transaction: async (work) =>
      work({
        query: async (sql) => {
          if (sql.includes("repository_access"))
            return { rows: [{ repository_id: 2, state: "public", generation: 0 }] };
          if (sql.includes("leaderboard_pipeline.corrections") && correction)
            return { rows: [{ artifact_id: correction.artifactId, document: { fact: correction } }] };
          return { rows: [] };
        },
      }),
  };
  const components = {
    metrics,
    ingestion: { CollectionStore: class {}, InboxStore: class {}, OutboxStore: class {}, sourceFamilies: ["issues"] },
    controls: { configurationOverlay },
    service: { createService: () => ({ close: async () => {} }) },
  };
  const runtime = await createPipeline({
    components,
    db,
    controlsStore: h.store,
    config,
    dataMode: "synthetic",
    now: () => cutoff,
    verifyConfiguration: verifyConfiguration ? () => verifyConfiguration(update) : async () => true,
    policyComparisonAuthorityCurrent: fence === "absent" ? undefined : (fence ?? authority.isCurrent),
  });
  t.after(() => runtime.stop());
  const input = capture();
  input.authorization.configurationHash = comparisonHash(config);
  if (correction) {
    input.input.facts.push(correction);
    input.authorization.corrections = [{ artifactId: correction.artifactId, hash: comparisonHash(correction) }];
  }
  const retained = h.store.transaction((state) => runtime.policyComparisons.comparisons.capture(state, input));
  const sid = createHash("sha256").update("a".repeat(43)).digest("base64url");
  const session = { ...h.store.read().sessions[sid], sid };
  const request = {
    path: prefix,
    method: "POST",
    session,
    refreshSession: async () => session,
    input: { inputId: retained.inputId, candidatePolicy: policy({ version: "synthetic-runtime-next", rank: false }) },
  };
  return {
    h,
    authority,
    update,
    request,
    retained,
    runtime,
    manager: createPolicyComparisonManager(runtime.policyComparisons),
    expire: () => {
      time += 60_001;
    },
  };
}

test("approval revoked inside reviewer refresh prevents persistence and response", async (t) => {
  let allowed = true;
  const h = await runtimePreviewHarness(t, { verifyConfiguration: async () => allowed });
  let sent = false;
  await assert.rejects(
    h.manager({
      ...h.request,
      refreshSession: async () => {
        allowed = false;
        h.update({ configurationHashes: [] });
        await Promise.resolve();
        return h.request.session;
      },
      respond: () => {
        sent = true;
      },
    }),
    /authorization unavailable/,
  );
  assert.equal(sent, false);
  assert.equal(h.h.store.db.prepare("SELECT count(*) AS n FROM policy_previews").get().n, 0);
});

test("reviewer revoked inside final awaited approval is caught by the atomic authority cache", async (t) => {
  let checks = 0;
  const h = await runtimePreviewHarness(t, {
    verifyConfiguration: async (update) => {
      if (++checks === 2) update({ reviewers: [] });
      await Promise.resolve();
      return true;
    },
  });
  let sent = false;
  await assert.rejects(
    h.manager({
      ...h.request,
      respond: () => {
        sent = true;
      },
    }),
    /Preview authority changed/,
  );
  assert.equal(checks, 2);
  assert.equal(sent, false);
  assert.equal(h.h.store.db.prepare("SELECT count(*) AS n FROM policy_previews").get().n, 0);
});

for (const [name, fence] of [
  ["absent", "absent"],
  ["thenable", () => Promise.resolve(true)],
  ["rejected thenable", () => Promise.reject(Error("synthetic private error"))],
])
  test(`runtime preview fails closed with ${name} final authority fence`, async (t) => {
    const h = await runtimePreviewHarness(t, { fence });
    await assert.rejects(h.manager(h.request), /Preview authority changed/);
    assert.equal(h.h.store.db.prepare("SELECT count(*) AS n FROM policy_previews").get().n, 0);
  });

test("stale final authority cache denies preview; valid cache supplies an executable local path", async (t) => {
  const h = await runtimePreviewHarness(t);
  assert.equal((await h.manager(h.request)).status, 200);
  h.expire();
  await assert.rejects(h.manager(h.request), /Preview authority changed/);
  h.update();
  assert.equal((await h.manager(h.request)).status, 200);
  assert.equal(h.authority.isCurrent({ configurationHash: "a".repeat(64), actorId: "999" }), false);
});

test("future and unreviewed revisions cannot become inclusion causes or trusted correction bindings", async (t) => {
  const input = capture();
  input.input.facts.push(
    fact("synthetic-fact-b", {
      state: "excluded",
      revision: 1,
      correctionReceipt: "synthetic-later-correction",
      observedAt: "2026-10-18T00:00:01.000Z",
    }),
  );
  input.input.facts.push(fact("synthetic-fact-b", { state: "excluded", revision: 2 }));
  const h = await harness(t, { input });
  const result = await h.preview();
  assert.equal(result.status, 200);
  const cause = result.data.changes
    .find((c) => c.actorId === "101")
    .causes.included.find((c) => c.factId === "synthetic-fact-b");
  assert.equal(cause.revision, 0);
  assert.equal(cause.reasons.includes("reviewed_correction"), false);
});

test("current correction beyond frozen cutoff redacts original facts even when its hash was supplied to capture", async (t) => {
  const correction = fact("synthetic-fact-a", {
    state: "excluded",
    revision: 1,
    correctionReceipt: "synthetic-later-correction",
    observedAt: "2026-10-18T00:00:01.000Z",
  });
  const h = await runtimePreviewHarness(t, { correction });
  const record = h.runtime.policyComparisons.comparisons.input(h.retained.inputId);
  assert.equal(
    record.authorization.corrections.some((entry) => entry.hash === comparisonHash(correction)),
    false,
  );
  const result = await h.manager(h.request);
  assert.equal(result.status, 200);
  assert.equal(result.data.redactionsApplied, true);
  assert.equal(
    result.data.before.rows.some((row) => row.evidenceIds.includes("synthetic-fact-a")),
    false,
  );
});

for (const expiry of ["authority", "session", "input"])
  test(`${expiry} expiry during synchronous calculation rolls back all preview writes`, async (t) => {
    const { createPolicyComparisonManager } = await import("../src/policy-comparison.mjs");
    const { createPolicyPreviewAuthority, previewAuthorityLimitsV1 } =
      await import("../src/policy-preview-authority.mjs");
    const h = await harness(t);
    let now = Date.parse(cutoff);
    const authority = createPolicyPreviewAuthority({ now: () => now });
    const hash = "a".repeat(64);
    authority.replace({
      schemaVersion: previewAuthorityLimitsV1.schemaVersion,
      revision: 1,
      validUntil: now + (expiry === "authority" ? 1 : 60_000),
      configurationHashes: [hash],
      reviewers: [{ actorId: "201", roleVersion: "1" }],
    });
    const sid = createHash("sha256").update("a".repeat(43)).digest("base64url");
    h.store.transaction((state) => {
      if (expiry === "session") state.sessions[sid].expires = now + 1;
      if (expiry === "input")
        h.store.db.prepare("UPDATE policy_preview_inputs SET expires=? WHERE id=?").run(now + 1, h.retained.inputId);
    });
    const session = { ...h.store.read().sessions[sid], sid };
    h.comparisons.metrics = {
      ...metrics,
      comparePolicies(...args) {
        const result = metrics.comparePolicies(...args);
        now += 2;
        h.advance(2);
        return result;
      },
    };
    let sent = false;
    const manager = createPolicyComparisonManager({
      comparisons: h.comparisons,
      withAuthorizedInputs: async (_, work) =>
        work([], {
          refreshApproval: async () => true,
          isCurrent: () =>
            authority.isCurrent({
              configurationHash: hash,
              actorId: session.actorId,
              roleVersion: session.roleVersion,
            }),
        }),
    });
    await assert.rejects(
      manager({
        path: prefix,
        method: "POST",
        session,
        refreshSession: async () => session,
        input: {
          inputId: h.retained.inputId,
          candidatePolicy: policy({ version: "synthetic-expiring-next", rank: false }),
        },
        respond: () => {
          sent = true;
        },
      }),
      expiry === "authority"
        ? /Preview authority changed/
        : expiry === "session"
          ? /Reviewer session revoked/
          : /input or result unavailable/,
    );
    assert.equal(sent, false);
    assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM policy_previews").get().n, 0);
    assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM policy_preview_candidate_versions").get().n, 0);
  });

for (const operation of ["list", "saved read"])
  test(`${operation} crossing input expiry cannot return private output`, async (t) => {
    const h = await harness(t);
    const saved = await h.preview();
    const sid = createHash("sha256").update("a".repeat(43)).digest("base64url");
    h.store.transaction((state) => {
      state.sessions[sid].expires += comparisonLimitsV1.retentionMs;
    });
    const method = operation === "list" ? "metadata" : "redact";
    const original = h.comparisons[method].bind(h.comparisons);
    h.comparisons[method] = (...args) => {
      const result = original(...args);
      h.advance(comparisonLimitsV1.retentionMs);
      return result;
    };
    const reply = await h.call(operation === "list" ? `${prefix}/inputs` : `${prefix}/${saved.data.comparisonId}`);
    assert.equal(reply.status, 404);
    assert.equal(reply.data.error, "Preview input or result unavailable");
  });

test("HTTP serialization rechecks expiry before success headers or private bytes", async (t) => {
  const h = await harness(t);
  const original = h.comparisons.redact.bind(h.comparisons);
  h.comparisons.redact = (...args) => {
    const result = original(...args);
    return {
      ...result,
      toJSON() {
        h.advance(900_001);
        return result;
      },
    };
  };
  const reply = await h.preview();
  assert.equal(reply.status, 401);
  assert.deepEqual(reply.data, { error: "Reviewer session revoked" });
});

test("expiry crossed by commit withholds the response even after a valid calculation", async (t) => {
  const h = await harness(t);
  const transaction = h.store.transaction.bind(h.store);
  let committed = false;
  h.store.transaction = (...args) => {
    const result = transaction(...args);
    if (result?.comparisonId) {
      committed = true;
      h.advance(900_001);
    }
    return result;
  };
  const reply = await h.preview();
  assert.equal(committed, true);
  assert.equal(reply.status, 401);
  assert.deepEqual(reply.data, { error: "Reviewer session revoked" });
});

test("identity-bound private inputs require a host verifier and cannot use the legacy minimal-input path", async (t) => {
  const input = capture();
  input.authorization.identityEvidence = {
    schemaVersion: "pipeline-identity-evidence/v1",
    normalizationHashes: ["a".repeat(64)],
  };
  const h = await harness(t, { input });
  const reply = await h.preview();
  assert.equal(reply.status, 409);
  assert.deepEqual(reply.data, { error: "Frozen identity verification unavailable" });
  assert.equal((await h.call(prefix + "/inputs")).status, 409);
  const record = h.comparisons.input(h.retained.inputId);
  assert.throws(() => h.comparisons.compare(record, policy()), /identity verification unavailable/);
  assert.throws(() => h.comparisons.compare(record, policy(), async () => record.input), /cannot be computed/);
  assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM policy_previews").get().n, 0);
});

test("private triage replay preserves the exact registry grouping policy version", async (t) => {
  const input = capture();
  const grouping = metrics.getMetricGroupingPolicy("items_triaged");
  const triage = policy({
    metricId: "items_triaged",
    version: "synthetic-triage/v1",
    unit: metrics.getMetricDefinition("items_triaged").definition.unit,
    roles: ["triager"],
    groupBy: grouping.group_by,
    groupingSeconds: grouping.grouping_seconds,
    groupingPolicyVersion: grouping.version,
    dateBasis: grouping.date_basis,
    rankedStates: [grouping.state],
  });
  input.policies = [triage];
  input.input.facts = [
    fact("synthetic-triage-a", { metricId: "items_triaged", role: "triager", rawState: "labeled:bug" }),
    fact("synthetic-triage-b", { metricId: "items_triaged", role: "triager", rawState: "labeled:bug" }),
  ];
  const h = await harness(t, { input });
  const retained = h.comparisons.input(h.retained.inputId);
  assert.equal(retained.policies[0].groupingPolicyVersion, grouping.version);
  const candidate = { ...triage, version: "synthetic-triage/v2" };
  const preview = await h.preview(candidate);
  assert.equal(preview.status, 200, JSON.stringify(preview));
  assert.equal(preview.data.before.rows[0].value, 1);
  assert.equal(preview.data.after.rows[0].value, 1);
  assert.equal(preview.data.publicEnabled, false);
  for (const patch of [
    { groupingPolicyVersion: undefined },
    { groupingPolicyVersion: "unreviewed-grouping/v2" },
    { groupingPolicyVersion: { injected: true } },
    { groupingSeconds: 60 },
  ])
    assert.equal((await h.preview({ ...candidate, ...patch })).status, 400);
  await h.restart();
  const replay = await h.call(prefix + "/" + preview.data.comparisonId);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.resultHash, preview.data.resultHash);
});
