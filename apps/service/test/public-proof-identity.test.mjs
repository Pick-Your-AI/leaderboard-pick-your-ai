// Synthetic publication inputs only; no live source or contributor acceptance is implied.
import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../dist/app.js";
import { readFixture, at } from "../../../tests/fixtures/pending-metric.mjs";

function fixture() {
  const input = readFixture();
  input.selected.portfolioEvidence = [
    ...input.selected.evidence.map((entry) => ({
      ...structuredClone(entry),
      activityState: "accepted",
      observedAt: at,
    })),
    ...structuredClone(input.selected.pendingEvidence),
  ];
  return input;
}

function harness(t, input) {
  const app = createService({
    now: () => Date.parse(at),
    source: {
      async read() {
        return structuredClone(input);
      },
    },
  });
  t.after(() => app.close());
  return app;
}

function unavailable(response) {
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { error: "public_projection_unavailable" });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers.etag, undefined);
}

const pairs = [
  ["primary and portfolio", (input) => [input.selected.evidence[0], input.selected.portfolioEvidence[0]]],
  [
    "primary and pending",
    (input) => {
      const pending = input.selected.pendingEvidence[0];
      const { activityState, observedAt, ...primary } = structuredClone(pending);
      // Primary eligibility alone is not acceptance; this proof is not added to an accepted row.
      input.selected.evidence.push(primary);
      return [primary, pending];
    },
  ],
  [
    "portfolio and pending",
    (input) => {
      const pending = input.selected.pendingEvidence[0];
      const portfolio = input.selected.portfolioEvidence.find(
        (entry) => entry.contribution.contributionId === pending.contribution.contributionId,
      );
      return [portfolio, pending];
    },
  ],
];
for (const [name, select] of pairs)
  test(`one proof cannot name different actors in ${name}`, async (t) => {
    const input = fixture();
    const [original, alternate] = select(input);
    const app = harness(t, input);
    const url = `/api/v1/evidence/${original.contribution.contributionId}?snapshot=${input.head.snapshotId}`;
    const matched = await app.inject(url);
    assert.equal(matched.statusCode, 200);
    assert.equal(matched.json().contribution.actorId, "101");
    alternate.contribution.actorId = "102";
    unavailable(await app.inject(url));
  });

const contradictions = [
  [
    "canonical event",
    (_input, alternate) => {
      alternate.contribution.canonicalEventId = "synthetic-other-event";
    },
  ],
  [
    "artifact identity",
    (input, alternate) => {
      alternate.artifact = structuredClone(input.selected.evidence[1].artifact);
      alternate.contribution.artifactId = alternate.artifact.stableId;
    },
  ],
  [
    "credited roles",
    (_input, alternate) => {
      alternate.contribution.roles = ["reviewer"];
    },
  ],
  [
    "qualification",
    (_input, alternate) => {
      alternate.contribution.qualification = "ineligible";
    },
  ],
  [
    "public metric membership",
    (input, alternate) => {
      input.selected.ranking.push({ metricId: "pr_opened", direction: "descending", rank: false });
      alternate.contribution.metricIds = ["pr_opened"];
    },
  ],
];
for (const [name, change] of contradictions)
  test(`one proof cannot carry contradictory ${name} across collections`, async (t) => {
    const input = fixture();
    const original = input.selected.evidence[0];
    change(input, input.selected.portfolioEvidence[0]);
    unavailable(await harness(t, input).inject(`/api/v1/evidence/${original.contribution.contributionId}`));
  });

test("legacy and equivalent copies preserve canonical contribution identity and collection-specific context", async (t) => {
  const input = readFixture();
  const original = input.selected.evidence[0];
  const url = `/api/v1/evidence/${original.contribution.contributionId}`;
  const app = harness(t, input);
  assert.equal((await app.inject(url)).statusCode, 200, "Legacy primary-only proof remains supported");
  input.selected.ranking.push({ metricId: "pr_opened", direction: "descending", rank: false });
  original.contribution.roles = ["coauthor", "author"];
  original.contribution.metricIds = ["pr_merged", "pr_opened"];
  original.contribution.reasonCodes = ["public_accepted_source"];
  const alternate = {
    ...structuredClone(original),
    // The publisher uses a metric-effective clock in primary proof and source occurrence in the portfolio.
    occurredAt: "2026-10-17T11:00:00.000Z",
    activityState: "accepted",
    observedAt: at,
  };
  Object.assign(alternate.contribution, {
    actorId: " 101 ",
    artifactId: ` ${original.contribution.artifactId} `,
    canonicalEventId: ` ${original.contribution.canonicalEventId} `,
    roles: ["author", "coauthor"],
    metricIds: ["pr_opened", "pr_merged", "documentation"],
    reasonCodes: ["public_accepted_work"],
  });
  input.selected.portfolioEvidence = [alternate];
  const response = await app.inject(url);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().contribution.actorId, original.contribution.actorId);
  assert.deepEqual(response.json().contribution.roles, ["author", "coauthor"]);
  assert.deepEqual(response.json().contribution.metricIds, ["pr_opened", "pr_merged"]);
  assert.equal(response.json().occurredAt, alternate.occurredAt);
  assert.deepEqual(response.json().contribution.reasonCodes, ["public_accepted_work"]);
});

test("distinct contribution IDs may attribute the same artifact and source event to collaborators", async (t) => {
  const input = fixture();
  const shared = structuredClone(input.selected.portfolioEvidence[0]);
  shared.contribution.contributionId = "synthetic-collaborator-proof";
  shared.contribution.actorId = "102";
  shared.contribution.roles = ["coauthor"];
  input.selected.portfolioEvidence.push(shared);
  const app = harness(t, input);
  const response = await app.inject(`/api/v1/evidence/${shared.contribution.contributionId}`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().contribution.actorId, "102");
  assert.equal(response.json().artifact.stableId, input.selected.evidence[0].artifact.stableId);
  assert.equal((await app.inject("/api/v1/boards?metric=pr_merged")).statusCode, 200);
});

for (const field of ["actorId", "artifactId"])
  test(`unknown ${field} stays withheld without erasing a known cross-collection identity`, async (t) => {
    const input = fixture();
    const original = input.selected.evidence[0];
    input.selected.portfolioEvidence[0].contribution[field] = null;
    const app = harness(t, input);
    const url = `/api/v1/evidence/${original.contribution.contributionId}`;
    const known = await app.inject(url);
    assert.equal(known.statusCode, 200);
    assert.equal(known.json().contribution[field], original.contribution[field]);
    const alternate = { ...structuredClone(original), activityState: "pending", observedAt: at };
    if (field === "actorId") alternate.contribution.actorId = "102";
    else {
      alternate.artifact = structuredClone(input.selected.evidence[1].artifact);
      alternate.contribution.artifactId = alternate.artifact.stableId;
    }
    input.selected.pendingEvidence.push(alternate);
    unavailable(await app.inject(url));
  });

test("current and pinned routes reject conflicting proof before conditional reuse and recover after repair", async (t) => {
  const input = fixture();
  const proof = input.selected.evidence[0];
  const app = harness(t, input);
  const routes = [
    "/api/v1/boards?metric=pr_merged",
    `/api/v1/evidence/${proof.contribution.contributionId}`,
    "/api/v1/contributors",
    "/api/v1/contributors/101",
    "/api/v1/exports?metric=pr_merged&format=json",
    "/api/v1/exports?metric=pr_merged&format=csv",
  ];
  const urls = routes.flatMap((url) => [
    url,
    `${url}${url.includes("?") ? "&" : "?"}snapshot=${input.head.snapshotId}`,
  ]);
  const validators = [];
  for (const url of urls) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200, url);
    assert.ok(response.headers.etag, url);
    validators.push({ url, headers: { "if-none-match": response.headers.etag } });
  }
  input.selected.portfolioEvidence[0].contribution.actorId = "102";
  const conflicted = await Promise.all(validators.map((request) => app.inject(request)));
  input.selected.portfolioEvidence[0].contribution.actorId = "101";
  const recovered = await Promise.all(validators.map((request) => app.inject(request)));
  assert.deepEqual(
    recovered.map((response) => response.statusCode),
    urls.map(() => 304),
  );
  for (const response of conflicted) unavailable(response);
});

test("discarding a suppressed counterpart cannot reattribute its proof to another public actor", async (t) => {
  const input = fixture();
  input.controls.suppressedActorIds.push("101");
  const app = harness(t, input);
  const url = `/api/v1/evidence/${input.selected.evidence[0].contribution.contributionId}?snapshot=${input.head.snapshotId}`;
  assert.equal((await app.inject(url)).statusCode, 404, "Matching copies obey current suppression");
  assert.equal((await app.inject("/api/v1/boards?metric=pr_merged")).statusCode, 200);
  input.selected.portfolioEvidence[0].contribution.actorId = "102";
  unavailable(await app.inject(url));
});

test("a conflicting comparison baseline withholds movement without discarding valid current totals", async (t) => {
  const previous = fixture();
  const current = fixture();
  Object.assign(current.selected.snapshot, { snapshotId: "synthetic-pending-2", revision: 2 });
  Object.assign(current.head, { snapshotId: "synthetic-pending-2", revision: 2 });
  previous.head = structuredClone(current.head);
  const app = createService({
    now: () => Date.parse(at),
    source: {
      async read() {
        return structuredClone(current);
      },
      async readComparison() {
        return structuredClone({ current, previous, currentHistory: null, previousHistory: null });
      },
    },
  });
  t.after(() => app.close());
  const url = "/api/v1/boards?metric=pr_merged&snapshot=synthetic-pending-2&compare=synthetic-pending-1";
  const matched = await app.inject(url);
  assert.equal(matched.statusCode, 200);
  assert.ok(matched.json().rows.every((row) => row.movement.reason === "insufficient_evidence_history"));
  previous.selected.portfolioEvidence[0].contribution.actorId = "102";
  const response = await app.inject(url);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json().rows.map((row) => row.result.value),
    matched.json().rows.map((row) => row.result.value),
  );
  assert.ok(response.json().rows.every((row) => row.movement.reason === "comparison_unavailable"));
});
