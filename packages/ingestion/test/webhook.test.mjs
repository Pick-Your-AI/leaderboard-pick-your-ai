import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createWebhookHandler, verifySignature } from "../dist/index.js";

const secret = "synthetic-webhook-secret-for-tests-only";
const deliveryId = "00000000-0000-4000-8000-000000000001";
export function payload(overrides = {}) {
  return {
    action: "opened",
    installation: { id: 1 },
    repository: { id: 2, full_name: "synthetic-org/synthetic-repo", private: false, visibility: "public" },
    sender: { node_id: "SYNTHETIC_ACTOR", email: "must-not-store@example.invalid" },
    issue: {
      node_id: "SYNTHETIC_ISSUE",
      number: 3,
      created_at: "2026-01-01T00:00:00Z",
      title: "must not store",
      body: "must not store",
      user: { email: "must-not-store@example.invalid" },
    },
    ...overrides,
  };
}
export function request(data = payload(), headers = {}, raw) {
  const body = raw ?? JSON.stringify(data);
  return new Request("https://synthetic.invalid/webhooks/github", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": "issues",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      ...headers,
    },
  });
}
export function handler(store, extra = {}) {
  return createWebhookHandler({ secrets: [secret], scope: new Map([[1, new Set([2])]]), store, ...extra });
}

test("matches GitHub published HMAC vector and rejects altered bytes and malformed signatures", () => {
  const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
  assert.equal(verifySignature(Buffer.from("Hello, World!"), signature, ["It's a Secret to Everybody"]), true);
  assert.equal(verifySignature(Buffer.from("Hello, World?"), signature, ["It's a Secret to Everybody"]), false);
  for (const invalid of [null, "sha1=abc", "sha256=ab", `sha256=${"g".repeat(64)}`]) {
    assert.equal(verifySignature(Buffer.from("Hello, World!"), invalid, [secret]), false);
  }
});

test("rotation accepts both active keys; empty and weak configuration fails closed", async () => {
  const rotated = handler(
    { insert: async () => "accepted" },
    { secrets: ["other-synthetic-key-of-at-least-32-chars", secret] },
  );
  assert.equal((await rotated(request())).status, 202);
  assert.throws(() => handler({}, { secrets: [] }));
  assert.throws(() => handler({}, { secrets: ["short"] }));
});

test("durable acknowledgement follows commit; storage sees minimized data only", async () => {
  let receipt;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let responded = false;
  const pending = handler({
    insert: async (delivery) => {
      receipt = delivery;
      await gate;
      return "accepted";
    },
  })(request()).then((response) => {
    responded = true;
    return response;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responded, false);
  assert.equal(receipt.envelope.actorId, "SYNTHETIC_ACTOR");
  assert.equal(receipt.envelope.occurredAt, "2026-01-01T00:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(receipt), /must.not.store|email|title|body"|user"/);
  release();
  assert.equal((await pending).status, 202);
});

test("storage failures fail closed and never disclose SQL or secrets", async () => {
  const response = await handler({
    insert: async () => {
      throw new Error("database password synthetic-sensitive");
    },
  })(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "intake_unavailable" });
});

test("bad signature, JSON, scope, visibility and unsupported events never reach storage", async () => {
  let calls = 0;
  const receive = handler({
    insert: async () => {
      calls++;
      return "accepted";
    },
  });
  const cases = [
    [request(undefined, { "x-hub-signature-256": "sha256=bad" }), 401],
    [request(undefined, {}, "{"), 400],
    [request(payload({ installation: { id: 999 } })), 403],
    [request(payload({ repository: { ...payload().repository, private: true } })), 403],
    [request(payload({ repository: { ...payload().repository, visibility: undefined } })), 403],
    [request(payload({ repository: { ...payload().repository, full_name: "synthetic-org/.." } })), 400],
    [request(undefined, { "x-github-event": "push" }), 422],
    [request(payload({ action: "transferred" })), 422],
    [request(undefined, { "x-github-delivery": "invalid" }), 400],
    [request(undefined, { "content-encoding": "gzip" }), 415],
    [request(undefined, { "content-type": "text/plain" }), 415],
    [request(payload({ issue: { ...payload().issue, pull_request: {} } })), 422],
  ];
  for (const [input, status] of cases) assert.equal((await receive(input)).status, status);
  assert.equal(calls, 0);
});

test("streamed and declared oversized bodies are rejected before persistence", async () => {
  const receive = handler({ insert: async () => assert.fail("must not persist") }, { maxBodyBytes: 10 });
  assert.equal((await receive(request())).status, 413);
  assert.equal((await receive(request(undefined, { "content-length": "9999" }))).status, 413);
});

test("unknown timestamps and actors stay unknown; PR and issue namespaces stay distinct", async () => {
  const deliveries = [];
  const receive = handler({
    insert: async (value) => {
      deliveries.push(value);
      return "accepted";
    },
  });
  assert.equal((await receive(request(payload({ action: "reopened", sender: null })))).status, 202);
  assert.equal(deliveries[0].envelope.occurredAt, null);
  assert.equal(deliveries[0].envelope.actorId, null);
  const pr = payload({ pull_request: payload().issue });
  assert.equal((await receive(request(pr, { "x-github-event": "pull_request" }))).status, 202);
  assert.match(deliveries[1].envelope.sourceUrl, /\/pull\/3$/);
});

test("configuration is snapshotted and duplicate/conflict acknowledgements differ", async () => {
  const scope = new Map([[1, new Set([2])]]);
  const receive = handler({ insert: async () => "duplicate" }, { scope });
  scope.get(1).add(999);
  assert.equal((await receive(request())).status, 200);
  assert.equal((await receive(request(payload({ repository: { ...payload().repository, id: 999 } })))).status, 403);
  assert.equal((await handler({ insert: async () => "conflict" })(request())).status, 409);
});

test("unsigned event header cannot broaden a signed repository deletion to installation revocation", async () => {
  const calls = [];
  const receive = handler(
    { insert: async () => "accepted" },
    {
      scope: new Map([[1, new Set([2, 3])]]),
      lifecycle: {
        suppress: async (...args) => {
          calls.push(args);
          return "accepted";
        },
      },
    },
  );
  const deletion = { action: "deleted", installation: { id: 1 }, repository: { id: 2 } };
  assert.equal((await receive(request(deletion, { "x-github-event": "installation" }))).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await receive(request(deletion, { "x-github-event": "repository" }))).status, 202);
  assert.deepEqual(calls[0].slice(2), [1, [2], "removed"]);
});

test("installation-wide restriction requires installation-specific signed payload evidence", async () => {
  const calls = [];
  const receive = handler(
    { insert: async () => "accepted" },
    {
      scope: new Map([[1, new Set([2, 3])]]),
      lifecycle: {
        suppress: async (...args) => {
          calls.push(args);
          return "accepted";
        },
      },
    },
  );
  for (const action of ["deleted", "suspend"]) {
    const installation = {
      id: 1,
      app_id: 20,
      target_id: 42,
      target_type: "Enterprise",
      repository_selection: "selected",
      account: null,
    };
    assert.equal(
      (await receive(request({ action, installation, repository: { id: 2 } }, { "x-github-event": "installation" })))
        .status,
      202,
    );
    for (const incomplete of [{ id: 1 }, { ...installation, app_id: null }, { ...installation, target_type: "" }]) {
      assert.equal(
        (await receive(request({ action, installation: incomplete }, { "x-github-event": "installation" }))).status,
        400,
      );
    }
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(2), [1, [2, 3], "revoked"]);
});

test("repository transfer suppresses only the previously approved repository pending a fresh scope review", async () => {
  const calls = [];
  const receive = handler(
    { insert: async () => "accepted" },
    {
      scope: new Map([[1, new Set([2, 3])]]),
      lifecycle: {
        suppress: async (...args) => {
          calls.push(args);
          return "accepted";
        },
      },
    },
  );
  const transfer = { action: "transferred", installation: { id: 1 }, repository: { id: 2 }, enterprise: { id: 42 } };
  assert.equal((await receive(request(transfer, { "x-github-event": "repository" }))).status, 202);
  assert.deepEqual(calls[0].slice(2), [1, [2], "removed"]);
  assert.equal(
    (await receive(request({ ...transfer, repository: { id: 99 } }, { "x-github-event": "repository" }))).status,
    403,
  );
  assert.equal(calls.length, 1);
});

test("signed child-object deletions cannot become whole-repository restrictions through the event header", async () => {
  let calls = 0;
  const receive = handler(
    { insert: async () => "accepted" },
    {
      lifecycle: {
        suppress: async () => {
          calls++;
          return "accepted";
        },
      },
    },
  );
  for (const subject of ["issue", "pull_request", "comment", "release", "discussion", "label", "milestone"]) {
    const child = { action: "deleted", installation: { id: 1 }, repository: { id: 2 }, [subject]: { id: 5 } };
    assert.equal((await receive(request(child, { "x-github-event": "repository" }))).status, 400, subject);
  }
  assert.equal(calls, 0);
});
