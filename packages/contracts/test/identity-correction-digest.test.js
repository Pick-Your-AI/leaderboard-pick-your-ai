import assert from "node:assert/strict";
import test from "node:test";
import {
  digestVerifiedIdentityCorrectionProposal,
  encodeVerifiedIdentityCorrectionProposal,
  verifiedIdentityCorrectionProposalEncodingVersion,
  verifiedIdentityCorrectionProposalSchema,
} from "../dist/index.js";

// Literal expected bytes were specified independently of the encoder. The
// known SHA-256 values were calculated with Python hashlib, not this helper.
const marker = "leaderboard-verified-identity-correction-proposal/v1";
const canonicalProposal =
  '{"assignments":[{"contributionId":"contribution.1","evidenceIds":["proof.1"],"resultActorId":"1","role":"author","sourceActorId":"2","sourceAttributionSha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","sourceEventId":"event.1","sourceRevision":"revision.1"}],"authorityBasis":"reviewed_source_attribution","correctionId":"correction.1","kind":"merge","policyVersion":"policy.1","preparedAt":"2026-10-19T12:00:00Z","proofs":[{"contributionIds":["contribution.1"],"evidenceId":"proof.1","expiresAt":null,"kind":"source_attribution","recordedAt":"2026-10-18T00:00:00Z","subjectActorIds":["1","2"]}],"requester":{"actorId":"1","githubDatabaseId":1,"githubNodeId":"NODE_1","providerKind":"user"},"resultActors":[{"actorId":"1","githubDatabaseId":1,"githubNodeId":"NODE_1","providerKind":"user"}],"revision":1,"schemaVersion":"leaderboard-verified-identity-correction/v1","sourceActors":[{"actorId":"1","githubDatabaseId":1,"githubNodeId":"NODE_1","providerKind":"user"},{"actorId":"2","githubDatabaseId":2,"githubNodeId":"NODE_2","providerKind":"user"}]}';
const actorOne = '{"actorId":"1","githubDatabaseId":1,"githubNodeId":"NODE_1","providerKind":"user"}';
const actorTwo = '{"actorId":"2","githubDatabaseId":2,"githubNodeId":"NODE_2","providerKind":"user"}';
const baseDigest = "f56c80b94dcf3e437d18ad6adddb578a609dcfa5576febf182de195c327df468";

const vectors = [
  ["ascii merge", canonicalProposal, 1127, "f56c80b94dcf3e437d18ad6adddb578a609dcfa5576febf182de195c327df468"],
  [
    "reversed source array",
    canonicalProposal.replace(`"sourceActors":[${actorOne},${actorTwo}]`, `"sourceActors":[${actorTwo},${actorOne}]`),
    1127,
    "3a3af8be9a2c97d08e839d540edb778f8763318ccf33ad68eb109f3638f6d676",
  ],
  [
    "reversed proof subjects",
    canonicalProposal.replace('"subjectActorIds":["1","2"]', '"subjectActorIds":["2","1"]'),
    1127,
    "0603e84bf245eaee07dc772737b6c45d6b8864432321e8c8768c87d5cd439710",
  ],
  [
    "future expiry",
    canonicalProposal.replace('"expiresAt":null', '"expiresAt":"2026-10-20T00:00:00Z"'),
    1145,
    "5f44c2e69369575238faccbbf5e1fcf9d7ccb1247622fb31df619f9a1fc6b4d6",
  ],
  [
    "equivalent offset",
    canonicalProposal.replace('"preparedAt":"2026-10-19T12:00:00Z"', '"preparedAt":"2026-10-19T13:00:00+01:00"'),
    1132,
    "7d4c7f385fb2cd3675c8ee95093b2231b437c6135c495fed7ce38033157b9478",
  ],
  [
    "equivalent fraction",
    canonicalProposal.replace('"preparedAt":"2026-10-19T12:00:00Z"', '"preparedAt":"2026-10-19T12:00:00.0000Z"'),
    1132,
    "13b612d193aceabcf74df256bd98013cef6a864cc264d82aa49391d53199703e",
  ],
  [
    "precise fraction",
    canonicalProposal.replace(
      '"preparedAt":"2026-10-19T12:00:00Z"',
      '"preparedAt":"2026-10-19T12:00:00.0000000000000000001Z"',
    ),
    1147,
    "49693a3dd3799657dc0706fdce6a41f072353d63043abf5bc37205e3db3c281d",
  ],
  [
    "maximum safe identity and revision",
    canonicalProposal
      .replaceAll('"1"', '"9007199254740991"')
      .replaceAll('"githubDatabaseId":1', '"githubDatabaseId":9007199254740991')
      .replace('"revision":1', '"revision":9007199254740991'),
    1262,
    "292cba077a319d301d8e7005b386020d11f3a868a8896a9a3c792bdba00e794f",
  ],
  [
    "composed unicode",
    canonicalProposal.replaceAll('"NODE_1"', '"NODE_\u00e9"'),
    1130,
    "bd38e3ff97d02c305763ab7357fd3c704eadfab43689f37c9dc7d5b05c57b5c5",
  ],
  [
    "decomposed unicode",
    canonicalProposal.replaceAll('"NODE_1"', '"NODE_e\u0301"'),
    1133,
    "214a5e01da60da1262971aa2f59cb8eed91891535504a8e49be6dbf9712b9b06",
  ],
  [
    "supplementary scalar",
    canonicalProposal.replaceAll('"NODE_1"', '"NODE_\ud83d\ude00"'),
    1136,
    "b23cc79b17f27dd2d7a096492c6a96847765dfe7d09456359bf81cf316429dda",
  ],
  [
    "lone high surrogate",
    canonicalProposal.replaceAll('"NODE_1"', '"NODE_\\ud800"'),
    1142,
    "177a3122640c75911ef90cc0981171464acce51b309bfc9453bce2899b11fb8a",
  ],
  [
    "lone low surrogate",
    canonicalProposal.replaceAll('"NODE_1"', '"NODE_\\udc00"'),
    1142,
    "1aa0af61cf429987808654b5f123ce292bb19ed6958cb9d5cdee9060e69b3b7a",
  ],
  [
    "replacement character",
    canonicalProposal.replaceAll('"NODE_1"', '"NODE_\ufffd"'),
    1133,
    "9c73344f1524f9057b97252610019e828bf9548a6c3a77e70440397d0aaaacac",
  ],
  [
    "quoted backslash and controls",
    canonicalProposal.replaceAll('"NODE_1"', '"NODE_\\"\\\\\\u0000\\b"'),
    1160,
    "e5d12fcf96310491a29f775e66d10bf6eb45009f00705928ab342002774882ca",
  ],
];

function proposal() {
  return JSON.parse(canonicalProposal);
}

function expectedBytes(canonical = canonicalProposal) {
  return Uint8Array.from(Buffer.from(`${marker}\n${canonical}`, "utf8"));
}

function reversedObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reversedObjectKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reversedObjectKeys(item)]),
    );
  }
  return value;
}

function richProposal() {
  const value = proposal();
  value.assignments.push({ ...structuredClone(value.assignments[0]), contributionId: "contribution.2" });
  value.proofs.push({ ...structuredClone(value.proofs[0]), evidenceId: "proof.2" });
  for (const assignment of value.assignments) assignment.evidenceIds = ["proof.1", "proof.2"];
  for (const proof of value.proofs) proof.contributionIds = ["contribution.1", "contribution.2"];
  return value;
}

function linkProposal() {
  const value = proposal();
  value.kind = "link";
  value.authorityBasis = "verified_account_control";
  value.resultActors = structuredClone(value.sourceActors);
  value.assignments = [];
  value.proofs = [
    {
      ...value.proofs[0],
      evidenceId: "control.1",
      kind: "account_control",
      contributionIds: [],
      expiresAt: "2026-10-20T00:00:00Z",
    },
    { ...value.proofs[0], evidenceId: "consent.1", kind: "consent", contributionIds: [] },
  ];
  return value;
}

function splitProposal() {
  const value = richProposal();
  value.kind = "split";
  value.sourceActors = [structuredClone(value.sourceActors[1])];
  value.resultActors = [structuredClone(value.resultActors[0]), structuredClone(value.sourceActors[0])];
  return value;
}

function assertCompleteProposalBytes(value) {
  const bytes = encodeVerifiedIdentityCorrectionProposal(value);
  const text = Buffer.from(bytes).toString("utf8");
  assert.ok(text.startsWith(`${marker}\n`));
  assert.deepEqual(JSON.parse(text.slice(marker.length + 1)), verifiedIdentityCorrectionProposalSchema.parse(value));
  return bytes;
}

for (const [name, canonical, size, digest] of vectors) {
  test(`canonical proposal literal vector: ${name}`, async () => {
    const input = JSON.parse(canonical);
    const before = structuredClone(input);
    const encoded = encodeVerifiedIdentityCorrectionProposal(input);
    assert.equal(verifiedIdentityCorrectionProposalEncodingVersion, marker);
    assert.deepEqual(encoded, expectedBytes(canonical));
    assert.equal(encoded.byteLength, size);
    assert.equal(await digestVerifiedIdentityCorrectionProposal(input), digest);
    assert.deepEqual(input, before);
  });
}

test("canonical proposal sorts every object level without sorting arrays", async () => {
  const value = reversedObjectKeys(proposal());
  assert.notEqual(JSON.stringify(value), canonicalProposal);
  assert.deepEqual(encodeVerifiedIdentityCorrectionProposal(value), expectedBytes());
  assert.equal(await digestVerifiedIdentityCorrectionProposal(value), baseDigest);
});

for (const [name, change] of [
  [
    "correction ID",
    (value) => {
      value.correctionId = "correction.2";
    },
  ],
  [
    "proposal revision",
    (value) => {
      value.revision = 2;
    },
  ],
  [
    "policy version",
    (value) => {
      value.policyVersion = "policy.2";
    },
  ],
  [
    "prepared time",
    (value) => {
      value.preparedAt = "2026-10-19T12:00:00.000000001Z";
    },
  ],
  [
    "requester identity",
    (value) => {
      value.requester = { actorId: "3", githubDatabaseId: 3, githubNodeId: "NODE_3", providerKind: "user" };
    },
  ],
  [
    "requester provider kind",
    (value) => {
      value.requester = { actorId: "3", githubDatabaseId: 3, githubNodeId: "NODE_3", providerKind: "bot" };
    },
  ],
  [
    "affected opaque identity",
    (value) => {
      value.sourceActors[1].githubNodeId = "NODE_2_changed";
    },
  ],
  [
    "affected provider kind",
    (value) => {
      value.sourceActors[1].providerKind = "github_app";
    },
  ],
  [
    "source event",
    (value) => {
      value.assignments[0].sourceEventId = "event.2";
    },
  ],
  [
    "source revision",
    (value) => {
      value.assignments[0].sourceRevision = "revision.2";
    },
  ],
  [
    "source attribution digest",
    (value) => {
      value.assignments[0].sourceAttributionSha256 = "f".repeat(64);
    },
  ],
  [
    "contribution role",
    (value) => {
      value.assignments[0].role = "coauthor";
    },
  ],
  [
    "contribution and proof scope",
    (value) => {
      value.assignments[0].contributionId = "contribution.2";
      value.proofs[0].contributionIds = ["contribution.2"];
    },
  ],
  [
    "evidence identifier and reference",
    (value) => {
      value.assignments[0].evidenceIds = ["proof.2"];
      value.proofs[0].evidenceId = "proof.2";
    },
  ],
  [
    "recorded proof time",
    (value) => {
      value.proofs[0].recordedAt = "2026-10-18T01:00:00Z";
    },
  ],
  [
    "proof expiry",
    (value) => {
      value.proofs[0].expiresAt = "2026-10-20T00:00:00Z";
    },
  ],
  [
    "source and result attribution",
    (value) => {
      value.resultActors = [structuredClone(value.sourceActors[1])];
      value.assignments[0].sourceActorId = "1";
      value.assignments[0].resultActorId = "2";
    },
  ],
]) {
  test(`canonical proposal binds ${name}`, async () => {
    const value = proposal();
    change(value);
    assertCompleteProposalBytes(value);
    assert.notEqual(await digestVerifiedIdentityCorrectionProposal(value), baseDigest);
  });
}

for (const [name, select] of [
  ["source actors", (value) => value.sourceActors],
  ["assignments", (value) => value.assignments],
  ["proofs", (value) => value.proofs],
  ["assignment evidence references", (value) => value.assignments[0].evidenceIds],
  ["proof subjects", (value) => value.proofs[0].subjectActorIds],
  ["proof contributions", (value) => value.proofs[0].contributionIds],
]) {
  test(`canonical proposal preserves ${name} array order`, async () => {
    const value = richProposal();
    const before = await digestVerifiedIdentityCorrectionProposal(value);
    select(value).reverse();
    assertCompleteProposalBytes(value);
    assert.notEqual(await digestVerifiedIdentityCorrectionProposal(value), before);
  });
}

test("canonical proposal preserves result actor order in a valid split", async () => {
  const value = splitProposal();
  const before = await digestVerifiedIdentityCorrectionProposal(value);
  value.resultActors.reverse();
  assertCompleteProposalBytes(value);
  assert.notEqual(await digestVerifiedIdentityCorrectionProposal(value), before);
});

test("canonical proposal binds link authority and every protected proof", async () => {
  const value = linkProposal();
  const before = await digestVerifiedIdentityCorrectionProposal(value);
  assertCompleteProposalBytes(value);
  assert.notEqual(before, baseDigest);
  value.proofs[1].recordedAt = "2026-10-18T01:00:00Z";
  assert.notEqual(await digestVerifiedIdentityCorrectionProposal(value), before);
});

test("canonical proposal rejects invalid records before invoking Web Crypto", async (context) => {
  let hashCalls = 0;
  context.mock.method(globalThis.crypto.subtle, "digest", () => {
    hashCalls++;
    throw new Error("Invalid records must never reach hashing.");
  });
  for (const [name, change] of [
    [
      "wrong schema version",
      (value) => {
        value.schemaVersion = "leaderboard-verified-identity-correction/v2";
      },
    ],
    [
      "unknown root field",
      (value) => {
        value.email = "synthetic@example.invalid";
      },
    ],
    [
      "unknown identity field",
      (value) => {
        value.requester.login = "synthetic";
      },
    ],
    [
      "unknown assignment field",
      (value) => {
        value.assignments[0].extra = true;
      },
    ],
    [
      "unknown proof field",
      (value) => {
        value.proofs[0].extra = true;
      },
    ],
    [
      "omitted nullable expiry",
      (value) => {
        delete value.proofs[0].expiresAt;
      },
    ],
    [
      "identity mismatch",
      (value) => {
        value.requester.githubDatabaseId = 2;
      },
    ],
    [
      "inconsistent opaque identity",
      (value) => {
        value.resultActors[0].githubNodeId = "NODE_other";
      },
    ],
    [
      "unknown evidence reference",
      (value) => {
        value.assignments[0].evidenceIds = ["missing"];
      },
    ],
    [
      "expired proof",
      (value) => {
        value.proofs[0].expiresAt = value.preparedAt;
      },
    ],
    [
      "uppercase digest",
      (value) => {
        value.assignments[0].sourceAttributionSha256 = "A".repeat(64);
      },
    ],
    [
      "unsafe database integer",
      (value) => {
        value.requester.githubDatabaseId = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "unsafe proposal revision",
      (value) => {
        value.revision = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "fractional proposal revision",
      (value) => {
        value.revision = 1.5;
      },
    ],
    [
      "negative zero revision",
      (value) => {
        value.revision = -0;
      },
    ],
    [
      "NaN revision",
      (value) => {
        value.revision = NaN;
      },
    ],
    [
      "infinite revision",
      (value) => {
        value.revision = Infinity;
      },
    ],
    [
      "whitespace in opaque ID",
      (value) => {
        value.sourceActors[1].githubNodeId = "NODE\n2";
      },
    ],
    [
      "decision wrapper",
      (value) => {
        value.proposalSha256 = baseDigest;
      },
    ],
  ]) {
    const value = proposal();
    change(value);
    assert.throws(() => encodeVerifiedIdentityCorrectionProposal(value), { name: "ZodError" }, name);
    await assert.rejects(digestVerifiedIdentityCorrectionProposal(value), { name: "ZodError" }, name);
  }
  assert.equal(hashCalls, 0);
});

test("proposal digest detaches all nested data before returning its promise", async () => {
  const value = proposal();
  const pending = digestVerifiedIdentityCorrectionProposal(value);
  value.requester.githubNodeId = "changed_requester";
  value.sourceActors[0].githubNodeId = "changed_source";
  value.resultActors[0].githubNodeId = "changed_result";
  value.assignments[0].sourceEventId = "changed_event";
  value.assignments[0].evidenceIds.push("changed_evidence");
  value.proofs[0].recordedAt = "2027-01-01T00:00:00Z";
  value.proofs[0].subjectActorIds.reverse();
  value.policyVersion = "changed_policy";
  assert.equal(await pending, baseDigest);
});

test("canonical proposal returns independent bytes without changing caller data", async () => {
  const value = proposal();
  const before = structuredClone(value);
  const first = encodeVerifiedIdentityCorrectionProposal(value);
  const second = encodeVerifiedIdentityCorrectionProposal(value);
  assert.notEqual(first.buffer, second.buffer);
  first.fill(0);
  assert.deepEqual(second, expectedBytes());
  assert.deepEqual(encodeVerifiedIdentityCorrectionProposal(value), expectedBytes());
  assert.deepEqual(value, before);
  assert.equal(await digestVerifiedIdentityCorrectionProposal(value), baseDigest);
});

test("proposal digest requires Web Crypto instead of silently changing algorithms", async (context) => {
  context.mock.getter(globalThis, "crypto", () => undefined);
  assert.deepEqual(encodeVerifiedIdentityCorrectionProposal(proposal()), expectedBytes());
  await assert.rejects(
    digestVerifiedIdentityCorrectionProposal(proposal()),
    /SHA-256 requires Web Crypto SubtleCrypto/,
  );
});
