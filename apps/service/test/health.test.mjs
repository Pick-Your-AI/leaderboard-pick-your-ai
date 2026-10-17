import test from "node:test";
import assert from "node:assert/strict";
import { createService } from "../dist/app.js";

test("health endpoint identifies a running local service", async () => {
  const app = createService();
  try {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok" });
  } finally {
    await app.close();
  }
});

test("read API is explicit that no public snapshot exists yet", async () => {
  const app = createService();
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "scaffold");
    assert.equal(response.json().revision, null);
  } finally {
    await app.close();
  }
});
