import assert from "node:assert/strict";
import test from "node:test";
import {
  canReview,
  canAcceptEvidence,
  control,
  ControlsFailure,
  verifiedSession,
  verifiedEvidenceTerms,
  evidenceSubmissionInput,
  sourceUseReviewInput,
  type EvidenceTerms,
  type Receipt,
  type Session,
} from "../src/controls/client.ts";
const session: Session = { actorId: "1", csrf: "a".repeat(43), roles: ["reviewer"], expires: Date.now() + 600000 };
test("controls fail closed on malformed identity, authority, CSRF or expired session", () => {
  assert.equal(verifiedSession(session), session);
  for (const patch of [{ actorId: "alice" }, { roles: ["admin"] }, { csrf: "bad" }, { expires: 0 }])
    assert.throws(() => verifiedSession({ ...session, ...patch }));
});

for (const [description, actorId] of [
  ["numeric", 1],
  ["singleton array", ["1"]],
  ["nested array", [["1"]]],
  ["missing", undefined],
  ["null", null],
  ["object", { id: "1" }],
  ["zero", "0"],
  ["leading zero", "01"],
  ["overlength", "1".repeat(21)],
  ["terminal LF", "1\n"],
  ["terminal CR", "1\r"],
  ["terminal CRLF", "1\r\n"],
  ["terminal line separator", "1\u2028"],
  ["terminal paragraph separator", "1\u2029"],
] as Array<[string, unknown]>) {
  test(`protected session rejects ${description} actor identity before use`, () => {
    const decoded = JSON.parse(JSON.stringify({ ...session, actorId })) as Session;
    assert.throws(() => verifiedSession(decoded), /Invalid or expired controls session/);
  });
}

test("protected session preserves canonical string ownership beyond numeric precision", () => {
  for (const actorId of ["1", "9007199254740993", "99999999999999999999"]) {
    const decoded = { ...session, actorId };
    assert.equal(verifiedSession(decoded), decoded);
    const own = { owner: actorId, kind: "evidence", status: "pending", collaborators: {} } as Receipt;
    assert.equal(canReview(own, decoded), false);
    assert.equal(canReview({ ...own, owner: "2" }, decoded), true);
  }
});

const terms: EvidenceTerms = {
  schemaVersion: "evidence-terms/v1",
  version: "evidence-terms/2026-10-19",
  rightsPolicyVersion: "2026-10-18",
  paragraphs: ["Synthetic displayed terms; no real participant agreement."],
  digest: "b".repeat(64),
};
function evidenceForm(patch: Record<string, string> = {}) {
  const data = new FormData();
  for (const [name, value] of Object.entries({
    locator: "https://github.com/synthetic/example/issues/55",
    category: "mentorship",
    scope: "Synthetic public claim",
    detail: "Synthetic private review detail",
    collaborators: "9007199254740993",
    submitterRoleChoice: "unknown",
    "participantRole-9007199254740993Choice": "unknown",
    periodKind: "unknown",
    sourceUseState: "unresolved",
    consent: "on",
    ...patch,
  }))
    data.set(name, value);
  return data;
}
test("evidence terms require the actual displayed paragraphs and a complete version binding", () => {
  assert.equal(verifiedEvidenceTerms(terms), terms);
  for (const value of [
    null,
    {},
    { ...terms, digest: "short" },
    { ...terms, paragraphs: [] },
    { ...terms, paragraphs: [null] },
    { ...terms, rightsPolicyVersion: "" },
  ])
    assert.throws(() => verifiedEvidenceTerms(value), /terms are unavailable/);
});
test("evidence intake preserves unknowns and numeric identity without granting another person's consent", () => {
  const result = evidenceSubmissionInput(evidenceForm(), terms, "1", ["mentorship"]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.collaborators, ["9007199254740993"]);
  assert.deepEqual(result.value.intake, {
    schemaVersion: "evidence-intake/v1",
    termsVersion: terms.version,
    termsDigest: terms.digest,
    sourceUseBasis: { state: "unresolved" },
    roles: { submitter: null, collaborators: { "9007199254740993": null } },
    period: { kind: "unknown" },
  });
  assert.equal(Object.hasOwn(result.value.intake, "participantConsents"), false);
  assert.equal(Object.hasOwn(result.value.intake, "claimDigest"), false);
});
test("evidence intake validates actual dates, participant scope and declared basis before any request", () => {
  const known = evidenceSubmissionInput(
    evidenceForm({
      submitterRoleChoice: "described",
      submitterRole: "Mentor",
      "participantRole-9007199254740993Choice": "described",
      "participantRole-9007199254740993": "Learner",
      periodKind: "date",
      periodDate: "2024-02-29",
      sourceUseState: "declared",
      sourceUseStatement: "Synthetic declared basis",
    }),
    terms,
    "1",
    ["mentorship"],
  );
  assert.equal(known.ok, true);
  if (known.ok) {
    assert.deepEqual(known.value.intake.period, { kind: "date", date: "2024-02-29" });
    assert.equal(known.value.intake.roles.submitter, "Mentor");
    assert.deepEqual(known.value.intake.sourceUseBasis, { state: "declared", statement: "Synthetic declared basis" });
  }
  for (const [patch, field] of [
    [{ locator: "https://private.invalid/evidence" }, "locator"],
    [{ locator: "https://user:secret@github.com/synthetic/example/issues/1" }, "locator"],
    [{ collaborators: "1" }, "collaborators"],
    [{ collaborators: "2, 2" }, "collaborators"],
    [{ periodKind: "date", periodDate: "2025-02-29" }, "periodDate"],
    [{ periodKind: "interval", periodStart: "2026-10-19", periodEnd: "2026-10-18" }, "periodEnd"],
    [{ sourceUseState: "declared", sourceUseStatement: " " }, "sourceUseStatement"],
    [{ consent: "" }, "consent"],
  ] as Array<[Record<string, string>, string]>) {
    const result = evidenceSubmissionInput(evidenceForm(patch), terms, "1", ["mentorship"]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors[field], field);
  }
  assert.equal(evidenceSubmissionInput(evidenceForm(), null, "1", ["mentorship"]).ok, false);
});
test("source-use acceptance needs its own bounded review and actual reference revision", () => {
  const data = new FormData();
  data.set("source", "on");
  assert.equal(sourceUseReviewInput(data).ok, false);
  data.set("sourceUseRationale", "Synthetic independent source-use review");
  data.set("reviewLocator-0", "https://github.com/synthetic/example/blob/revision/rights.md");
  data.set("reviewRevision-0", "synthetic-reviewed-revision");
  data.set("sourceUsePermitted", "on");
  assert.deepEqual(sourceUseReviewInput(data), {
    ok: true,
    value: {
      disposition: "permitted",
      rationale: "Synthetic independent source-use review",
      references: [
        {
          locator: "https://github.com/synthetic/example/blob/revision/rights.md",
          revision: "synthetic-reviewed-revision",
        },
      ],
    },
  });
  data.set("reviewRevision-1", "unpaired revision");
  assert.equal(sourceUseReviewInput(data).ok, false);
  data.set("reviewLocator-1", "https://internal.invalid/proof");
  assert.equal(sourceUseReviewInput(data).ok, false);
});
test("fresh evidence acceptance requires a pending or appealed receipt with current intake and consent", () => {
  const receipt = {
    kind: "evidence",
    status: "pending",
    collaborators: {},
    intake: {
      schemaVersion: "evidence-intake/v1",
      claimRevision: 1,
      claimDigest: "c".repeat(64),
    },
    intakeEligibility: { state: "awaiting_review" },
  } as Receipt;
  assert.equal(canAcceptEvidence(receipt), true);
  assert.equal(canAcceptEvidence({ ...receipt, status: "appealed" }), true);
  for (const patch of [
    { status: "accepted", intakeEligibility: { state: "source_use_review_required" } },
    { status: "accepted", intakeEligibility: { state: "eligible" } },
    { status: "rejected" },
    { status: "withdrawn" },
    { status: "merged" },
    { status: "applied" },
    { status: undefined },
    { intake: null },
    { intakeEligibility: undefined },
    { intakeEligibility: { state: "updated_intake_required" } },
    { intakeEligibility: { state: "participant_consent_required" } },
  ])
    assert.equal(canAcceptEvidence({ ...receipt, ...patch } as Receipt), false);
});
test("review affordances exclude self, collaborators, wrong roles and terminal receipts", () => {
  const receipt = { owner: "2", kind: "evidence", status: "pending", collaborators: {} } as Receipt;
  assert.equal(canReview(receipt, session), true);
  for (const patch of [
    { owner: "1" },
    { collaborators: { "1": "pending" } },
    { kind: "privacy" },
    { status: "applied" },
  ])
    assert.equal(canReview({ ...receipt, ...patch }, session), false);
});
test("controls client fixes same-origin credentials, forbids arbitrary paths, and sends CSRF only for writes", async () => {
  const previous = globalThis.fetch;
  const seen: Array<{ path: unknown; init: RequestInit | undefined }> = [];
  globalThis.fetch = async (path, init) => {
    seen.push({ path, init });
    return new Response("{}", { headers: { "content-type": "application/json" } });
  };
  try {
    await assert.rejects(() => control("https://elsewhere.invalid/controls/session"));
    await assert.rejects(() => control("/controls/public"));
    await assert.rejects(() => control("/controls/profile", undefined, {}));
    await control("/controls/session");
    await control("/controls/profile", session, { bio: "" });
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.init!.credentials, "same-origin");
    assert.equal(seen[0]!.init!.redirect, "error");
    assert.equal(seen[0]!.init!.cache, "no-store");
    assert.equal(new Headers(seen[0]!.init!.headers).get("x-csrf-token"), null);
    assert.equal(new Headers(seen[1]!.init!.headers).get("x-csrf-token"), session.csrf);
    globalThis.fetch = async () => new Response('{"error":"private details"}', { status: 403 });
    await assert.rejects(
      () => control("/controls/session"),
      (e) => e instanceof ControlsFailure && !e.message.includes("private details"),
    );
  } finally {
    globalThis.fetch = previous;
  }
});

test("controls rejects oversized bodies and invalid JSON rather than trusting a successful status", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(" ".repeat(2_000_001), { headers: { "content-type": "application/json" } });
    await assert.rejects(() => control("/controls/session"), /exceeds/);
    globalThis.fetch = async () => new Response("not json", { headers: { "content-type": "application/json" } });
    await assert.rejects(() => control("/controls/session"));
  } finally {
    globalThis.fetch = previous;
  }
});
