import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  bindPublicStewardshipReview,
  parsePublicStewardshipReview,
  publicStewardshipReviewDigest,
} from "../dist/public-stewardship-review.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const evidence = (label) => {
  const revision = sha("synthetic revision " + label).slice(0, 40);
  return {
    locator: "https://github.com/example/evidence/blob/" + revision + "/" + label + ".json",
    revision,
    sha256: sha("synthetic sanitized bytes " + label),
  };
};
function fixture(action = "pinned") {
  return {
    version: "public-stewardship-review/v1",
    requestId: "evidence:synthetic-17",
    claimRevision: 3,
    claimDigest: sha("synthetic current claim"),
    reviewedInputDigest: sha("synthetic current private intake"),
    actorId: "100",
    contributorRole: "triager",
    target: {
      kind: "issue_comment",
      repositoryId: "40",
      repositorySlug: "example/project",
      issueId: "I_synthetic_issue",
      issueNumber: "17",
      commentId: "IC_synthetic_comment",
      commentDatabaseId: "9007199254740993",
      url: "https://github.com/example/project/issues/17#issuecomment-9007199254740993",
    },
    action,
    before: { pinned: action === "unpinned", evidence: evidence("before") },
    after: { pinned: action === "pinned", evidence: evidence("after") },
    occurredAt: null,
  };
}
function current(review) {
  return {
    request: {
      id: review.requestId,
      version: 8,
      category: "public_moderation",
      owner: review.actorId,
      collaborators: ["101", "102"],
      claimRevision: review.claimRevision,
      claimDigest: review.claimDigest,
      reviewedInputDigest: review.reviewedInputDigest,
      submitterRole: review.contributorRole,
    },
    decision: {
      requestId: review.requestId,
      requestVersion: 8,
      descriptorDigest: publicStewardshipReviewDigest(review),
      reviewerId: "200",
      reviewerRoleVersion: "synthetic-role/v4",
      policyVersion: "synthetic-review/v1",
      acceptedAt: "2026-10-20T04:00:00.123Z",
      references: [review.before.evidence, review.after.evidence].map(({ locator, revision }) => ({
        locator,
        revision,
      })),
    },
    currentReviewerRoleVersion: "synthetic-role/v4",
  };
}
function set(value, path, replacement) {
  const parts = path.split(".");
  const field = parts.pop();
  let target = value;
  for (const part of parts) target = target[part];
  target[field] = replacement;
}
const invalid = (run) =>
  assert.throws(run, (error) => error instanceof TypeError && error.message === "invalid_public_stewardship_review");

for (const action of ["pinned", "unpinned"]) {
  test("binds synthetic " + action + " with its own comment and unknown original clock", () => {
    const input = fixture(action);
    const state = current(input);
    const result = bindPublicStewardshipReview(input, state);
    assert.deepEqual(result.review, input);
    assert.equal(result.review.target.commentDatabaseId, "9007199254740993");
    assert.notEqual(result.review.target.commentId, result.review.target.issueId);
    assert.notEqual(result.review.target.url, result.review.before.evidence.locator);
    assert.equal(result.review.actorId, "100");
    assert.equal(result.reviewerId, "200");
    assert.equal(result.review.occurredAt, null);
    assert.equal(result.acceptedAt, state.decision.acceptedAt);
    assert.deepEqual(
      Object.keys(result).sort(),
      [
        "acceptedAt",
        "descriptorDigest",
        "policyVersion",
        "requestVersion",
        "review",
        "reviewerId",
        "reviewerRoleVersion",
      ].sort(),
    );
  });
}

test("does not copy authorship, a pin-object identity or a current pin clock", () => {
  for (const [path, field, value] of [
    ["target", "authorId", "999"],
    ["target", "pinnedObjectId", "PIC_other"],
    ["target", "pinnedBy", "999"],
    ["target", "pinnedAt", "2026-10-19T00:00:00.000Z"],
  ]) {
    const input = fixture();
    input[path][field] = value;
    invalid(() => parsePublicStewardshipReview(input));
  }
  for (const time of ["2026-10-19T00:00:00.000Z", 1792368000000, "", undefined])
    invalid(() => parsePublicStewardshipReview({ ...fixture(), occurredAt: time }));
});

test("same immutable sanitized artifact can describe both states without a conflicting hash", () => {
  const input = fixture();
  input.after.evidence = structuredClone(input.before.evidence);
  const state = current(input);
  state.decision.references.pop();
  assert.equal(bindPublicStewardshipReview(input, state).review.after.pinned, true);
  input.after.evidence.sha256 = sha("different bytes behind the same pinned reference");
  invalid(() => parsePublicStewardshipReview(input));
});

for (const [path, value] of [
  ["requestId", "evidence:another"],
  ["claimRevision", 4],
  ["claimDigest", sha("other claim")],
  ["reviewedInputDigest", sha("other role or private detail")],
  ["actorId", "103"],
  ["target.repositoryId", "41"],
  ["target.issueId", "I_other"],
  ["target.commentId", "IC_other"],
  ["before.evidence.sha256", sha("other before bytes")],
  ["after.evidence.sha256", sha("other after bytes")],
]) {
  test("changed descriptor field cannot reuse the original decision: " + path, () => {
    const input = fixture();
    const state = current(input);
    set(input, path, value);
    invalid(() => bindPublicStewardshipReview(input, state));
    assert.notEqual(publicStewardshipReviewDigest(input), state.decision.descriptorDigest);
  });
}

test("coherent target and opposite transition substitutions still need a new reviewed digest", () => {
  const original = fixture();
  const state = current(original);
  const opposite = fixture("unpinned");
  invalid(() => bindPublicStewardshipReview(opposite, state));
  const moved = fixture();
  moved.target.repositorySlug = "example/other";
  moved.target.issueNumber = "18";
  moved.target.commentDatabaseId = "22";
  moved.target.url = "https://github.com/example/other/issues/18#issuecomment-22";
  invalid(() => bindPublicStewardshipReview(moved, state));
  const alteredProof = fixture();
  alteredProof.before.evidence = evidence("replacement");
  state.decision.references.push({
    locator: alteredProof.before.evidence.locator,
    revision: alteredProof.before.evidence.revision,
  });
  invalid(() => bindPublicStewardshipReview(alteredProof, state));
});

for (const [path, value] of [
  ["request.id", "other"],
  ["request.version", 9],
  ["request.category", "ordering"],
  ["request.owner", "101"],
  ["request.claimRevision", 4],
  ["request.claimDigest", sha("other")],
  ["request.reviewedInputDigest", sha("unreviewed private text")],
  ["request.submitterRole", "commenter"],
  ["decision.requestId", "other"],
  ["decision.requestVersion", 7],
  ["decision.descriptorDigest", sha("old descriptor")],
  ["currentReviewerRoleVersion", "synthetic-role/v5"],
  ["decision.reviewerId", "100"],
  ["decision.reviewerId", "102"],
]) {
  test("rejects stale or ineligible current binding: " + path + "=" + String(value).slice(0, 20), () => {
    const input = fixture();
    const state = current(input);
    set(state, path, value);
    invalid(() => bindPublicStewardshipReview(input, state));
  });
}

test("actual accepted version is exact without an inferred increment or decrement", () => {
  const input = fixture();
  const state = current(input);
  state.request.version = state.decision.requestVersion = 9;
  assert.equal(bindPublicStewardshipReview(input, state).requestVersion, 9);
  state.decision.requestVersion = 8;
  invalid(() => bindPublicStewardshipReview(input, state));
});

test("neither a Boolean nor a self-minted digest authenticates a decision", () => {
  const input = fixture();
  invalid(() => bindPublicStewardshipReview(input, { verified: true }));
  const state = current(input);
  state.decision.verified = true;
  invalid(() => bindPublicStewardshipReview(input, state));
  delete state.decision.verified;
  state.decision.reviewerId = input.actorId;
  state.decision.descriptorDigest = publicStewardshipReviewDigest(input);
  invalid(() => bindPublicStewardshipReview(input, state));
  // Matching structural data still returns only a bound descriptor, no authorization flag.
  assert.equal(Object.hasOwn(bindPublicStewardshipReview(input, current(input)), "verified"), false);
});

test("requires each original reviewed reference and admits unused references before binding", () => {
  for (const change of [
    (state) => state.decision.references.pop(),
    (state) => state.decision.references.push(structuredClone(state.decision.references[0])),
    (state) => {
      state.decision.references[0].revision = "f".repeat(40);
    },
    (state) => {
      state.decision.references.push({ locator: "https://private.invalid/internal", revision: "f".repeat(40) });
    },
    (state) => {
      state.decision.references.push({ ...state.decision.references[0], reason: "restricted" });
    },
  ]) {
    const input = fixture();
    const state = current(input);
    change(state);
    invalid(() => bindPublicStewardshipReview(input, state));
  }
  const input = fixture();
  const state = current(input);
  const extra = evidence("additional-reviewed-source");
  state.decision.references.push({ locator: extra.locator, revision: extra.revision });
  assert.equal(bindPublicStewardshipReview(input, state).review.occurredAt, null);
});

test("rejects unsupported target kinds, no-op states and numeric Boolean aliases", () => {
  for (const [path, value] of [
    ["target.kind", "discussion_comment"],
    ["target.kind", "issue"],
    ["action", "locked"],
    ["action", "unlocked"],
    ["before.pinned", true],
    ["after.pinned", false],
    ["before.pinned", 0],
    ["after.pinned", 1],
    ["target.commentId", "I_synthetic_issue"],
    ["target.url", "https://github.com/example/project/pull/17#issuecomment-9007199254740993"],
  ]) {
    const input = fixture();
    set(input, path, value);
    invalid(() => parsePublicStewardshipReview(input));
  }
});

test("rejects restricted moderation, offender, quality and sanction fields throughout", () => {
  for (const [parent, key] of [
    ["", "quality"],
    ["", "justification"],
    ["", "sanctionSeverity"],
    ["target", "offenderId"],
    ["target", "privateReport"],
    ["before", "restrictedReason"],
    ["after.evidence", "rawPayload"],
  ]) {
    const input = fixture();
    set(input, parent ? parent + "." + key : key, "private-sentinel");
    invalid(() => parsePublicStewardshipReview(input));
  }
});

test("requires exact HTTPS GitHub target coordinates and immutable evidence paths", () => {
  for (const value of [
    "http://github.com/example/project/issues/17#issuecomment-9007199254740993",
    "https://github.com:443/example/project/issues/17#issuecomment-9007199254740993",
    "https://u:p@github.com/example/project/issues/17#issuecomment-9007199254740993",
    "https://github.com/example/project/issues/17?private=1#issuecomment-9007199254740993",
    "https://github.com/example/project/issues/017#issuecomment-9007199254740993",
    "https://github.com/example/project/issues/17#issuecomment-22",
    "https://github.com/example/other/issues/17#issuecomment-9007199254740993",
    "https://github.com/example/project/issues/x/../17#issuecomment-9007199254740993",
    "https://github.com/example/project/issues/%31%37#issuecomment-9007199254740993",
  ]) {
    const input = fixture();
    input.target.url = value;
    invalid(() => parsePublicStewardshipReview(input));
  }
  for (const suffix of ["?download=1", "#private", "/../other.json"]) {
    const input = fixture();
    input.before.evidence.locator += suffix;
    invalid(() => parsePublicStewardshipReview(input));
  }
  for (const field of ["revision", "sha256"]) {
    const input = fixture();
    input.before.evidence[field] = "not-an-immutable-pin";
    invalid(() => parsePublicStewardshipReview(input));
  }
  const input = fixture();
  input.before.evidence.locator = input.before.evidence.locator.replace("/blob/", "/tree/");
  invalid(() => parsePublicStewardshipReview(input));
});

test("keeps canonical decimal IDs exact and rejects aliases and unsafe versions", () => {
  for (const value of [0, 1, 1n, true, "0", "01", "-1", "1.0", "1e3", "9".repeat(21), " 1"]) {
    const input = fixture();
    input.actorId = value;
    invalid(() => parsePublicStewardshipReview(input));
  }
  for (const value of [0, -0, -1, 1.5, Number.NaN, Infinity, 2 ** 53, "3", true]) {
    const input = fixture();
    input.claimRevision = value;
    invalid(() => parsePublicStewardshipReview(input));
    const state = current(fixture());
    state.request.version = value;
    invalid(() => bindPublicStewardshipReview(fixture(), state));
  }
  const input = fixture();
  input.actorId = "9".repeat(20);
  assert.equal(parsePublicStewardshipReview(input).actorId, "9".repeat(20));
});

test("keeps valid Unicode identities exact without lossy surrogate hashing or normalization", () => {
  for (const name of ["evidence:café", "evidence:cafe\u0301", "evidence:\u{1f4c4}"]) {
    const input = fixture();
    input.requestId = name;
    assert.equal(parsePublicStewardshipReview(input).requestId, name);
  }
  const composed = fixture(),
    decomposed = fixture();
  composed.requestId = "evidence:café";
  decomposed.requestId = "evidence:cafe\u0301";
  assert.notEqual(publicStewardshipReviewDigest(composed), publicStewardshipReviewDigest(decomposed));
  for (const name of ["\ud800", "\udc00", "x\u0000y", "x\u0085y", " x", "x ", "x".repeat(201), ""]) {
    const input = fixture();
    input.requestId = name;
    invalid(() => parsePublicStewardshipReview(input));
  }
});

test("validates the canonical actual acceptance clock without filling source time", () => {
  for (const value of [
    "2026-02-30T00:00:00.000Z",
    "2026-10-20T24:00:00.000Z",
    "2026-10-20T04:00:00Z",
    "2026-10-20T04:00:00.1234Z",
    "2026-10-20T04:00:00.123+00:00",
    "0000-01-01T00:00:00.000Z",
    1792468800123,
    null,
  ]) {
    const input = fixture();
    const state = current(input);
    state.decision.acceptedAt = value;
    invalid(() => bindPublicStewardshipReview(input, state));
  }
  const input = fixture();
  const state = current(input);
  state.decision.acceptedAt = "2000-02-29T00:00:00.000Z";
  assert.equal(bindPublicStewardshipReview(input, state).review.occurredAt, null);
});

test("rejects proxy records and arrays before invoking any trap", () => {
  let called = 0;
  const proxy = (value) =>
    new Proxy(value, {
      get() {
        called++;
        throw new Error("private-sentinel");
      },
      getPrototypeOf() {
        called++;
        throw new Error("private-sentinel");
      },
      ownKeys() {
        called++;
        throw new Error("private-sentinel");
      },
      getOwnPropertyDescriptor() {
        called++;
        throw new Error("private-sentinel");
      },
    });
  invalid(() => parsePublicStewardshipReview(proxy(fixture())));
  const input = fixture();
  input.target = proxy(input.target);
  invalid(() => parsePublicStewardshipReview(input));
  const state = current(fixture());
  state.request.collaborators = proxy(state.request.collaborators);
  invalid(() => bindPublicStewardshipReview(fixture(), state));
  const revoked = Proxy.revocable(fixture(), {});
  revoked.revoke();
  invalid(() => parsePublicStewardshipReview(revoked.proxy));
  assert.equal(called, 0);
});

test("rejects accessors, hidden data, symbols, inherited fields and serialization callbacks without calling them", () => {
  let called = 0;
  for (const mutate of [
    (input) =>
      Object.defineProperty(input, "actorId", {
        enumerable: true,
        get() {
          called++;
          return "100";
        },
      }),
    (input) => Object.defineProperty(input, "actorId", { enumerable: false, value: "100" }),
    (input) => Object.defineProperty(input, "extra", { enumerable: false, value: "private-sentinel" }),
    (input) => {
      input[Symbol("hidden")] = true;
    },
    (input) => {
      input.toJSON = () => {
        called++;
        return fixture();
      };
    },
    (input) => Object.setPrototypeOf(input, { private: "sentinel" }),
  ]) {
    const input = fixture();
    mutate(input);
    invalid(() => parsePublicStewardshipReview(input));
  }
  const inherited = Object.create(fixture());
  invalid(() => parsePublicStewardshipReview(inherited));
  assert.equal(called, 0);
});

test("bounds dense reviewed arrays and rejects malformed unused entries", () => {
  for (const mutate of [
    (state) => {
      delete state.request.collaborators[0];
    },
    (state) => {
      state.request.collaborators.extra = true;
    },
    (state) => {
      state.request.collaborators.push("101");
    },
    (state) => {
      state.request.collaborators.push("100");
    },
    (state) => {
      state.request.collaborators = Array.from({ length: 21 }, (_, i) => String(i + 300));
    },
    (state) => {
      state.request.collaborators = new Array(1_000_000);
    },
    (state) => {
      state.decision.references = [];
    },
    (state) => {
      delete state.decision.references[0];
    },
    (state) => {
      state.decision.references = Array.from({ length: 6 }, (_, i) => {
        const { locator, revision } = evidence("extra" + i);
        return { locator, revision };
      });
    },
  ]) {
    const input = fixture(),
      state = current(input);
    mutate(state);
    invalid(() => bindPublicStewardshipReview(input, state));
  }
  let called = 0;
  const input = fixture(),
    state = current(input);
  Object.defineProperty(state.request.collaborators, "0", {
    get() {
      called++;
      return "101";
    },
    enumerable: true,
  });
  invalid(() => bindPublicStewardshipReview(input, state));
  assert.equal(called, 0);
  const empty = current(input);
  empty.request.collaborators = [];
  assert.equal(bindPublicStewardshipReview(input, empty).reviewerId, "200");
});

test("canonical digest ignores object key insertion order but preserves every semantic value", () => {
  const input = fixture();
  const reverse = (value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, child]) => [key, reverse(child)]),
        )
      : value;
  assert.equal(publicStewardshipReviewDigest(input), publicStewardshipReviewDigest(reverse(input)));
  assert.deepEqual(parsePublicStewardshipReview(parsePublicStewardshipReview(input)), input);
  const nullPrototype = Object.assign(Object.create(null), input);
  assert.equal(publicStewardshipReviewDigest(nullPrototype), publicStewardshipReviewDigest(input));
});

test("returns deeply detached frozen data and retains no caller authority containers", () => {
  const input = fixture(),
    state = current(input);
  const expected = structuredClone(input);
  const result = bindPublicStewardshipReview(input, state);
  input.target.commentId = "IC_changed";
  input.before.evidence.sha256 = sha("changed");
  state.decision.references.length = 0;
  state.request.owner = "999";
  assert.deepEqual(result.review, expected);
  for (const part of [
    result,
    result.review,
    result.review.target,
    result.review.before,
    result.review.before.evidence,
    result.review.after,
    result.review.after.evidence,
  ])
    assert.equal(Object.isFrozen(part), true);
  assert.throws(() => {
    result.review.target.commentId = "IC_mutation";
  }, TypeError);
  assert.throws(() => {
    result.review.after.evidence.sha256 = sha("mutation");
  }, TypeError);
  assert.equal(Object.hasOwn(result, "references"), false);
  assert.equal(Object.hasOwn(result, "collaborators"), false);
});

test("refuses unrecognized versions and top-level values with stable sanitized errors", () => {
  for (const value of [
    null,
    undefined,
    [],
    false,
    "private-sentinel",
    1,
    { ...fixture(), version: "public-stewardship-review/v2" },
  ])
    invalid(() => parsePublicStewardshipReview(value));
  const input = fixture(),
    state = current(input);
  state.request.status = "accepted";
  invalid(() => bindPublicStewardshipReview(input, state));
});
