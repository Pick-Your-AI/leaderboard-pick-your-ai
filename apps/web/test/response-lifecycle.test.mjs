import { metricRegistryV1 } from "@pick-your-ai/metrics";
import assert from "node:assert/strict";
import test from "node:test";
import { exportPage, ReadFailure, request, selection } from "../src/remote/client.ts";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const read = (signal = new AbortController().signal) =>
  request("/api/v1", "leaderboards", new URLSearchParams(), signal);
const failure = (code) => (error) => error instanceof ReadFailure && error.code === code;
function source(chunks, { stalledCancellation = false } = {}) {
  const state = { reads: 0, cancelled: false };
  const body = new ReadableStream(
    {
      pull(controller) {
        const chunk = chunks[state.reads++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
        if (stalledCancellation) return new Promise(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  return { body, state };
}

for (const length of ["2000001", "invalid", "-1"]) {
  test(`an unsupported advertised length (${length}) discards the response before reading`, async (t) => {
    const { body, state } = source([new TextEncoder().encode("{}")]);
    t.mock.method(
      globalThis,
      "fetch",
      async () => new Response(body, { headers: { ...jsonHeaders, "content-length": length } }),
    );
    await assert.rejects(read, failure("api_response_too_large"));
    assert.equal(state.reads, 0);
    assert.equal(state.cancelled, true);
    assert.equal(body.locked, false);
  });
}

for (const length of [null, "2"]) {
  test(`actual decoded bytes stay bounded with ${length === null ? "no" : "a false"} advertised length`, async (t) => {
    const { body, state } = source([new Uint8Array(2_000_001), new Uint8Array(10)], {
      stalledCancellation: true,
    });
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(body, { headers: length === null ? jsonHeaders : { ...jsonHeaders, "content-length": length } }),
    );
    await assert.rejects(read, failure("api_response_too_large"));
    assert.equal(state.reads, 1);
    assert.equal(state.cancelled, true);
    assert.equal(body.locked, false, "cleanup does not await a stalled underlying cancel hook");
  });
}

test("a valid body exactly at the limit succeeds and releases its reader", async (t) => {
  const { body } = source([new TextEncoder().encode("{}" + " ".repeat(1_999_998))]);
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    return new Response(body, { headers: jsonHeaders });
  });
  assert.deepEqual(await read(), {});
  assert.equal(body.locked, false);
});

test("multibyte UTF-8 split across chunks is preserved exactly", async (t) => {
  const encoded = new TextEncoder().encode('{"label":"€"}');
  const { body } = source([encoded.slice(0, 11), encoded.slice(11, 12), encoded.slice(12)]);
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: jsonHeaders }));
  assert.deepEqual(await read(), { label: "€" });
  assert.equal(body.locked, false);
});

test("malformed UTF-8 cannot silently rewrite returned public evidence", async (t) => {
  const prefix = new TextEncoder().encode('{"label":"');
  const suffix = new TextEncoder().encode('"}');
  const { body } = source([prefix, new Uint8Array([0xc3, 0x28]), suffix]);
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: jsonHeaders }));
  await assert.rejects(read, failure("invalid_api_response"));
  assert.equal(body.locked, false);
});

for (const contentType of [null, "text/html", "text/html; application/json", "application/jsonp"]) {
  test(`a non-JSON media type (${contentType ?? "missing"}) cancels the unread body`, async (t) => {
    const { body, state } = source([new TextEncoder().encode("{}")]);
    t.mock.method(
      globalThis,
      "fetch",
      async () => new Response(body, { headers: contentType === null ? {} : { "content-type": contentType } }),
    );
    await assert.rejects(read, failure("invalid_api_response"));
    assert.equal(state.reads, 0);
    assert.equal(state.cancelled, true);
    assert.equal(body.locked, false);
  });
}

test("a JSON syntax failure releases the completed reader", async (t) => {
  const { body } = source([new TextEncoder().encode("not-json")]);
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: jsonHeaders }));
  await assert.rejects(read, failure("invalid_api_response"));
  assert.equal(body.locked, false);
});

test("an errored stream releases the reader and does not become a successful response", async (t) => {
  const expected = new Error("synthetic transport interrupted");
  const body = new ReadableStream({ pull: (controller) => controller.error(expected) });
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: jsonHeaders }));
  await assert.rejects(read, (error) => error === expected);
  assert.equal(body.locked, false);
});

test("abort after headers cancels a stalled body even when its transport ignores the signal", async (t) => {
  const started = Promise.withResolvers();
  let cancelled = false;
  const body = new ReadableStream(
    {
      pull() {
        started.resolve();
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: jsonHeaders }));
  const controller = new AbortController();
  const pending = read(controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("an aborted selection discards late headers without publishing their response", async (t) => {
  const controller = new AbortController();
  const { body, state } = source([new TextEncoder().encode("{}")]);
  t.mock.method(globalThis, "fetch", async () => {
    controller.abort();
    return new Response(body, { headers: jsonHeaders });
  });
  await assert.rejects(
    () => read(controller.signal),
    (error) => error.name === "AbortError",
  );
  assert.equal(state.reads, 0);
  assert.equal(state.cancelled, true);
});

test("a pre-aborted selection never starts another request", async (t) => {
  const fetcher = t.mock.method(globalThis, "fetch", async () => new Response("{}", { headers: jsonHeaders }));
  await assert.rejects(
    () => read(AbortSignal.abort()),
    (error) => error.name === "AbortError",
  );
  assert.equal(fetcher.mock.callCount(), 0);
});

test("bounded server errors expose only the controlled code and release the reader", async (t) => {
  const { body } = source([new TextEncoder().encode('{"error":"secret internal details"}')]);
  t.mock.method(globalThis, "fetch", async () => new Response(body, { status: 503, headers: jsonHeaders }));
  await assert.rejects(
    read,
    (error) => error instanceof ReadFailure && error.status === 503 && error.code === "http_503",
  );
  assert.equal(body.locked, false);
});

test("a public CSV download preserves UTF-8 and releases the shared reader", async (t) => {
  const csv = "metric,value\nsynthetic,€\n";
  const { body } = source([new TextEncoder().encode(csv)]);
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(body, { headers: { "content-type": "text/csv; charset=utf-8" } }),
  );
  const blob = await exportPage(
    "/api/v1",
    selection("?snapshot=s1"),
    "csv",
    new AbortController().signal,
    metricRegistryV1.metrics.find((metric) => metric.id === "pr_opened"),
  );
  assert.equal(await blob.text(), csv);
  assert.equal(body.locked, false);
});

for (const invalid of ["server", "media_type", "actor_scope"]) {
  test(`an invalid export ${invalid} discards the body before reading`, async (t) => {
    const { body, state } = source([new TextEncoder().encode("private response")]);
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(body, {
          status: invalid === "server" ? 503 : 200,
          headers: {
            "content-type": invalid === "media_type" ? "text/html; text/csv" : "text/csv",
            "x-leaderboard-actor-filter": invalid === "actor_scope" ? "all" : "user",
          },
        }),
    );
    await assert.rejects(
      () =>
        exportPage(
          "/api/v1",
          selection("?snapshot=s1&actors=user"),
          "csv",
          new AbortController().signal,
          metricRegistryV1.metrics.find((metric) => metric.id === "pr_opened"),
        ),
      failure(
        invalid === "server"
          ? "export_http_503"
          : invalid === "media_type"
            ? "invalid_export_response"
            : "api_actor_filter_mismatch",
      ),
    );
    assert.equal(state.reads, 0);
    assert.equal(state.cancelled, true);
    assert.equal(body.locked, false);
  });
}

test("a CSV download rejects corrupt UTF-8 instead of offering changed bytes", async (t) => {
  const { body } = source([new Uint8Array([0x63, 0x2c, 0xc3, 0x28])]);
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "content-type": "text/csv" } }));
  await assert.rejects(
    () =>
      exportPage(
        "/api/v1",
        selection("?snapshot=s1"),
        "csv",
        new AbortController().signal,
        metricRegistryV1.metrics.find((metric) => metric.id === "pr_opened"),
      ),
    failure("invalid_export_response"),
  );
  assert.equal(body.locked, false);
});
