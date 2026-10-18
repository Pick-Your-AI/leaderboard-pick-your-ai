import test from "node:test";
import assert from "node:assert/strict";
import { documentPolicy, documentHeaders } from "../security-policy.ts";

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
  assert.equal(documentHeaders["Content-Security-Policy"], `${documentPolicy}; frame-ancestors 'none'`);
  assert.equal(documentHeaders["X-Content-Type-Options"], "nosniff");
  assert.equal(documentHeaders["Referrer-Policy"], "no-referrer");
});
