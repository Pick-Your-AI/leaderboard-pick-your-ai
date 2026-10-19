import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGithubObservation, applyRecognitionReceipt } from "../dist/index.js";
import {
  authoredNotesEnvelope,
  authoredNotesPathPolicy,
  authoredNotesScenario,
  authoredNotesReceipt,
  notesCandidate,
  notesPurpose,
  notesMergeTime,
  notesReviewTime,
  notesRevision,
  notesDomainReasons,
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
