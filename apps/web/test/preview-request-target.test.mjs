import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

function get(port, path, headers = ["Host", "127.0.0.1", "Connection", "close"]) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      response.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("synthetic_preview_request_timeout")));
    req.end();
  });
}

test("the actual preview admits large targets while retaining independent HTTP header bounds", async (t) => {
  const child = spawn(
    process.execPath,
    ["--max-http-header-size=66560", "preview.mjs", "--host", "127.0.0.1", "--port", "0", "--strictPort"],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  });
  const port = await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`synthetic_preview_start_timeout: ${output}`)), 20_000);
    const read = (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`synthetic_preview_exit_${code}: ${output}`));
    });
  });
  await t.test("all 100 maximum-length encoded Project IDs reach the document", async () => {
    const projects = Array.from(
      { length: 100 },
      (_, index) => `PVT_${String(index).padStart(3, "0")}_${":".repeat(120)}`,
    );
    const path = `/start?${new URLSearchParams({ context: "current", project: projects.join(",") })}`;
    assert.ok(path.length > 16 * 1024 && path.length < 48 * 1024);
    const result = await get(port, path);
    assert.equal(result.status, 200);
    assert.match(result.body, /<html/);
    assert.ok(result.headers["content-security-policy"]);
  });
  await t.test("the exact 48 KiB target boundary remains admitted", async () => {
    const path = `/start?${"a".repeat(48 * 1024 - 7)}`;
    assert.equal(path.length, 48 * 1024);
    assert.equal((await get(port, path)).status, 200);
  });
  await t.test("an additional target byte receives 414 before document or proxy access", async () => {
    const result = await get(port, `/start?${"a".repeat(48 * 1024 - 6)}`);
    assert.equal(result.status, 414);
    assert.equal(result.body, "query_too_large");
    assert.equal(result.headers["cache-control"], "no-store");
  });
  const fields = ["Host", "127.0.0.1", "Connection", "close", "X-Synthetic", ""];
  const baseBytes = 2 + fields.reduce((sum, value) => sum + Buffer.byteLength(value, "latin1") + 2, 0);
  await t.test("16 KiB of parsed ordinary headers is independently admitted", async () => {
    const headers = [...fields];
    headers[5] = "é".repeat(16 * 1024 - baseBytes);
    assert.equal((await get(port, "/start", headers)).status, 200);
  });
  await t.test("an additional ordinary-header byte still receives 431", async () => {
    const headers = [...fields];
    headers[5] = "é".repeat(16 * 1024 - baseBytes + 1);
    const result = await get(port, "/start", headers);
    assert.equal(result.status, 431);
    assert.equal(result.body, "headers_too_large");
  });
  await t.test("1,000 short headers do not borrow the target budget", async () => {
    const headers = ["Host", "127.0.0.1", "Connection", "close"];
    for (let index = 0; index < 998; index++) headers.push("a", "b");
    assert.equal((await get(port, "/start", headers)).status, 200);
  });
  await t.test("one overflow header is detected instead of truncated away", async () => {
    const headers = ["Host", "127.0.0.1", "Connection", "close"];
    for (let index = 0; index < 999; index++) headers.push("a", "b");
    const result = await get(port, "/start", headers);
    assert.equal(result.status, 431);
    assert.equal(result.body, "headers_too_large");
  });
});
