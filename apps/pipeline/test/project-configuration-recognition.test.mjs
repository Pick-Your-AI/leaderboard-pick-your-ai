// These fictional source observations and protected review records exercise the
// actual materializer. They do not attest to a live Project edit or permission.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  normalizeGithubObservation,
  applyRecognitionReceipt,
  defaultDeliveryNormalizationVersion,
} from "@pick-your-ai/github";
import { materializeRecognition, recognitionFingerprint } from "../src/recognition-adapter.mjs";
import { domainDateBasis } from "../src/domain-recognition.mjs";
import { hasReviewedEvidenceIntake } from "../../controls/src/evidence-intake.mjs";
import { evidenceIntakeAuthority } from "../../controls/src/evidence-intake.mjs";
import { attachSyntheticEvidenceIntake } from "../../../tests/fixtures/evidence-intake.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("../../../packages/github/test/fixtures/engineering.json", import.meta.url), "utf8"),
);
const beforeRevision = "b".repeat(40),
  afterRevision = "c".repeat(40);
const occurredAt = "2026-10-07T10:00:00.000Z";
const acceptedAt = "2026-10-09T10:00:00.000Z";
const cutoff = "2026-10-10T10:00:00.000Z";
const metric = "project_configuration";
const error = /project_configuration_evidence_unverified/;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function attachProjectIntake(request, role = "editor") {
  return attachSyntheticEvidenceIntake(request, {
    intake: {
      roles: {
        submitter: role,
        collaborators: Object.fromEntries(Object.keys(request.collaborators).map((id) => [id, null])),
      },
    },
  });
}
const pin = (revision, contentHash, path = "project/configuration.json") => ({
  revision,
  sourceRevisionUrl: `https://github.com/synthetic-owner/repository/blob/${revision}/${path}`,
  contentHash,
});
const facets = {
  "field add": { kind: "field", fieldId: "FIELD_1", operation: "add", before: null, after: "Effort" },
  "field rename": { kind: "field", fieldId: "FIELD_1", operation: "rename", before: "Effort", after: "Size" },
  "option add": {
    kind: "option",
    fieldId: "FIELD_1",
    optionId: "OPTION_1",
    operation: "add",
    before: null,
    after: "Small",
  },
  "option rename": {
    kind: "option",
    fieldId: "FIELD_1",
    optionId: "OPTION_1",
    operation: "rename",
    before: "Small",
    after: "Low",
  },
  "view add": { kind: "view", viewId: "VIEW_1", operation: "add", before: null, after: "Delivery" },
  "view rename": { kind: "view", viewId: "VIEW_1", operation: "rename", before: "Delivery", after: "Milestones" },
  filter: { kind: "filter", viewId: "VIEW_1", before: "", after: "status:Done" },
  group: { kind: "group", viewId: "VIEW_1", before: [], after: ["FIELD_1"] },
  sort: { kind: "sort", viewId: "VIEW_1", before: [], after: [{ fieldId: "FIELD_1", direction: "asc" }] },
  layout: { kind: "layout", viewId: "VIEW_1", before: "table", after: "board" },
  "workflow enable": {
    kind: "workflow",
    workflowId: "WORKFLOW_1",
    operation: "enable",
    before: { enabled: false, configurationHash: "a".repeat(64) },
    after: { enabled: true, configurationHash: "a".repeat(64) },
  },
  "workflow disable": {
    kind: "workflow",
    workflowId: "WORKFLOW_1",
    operation: "disable",
    before: { enabled: true, configurationHash: "a".repeat(64) },
    after: { enabled: false, configurationHash: "a".repeat(64) },
  },
  "workflow configure": {
    kind: "workflow",
    workflowId: "WORKFLOW_1",
    operation: "configure",
    before: { enabled: true, configurationHash: "a".repeat(64) },
    after: { enabled: true, configurationHash: "f".repeat(64) },
  },
};

function fixtureProof(record) {
  // Retain actual finite fixture bytes and their hashes, rather than treating
  // arbitrary hex strings as evidence that the fixture changed. A production
  // host must independently check its own pinned public snapshot bytes.
  const states = record.details.facets
    .map((facet) => {
      const { before, after, ...identity } = facet;
      return { identity, before, after };
    })
    .sort((left, right) => JSON.stringify(left.identity).localeCompare(JSON.stringify(right.identity)));
  const bytes = Object.fromEntries(
    ["before", "after"].map((side) => [
      side,
      JSON.stringify({
        fixture: "Fictional reviewed Project configuration, not a live API capture",
        projectId: record.details.projectId,
        configuration: states.map((entry) => ({ ...entry.identity, value: entry[side] })),
      }) + "\n",
    ]),
  );
  for (const side of ["before", "after"]) record.details[side].contentHash = sha256(bytes[side]);
  const attribution = `Fictional reviewed role: contributor ${record.details.contributor.actorId} is the Project configuration ${record.details.contributor.role}.\n`;
  record.details.contributor.attribution.contentHash = sha256(attribution);
  return { ...bytes, attribution };
}

function scenario(facet = "field add") {
  const input = normalizeGithubObservation({
    repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_rest", revision: occurredAt, isSynthetic: false },
    family: "pull_request",
    action: "closed",
    occurredAt,
    observedAt: acceptedAt,
    payload: {
      repository: fixture.repository,
      pull_request: { ...structuredClone(fixture.pull_request), user: fixture.author, merge_commit_sha: afterRevision },
    },
    integration: {
      before: beforeRevision,
      after: afterRevision,
      targetBranch: "main",
      defaultBranch: "main",
      canonicalChangeId: "fixture-project-change",
      commitShas: [afterRevision],
      diff: {
        before: beforeRevision,
        after: afterRevision,
        complete: true,
        files: [{ path: "project/configuration.json", additions: 2, deletions: 1 }],
      },
    },
  });
  const candidate = input.facts.find((fact) => fact.metricId === "pr_merged");
  const evidence = input.evidence.find((entry) => entry.contribution.contributionId === candidate.id);
  const decision = {
    id: "private-project-decision",
    actor: "202",
    action: "accepted",
    at: Date.parse(acceptedAt),
    version: 2,
    policyVersion: "project-review:v1",
  };
  const request = {
    id: "private-project-request",
    kind: "evidence",
    status: "accepted",
    owner: "101",
    version: 2,
    category: "project_configuration",
    scope: "repository:2:project:PVT_1",
    policyVersion: decision.policyVersion,
    locator: evidence.artifact.publicUrl,
    collaborators: {},
    history: [decision],
  };
  attachProjectIntake(request);
  const record = {
    requestId: request.id,
    requestVersion: request.version,
    decisionId: decision.id,
    factId: candidate.id,
    sourceRevision: evidence.sourceRevision,
    sourceRevisionUrl: evidence.sourceRevisionUrl,
    validUntil: "2026-11-01T00:00:00.000Z",
    synthetic: false,
    publicSafe: true,
    details: {
      projectId: "PVT_1",
      changeSetId: "project-change:1",
      before: pin(beforeRevision, "d".repeat(64)),
      after: pin(afterRevision, "e".repeat(64)),
      contributor: {
        actorId: "101",
        role: "editor",
        attribution: pin(afterRevision, "f".repeat(64), "project/attribution.md"),
      },
      facets: [structuredClone(facets[facet])],
    },
  };
  const binding = {
    category: request.category,
    scope: request.scope,
    policyVersion: decision.policyVersion,
    metricId: metric,
    sourceMetricId: "pr_merged",
    repositoryId: "2",
    reviewerIds: ["202"],
    domainEvidence: {
      version: "project-configuration-evidence/v1",
      projects: [{ id: "PVT_1", url: "https://github.com/orgs/synthetic-owner/projects/1" }],
      records: [record],
    },
  };
  const proofBytes = fixtureProof(record);
  return {
    input,
    candidate,
    evidence,
    decision,
    request,
    record,
    binding,
    proofBytes,
    state: { requests: { [request.id]: request }, audit: [decision], profiles: {} },
    policies: [
      {
        policy: {
          metricId: metric,
          version: decision.policyVersion,
          dateBasis: "acceptedAt",
          groupBy: "canonical",
          rankedStates: ["qualified"],
        },
      },
    ],
  };
}
const run = (s, apply = applyRecognitionReceipt) =>
  materializeRecognition(s.input, s.state, [s.binding], s.policies, apply, cutoff);
const recognized = (out) => out.facts.filter((fact) => fact.metricId === metric && fact.state === "qualified");
function alias(s, suffix = "later") {
  const request = structuredClone(s.request);
  request.id += `-${suffix}`;
  const decision = request.history.at(-1);
  decision.id += `-${suffix}`;
  decision.at += 1000;
  decision.receipt = request.id;
  attachProjectIntake(request);
  assert.equal(hasReviewedEvidenceIntake(request), true, "alias must reach typed proof validation");
  s.state.requests[request.id] = request;
  s.state.audit.push(decision);
  const record = structuredClone(s.record);
  record.requestId = request.id;
  record.decisionId = decision.id;
  s.binding.domainEvidence.records.push(record);
  return { request, decision, record };
}

test("project configuration: generic receipts cannot establish typed before/after proof", () => {
  const s = scenario();
  delete s.binding.domainEvidence;
  let calls = 0;
  assert.throws(
    () =>
      run(s, (...args) => {
        calls++;
        return applyRecognitionReceipt(...args);
      }),
    error,
  );
  assert.equal(calls, 0);
});

for (const [label, facet] of Object.entries(facets))
  test(`project configuration: valid typed ${label} contributes one accepted change set`, () => {
    const s = scenario(label),
      original = structuredClone(s.input);
    const out = run(s),
      facts = recognized(out);
    assert.notEqual(s.proofBytes.before, s.proofBytes.after);
    assert.equal(s.record.details.before.contentHash, sha256(s.proofBytes.before));
    assert.equal(s.record.details.after.contentHash, sha256(s.proofBytes.after));
    assert.equal(s.record.details.contributor.attribution.contentHash, sha256(s.proofBytes.attribution));
    assert.equal(facts.length, 1);
    assert.equal(facts[0].acceptedAt, acceptedAt);
    assert.equal(facts[0].occurredAt, occurredAt);
    assert.equal(facts[0].role, "author");
    assert.deepEqual(out.evidence.at(-1).contribution.reasonCodes, [
      "independent_recognition_receipt",
      "domain_metric:project_configuration",
      "domain_clock:accepted_at",
      "reviewed_configuration_not_automated_item_effects",
      "configuration_role:editor",
      `configuration_facet:${facet.kind}`,
    ]);
    assert.doesNotMatch(
      JSON.stringify(out.evidence.at(-1)),
      /private-project|PVT_1|WORKFLOW_1|changeSetId|contentHash|attribution\.md/,
    );
    assert.deepEqual(s.input, original);
  });

const invalid = [
  [
    "missing before snapshot",
    (s) => {
      delete s.record.details.before;
    },
  ],
  [
    "missing configuration actor role",
    (s) => {
      delete s.record.details.contributor.role;
    },
  ],
  [
    "creator is not a configuration role",
    (s) => {
      s.record.details.contributor.role = "creator";
    },
  ],
  [
    "foreign configuration contributor",
    (s) => {
      s.record.details.contributor.actorId = "303";
    },
  ],
  [
    "missing public attribution",
    (s) => {
      delete s.record.details.contributor.attribution;
    },
  ],
  [
    "private or unreviewed configuration",
    (s) => {
      s.record.publicSafe = false;
    },
  ],
  [
    "synthetic review evidence",
    (s) => {
      s.record.synthetic = true;
    },
  ],
  [
    "synthetic source fact",
    (s) => {
      s.input.syntheticFactIds = [s.candidate.id];
    },
  ],
  [
    "synthetic input",
    (s) => {
      s.input.isSynthetic = true;
    },
  ],
  [
    "unknown actor",
    (s) => {
      s.input.actors.find((actor) => actor.id === "101").kind = "unknown";
    },
  ],
  [
    "automated actor",
    (s) => {
      s.input.actors.find((actor) => actor.id === "101").executionMode = "automated";
    },
  ],
  [
    "creator role in source",
    (s) => {
      s.candidate.role = "creator";
    },
  ],
  [
    "stale request revision",
    (s) => {
      s.record.requestVersion++;
    },
  ],
  [
    "foreign decision",
    (s) => {
      s.record.decisionId = "another-decision";
    },
  ],
  [
    "foreign fact",
    (s) => {
      s.record.factId = "another-fact";
    },
  ],
  [
    "duplicate record",
    (s) => {
      s.binding.domainEvidence.records.push(structuredClone(s.record));
    },
  ],
  [
    "unconfigured Project",
    (s) => {
      s.record.details.projectId = "PVT_2";
    },
  ],
  [
    "duplicate Project authority",
    (s) => {
      s.binding.domainEvidence.projects.push(structuredClone(s.binding.domainEvidence.projects[0]));
    },
  ],
  [
    "nonpublic Project locator",
    (s) => {
      s.binding.domainEvidence.projects[0].url = "http://github.com/orgs/owner/projects/1";
    },
  ],
  [
    "mutable before revision",
    (s) => {
      s.record.details.before.revision = "main";
    },
  ],
  [
    "mutable after URL",
    (s) => {
      s.record.details.after.sourceRevisionUrl =
        "https://github.com/synthetic-owner/repository/blob/main/project/configuration.json";
    },
  ],
  [
    "foreign proof repository",
    (s) => {
      s.record.details.before.sourceRevisionUrl = s.record.details.before.sourceRevisionUrl.replace(
        "/repository/",
        "/foreign/",
      );
    },
  ],
  [
    "different snapshot artifact",
    (s) => {
      s.record.details.before.sourceRevisionUrl += ".other";
    },
  ],
  [
    "same snapshot revision",
    (s) => {
      s.record.details.before = pin(afterRevision, "d".repeat(64));
    },
  ],
  [
    "same snapshot content",
    (s) => {
      s.record.details.before.contentHash = s.record.details.after.contentHash;
    },
  ],
  [
    "unbound after revision",
    (s) => {
      s.record.details.after = pin("a".repeat(40), "e".repeat(64));
    },
  ],
  [
    "stale attribution revision",
    (s) => {
      s.record.details.contributor.attribution = pin(beforeRevision, "f".repeat(64), "project/attribution.md");
    },
  ],
  [
    "encoded proof URL",
    (s) => {
      s.record.details.before.sourceRevisionUrl = s.record.details.before.sourceRevisionUrl.replace(
        "configuration",
        "%63onfiguration",
      );
    },
  ],
  [
    "contradictory immutable proof hash",
    (s) => {
      s.record.details.contributor.attribution = { ...s.record.details.after, contentHash: "f".repeat(64) };
    },
  ],
  [
    "missing facets",
    (s) => {
      s.record.details.facets = [];
    },
  ],
  [
    "unknown facet",
    (s) => {
      s.record.details.facets[0].kind = "updatedAt";
    },
  ],
  [
    "duplicate facet",
    (s) => {
      s.record.details.facets.push(structuredClone(s.record.details.facets[0]));
    },
  ],
  [
    "facet no-op",
    (s) => {
      s.record.details.facets = [{ ...facets["field rename"], after: "Effort" }];
    },
  ],
  [
    "add with invented prior value",
    (s) => {
      s.record.details.facets[0].before = "Unknown";
    },
  ],
  [
    "rename without prior value",
    (s) => {
      s.record.details.facets = [{ ...facets["field rename"], before: null }];
    },
  ],
  [
    "extra creator field",
    (s) => {
      s.record.details.createdBy = "101";
    },
  ],
  [
    "ambiguous sort fields",
    (s) => {
      s.record.details.facets = [
        {
          ...structuredClone(facets.sort),
          after: [
            { fieldId: "FIELD_1", direction: "asc" },
            { fieldId: "FIELD_1", direction: "desc" },
          ],
        },
      ];
    },
  ],
  [
    "unknown layout",
    (s) => {
      s.record.details.facets = [{ ...facets.layout, after: "unknown" }];
    },
  ],
  [
    "workflow toggle is not configuration-only",
    (s) => {
      s.record.details.facets = [
        {
          ...structuredClone(facets["workflow configure"]),
          after: { enabled: false, configurationHash: "f".repeat(64) },
        },
      ];
    },
  ],
  [
    "workflow enable does not change state",
    (s) => {
      s.record.details.facets = [
        { ...structuredClone(facets["workflow enable"]), after: { enabled: false, configurationHash: "a".repeat(64) } },
      ];
    },
  ],
  [
    "expired proof",
    (s) => {
      s.record.validUntil = "2026-10-09T23:59:59.999Z";
    },
  ],
  [
    "nanosecond future original source",
    (s) => {
      s.candidate.occurredAt = s.evidence.occurredAt = "2026-10-09T10:00:00.000000001Z";
    },
  ],
  [
    "unknown original source clock",
    (s) => {
      s.candidate.occurredAt = s.evidence.occurredAt = null;
    },
  ],
  [
    "duplicate candidate evidence",
    (s) => {
      s.input.evidence.push(structuredClone(s.evidence));
    },
  ],
  [
    "foreign artifact identity",
    (s) => {
      s.evidence.contribution.artifactId = "foreign-artifact";
    },
  ],
  [
    "mutable collected revision",
    (s) => {
      s.evidence.sourceRevision = s.record.sourceRevision = "main";
    },
  ],
  [
    "already recognized source",
    (s) => {
      s.candidate.state = "qualified";
    },
  ],
  [
    "current Project state substituted for contributor source",
    (s) => {
      s.binding.sourceMetricId = s.candidate.metricId = "project_configuration";
    },
  ],
];
for (const [name, change] of invalid)
  test(`project configuration: ${name} cannot qualify`, () => {
    const s = scenario();
    change(s);
    assert.throws(() => run(s), error);
  });

for (const kind of ["facets", "group", "sort"])
  test(`project configuration: sparse ${kind} cannot replace typed values`, () => {
    const s = scenario();
    s.record.details.facets =
      kind === "facets"
        ? new Array(1)
        : [
            {
              ...structuredClone(facets[kind]),
              after: new Array(1),
            },
          ];
    assert.throws(() => run(s), error);
  });

for (const collection of ["projects", "records"])
  test(`project configuration: sparse ${collection} cannot hide missing authority entries`, () => {
    const s = scenario();
    s.binding.domainEvidence[collection].length++;
    assert.throws(() => run(s), error);
  });

test("project configuration: all facets in one change set still contribute one unit", () => {
  const s = scenario();
  s.record.details.facets = [
    facets["field add"],
    facets["option add"],
    facets["view add"],
    facets.filter,
    facets.group,
    facets.sort,
    facets.layout,
    facets["workflow enable"],
  ].map((facet) => structuredClone(facet));
  fixtureProof(s.record);
  assert.equal(recognized(run(s)).length, 1);
});

for (const role of ["author", "coauthor", "editor"])
  test(`project configuration: an explicitly consented ${role} role stays distinct from source authorship`, () => {
    const s = scenario();
    s.record.details.contributor.role = role;
    fixtureProof(s.record);
    attachProjectIntake(s.request, role);
    assert.equal(recognized(run(s)).length, 1);
    assert.equal(recognized(run(s))[0].role, "author");
  });

for (const role of [null, "reviewer", "another role"])
  test(`project configuration: ${String(role)} intake role cannot authorize a different configuration role`, () => {
    const s = scenario();
    attachProjectIntake(s.request, role);
    assert.equal(hasReviewedEvidenceIntake(s.request), true);
    assert.throws(() => run(s), error);
  });

test("project configuration: a valid confirming receipt shares the earliest canonical unit", () => {
  const s = scenario();
  alias(s);
  const out = run(s);
  assert.equal(recognized(out).length, 1);
  assert.equal(recognized(out)[0].acceptedAt, acceptedAt);
  assert.equal(recognized(out)[0].acceptanceReceipt, s.decision.id);
});

test("project configuration: an invalid later alias is checked before deduplication", () => {
  const s = scenario();
  alias(s).record.details.contributor.role = "creator";
  assert.throws(() => run(s), error);
});

test("project configuration: conflicting later change-set proof cannot hide behind deduplication", () => {
  const s = scenario();
  alias(s).record.details.facets[0].after = "Different configuration";
  assert.throws(() => run(s), error);
});

test("project configuration: conflicting immutable URL hashes across units fail closed", () => {
  const s = scenario();
  const later = alias(s);
  later.record.details.changeSetId = "project-change:2";
  later.record.details.after.contentHash = "a".repeat(64);
  assert.throws(() => run(s), error);
});

test("project configuration: receipt and facet order do not affect the canonical unit", () => {
  const s = scenario();
  s.record.details.facets.push(structuredClone(facets.layout));
  fixtureProof(s.record);
  const initial = recognized(run(s))[0];
  alias(s).record.details.facets.reverse();
  s.binding.domainEvidence.records.reverse();
  s.state.requests = Object.fromEntries(Object.entries(s.state.requests).reverse());
  assert.deepEqual(recognized(run(s)), [initial]);
});

test("project configuration: one workflow change and 100 automated effects remain separate", () => {
  const s = scenario("workflow enable");
  for (let index = 1; index <= 100; index++) {
    const raw = normalizeGithubObservation({
      repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public" },
      proof: {
        verified: true,
        source: "github_webhook",
        revision: occurredAt,
        eventId: `effect:${index}`,
        isSynthetic: false,
      },
      family: "field_change",
      action: "project_status_changed",
      occurredAt,
      observedAt: acceptedAt,
      payload: {
        id: `PVT_ITEM_${index}`,
        url: "https://github.com/orgs/synthetic-owner/projects/1",
        sender: fixture.bot,
        execution_mode: "automated",
        change: { before: "Todo", after: "Done" },
      },
    });
    s.input.facts.push(...raw.facts);
    s.input.evidence.push(...raw.evidence);
    s.input.observations.push(...raw.observations);
    for (const actor of raw.actors)
      if (!s.input.actors.some((entry) => entry.id === actor.id)) s.input.actors.push(actor);
  }
  const rawFacts = structuredClone(s.input.facts.filter((fact) => fact.metricId === "project_status_updates"));
  assert.equal(rawFacts.length, 100);
  const out = run(s);
  assert.equal(recognized(out).length, 1);
  assert.deepEqual(
    out.facts.filter((fact) => fact.metricId === "project_status_updates"),
    rawFacts,
  );
  assert.equal(out.observations.filter((entry) => entry.actorId === "404").length, 100);
  assert.equal(out.actors.find((actor) => actor.id === "404").executionMode, "automated");
});

for (const [name, patch] of [
  ["occurrence clock", { dateBasis: "occurredAt" }],
  ["raw observed ranking", { rankedStates: ["observed"] }],
  ["per-artifact expansion", { groupBy: "actor_artifact" }],
])
  test(`project configuration: policy rejects ${name}`, () => {
    const s = scenario();
    Object.assign(s.policies[0].policy, patch);
    assert.throws(() => run(s), /recognition_policy_not_configured/);
  });

test("project configuration: policy and old publication authority are explicitly versioned", () => {
  const s = scenario();
  assert.equal(domainDateBasis(metric), "acceptedAt");
  const before = recognitionFingerprint(s.state, []);
  const legacyAuthority = [
    "localization-review-target/v1",
    [s.request],
    [],
    s.state.audit.map((event) => JSON.stringify(event)).sort(),
    [s.binding],
    evidenceIntakeAuthority(),
  ];
  assert.notEqual(recognitionFingerprint(s.state, [s.binding]), sha256(JSON.stringify(legacyAuthority)));
  const binding = structuredClone(s.binding);
  assert.notEqual(recognitionFingerprint(s.state, [binding]), before);
  binding.domainEvidence.records[0].details.contributor.role = "author";
  assert.notEqual(recognitionFingerprint(s.state, [binding]), recognitionFingerprint(s.state, [s.binding]));
});

for (const state of ["withdrawn", "pending", "appealed", "rejected"])
  test(`project configuration: ${state} requests retain source observations without accepted credit`, () => {
    const s = scenario();
    s.request.status = state;
    assert.deepEqual(run(s), s.input);
  });

test("project configuration: missing current intake and participant consent never qualify", () => {
  for (const change of [
    (s) => {
      delete s.request.intake;
    },
    (s) => {
      s.request.collaborators["303"] = "pending";
    },
    (s) => {
      s.request.collaborators["303"] = "declined";
    },
    (s) => {
      delete s.decision.sourceUseReview;
    },
  ]) {
    const s = scenario();
    change(s);
    assert.deepEqual(run(s), s.input);
  }
});

test("project configuration: an owner or participant cannot replace independent source review", () => {
  for (const actor of ["101", "303"]) {
    const s = scenario();
    s.request.collaborators = actor === "303" ? { 303: "accepted" } : {};
    s.decision.actor = actor;
    s.binding.reviewerIds.push(actor);
    attachProjectIntake(s.request);
    assert.throws(() => run(s), /recognition_decision_unverified/);
  }
});

test("project configuration persistence: withdrawal retires actual stored recognition after SQL and SQLite reopen", async (t) => {
  const { harness, components, publicScope } = await import("./harness.mjs");
  const { createPipeline } = await import("../src/runtime.mjs");
  const s = scenario("workflow configure");
  // Remove only fixture labels to exercise the public-mode gate, using the same
  // normalized fictional observations. This is not a real Project or review.
  const replace = (value) =>
    JSON.parse(JSON.stringify(value), (_key, entry) =>
      typeof entry === "string"
        ? entry.replace(/synthetic/gi, "fixture").replaceAll("fixture-owner/repository", "example-org/example-repo")
        : entry,
    );
  s.input = replace(s.input);
  s.binding = replace(s.binding);
  s.state = replace(s.state);
  s.request = s.state.requests["private-project-request"];
  attachProjectIntake(s.request);
  s.state.audit = [structuredClone(s.request.history.at(-1))];
  assert.equal(recognized(run(s)).length, 1, "persistent fixture must retain the exact typed authority schema");
  const payload = replace(fixture.pull_request);
  payload.html_url = s.request.locator;
  const h = await harness(t, {
    markerFreeConfig: true,
    dataMode: "public",
    payloads: [payload],
    defaultDeliveryNormalizationVersion,
    normalizerFactory: () => async () => structuredClone(s.input),
    configure(config) {
      config.recognitionBindings = [s.binding];
      const policy = {
        ...config.policies[0].policy,
        ...s.policies[0].policy,
        roles: ["author"],
        unit: components.metrics.getMetricDefinition(metric).definition.unit,
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "fixture-review-approval" },
      ];
    },
  });
  h.controlsStore.transaction((state) => {
    state.requests = s.state.requests;
    state.audit = s.state.audit;
  });
  const result = await h.runtime.runOnce({ cutoff });
  assert.equal(result.state, "published");
  const snapshotId = result.publications[0].snapshotId;
  const published = await h.runtime.source.read(publicScope, snapshotId, new AbortController().signal);
  assert.equal(published.selected.rows[0].result.value, 1);
  const proofId = published.selected.portfolioEvidence.find((entry) => entry.activityState === "accepted").contribution
    .contributionId;
  const proofPath = `/api/v1/evidence/${proofId}?snapshot=${snapshotId}`;
  const response = await h.runtime.app.inject(proofPath);
  assert.equal(response.statusCode, 200, response.body);
  assert.doesNotMatch(response.body, /private-project|project-change:1|contentHash|configurationHash|attribution\.md/);
  const originalConfirmation = structuredClone(h.controlsStore.read().pipelinePublications[snapshotId]);
  h.controlsStore.transaction((state) => {
    const request = state.requests[s.request.id];
    request.status = "withdrawn";
    components.controls.record(state, request, "101", "withdrawn", Date.parse(cutoff));
  });
  await h.runtime.stop();
  await h.reopenDatabase();
  h.controlsStore.close();
  const { join } = await import("node:path");
  // Reopen the physical SQLite handle while retaining the harness-owned wrapper
  // so its existing cleanup closes the new handle exactly once.
  h.controlsStore.db = new components.controls.ControlStore(join(h.directory, "controls.sqlite")).db;
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  assert.equal(h.controlsStore.read().requests[s.request.id].status, "withdrawn");
  assert.deepEqual(h.controlsStore.read().pipelinePublications[snapshotId], originalConfirmation);
  assert.equal(await restarted.source.read(publicScope, snapshotId, new AbortController().signal), null);
  assert.equal((await restarted.app.inject(proofPath)).statusCode, 410);
  await assert.rejects(restarted.aggregateExplanations.read(snapshotId), /authorization_changed/);
  const next = await restarted.runOnce({ cutoff });
  assert.equal(next.state, "published");
  const current = await restarted.source.read(
    publicScope,
    next.publications[0].snapshotId,
    new AbortController().signal,
  );
  assert.equal(
    current.selected.portfolioEvidence.some((entry) => entry.activityState === "accepted"),
    false,
  );
  assert.equal((await h.db.query("SELECT count(*) AS n FROM leaderboard_pipeline.normalizations")).rows[0].n > 0, true);
});
