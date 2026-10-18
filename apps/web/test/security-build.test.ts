import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentPolicyForApiBase } from "../security-policy.ts";
import { buildConfiguredApp } from "./securityBuild.ts";

for (const processBase of [undefined, "https://process.example.invalid:8443/api/v1"]) {
  test(`built CSP and client share ${processBase ? "process override" : "mode-file"} API configuration`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pyai-csp-build-"));
    try {
      const fileBase = "https://mode.example.invalid/api/v1";
      const expected = processBase ?? fileBase;
      const built = await buildConfiguredApp(directory, fileBase, processBase);
      const policy = built.html
        .match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1]
        ?.replaceAll("&#39;", "'");
      assert.equal(policy, documentPolicyForApiBase(expected));
      assert.ok(built.html.indexOf("Content-Security-Policy") < built.html.indexOf("<script"));
      assert.ok(built.javascript.includes(expected), "the actual application bundle must use the same API base");
      assert.ok(!policy?.includes("default.example.invalid"));
      if (processBase) assert.ok(!policy?.includes("mode.example.invalid"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("invalid configured API fails the actual build before publishing a document", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pyai-csp-invalid-build-"));
  try {
    await assert.rejects(
      buildConfiguredApp(directory, "https://api.example.invalid/api/v1; script-src *"),
      /Invalid VITE_PUBLIC_API_BASE/,
    );
    await assert.rejects(access(join(directory, "dist", "index.html")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
