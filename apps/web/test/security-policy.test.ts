import test from "node:test";
import assert from "node:assert/strict";
import { documentPolicy, documentPolicyForApiBase, documentHeaders } from "../security-policy.ts";

test("production CSP has no executable inline, external, image or embedding allowance", () => {
  const rules = new Map(
    documentPolicy.split("; ").map((rule) => {
      const [name, ...values] = rule.split(" ");
      return [name, values.join(" ")];
    }),
  );
  for (const name of [
    "default-src",
    "script-src-attr",
    "img-src",
    "object-src",
    "base-uri",
    "frame-src",
    "worker-src",
  ]) {
    assert.equal(rules.get(name), "'none'");
  }
  for (const name of ["script-src", "style-src", "font-src", "connect-src", "form-action"]) {
    assert.equal(rules.get(name), "'self'");
  }
  assert.equal(rules.has("frame-ancestors"), false);
  assert.equal(documentHeaders["Content-Security-Policy"], "frame-ancestors 'none'");
  assert.equal(documentHeaders["X-Content-Type-Options"], "nosniff");
  assert.equal(documentHeaders["Referrer-Policy"], "no-referrer");
});

test("only the exact normalized HTTPS API origin gains a connection allowance", () => {
  for (const value of [undefined, "", "/api/v1", "api/v1", "/approved_api/v2/"]) {
    assert.equal(documentPolicyForApiBase(value), documentPolicy);
  }
  for (const [base, origin] of [
    ["https://api.example.invalid/api/v1", "https://api.example.invalid"],
    ["HTTPS://API.EXAMPLE.INVALID:443/api/v1/", "https://api.example.invalid"],
    ["https://api.example.invalid:8443/public/v1", "https://api.example.invalid:8443"],
    ["https://127.0.0.1:8443/api/v1", "https://127.0.0.1:8443"],
  ]) {
    assert.equal(
      documentPolicyForApiBase(base),
      documentPolicy.replace("connect-src 'self'", `connect-src 'self' ${origin}`),
    );
  }
});

test("ambiguous or unsafe build configuration cannot become a CSP source", () => {
  for (const value of [
    "http://api.example.invalid/api/v1",
    "//api.example.invalid/api/v1",
    "https:api.example.invalid/api/v1",
    "https:///api.example.invalid/api/v1",
    "https://user:password@api.example.invalid/api/v1",
    "https://api.example.invalid/api/v1?token=x",
    "https://api.example.invalid/api/v1?",
    "https://api.example.invalid/api/v1#fragment",
    "https://api.example.invalid/api/v1#",
    "https://api.example.invalid//api/v1",
    "https://api.example.invalid/api/%2Fv1",
    "https://api.example.invalid/",
    "https://*.example.invalid/api/v1",
    "https://api.example.invalid;script-src/api/v1",
    "https://api.example.invalid/api/v1; script-src *",
    "https://api.example.invalid\\api\\v1",
    "https://api.example.invalid/\napi/v1",
    " https://api.example.invalid/api/v1",
    "https://api.example.invalid:99999/api/v1",
    "https://[::1]/api/v1",
    "data:text/plain,api/v1",
    "javascript:alert(1)",
    "/api/v1?x",
    "/api/v1#x",
    "///api/v1",
  ])
    assert.throws(() => documentPolicyForApiBase(value), /Invalid VITE_PUBLIC_API_BASE/, value);
});
