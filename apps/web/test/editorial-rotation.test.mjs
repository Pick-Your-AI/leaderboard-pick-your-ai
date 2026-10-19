import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../../service/dist/app.js";
import { selection } from "../src/remote/client.ts";
import {
  editorialCandidates,
  editorialBinding,
  editorialCompare,
  orderEditorialDimensions,
  readEditorialAssessment,
  readEditorialDimensions,
} from "../src/remote/editorial-rotation-client.ts";
import { participationHistorySource } from "../../../tests/fixtures/participation-history.mjs";

// All identities, classifications, approvals and provider inputs are synthetic.
const period = { start: "2026-01-01T00:00:00.000Z", end: "2026-10-18T00:00:00.000Z" };
const selected = selection("?organization=Pick-Your-AI");
const candidate = (n = 1, changes = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  actorId: "101",
  claimId: `claim-${n}`,
  sourceUrl: `https://github.com/synthetic-editorial/example/issues/${n}`,
  category: "Research",
  selectionExplanation: `Reviewed synthetic selection ${n}`,
  selectedAt: "2026-10-18T12:00:00.000Z",
  ruleVersion: "reviewed-opt-in/v1",
  label: "Editorial selection — not a computed ranking",
  bio: "Consented synthetic bio",
  nominationVersion: 2,
  claimVersion: 1,
  classificationVersion: 2,
  classificationRevision: 1,
  classificationDigest: "a".repeat(64),
  workstreams: ["Evidence review"],
  behindScenes: false,
  newcomerPeriod: period,
  classificationExplanation: "Independently reviewed synthetic editorial description",
  ...changes,
});
const wire = (candidates) => ({
  schemaVersion: "editorial-dimensions/v1",
  ordering: "reviewed-editorial-dimensions/v1",
  candidates,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function fixture(t, original = [candidate()], final = original, options = {}) {
  const input = participationHistorySource();
  const app = createService({ source: options.stock ? { read: input.source.read } : input.source });
  t.after(() => app.close());
  const calls = [];
  let controls = 0;
  const read = async (base, path, params, signal) => {
    signal.throwIfAborted();
    calls.push({ base, path, params: new URLSearchParams(params) });
    if (base === "/controls") return structuredClone(wire(controls++ === 0 ? original : final));
    const response = await app.inject({ method: "GET", url: `/api/v1/${path}?${params}` });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  return { ...input, app, read, calls, controls: () => controls };
}
const load = (f, signal = new AbortController().signal, read = f.read) =>
  readEditorialDimensions("/controls", "/api/v1", "Pick-Your-AI", selected, signal, read);

test("the closed projection rejects private fields, malformed declarations and incomplete capacity prefixes", () => {
  assert.equal(editorialCandidates(wire([candidate(1, { bio: "" })]))[0].bio, null);
  for (const change of [
    (v) => {
      v.historyKey = "self-asserted";
    },
    (v) => {
      v.candidates[0].privateReason = "private";
    },
    (v) => {
      v.candidates[0].workstreams = ["label\nheader"];
    },
    (v) => {
      v.candidates[0].workstreams = ["\uD800"];
    },
    (v) => {
      v.candidates[0].workstreams = ["\uDFFF"];
    },
    (v) => {
      v.candidates[0].classificationDigest = "x";
    },
    (v) => {
      v.candidates[0].newcomerPeriod.start = "2026-01-01T00:00:00.001Z";
    },
    (v) => {
      v.candidates[0].newcomerPeriod.start = "2024-01-01T00:00:00.000Z";
    },
    (v) => {
      v.candidates[0].sourceUrl = "https://attacker.example/private";
    },
    (v) => {
      v.candidates.push(structuredClone(v.candidates[0]));
    },
    (v) => {
      v.candidates = Array.from({ length: 9 }, (_, i) => candidate(i + 1));
    },
    (v) => {
      v.candidates = Array.from({ length: 33 }, (_, i) => candidate(i + 1, { newcomerPeriod: null }));
    },
  ]) {
    const value = structuredClone(wire([candidate()]));
    change(value);
    assert.throws(() => editorialCandidates(value));
  }
});

test("UTF-8 lanes round-robin with global deduplication, stable ties and no multi-lane starvation", () => {
  const cards = [
    candidate(1, { workstreams: ["A", "B"], behindScenes: true }),
    candidate(2, { workstreams: ["A", "B"] }),
    candidate(3, { workstreams: ["B"] }),
    candidate(4, { workstreams: ["é"] }),
    candidate(5, { workstreams: ["e\u0301"] }),
    candidate(6, { workstreams: [], behindScenes: true }),
    candidate(7, { workstreams: [] }),
  ].map((value) => ({
    candidate: value,
    assessment: value.id.endsWith("7")
      ? { state: "known", value: { history: { state: "known", newcomer: true } } }
      : { state: "unknown", reason: "unavailable" },
  }));
  const expected = [1, 2, 5, 4, 6, 7, 3].map((n) => candidate(n).id);
  assert.deepEqual(
    orderEditorialDimensions(cards).map((c) => c.candidate.id),
    expected,
  );
  assert.deepEqual(
    orderEditorialDimensions([...cards].reverse()).map((c) => c.candidate.id),
    expected,
  );
  assert.equal(new Set(expected).size, cards.length);
  assert.ok(editorialCompare("e\u0301", "é") < 0);
  assert.throws(() => editorialCompare("\uD800", "\uFFFD"));
  assert.throws(() => editorialCompare("\uFFFD", "\uDFFF"));
  assert.deepEqual(
    editorialCandidates(wire([candidate(1, { workstreams: ["🌟", "\uFFFD", "é", "e\u0301"] })]))[0].workstreams,
    ["🌟", "\uFFFD", "é", "e\u0301"],
  );
  assert.notEqual(
    editorialBinding(candidate(1, { workstreams: ["é"] })),
    editorialBinding(candidate(1, { workstreams: ["e\u0301"] })),
  );
});

test("actual profile bootstrap independently pins the actual finite-period history producer", async (t) => {
  const f = await fixture(t);
  const result = await load(f);
  assert.equal(result.cards[0].assessment.state, "known");
  assert.equal(result.cards[0].assessment.value.history.newcomer, true);
  assert.equal(result.cards[0].assessment.value.history.firstProof.proof.repositoryId, "3");
  assert.equal(f.state.calls, 1);
  assert.deepEqual(
    f.calls.map((c) => c.path),
    ["spotlight-rotation", "contributors/101", "contributors/101/participation-history", "spotlight-rotation"],
  );
  const bootstrap = f.calls[1].params,
    history = f.calls[2].params;
  for (const params of [bootstrap, history]) {
    assert.equal(params.get("organization"), "Pick-Your-AI");
    assert.equal(params.get("start"), period.start);
    assert.equal(params.get("end"), period.end);
    for (const absent of [
      "repository",
      "workstream",
      "category",
      "context",
      "project",
      "role",
      "search",
      "compare",
      "cursor",
      "historyKey",
    ])
      assert.equal(params.has(absent), false, absent);
  }
  assert.equal(bootstrap.has("snapshot"), false);
  assert.equal(bootstrap.get("limit"), "1");
  assert.equal(history.get("snapshot"), "synthetic-history-selected");
});

test("missing producer and wrong profile, scope or history pins stay unknown instead of classifying", async (t) => {
  const stock = await fixture(t, [candidate()], undefined, { stock: true });
  assert.equal((await load(stock)).cards[0].assessment.state, "unknown");
  for (const [target, change] of [
    [
      "profile",
      (v) => {
        v.actorId = "102";
      },
    ],
    [
      "profile",
      (v) => {
        v.scope.repository = "2";
      },
    ],
    [
      "history",
      (v) => {
        v.snapshotId = "not-the-profile";
      },
    ],
    [
      "history",
      (v) => {
        v.policyVersion = "different";
      },
    ],
    [
      "history",
      (v) => {
        v.revision++;
      },
    ],
  ]) {
    const f = await fixture(t);
    const read = async (...args) => {
      const value = await f.read(...args);
      if (args[0] !== "/controls" && (args[1].endsWith("participation-history") ? "history" : "profile") === target)
        change(value);
      return value;
    };
    assert.equal((await load(f, undefined, read)).cards[0].assessment.state, "unknown", target);
  }
});

test("fresh Controls public bytes replace earlier card content and changed bindings retire only old assessments", async (t) => {
  const old = candidate(),
    fresh = candidate(1, {
      bio: "Newly consented bio",
      selectionExplanation: "Fresh rationale",
      sourceUrl: "https://github.com/synthetic-editorial/example/issues/999",
      classificationExplanation: "Fresh public review",
    });
  const f = await fixture(t, [old], [fresh]);
  const result = await load(f);
  assert.deepEqual(result.cards[0].candidate, fresh);
  assert.equal(result.cards[0].assessment.state, "known");
  for (const change of [
    { nominationVersion: 3 },
    { claimVersion: 2 },
    { classificationVersion: 3 },
    { classificationRevision: 2 },
    { classificationDigest: "b".repeat(64) },
    { workstreams: ["Changed exact description"] },
    { behindScenes: true },
    { newcomerPeriod: { ...period, start: "2026-02-01T00:00:00.000Z" } },
  ]) {
    const changed = candidate(1, change),
      newcomer = candidate(2);
    const g = await fixture(t, [old], [changed, newcomer]);
    const value = await load(g);
    assert.deepEqual(
      value.cards.map((c) => c.candidate),
      [changed, newcomer],
    );
    assert.deepEqual(
      value.cards.map((c) => c.assessment),
      Array(2).fill({ state: "unknown", reason: "changed_or_unassessed" }),
    );
    assert.equal(g.state.calls, 1, "a newly arrived classification is not silently assessed from another candidate");
  }
});

test("withdrawal and a failed final projection cannot retain an earlier positive", async (t) => {
  const f = await fixture(t, [candidate()], []);
  assert.deepEqual(await load(f), { cards: [], ordered: [] });
  const g = await fixture(t);
  await assert.rejects(
    load(g, undefined, async (...args) => {
      if (args[0] === "/controls" && g.controls() > 0) throw new Error("Current consent unavailable");
      return g.read(...args);
    }),
    /Current consent unavailable/,
  );
});

test("eight candidate chains make at most sixteen source calls and at most two concurrent reads", async (t) => {
  const f = await fixture(
    t,
    Array.from({ length: 8 }, (_, i) => candidate(i + 1)),
  );
  let active = 0,
    maximum = 0,
    sourceCalls = 0;
  const result = await load(f, undefined, async (...args) => {
    if (args[0] === "/controls") return f.read(...args);
    sourceCalls++;
    active++;
    maximum = Math.max(maximum, active);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await f.read(...args);
    } finally {
      active--;
    }
  });
  assert.equal(result.cards.length, 8);
  assert.equal(sourceCalls, 16);
  assert.equal(maximum, 2);
  assert.equal(
    result.cards.every((c) => c.assessment.state === "known"),
    true,
  );
});

test("abort retires delayed profile success and failure without requesting fresh Controls", async (t) => {
  for (const fail of [false, true]) {
    const f = await fixture(t),
      gate = deferred(),
      entered = deferred(),
      controller = new AbortController();
    const reading = load(f, controller.signal, async (...args) => {
      if (args[0] !== "/controls") {
        entered.resolve();
        await gate.promise;
        if (fail) throw new Error("retired failure");
      }
      return f.read(...args);
    });
    const rejected = assert.rejects(reading, /retired selection/);
    await entered.promise;
    controller.abort(new Error("retired selection"));
    await rejected;
    gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.controls(), 1);
    assert.equal(f.state.calls, 0);
  }
});

test("the finite source budget releases a hanging provider and exposes an explicit unknown batch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = deferred(),
    entered = deferred();
  let controls = 0,
    sourceCalls = 0;
  const result = readEditorialDimensions(
    "/controls",
    "/api/v1",
    "Pick-Your-AI",
    selected,
    new AbortController().signal,
    async (base) => {
      if (base === "/controls") {
        controls++;
        return wire([candidate()]);
      }
      sourceCalls++;
      entered.resolve();
      await gate.promise;
      throw new Error("retired provider");
    },
  );
  await entered.promise;
  t.mock.timers.tick(10000);
  const value = await result;
  assert.deepEqual(value.cards[0].assessment, { state: "unknown", reason: "history_budget_exhausted" });
  assert.equal(controls, 2);
  assert.equal(sourceCalls, 1);
  gate.resolve();
  await Promise.resolve();
});

test("filtered or historical overview inputs cannot accidentally call the dimension provider", async () => {
  let calls = 0;
  for (const query of [
    "?repository=2",
    "?actors=user",
    "?snapshot=historical",
    "?category=pr_merged",
    `?start=${period.start}&end=${period.end}`,
  ])
    await assert.rejects(
      readEditorialDimensions(
        "/controls",
        "/api/v1",
        "Pick-Your-AI",
        selection(query),
        new AbortController().signal,
        async () => {
          calls++;
          throw new Error("must not call");
        },
      ),
      /editorial_scope_unavailable/,
    );
  assert.equal(calls, 0);
});
