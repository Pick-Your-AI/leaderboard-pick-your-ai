import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createWebhookHandler } from "../dist/index.js";

const secret = "synthetic-lifecycle-shape-test-key-only";
const installation = {
  id: 1,
  app_id: 20,
  target_id: 42,
  target_type: "Organization",
  repository_selection: "selected",
};

function signedRequest(event, value, headers = {}) {
  const body = JSON.stringify(value);
  return new Request("https://synthetic.invalid/webhooks/github", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "00000000-0000-4000-8000-000000000001",
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      ...headers,
    },
  });
}

function receiver(result = "accepted") {
  const effects = { inserted: [], suppressed: [] };
  const receive = createWebhookHandler({
    secrets: [secret],
    scope: new Map([[1, new Set([2, 3])]]),
    store: {
      insert: async (value) => {
        effects.inserted.push(value);
        return result;
      },
    },
    lifecycle: {
      suppress: async (...args) => {
        effects.suppressed.push(args.slice(2));
        return result;
      },
    },
  });
  return { receive, effects };
}

const malformed = [
  ["installation action array", "installation", { action: ["deleted"], installation }, 422],
  ["installation action nested array", "installation", { action: [["suspend"]], installation }, 422],
  ...["privatized", "deleted", "transferred"].map((action) => [
    `repository ${action} action array`,
    "repository",
    { action: [action], installation: { id: 1 }, repository: { id: 2 } },
    422,
  ]),
  ...["all", "selected"].map((selection) => [
    `installation ${selection} selection array`,
    "installation",
    { action: "deleted", installation: { ...installation, repository_selection: [selection] } },
    400,
  ]),
  [
    "installation selection nested array",
    "installation",
    { action: "suspend", installation: { ...installation, repository_selection: [["selected"]] } },
    400,
  ],
];

for (const [name, event, value, status] of malformed) {
  test(`signed lifecycle ${name} cannot trigger a restriction`, async () => {
    const { receive, effects } = receiver();
    const response = await receive(signedRequest(event, value));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: status === 422 ? "unsupported_action" : "invalid_payload" });
    assert.deepEqual(effects, { inserted: [], suppressed: [] });
  });
}

test("literal lifecycle actions preserve their exact approved scope and restriction reason", async () => {
  const { receive, effects } = receiver();
  const expected = [];
  for (const action of ["deleted", "suspend"]) {
    for (const selection of ["all", "selected"]) {
      const response = await receive(
        signedRequest("installation", {
          action,
          installation: { ...installation, repository_selection: selection, account: null },
        }),
      );
      assert.equal(response.status, 202);
      expected.push([1, [2, 3], "revoked"]);
    }
  }
  for (const action of ["privatized", "deleted", "transferred"]) {
    const response = await receive(
      signedRequest("repository", { action, installation: { id: 1 }, repository: { id: 2 } }),
    );
    assert.equal(response.status, 202);
    expected.push([1, [2], action === "privatized" ? "private" : "removed"]);
  }
  const removed = await receive(
    signedRequest("installation_repositories", {
      action: "removed",
      installation: { id: 1 },
      repositories_removed: [{ id: 2 }, { id: 99 }],
    }),
  );
  assert.equal(removed.status, 202);
  expected.push([1, [2], "removed"]);
  assert.deepEqual(effects, { inserted: [], suppressed: expected });
});

test("missing and unsupported lifecycle values retain their existing error categories without side effects", async () => {
  const { receive, effects } = receiver();
  for (const event of ["installation", "installation_repositories", "repository"]) {
    for (const action of [undefined, null, true, 7, {}, [], "", "created", "deleted "]) {
      const response = await receive(signedRequest(event, { action, installation, repository: { id: 2 } }));
      assert.equal(response.status, 422, `${event}: ${JSON.stringify(action)}`);
      assert.deepEqual(await response.json(), { error: "unsupported_action" });
    }
  }
  for (const selection of [undefined, null, true, 7, {}, [], "", "unknown"]) {
    const response = await receive(
      signedRequest("installation", {
        action: "deleted",
        installation: { ...installation, repository_selection: selection },
      }),
    );
    assert.equal(response.status, 400, JSON.stringify(selection));
    assert.deepEqual(await response.json(), { error: "invalid_payload" });
  }
  assert.deepEqual(effects, { inserted: [], suppressed: [] });
});

test("lifecycle signature admission still precedes shape classification", async () => {
  const { receive, effects } = receiver();
  for (const [, event, value] of malformed) {
    const response = await receive(signedRequest(event, value, { "x-hub-signature-256": `sha256=${"0".repeat(64)}` }));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "invalid_signature" });
  }
  assert.deepEqual(effects, { inserted: [], suppressed: [] });
});

test("valid lifecycle duplicate and conflicting deliveries retain their acknowledgement categories", async () => {
  for (const [result, status, body] of [
    ["accepted", 202, { status: "accepted" }],
    ["duplicate", 200, { status: "duplicate" }],
    ["conflict", 409, { error: "delivery_conflict" }],
  ]) {
    const { receive, effects } = receiver(result);
    const response = await receive(signedRequest("installation", { action: "deleted", installation }));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), body);
    assert.deepEqual(effects, { inserted: [], suppressed: [[1, [2, 3], "revoked"]] });
  }
});
