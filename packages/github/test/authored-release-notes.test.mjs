import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGithubObservation, applyRecognitionReceipt } from "../dist/index.js";
import { aggregateMetric } from "@pick-your-ai/metrics";
import { attachSyntheticEvidenceIntake } from "../../../tests/fixtures/evidence-intake.mjs";
import {
  authoredNotesEnvelope,
  authoredNotesPathPolicy,
  authoredNotesScenario,
  authoredNotesReceipt,
  materializeAuthoredNotes,
  notesCandidate,
  notesPurpose,
  notesMergeTime,
  notesReviewTime,
  notesRevision,
  notesDomainReasons,
  notesCutoff,
} from "../../../tests/fixtures/authored-release-notes.mjs";

const docs = (input) => input.evidence.filter((entry) => entry.contribution.metricIds.includes("documentation"));
test("authored notes source: selected substantive paths add one candidate without changing the documentation unit", () => {
  const envelope = authoredNotesEnvelope({
    files: [
      { path: "docs/releases/v1.md", additions: 4, deletions: 1 },
      { path: "docs/releases/v2.md", additions: 0, deletions: 3 },
    ],
  });
  const selected = normalizeGithubObservation(envelope, authoredNotesPathPolicy());
  const genericPolicy = authoredNotesPathPolicy();
  delete genericPolicy.releaseNotesPaths;
  const generic = normalizeGithubObservation(envelope, genericPolicy);
  assert.equal(docs(selected).length, 1);
  assert.ok(docs(selected)[0].contribution.reasonCodes.includes(notesCandidate));
  assert.ok(!docs(selected)[0].contribution.reasonCodes.includes(notesPurpose));
  assert.deepEqual(selected.facts, generic.facts);
  assert.deepEqual(selected.actors, generic.actors);
  assert.equal(docs(selected)[0].sourceRevision, notesRevision);
  assert.equal(docs(selected)[0].occurredAt, notesMergeTime);
});
for (const [name, files] of [
  [
    "suggestive title and labels on another documentation path",
    [{ path: "docs/guide.md", additions: 3, deletions: 0 }],
  ],
  [
    "zero-change notes move",
    [{ path: "docs/releases/new.md", previousPath: "docs/releases/old.md", additions: 0, deletions: 0 }],
  ],
  ["generated notes", [{ path: "docs/releases/auto.md", additions: 9, deletions: 0, generated: true }]],
  ["imported notes", [{ path: "docs/releases/import.md", additions: 9, deletions: 0, imported: true }]],
  ["formatting-only notes", [{ path: "docs/releases/format.md", additions: 2, deletions: 2, formattingOnly: true }]],
  [
    "excluded rename origin",
    [{ path: "docs/releases/from-research.md", previousPath: "docs/research/report.md", additions: 2, deletions: 1 }],
  ],
])
  test("authored notes source: " + name + " cannot supply a purpose candidate", () => {
    const out = normalizeGithubObservation(authoredNotesEnvelope({ files }), authoredNotesPathPolicy());
    assert.ok(docs(out).every((entry) => !entry.contribution.reasonCodes.includes(notesCandidate)));
  });
for (const [name, mutate] of [
  ["incomplete diff", (x) => (x.integration.diff.complete = false)],
  ["different merge pin", (x) => (x.payload.pull_request.merge_commit_sha = "d".repeat(40))],
  ["unmerged PR", (x) => (x.payload.pull_request.merged = false)],
  ["unverified target branch", (x) => (x.integration.targetBranch = "staging")],
])
  test("authored notes source: " + name + " withholds all documentation authority", () => {
    const envelope = authoredNotesEnvelope();
    mutate(envelope);
    assert.deepEqual(docs(normalizeGithubObservation(envelope, authoredNotesPathPolicy())), []);
  });
for (const [name, value] of [
  ["outside documentation", ["release/"]],
  ["overbroad parent", ["docs"]],
  ["unsafe traversal", ["docs/../release/"]],
  ["empty selection", []],
  ["duplicate path", ["docs/releases/", "docs/releases/"]],
  ["sparse selection", Array(1)],
  ["non-array selection", "docs/releases/"],
  ["overbound selection", Array.from({ length: 101 }, (_, i) => "docs/n" + i)],
])
  test("authored notes policy: " + name + " fails before normalization", () => {
    const policy = authoredNotesPathPolicy();
    policy.releaseNotesPaths = value;
    assert.throws(() => normalizeGithubObservation(authoredNotesEnvelope(), policy), /release.notes|documentation/i);
  });
test("authored notes policy: exact file selection and substantive rename within selected paths remain eligible", () => {
  const policy = authoredNotesPathPolicy();
  policy.releaseNotesPaths = ["docs/releases/exact.md"];
  const envelope = authoredNotesEnvelope({
    files: [{ path: "docs/releases/exact.md", previousPath: "docs/old.md", additions: 1, deletions: 1 }],
  });
  assert.ok(docs(normalizeGithubObservation(envelope, policy))[0].contribution.reasonCodes.includes(notesCandidate));
});
test("authored notes direct receipt: verified purpose retains author and merge time, separate from the later review", () => {
  const s = authoredNotesScenario(),
    original = structuredClone(s.input);
  const output = applyRecognitionReceipt(s.input, authoredNotesReceipt(s), s.binding.reviewerIds);
  const fact = output.facts.find((x) => x.metricId === "documentation" && x.state === "qualified");
  const proof = output.evidence.find((x) => x.contribution.contributionId === fact.id);
  assert.ok(proof.contribution.reasonCodes.includes(notesPurpose));
  for (const reason of notesDomainReasons) assert.ok(proof.contribution.reasonCodes.includes(reason));
  assert.equal(fact.actorId, "101");
  assert.equal(fact.role, "author");
  assert.equal(fact.occurredAt, notesMergeTime);
  assert.equal(proof.occurredAt, notesMergeTime);
  assert.equal(fact.acceptedAt, notesReviewTime);
  assert.equal(proof.sourceRevision, notesRevision);
  assert.deepEqual(s.input, original);
});
for (const [name, mutate] of [
  ["wrong reviewed revision", (s, r) => (r.sourceRevision = "d".repeat(40))],
  ["unsupported purpose", (s, r) => (r.documentationPurpose = "published_release")],
  ["non-documentation destination", (s, r) => (r.metricId = "maintenance")],
  ["qualified source", (s) => (s.target.state = "qualified")],
  ["original source acceptance", (s) => (s.target.acceptedAt = notesReviewTime)],
  [
    "coauthor role",
    (s) => {
      s.target.role = "coauthor";
      s.evidence.contribution.roles = ["coauthor"];
    },
  ],
  ["ineligible proof", (s) => (s.evidence.contribution.qualification = "ineligible")],
  [
    "missing source candidate",
    (s) =>
      (s.evidence.contribution.reasonCodes = s.evidence.contribution.reasonCodes.filter((x) => x !== notesCandidate)),
  ],
])
  test("authored notes direct receipt: " + name + " rejects before output mutation", () => {
    const s = authoredNotesScenario(),
      receipt = authoredNotesReceipt(s);
    mutate(s, receipt);
    const original = structuredClone(s.input);
    assert.throws(() => applyRecognitionReceipt(s.input, receipt, s.binding.reviewerIds));
    assert.deepEqual(s.input, original);
  });
test("authored notes source: bot authors stay bot participation while publication and merge operators supply no authorship", () => {
  const s = authoredNotesScenario({ bot: true });
  const out = applyRecognitionReceipt(s.input, authoredNotesReceipt(s), s.binding.reviewerIds);
  const fact = out.facts.find((x) => x.metricId === "documentation" && x.state === "qualified");
  assert.equal(fact.actorId, "404");
  assert.equal(fact.role, "author");
  assert.deepEqual(out.actors, s.input.actors);
  assert.ok(
    docs(out)
      .find((x) => x.contribution.contributionId === fact.id)
      .contribution.reasonCodes.includes(notesPurpose),
  );
  const release = authoredNotesEnvelope();
  release.family = "release";
  release.action = "published";
  release.payload = {
    repository: release.payload.repository,
    release: {
      id: 900,
      node_id: "R_fixture_900",
      html_url: "https://github.com/synthetic-owner/repository/releases/tag/v1",
      author: { id: 202, login: "publisher", type: "User" },
      published_at: notesReviewTime,
      draft: false,
      prerelease: false,
      tag_name: "v1",
    },
  };
  assert.deepEqual(docs(normalizeGithubObservation(release, authoredNotesPathPolicy())), []);
});

test("authored notes direct receipt: receipt aliases and caller changesets cannot multiply the existing documentation unit", () => {
  const s = authoredNotesScenario(),
    first = authoredNotesReceipt(s),
    later = { ...first, id: "later-purpose-review", acceptedAt: "2026-10-09T11:00:00.000Z" };
  first.changesetId = "arbitrary-one";
  later.changesetId = "arbitrary-two";
  const qualified = (receipt) =>
    applyRecognitionReceipt(s.input, receipt, s.binding.reviewerIds).facts.find(
      (fact) => fact.state === "qualified" && fact.metricId === "documentation",
    );
  const a = qualified(first),
    b = qualified(later);
  assert.equal(a.id, b.id);
  assert.equal(a.canonicalKey, b.canonicalKey);
  assert.equal(a.actorId, b.actorId);
  assert.equal(a.occurredAt, notesMergeTime);
});

function documentationTotal(s, output) {
  const from = "2026-10-01T00:00:00.000Z";
  const result = aggregateMetric(
    {
      datasetId: "fixture-direct-documentation",
      cutoff: notesCutoff,
      backfillRevision: "v1",
      repositoryIds: ["2"],
      actors: output.actors,
      facts: output.facts,
      coverage: [
        {
          schemaVersion: "leaderboard/v1",
          state: "complete",
          source: "github_rest",
          scopeId: "2",
          windowStart: from,
          windowEnd: notesCutoff,
          knownStart: from,
          lastSuccessfulSync: notesCutoff,
          sourceWatermark: notesCutoff,
          missingPages: 0,
          permissionsMissing: [],
          sourceErrors: [],
        },
      ],
    },
    s.policies[0].policy,
    {
      timezone: "UTC",
      from,
      to: notesCutoff,
      repos: [],
      projects: [],
      workstreams: [],
      roles: [],
      actors: "all",
      context: "event",
    },
  );
  return result.rows.find((row) => row.actorId === s.target.actorId)?.value;
}

function directDocumentationReceipt(s, purpose, order, changesetId) {
  const receipt = {
    ...authoredNotesReceipt(s),
    id: "fixture-direct-review-" + order,
    acceptedAt: order === 0 ? notesReviewTime : "2026-10-09T11:00:00.000Z",
    ...(changesetId === undefined ? {} : { changesetId }),
  };
  if (purpose === "generic") delete receipt.documentationPurpose;
  return receipt;
}

function legacyGenericDocumentation(s) {
  const unselected = structuredClone(s.input);
  const source = unselected.evidence.find((entry) => entry.contribution.contributionId === s.target.id);
  source.contribution.reasonCodes = source.contribution.reasonCodes.filter((reason) => reason !== notesCandidate);
  // The unchanged unselected path materializes the exact prior generic identity.
  // Old code retained the original candidate proof without using it for the unit.
  const output = applyRecognitionReceipt(
    unselected,
    directDocumentationReceipt(s, "generic", 0),
    s.binding.reviewerIds,
  );
  output.evidence.find((entry) => entry.contribution.contributionId === s.target.id).contribution.reasonCodes = [
    ...s.evidence.contribution.reasonCodes,
  ];
  return output;
}

for (const order of [
  ["generic", "purpose"],
  ["purpose", "generic"],
])
  for (const aliases of [false, true])
    test(`authored notes direct transition: ${order.join(" then ")} preserves one unit with caller aliases ${aliases}`, () => {
      const s = authoredNotesScenario();
      const receipts = order.map((purpose, index) =>
        directDocumentationReceipt(s, purpose, index, aliases ? "unrelated-caller-unit-" + index : undefined),
      );
      for (const receipt of receipts)
        assert.equal(documentationTotal(s, applyRecognitionReceipt(s.input, receipt, s.binding.reviewerIds)), 1);
      let output = s.input;
      for (const receipt of receipts) output = applyRecognitionReceipt(output, receipt, s.binding.reviewerIds);
      // The direct API retains conflicting reviews. The metric engine must keep
      // its existing fail-closed behavior instead of counting them as two units.
      assert.equal(documentationTotal(s, output), null);
      const facts = output.facts.filter((fact) => fact.metricId === "documentation" && fact.state === "qualified");
      assert.equal(new Set(facts.map((fact) => fact.canonicalKey)).size, 1);
      assert.ok(facts.every((fact) => fact.artifactId === s.target.artifactId && fact.occurredAt === notesMergeTime));
    });

test("authored notes direct transition: repeated generic reviews remain one contribution without adding a purpose", () => {
  const s = authoredNotesScenario();
  assert.equal(
    documentationTotal(
      s,
      applyRecognitionReceipt(s.input, directDocumentationReceipt(s, "generic", 0), s.binding.reviewerIds),
    ),
    1,
  );
  let output = s.input;
  for (const index of [0, 1])
    output = applyRecognitionReceipt(output, directDocumentationReceipt(s, "generic", index), s.binding.reviewerIds);
  assert.equal(documentationTotal(s, output), null);
  const facts = output.facts.filter((fact) => fact.metricId === "documentation" && fact.state === "qualified");
  assert.equal(new Set(facts.map((fact) => fact.canonicalKey)).size, 1);
  assert.ok(docs(output).every((entry) => !entry.contribution.reasonCodes.includes(notesPurpose)));
});

for (const purpose of ["generic", "purpose"])
  test(`authored notes direct transition: retained legacy generic then ${purpose} requires rebuilding the overlay`, () => {
    const s = authoredNotesScenario();
    const legacy = legacyGenericDocumentation(s);
    const original = structuredClone(legacy);
    assert.equal(documentationTotal(s, legacy), 1);
    assert.throws(
      () => applyRecognitionReceipt(legacy, directDocumentationReceipt(s, purpose, 1), s.binding.reviewerIds),
      /documentation_recognition_requires_renormalization/,
    );
    assert.deepEqual(legacy, original);
  });

for (const category of ["example", "guide"])
  test(`authored notes direct transition: separately reviewed ${category} on the same PR remains a different unit`, () => {
    const s = authoredNotesScenario();
    const reviewedCategory = structuredClone(s);
    delete reviewedCategory.binding.documentationPurpose;
    reviewedCategory.record.details.category = category;
    reviewedCategory.request.detail = "Reviewed authored " + category + " work on this documentation PR.";
    attachSyntheticEvidenceIntake(reviewedCategory.request);
    reviewedCategory.state.audit = [structuredClone(reviewedCategory.decision)];
    // Obtain the unit from actual domain qualification and receipt materialization,
    // including current private review and intake checks, not a copied hash formula.
    let categoryReceipt;
    let output = materializeAuthoredNotes(reviewedCategory, (input, receipt, reviewers) => {
      categoryReceipt = receipt;
      return applyRecognitionReceipt(input, receipt, reviewers);
    });
    assert.equal(documentationTotal(s, output), 1);
    output = applyRecognitionReceipt(output, directDocumentationReceipt(s, "purpose", 1), s.binding.reviewerIds);
    assert.equal(documentationTotal(s, output), 2);
    const facts = output.facts.filter((fact) => fact.metricId === "documentation" && fact.state === "qualified");
    assert.equal(new Set(facts.map((fact) => fact.canonicalKey)).size, 2);
    const legacyAndCategory = applyRecognitionReceipt(
      legacyGenericDocumentation(s),
      categoryReceipt,
      s.binding.reviewerIds,
    );
    assert.equal(documentationTotal(s, legacyAndCategory), 2);
  });
