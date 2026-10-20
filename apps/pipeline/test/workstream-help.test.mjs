// All receipts and immutable statement bytes are explicit fictional test data.
import test from "node:test";
import assert from "node:assert/strict";
import { applyRecognitionReceipt } from "@pick-your-ai/github";
import { workstreamHelpVersion, reviewedWorkstreamHelpBindingSchema } from "@pick-your-ai/contracts";
import { recognitionFingerprint } from "../src/recognition-adapter.mjs";
import { selectWorkstreamHelp, validateWorkstreamHelpBindings } from "../src/workstream-help.mjs";
import { attachSyntheticEvidenceIntake } from "../../../tests/fixtures/evidence-intake.mjs";
import { evidenceIntakeAuthority } from "../../controls/src/evidence-intake.mjs";
import {
  helpScenario, updateHelpStatement, runHelp, helpCutoff, sha256,
} from "../../../tests/fixtures/workstream-help.mjs";

const invalid = /workstream_help_evidence_unverified/;
test("reviewed help binds actual normalized source, exact independent review and immutable bytes without changing metric units", () => {
  const s = helpScenario();
  const original = structuredClone(s.input);
  const out = runHelp(s);
  assert.equal(out.reviewedWorkstreamHelp.length, 1);
  const help = out.reviewedWorkstreamHelp[0];
  assert.equal(help.statement.sourceRevision, s.evidence.sourceRevision);
  assert.notEqual(help.statement.sourceRevision, help.statementRevision);
  assert.equal(help.statementHash, sha256(s.record.statement.content));
  assert.equal(help.statement.actorId, "101");
  assert.equal(out.facts.filter((fact) => fact.metricId === "maintenance").length, 1);
  assert.deepEqual(out.facts.slice(0, original.facts.length), original.facts);
  assert.deepEqual(s.input, original);
  assert.doesNotMatch(JSON.stringify(out.reviewedWorkstreamHelp), /private-help|requestVersion|decisionId|reviewerId|validUntil|sourceUseReview/);
});

test("current Project membership and categories cannot supply a missing reviewed relationship", () => {
  const s = helpScenario();
  delete s.binding.workstreamHelp;
  s.candidate.currentContext = { projects: ["PVT_A", "PVT_B"], workstreams: ["platform", "docs-team"] };
  s.candidate.eventContext = { projects: ["PVT_A"], workstreams: ["platform"] };
  const out = runHelp(s);
  assert.equal(Object.hasOwn(out, "reviewedWorkstreamHelp"), false);
  assert.equal(out.facts.filter((fact) => fact.metricId === "maintenance").length, 1);
  const raw = helpScenario();
  raw.binding.workstreamHelp.records = [];
  assert.deepEqual(runHelp(raw).reviewedWorkstreamHelp, []);
});

for (const [name, change] of Object.entries({
  "unmatched observed revision": (s) => { s.statement.sourceRevision = "another-observation"; updateHelpStatement(s); },
  "another source actor": (s) => { s.statement.actorId = "303"; updateHelpStatement(s); },
  "another source artifact": (s) => { s.statement.artifactId = "PR_other"; updateHelpStatement(s); },
  "another repository": (s) => { s.statement.repositoryId = "3"; updateHelpStatement(s); },
  "another source URL": (s) => { s.statement.sourceUrl += "9"; updateHelpStatement(s); },
  "a source clock substituted by acceptance": (s) => { s.statement.occurredAt = s.record.validUntil; updateHelpStatement(s); },
  "a stale request version": (s) => { s.record.requestVersion++; },
  "a different decision": (s) => { s.record.decisionId = "private-other-review"; },
  "an expired observation cutoff": (s) => { s.record.validUntil = "2026-10-10T09:59:59.9999Z"; },
  "a forged content digest": (s) => { s.record.statement.sha256 = "a".repeat(64); },
  "a foreign statement repository": (s) => { s.record.statement.url = s.record.statement.url.replace("example-repo", "foreign-repo"); },
  "a mutable statement URL": (s) => { s.record.statement.url = s.record.statement.url.replace("b".repeat(40), "main"); },
  "a different immutable statement revision": (s) => { s.record.statement.revision = "a".repeat(40); },
  "an extra private property": (s) => { s.record.privateReason = "PRIVATE_MUST_NOT_PROJECT"; },
  "duplicate record identity": (s) => { s.binding.workstreamHelp.records.push(structuredClone(s.record)); },
  "sparse records": (s) => { s.binding.workstreamHelp.records.length = 2; },
  "an unknown workstream": (s) => { s.binding.workstreamHelp.workstreams.pop(); },
  "an unsupported metric destination": (s) => { s.binding.metricId = "first_contribution"; },
})) {
  test("help admission rejects " + name + " before a receipt callback", () => {
    const s = helpScenario();
    change(s);
    let calls = 0;
    assert.throws(() => runHelp(s, (input) => { calls++; return input; }), invalid);
    assert.equal(calls, 0);
  });
}

test("accessors, proxies, duplicate JSON keys and contradictory immutable bytes cannot become proof", () => {
  const accessor = helpScenario();
  let invoked = false;
  Object.defineProperty(accessor.record.statement, "content", { enumerable: true, get() { invoked = true; return ""; } });
  assert.throws(() => recognitionFingerprint(accessor.state, [accessor.binding]), invalid);
  assert.equal(invoked, false);
  const proxy = helpScenario();
  proxy.binding.workstreamHelp = new Proxy(proxy.binding.workstreamHelp, { get() { throw new Error("trap invoked"); } });
  assert.throws(() => recognitionFingerprint(proxy.state, [proxy.binding]), invalid);
  const duplicate = helpScenario();
  duplicate.record.statement.content = duplicate.record.statement.content.replace(
    '"role":"author"', '"role":"unknown","role":"author"',
  );
  duplicate.record.statement.sha256 = sha256(duplicate.record.statement.content);
  assert.throws(() => runHelp(duplicate), invalid);
  const contradictory = helpScenario();
  const other = helpScenario(11).record;
  other.statement.url = contradictory.record.statement.url;
  contradictory.binding.workstreamHelp.records.push(other);
  assert.throws(() => validateWorkstreamHelpBindings([contradictory.binding]), invalid);
});

for (const [name, change] of Object.entries({
  "withdrawn request": (s) => { s.request.status = "withdrawn"; },
  "reopened appeal": (s) => { s.request.status = "appealed"; },
  "missing current intake": (s) => { delete s.request.intake; },
  "missing source-use review": (s) => { delete s.decision.sourceUseReview; s.state.audit = [structuredClone(s.decision)]; },
  "pending collaborator": (s) => { s.request.collaborators["303"] = "pending"; },
  "declined collaborator": (s) => { s.request.collaborators["303"] = "declined"; },
})) {
  test(name + " supplies no optional help or accepted metric credit", () => {
    const s = helpScenario();
    change(s);
    const out = runHelp(s);
    assert.deepEqual(out.reviewedWorkstreamHelp, []);
    assert.equal(out.facts.some((fact) => fact.metricId === "maintenance"), false);
  });
}

function alias(s, { reverseRelationship = false } = {}) {
  const request = structuredClone(s.request);
  request.id += "-alias";
  request.history[0].id += "-alias";
  request.history[0].receipt = request.id;
  request.history[0].at += 1000;
  const record = structuredClone(s.record);
  record.requestId = request.id;
  record.decisionId = request.history[0].id;
  if (reverseRelationship) {
    record.statement.url = record.statement.url.replace(".json", "-different.json");
    const statement = JSON.parse(record.statement.content);
    [statement.from, statement.to] = [statement.to, statement.from];
    record.statement.content = JSON.stringify(statement) + "\n";
    record.statement.sha256 = sha256(record.statement.content);
  }
  attachSyntheticEvidenceIntake(request, {
    intake: { roles: { submitter: "author", collaborators: {} } },
    sourceUseReview: { references: [{ locator: record.statement.url, revision: record.statement.revision }] },
  });
  s.state.requests[request.id] = request;
  s.state.audit.push(structuredClone(request.history[0]));
  s.binding.workstreamHelp.records.push(record);
  return { request, record };
}
test("valid aliases retain one event; a conflicting later alias cannot disappear through metric deduplication", () => {
  const s = helpScenario();
  const first = runHelp(s);
  alias(s);
  s.state.requests = Object.fromEntries(Object.entries(s.state.requests).reverse());
  s.binding.workstreamHelp.records.reverse();
  assert.deepEqual(runHelp(s).reviewedWorkstreamHelp, first.reviewedWorkstreamHelp);
  const bad = helpScenario();
  alias(bad, { reverseRelationship: true });
  assert.throws(() => runHelp(bad), invalid);
});

test("later help review binds the retained earlier source acceptance without changing metric receipt selection", () => {
  const s = helpScenario();
  const prior = runHelp(s);
  const later = alias(s);
  s.binding.workstreamHelp.records = [later.record];
  const out = runHelp(s);
  const help = out.reviewedWorkstreamHelp[0];
  assert.ok(help);
  assert.equal(help.acceptedAt, prior.reviewedWorkstreamHelp[0].acceptedAt);
  assert.equal(help.reviewedAt, "2026-10-09T10:00:01.000Z");
  assert.deepEqual(out.facts, prior.facts);
  assert.equal(out.facts.find((fact) => fact.id === help.contributionId).acceptanceReceipt, s.decision.id);
  assert.equal(Object.hasOwn(help, "sourceAcceptance"), false);
});

for (const [name, change] of Object.entries({
  "withdrawal": (s) => { s.request.status = "withdrawn"; },
  "consent withdrawal": (s) => { delete s.request.intake; },
  "superseded source review": (s) => { s.request.version++; },
  "current actor suppression": (s) => { s.state.profiles[s.request.owner] = { suppressed: true }; },
})) {
  test("later help cannot resurrect original source after " + name, () => {
    const s = helpScenario();
    const later = alias(s);
    s.binding.workstreamHelp.records = [later.record];
    change(s);
    assert.deepEqual(runHelp(s).reviewedWorkstreamHelp, []);
  });
}

test("conflicting original acceptance identities and another actor cannot be hidden by an alias", () => {
  const s = helpScenario();
  const later = alias(s);
  later.record.sourceAcceptance = {
    requestId: later.request.id, requestVersion: later.request.version, decisionId: later.request.history[0].id,
  };
  assert.throws(() => runHelp(s), invalid);
  const foreign = helpScenario();
  const other = alias(foreign);
  foreign.binding.workstreamHelp.records = [other.record];
  other.request.owner = "303";
  attachSyntheticEvidenceIntake(other.request, {
    intake: { roles: { submitter: "author", collaborators: {} } },
    sourceUseReview: { references: [{ locator: other.record.statement.url, revision: other.record.statement.revision }] },
  });
  foreign.state.audit = [structuredClone(foreign.decision), structuredClone(other.request.history[0])];
  assert.deepEqual(runHelp(foreign).reviewedWorkstreamHelp, []);
});

test("independent audit, factual source and callback output remain mandatory", () => {
  const noAudit = helpScenario();
  noAudit.state.audit = [];
  assert.throws(() => runHelp(noAudit), /recognition_decision_unverified/);
  const source = helpScenario();
  source.input.isSynthetic = true;
  assert.throws(() => runHelp(source), /recognition|maintenance|workstream_help/);
  const callback = helpScenario();
  assert.throws(() => runHelp(callback, (input, receipt, reviewers) => {
    const out = applyRecognitionReceipt(input, receipt, reviewers);
    out.facts.at(-1).actorId = "303";
    return out;
  }), invalid);
});

test("correction selection removes stale help instead of transferring its factual assertion", () => {
  const out = runHelp(helpScenario());
  const help = out.reviewedWorkstreamHelp[0];
  const fact = out.facts.find((entry) => entry.id === help.contributionId);
  const evidence = new Map(out.evidence.map((entry) => [entry.contribution.contributionId, entry]));
  assert.equal(selectWorkstreamHelp(out.reviewedWorkstreamHelp, [fact], evidence, out.workstreamHelpSourceDecisions).length, 1);
  for (const patch of [
    { actorId: "303" }, { state: "excluded" }, { role: "coauthor" }, { acceptanceReceipt: "different-current-receipt" },
    { occurredAt: "2026-10-07T10:00:00.0001Z" }, { acceptedAt: "2026-10-09T10:00:01.000Z" },
  ]) assert.deepEqual(selectWorkstreamHelp(out.reviewedWorkstreamHelp, [{ ...fact, ...patch }], evidence, out.workstreamHelpSourceDecisions), []);
});

test("help fingerprints bind exact proof and current decisions while an absent opt-in keeps old authority", () => {
  const s = helpScenario();
  const original = recognitionFingerprint(s.state, [s.binding]);
  s.record.validUntil = "2026-10-12T00:00:00.000Z";
  assert.notEqual(recognitionFingerprint(s.state, [s.binding]), original);
  delete s.binding.workstreamHelp;
  const noHelp = recognitionFingerprint(s.state, [s.binding]);
  // Exact pre-extension authority tuple for this established maintenance fixture.
  // A new optional rule must not retire an unrelated, unchanged publication.
  const legacy = [
    "localization-review-target/v1", [s.request], [], [JSON.stringify(s.decision)], [s.binding],
    "maintenance-merged-participant/v1", evidenceIntakeAuthority(),
  ];
  assert.equal(noHelp, sha256(JSON.stringify(legacy)));
  assert.equal(Object.hasOwn(runHelp(s), "reviewedWorkstreamHelp"), false);
});

test("persisted help and proof are revoked after actual SQL and SQLite reopen, then recompute without credit", async (t) => {
  const { harness, components, publicScope } = await import("./harness.mjs");
  const { createPipeline } = await import("../src/runtime.mjs");
  const s = helpScenario();
  const h = await harness(t, {
    markerFreeConfig: true, dataMode: "public", payloads: [s.payload],
    defaultDeliveryNormalizationVersion: components.github.defaultDeliveryNormalizationVersion,
    normalizerFactory: () => async () => structuredClone(s.input),
    configure(config) {
      config.repositories[0].families = ["pull_requests"];
      config.recognitionBindings = [s.binding];
      config.approvedWorkstreamHelpRuleVersion = workstreamHelpVersion;
      const policy = { ...config.policies[0].policy, ...s.policies[0].policy };
      config.policies = [{ policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "fixture-help-approval" }];
    },
  });
  h.controlsStore.transaction((state) => { state.requests = s.state.requests; state.audit = s.state.audit; });
  const result = await h.runtime.runOnce({ cutoff: helpCutoff });
  assert.equal(result.state, "published");
  const pin = result.publications[0].snapshotId;
  const path = "/api/v1/contributors/101/workstream-help?snapshot=" + pin;
  const response = await h.runtime.app.inject(path);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().recognitions.length, 1);
  assert.doesNotMatch(response.body, /private-help|requestVersion|decisionId|reviewerId|sourceUseReview|PRIVATE/);
  const proofId = response.json().recognitions[0].proof.contributionId;
  const proofPath = "/api/v1/evidence/" + proofId + "?snapshot=" + pin;
  assert.equal((await h.runtime.app.inject(proofPath)).statusCode, 200);
  const confirmation = structuredClone(h.controlsStore.read().pipelinePublications[pin]);
  h.controlsStore.transaction((state) => {
    state.requests[s.request.id].status = "withdrawn";
    components.controls.record(state, state.requests[s.request.id], "101", "withdrawn", Date.parse(helpCutoff));
  });
  await h.runtime.stop();
  await h.reopenDatabase();
  h.controlsStore.close();
  const { join } = await import("node:path");
  h.controlsStore.db = new components.controls.ControlStore(join(h.directory, "controls.sqlite")).db;
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  assert.deepEqual(h.controlsStore.read().pipelinePublications[pin], confirmation);
  assert.equal(await restarted.source.read(publicScope, pin, new AbortController().signal), null);
  for (const url of [path, proofPath]) {
    const denied = await restarted.app.inject(url);
    assert.equal(denied.statusCode, 410, denied.body);
    assert.match(denied.headers["cache-control"], /no-store/);
  }
  const next = await restarted.runOnce({ cutoff: helpCutoff });
  assert.equal(next.state, "published");
  const fresh = await restarted.app.inject("/api/v1/contributors/101/workstream-help?snapshot=" + next.publications[0].snapshotId);
  assert.equal(fresh.statusCode, 200, fresh.body);
  assert.deepEqual(fresh.json().recognitions, []);
  assert.equal((await h.db.query("SELECT count(*) AS n FROM leaderboard_pipeline.normalizations")).rows[0].n > 0, true);
});

for (const [name, make, asKey] of [
  ["escaped control value", () => "\u0000".repeat(1_333_334), false],
  ["escaped property name", () => "\u0000".repeat(1_333_334), true],
  ["unpaired surrogate value", () => "\ud800".repeat(1_333_334), false],
]) {
  test("help rejects over-budget " + name + " before serialization, schema admission or callbacks", (t) => {
    const s = helpScenario();
    const text = make();
    if (asKey) s.record.statement[text] = null;
    else s.record.statement.content = text;
    let parses = 0, clones = 0, callbacks = 0;
    const stringify = JSON.stringify;
    t.mock.method(JSON, "stringify", function (...args) {
      assert.ok(args[0] !== text, "the oversized escaped representation must never be allocated");
      return Reflect.apply(stringify, this, args);
    });
    t.mock.method(reviewedWorkstreamHelpBindingSchema, "safeParse", () => {
      parses++;
      throw new Error("schema admission reached");
    });
    t.mock.method(globalThis, "structuredClone", () => {
      clones++;
      throw new Error("cloning reached");
    });
    assert.throws(() => runHelp(s, () => { callbacks++; throw new Error("receipt callback reached"); }), invalid);
    assert.deepEqual({ parses, clones, callbacks }, { parses: 0, clones: 0, callbacks: 0 });
  });
}

test("an excessive property inventory rejects before descriptor copies, schema admission or receipt callbacks", (t) => {
  const s = helpScenario();
  const excessive = Object.create(null);
  for (let index = 0; index <= 250_000; index++) excessive["field" + index] = null;
  s.binding.workstreamHelp = excessive;
  let parses = 0, callbacks = 0;
  const descriptor = Object.getOwnPropertyDescriptor;
  const descriptors = Object.getOwnPropertyDescriptors;
  t.mock.method(Object, "getOwnPropertyDescriptor", function (value, key) {
    assert.ok(value !== excessive, "count rejection must precede per-property descriptor access");
    return Reflect.apply(descriptor, this, [value, key]);
  });
  t.mock.method(Object, "getOwnPropertyDescriptors", function (value) {
    assert.ok(value !== excessive, "bulk descriptor copies must not precede the count bound");
    return Reflect.apply(descriptors, this, [value]);
  });
  t.mock.method(reviewedWorkstreamHelpBindingSchema, "safeParse", () => {
    parses++;
    throw new Error("schema admission reached");
  });
  assert.throws(() => runHelp(s, () => { callbacks++; throw new Error("receipt callback reached"); }), invalid);
  assert.deepEqual({ parses, callbacks }, { parses: 0, callbacks: 0 });
});

test("ordinary escaped and multibyte public labels retain their exact reviewed statement bytes", () => {
  const s = helpScenario();
  const label = 'Platform "care" \\ documentation é 中 🧭';
  s.statement.from.label = label;
  s.binding.workstreamHelp.workstreams[0].label = label;
  updateHelpStatement(s);
  const out = runHelp(s);
  assert.equal(out.reviewedWorkstreamHelp[0].statement.from.label, label);
  assert.equal(out.reviewedWorkstreamHelp[0].statementHash, sha256(s.record.statement.content));
});
