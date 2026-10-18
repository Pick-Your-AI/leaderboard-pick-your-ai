import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../dist/app.js";
import { projectRead } from "../dist/public-source.js";
import { readFixture, at } from "../../../tests/fixtures/pending-metric.mjs";

// Fictional provider snapshots only; no executed scenario or factual review.
const fixed = [
  "domain_metric:reproductions",
  "domain_clock:accepted_at",
  "accepted_reproduction_scenario_not_bug_confirmation",
];
const metadata = (activityState) => ({
  schemaVersion: "leaderboard-evidence/v1",
  artifactTitle: null,
  sourceAction: activityState === "accepted" ? "recognition_accepted" : "pull_request_merged",
  sourceOccurredAt: at,
  observedAt: at,
  activityState,
  acceptedAt: activityState === "accepted" ? at : null,
  history: { coverage: "not_supplied", records: [] },
});
function fixture(outcome = "reproduced") {
  const input = readFixture(),
    proof = input.selected.evidence[0],
    actorId = proof.contribution.actorId;
  proof.contribution.metricIds = ["reproductions"];
  proof.contribution.reasonCodes = [
    "independent_recognition_receipt",
    ...fixed,
    `domain_outcome:${outcome}`,
    "private proof PRIVATE_SENTINEL",
  ];
  const row = input.selected.rows.find((entry) => entry.actorId === actorId);
  row.result.metricId = "reproductions";
  row.result.value = 1;
  row.evidenceIds = [proof.contribution.contributionId];
  delete row.pending;
  input.selected.rows = [row];
  input.selected.actors = input.selected.actors.filter((entry) => entry.actorId === actorId);
  input.selected.evidence = [proof];
  input.selected.portfolioEvidence = [{ ...structuredClone(proof), activityState: "accepted", observedAt: at }];
  input.selected.pendingEvidence = [];
  input.selected.diagnostics = [];
  input.selected.ranking = [{ metricId: "reproductions", direction: "descending", rank: true }];
  input.selected.methodology[0].metricId = "reproductions";
  return input;
}

for (const outcome of ["reproduced", "not_reproduced", "inconclusive"]) {
  test(`public reproduction proof and timeline retain ${outcome} and the bug-confirmation limit`, async (t) => {
    const input = fixture(outcome),
      original = structuredClone(input),
      projected = projectRead(input, input.selected.scope, null),
      expected = [...fixed, `domain_outcome:${outcome}`];
    assert.deepEqual(projected.selected.evidence[0].contribution.reasonCodes, [
      "independent_recognition_receipt",
      ...expected,
    ]);
    assert.deepEqual(projected.selected.portfolioEvidence[0].contribution.reasonCodes, [
      "public_accepted_work",
      ...expected,
    ]);
    assert.deepEqual(input, original);
    const app = createService({ now: () => Date.parse(at), source: { read: async () => structuredClone(input) } });
    t.after(() => app.close());
    const proofId = input.selected.evidence[0].contribution.contributionId;
    const urls = [
      "/api/v1/boards?metric=reproductions",
      "/api/v1/contributors/101?metric=reproductions",
      `/api/v1/evidence/${proofId}`,
      "/api/v1/exports?metric=reproductions&format=json",
      "/api/v1/exports?metric=reproductions&format=csv",
    ];
    for (const pin of ["", `snapshot=${input.head.snapshotId}`]) {
      for (const url of urls) {
        const response = await app.inject(url + (pin ? (url.includes("?") ? "&" : "?") + pin : ""));
        assert.equal(response.statusCode, 200, response.body);
        assert.doesNotMatch(response.body, /PRIVATE_SENTINEL|private proof/);
        if (url.includes("/evidence/") || url.includes("/contributors/")) {
          for (const reason of expected) assert.ok(response.body.includes(reason), `Missing ${reason}`);
        }
      }
    }
  });
}

test("accepted reproduction labels agree with explicit accepted metadata", async (t) => {
  const input = fixture();
  input.selected.evidence[0].evidenceMetadata = metadata("accepted");
  input.selected.portfolioEvidence[0].evidenceMetadata = metadata("accepted");
  const projected = projectRead(input, input.selected.scope, null);
  assert.equal(projected.selected.evidence[0].evidenceMetadata.activityState, "accepted");
  assert.equal(projected.selected.portfolioEvidence[0].evidenceMetadata.activityState, "accepted");
  const app = createService({ now: () => Date.parse(at), source: { read: async () => structuredClone(input) } });
  t.after(() => app.close());
  const response = await app.inject(`/api/v1/evidence/${input.selected.evidence[0].contribution.contributionId}`);
  assert.equal(response.statusCode, 200, response.body);
});

test("accepted reproduction copies cannot disagree or omit outcome explanations", async (t) => {
  const changes = [
    ...["observed", "pending", "unknown"].map((state) => [
      `ranked primary metadata explicitly marked ${state}`,
      (input) => {
        input.selected.portfolioEvidence = [];
        input.selected.evidence[0].evidenceMetadata = metadata(state);
      },
    ]),
    ...["observed", "pending", "unknown"].flatMap((state) =>
      ["independent_recognition_receipt", "public_accepted_work"].map((marker) => [
        `same-ID ${state} portfolio retains ${marker}`,
        (input) => {
          input.selected.portfolioEvidence[0].activityState = state;
          input.selected.portfolioEvidence[0].contribution.reasonCodes = [
            marker,
            ...fixed,
            "domain_outcome:reproduced",
          ];
        },
      ]),
    ),
    ...["independent_recognition_receipt", "public_accepted_work"].map((marker) => [
      `same-ID pending evidence retains ${marker}`,
      (input) => {
        input.selected.pendingEvidence = [
          {
            ...structuredClone(input.selected.evidence[0]),
            activityState: "pending",
            observedAt: at,
            contribution: {
              ...structuredClone(input.selected.evidence[0].contribution),
              reasonCodes: [marker, ...fixed, "domain_outcome:reproduced"],
            },
          },
        ];
      },
    ]),
    ...["observed", "pending", "unknown"].map((state) => [
      `ranked primary proof explicitly marked ${state}`,
      (input) => {
        input.selected.evidence[0].activityState = state;
      },
    ]),
    [
      "missing accepted explanation",
      (input) => {
        input.selected.portfolioEvidence[0].contribution.reasonCodes = ["public_accepted_work"];
      },
    ],
    [
      "valid but conflicting accepted outcome",
      (input) => {
        input.selected.portfolioEvidence[0].contribution.reasonCodes = [
          "public_accepted_work",
          ...fixed,
          "domain_outcome:inconclusive",
        ];
      },
    ],
    [
      "missing ranked explanation",
      (input) => {
        input.selected.evidence[0].contribution.reasonCodes = [];
      },
    ],
    [
      "conflicting metric explanation",
      (input) => {
        input.selected.evidence[0].contribution.reasonCodes.push("domain_metric:confirmed_bugs");
      },
    ],
  ];
  for (const [name, mutate] of changes) {
    await t.test(name, async (t) => {
      const input = fixture();
      mutate(input);
      assert.throws(
        () => projectRead(input, input.selected.scope, null),
        /^(?:Error: Invalid accepted reproduction explanation|Error: public_projection_unavailable)$/,
      );
      const app = createService({ now: () => Date.parse(at), source: { read: async () => structuredClone(input) } });
      t.after(() => app.close());
      for (const pin of ["", `snapshot=${input.head.snapshotId}`]) {
        for (const route of [
          "boards?metric=reproductions",
          "contributors/101?metric=reproductions",
          "exports?metric=reproductions&format=json",
          "exports?metric=reproductions&format=csv",
          `evidence/${input.selected.evidence[0].contribution.contributionId}`,
        ]) {
          const response = await app.inject(`/api/v1/${route}${pin ? (route.includes("?") ? "&" : "?") + pin : ""}`);
          assert.equal(response.statusCode, 503, response.body);
          assert.deepEqual(response.json(), { error: "public_projection_unavailable" });
          assert.equal(response.headers["cache-control"], "no-store");
        }
      }
    });
  }
});

test("descriptive reproduction work cannot acquire acceptance labels from private outcome text", () => {
  for (const state of ["observed", "pending", "unknown"]) {
    const input = fixture();
    input.selected.evidence = [];
    input.selected.rows = [];
    input.selected.portfolioEvidence[0].activityState = state;
    input.selected.portfolioEvidence[0].contribution.reasonCodes = [
      `public_${state}_work`,
      ...fixed,
      "domain_outcome:reproduced",
      "private proof PRIVATE_SENTINEL",
    ];
    const projected = projectRead(input, input.selected.scope, null);
    assert.deepEqual(projected.selected.portfolioEvidence[0].contribution.reasonCodes, [`public_${state}_work`]);
    assert.deepEqual(projected.selected.rows, []);
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_SENTINEL|domain_outcome|not_bug_confirmation/);
  }
});
