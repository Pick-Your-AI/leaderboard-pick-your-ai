import test from "node:test";
import assert from "node:assert/strict";
import { apiBase, controlsNavigationBase, ReadFailure } from "../src/remote/client.ts";

function location(t, origin) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin } } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
}
const configurationFailure = (error) =>
  error instanceof ReadFailure && error.status === 500 && error.code === "invalid_public_api_configuration";

test("public API paths and absolute URLs retain the document's exact origin", (t) => {
  location(t, "https://leaderboard.example.invalid");
  for (const raw of [
    undefined,
    "/api/v1/",
    "https://leaderboard.example.invalid/api/v1",
    "https://leaderboard.example.invalid:443/api/v1",
  ])
    assert.equal(apiBase(raw), "https://leaderboard.example.invalid/api/v1");
  assert.equal(apiBase("/public/api"), "https://leaderboard.example.invalid/public/api");
});

test("configured HTTPS public APIs retain their explicit origin and port", (t) => {
  location(t, "https://leaderboard.example.invalid");
  for (const raw of ["https://api.example.invalid/api/v1", "https://leaderboard.example.invalid:8443/api/v1"])
    assert.equal(apiBase(raw), raw);
  assert.throws(() => apiBase("http://leaderboard.example.invalid/api/v1"), configurationFailure);
});

test("local HTTP public reads remain on the browser origin rather than the upstream proxy port", (t) => {
  location(t, "http://127.0.0.1:5173");
  assert.equal(apiBase(), "http://127.0.0.1:5173/api/v1");
  assert.equal(apiBase("http://127.0.0.1:5173/api/v1/"), "http://127.0.0.1:5173/api/v1");
  assert.throws(() => apiBase("http://127.0.0.1:3001/api/v1"), configurationFailure);
});

test("explicit secure account navigation retains its separately configured origin", (t) => {
  location(t, "https://leaderboard.example.invalid");
  const configured = "https://accounts.example.invalid/controls/";
  assert.equal(controlsNavigationBase(configured), "https://accounts.example.invalid/controls");
  assert.equal(apiBase("https://api.example.invalid/api/v1"), "https://api.example.invalid/api/v1");
  assert.equal(controlsNavigationBase("/controls"), "https://leaderboard.example.invalid/controls");
  assert.throws(() => controlsNavigationBase("http://accounts.example.invalid/controls"), configurationFailure);
});

test("read and account configuration reject unsafe or malformed URL shapes with a controlled error", (t) => {
  location(t, "https://leaderboard.example.invalid");
  for (const raw of [
    "https://[invalid/api/v1",
    "https://leaderboard.example.invalid:not-a-port/api/v1",
    "https://user:password@leaderboard.example.invalid/api/v1",
    "/api/v1?token=synthetic",
    "/api/v1#fragment",
    "/api/%2fsecret",
    "javascript:alert(1)",
  ])
    for (const parse of [apiBase, controlsNavigationBase]) assert.throws(() => parse(raw), configurationFailure, raw);
});
