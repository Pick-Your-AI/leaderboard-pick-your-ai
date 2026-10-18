import assert from "node:assert/strict";
import test from "node:test";
import {
  canReview,
  control,
  ControlsFailure,
  verifiedSession,
  type Receipt,
  type Session,
} from "../src/controls/client.ts";
const session: Session = { actorId: "1", csrf: "a".repeat(43), roles: ["reviewer"], expires: Date.now() + 600000 };
test("controls fail closed on malformed identity, authority, CSRF or expired session", () => {
  assert.equal(verifiedSession(session), session);
  for (const patch of [{ actorId: "alice" }, { roles: ["admin"] }, { csrf: "bad" }, { expires: 0 }])
    assert.throws(() => verifiedSession({ ...session, ...patch }));
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
