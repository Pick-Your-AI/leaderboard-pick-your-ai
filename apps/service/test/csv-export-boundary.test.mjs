import assert from "node:assert/strict";
import test from "node:test";
import { metricRegistryV1 } from "../../../packages/metrics/dist/index.js";
import { readFixture } from "../../../tests/fixtures/pending-metric.mjs";
import { exportPage, ReadFailure, selection } from "../../web/src/remote/client.ts";
import { createService } from "../dist/app.js";

// Mutation helper for already valid, fully quoted service output. The downloader
// must reject altered wire data, independently of the provider-side projection.
function cells(raw) {
  const records = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (character === '"') {
      if (quoted && raw[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (!quoted && character === ",") {
      row.push(cell);
      cell = "";
    } else if (!quoted && character === "\r" && raw[index + 1] === "\n") {
      row.push(cell);
      records.push(row);
      row = [];
      cell = "";
      index++;
    } else cell += character;
  }
  assert.equal(quoted, false);
  assert.deepEqual(row, []);
  assert.equal(cell, "");
  return records;
}
const encode = (records) =>
  records.map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",") + "\r\n").join("");
function altered(raw, change) {
  const records = cells(raw);
  const column = (name) => {
    const index = records[0].indexOf(name);
    assert.ok(index >= 0, name);
    return index;
  };
  change(records, column);
  return encode(records);
}
const invalid = (error) =>
  error instanceof ReadFailure && error.status === 502 && error.code === "invalid_export_response";
async function harness(t, { metricId = "pr_merged", limit = "50", change = () => {} } = {}) {
  const input = readFixture();
  if (metricId !== "pr_merged") {
    for (const row of input.selected.rows) {
      row.result.metricId = metricId;
      row.result.value = 0.5;
    }
    for (const entry of [...input.selected.evidence, ...input.selected.pendingEvidence])
      entry.contribution.metricIds = [metricId];
    for (const entry of [...input.selected.methodology, ...input.selected.diagnostics]) entry.metricId = metricId;
    input.selected.ranking = [{ metricId, direction: "descending", rank: false }];
  }
  change(input);
  const app = createService({ source: { read: async () => structuredClone(input) } });
  t.after(() => app.close());
  const selected = selection(`?metric=${metricId}&snapshot=${input.selected.snapshot.snapshotId}&limit=${limit}`);
  const expected = metricRegistryV1.metrics.find((metric) => metric.id === metricId);
  const response = await app.inject(
    `/api/v1/exports?metric=${metricId}&snapshot=${selected.snapshot}&limit=${limit}&format=csv`,
  );
  assert.equal(response.statusCode, 200, response.body);
  const json = await app.inject(
    `/api/v1/exports?metric=${metricId}&snapshot=${selected.snapshot}&limit=${limit}&format=json`,
  );
  assert.equal(json.statusCode, 200, json.body);
  let wire = response.body;
  let format = "csv";
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(wire, {
        headers: { "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json" },
      }),
  );
  return {
    original: response.body,
    json: json.body,
    reply: (value, nextFormat = "csv") => {
      wire = value;
      format = nextFormat;
    },
    download: (selectionOverride = selected, definitionOverride = expected, nextFormat = "csv") =>
      exportPage("/api/v1", selectionOverride, nextFormat, new AbortController().signal, definitionOverride),
    selected,
    expected,
  };
}

test("real CSV downloads preserve ranked values, pending evidence and diagnostic samples", async (t) => {
  const h = await harness(t, { limit: "1" });
  assert.equal(await (await h.download()).text(), h.original);
  const [header, metadata, row] = cells(h.original);
  const at = (record, name) => record[header.indexOf(name)];
  assert.equal(at(metadata, "page_rows"), "1");
  assert.equal(at(metadata, "total_rows"), "2");
  assert.notEqual(at(metadata, "next_cursor"), "");
  assert.equal(at(row, "rank"), "1");
  assert.notEqual(at(row, "sample_count"), "");
  assert.equal(JSON.parse(at(row, "evidence")).length, 15);
});

for (const metricId of ["active_periods", "pr_accepted_rate", "review_wait"]) {
  test(`CSV ${metricId} stays descriptive for all ranking descriptor shapes`, async (t) => {
    const h = await harness(t, { metricId });
    assert.equal(await (await h.download()).text(), h.original);
    for (const rank of [true, "omitted", null]) {
      h.reply(
        altered(h.original, (records, col) => {
          for (const row of records.slice(1)) {
            const ranking = JSON.parse(row[col("ranking")]);
            if (rank === true) ranking.rank = true;
            else if (rank === "omitted") delete ranking.rank;
            row[col("ranking")] = JSON.stringify(rank === null ? null : ranking);
          }
          records[2][col("rank")] = "1";
        }),
      );
      await assert.rejects(h.download, invalid, String(rank));
    }
  });
}

test("CSV metric definitions bind to the loaded registry even with unranked rows", async (t) => {
  const h = await harness(t, { metricId: "active_periods" });
  for (const ranked of [true, false]) {
    h.reply(
      altered(h.original, (records, col) => {
        for (const row of records.slice(1)) {
          const metric = JSON.parse(row[col("metric_definition")]);
          metric.definition.aggregation = "count";
          metric.definition.release_eligibility = "automatic-baseline";
          row[col("metric_definition")] = JSON.stringify(metric);
          const ranking = JSON.parse(row[col("ranking")]);
          ranking.rank = ranked;
          row[col("ranking")] = JSON.stringify(ranking);
        }
        if (ranked) records[2][col("rank")] = "1";
      }),
    );
    await assert.rejects(h.download, invalid);
  }
  for (const column of ["definition", "unit"]) {
    h.reply(
      altered(h.original, (records, col) => {
        for (const row of records.slice(1)) row[col(column)] = "substituted";
      }),
    );
    await assert.rejects(h.download, invalid, column);
  }
});

test("CSV metadata and every row retain the displayed scope, snapshot, counts and actor lens", async (t) => {
  const h = await harness(t);
  for (const [column, value] of [
    ["snapshot", "another-snapshot"],
    ["organization", "another-org"],
    ["repository", "another-repo"],
    ["workstream", "another-workstream"],
    ["start", "2026-01-01T00:00:00.000Z"],
    ["metric", "active_periods"],
    ["actor_filter", "user"],
    ["page_rows", "0"],
    ["total_rows", "0"],
  ]) {
    h.reply(
      altered(h.original, (records, col) => {
        for (const row of records.slice(1)) row[col(column)] = value;
      }),
    );
    await assert.rejects(h.download, invalid, column);
  }
  for (const column of ["policy", "metric_definition", "coverage", "ranking", "next_cursor", "generated_at"]) {
    h.reply(
      altered(h.original, (records, col) => {
        records[2][col(column)] = "substituted";
      }),
    );
    await assert.rejects(h.download, invalid, `row ${column}`);
  }
});

test("CSV source proofs and pending records cannot gain unsafe or contradictory bindings", async (t) => {
  const h = await harness(t);
  const changes = [
    (records, col) => {
      const evidence = JSON.parse(records[2][col("evidence")]);
      evidence[0].sourceUrl = "javascript:alert(1)";
      records[2][col("evidence")] = JSON.stringify(evidence);
    },
    (records, col) => {
      const first = JSON.parse(records[2][col("evidence")]);
      const duplicate = { ...first[0], sourceUrl: "https://github.com/synthetic/wrong/pull/1" };
      records[3][col("evidence")] = JSON.stringify([duplicate]);
    },
    (records, col) => {
      records[3][col("pending_evidence")] = "[]";
    },
    (records, col) => {
      records[3][col("pending")] = "";
    },
    (records, col) => {
      records[2][col("actor_kind")] = "manual";
    },
    (records, col) => {
      records[2][col("execution_mode")] = "manual";
    },
    (records, col) => {
      records[3][col("actor_id")] = records[2][col("actor_id")];
    },
  ];
  for (const change of changes) {
    h.reply(altered(h.original, change));
    await assert.rejects(h.download, invalid);
  }
});

test("CSV grammar, bounded records and formula guards fail before a download is offered", async (t) => {
  const h = await harness(t, { limit: "1" });
  const [header, metadata, row] = cells(h.original);
  const payloads = [
    "metric,value\nsynthetic,1\n",
    h.original.slice(0, -2),
    h.original + "junk",
    h.original.slice(1),
    h.original.replace('"record_type",', '"record_type"oops,'),
    encode([header.slice(1), metadata.slice(1), row.slice(1)]),
    encode([[...header.slice(0, -1), header[0]], metadata, row]),
    encode([header, metadata, metadata, row]),
    encode([header, row, metadata]),
    encode([header, metadata, row, row]),
    altered(h.original, (records, col) => {
      records[1][col("actor_id")] = "hidden-row";
    }),
    altered(h.original, (records, col) => {
      records[2][col("actor")] = '=HYPERLINK("https://synthetic.invalid")';
    }),
    altered(h.original, (records, col) => {
      records[2][col("actor")] = "x\u0000hidden";
    }),
    altered(h.original, (records, col) => {
      records[2][col("actor")] = "x".repeat(256 * 1024 + 1);
    }),
    altered(h.original, (records, col) => {
      records[2][col("evidence")] = JSON.stringify(Array(2001).fill({}));
    }),
  ];
  for (const payload of payloads) {
    h.reply(payload);
    await assert.rejects(h.download, invalid);
  }
});

test("CSV unknown and empty results preserve absence while malformed numbers fail closed", async (t) => {
  const h = await harness(t, {
    change: (input) => {
      input.selected.rows[0].result.state = "unknown";
      delete input.selected.rows[0].result.value;
    },
  });
  assert.equal(await (await h.download()).text(), h.original);
  for (const [column, value] of [
    ["revision", ""],
    ["total_rows", "02"],
    ["page_rows", "NaN"],
    ["rank", "true"],
    ["value", "Infinity"],
    ["sample_count", ""],
    ["censored", "0.5"],
  ]) {
    h.reply(
      altered(h.original, (records, col) => {
        const targets = ["revision", "total_rows", "page_rows"].includes(column) ? records.slice(1) : [records[2]];
        for (const row of targets) row[col(column)] = value;
      }),
    );
    await assert.rejects(h.download, invalid, column);
  }
});

test("empty CSV pages retain valid provenance without inventing metric rows", async (t) => {
  const h = await harness(t, {
    change: (input) => {
      input.controls.suppressedActorIds = input.selected.actors.map((actor) => actor.actorId);
    },
  });
  assert.equal(cells(h.original).length, 2);
  assert.equal(await (await h.download()).text(), h.original);
});

test("real CSV retains quoted Unicode, multiline labels and inert formula prefixes byte for byte", async (t) => {
  const h = await harness(t, {
    change: (input) => {
      input.selected.actors[0].actor.login = 'synthetic €,"quoted"\nsecond line';
      input.selected.actors[1].actor.login = "=SUM(1,2)";
    },
  });
  assert.match(h.original, /synthetic €/);
  assert.match(h.original, /'=SUM\(1,2\)/);
  assert.equal(await (await h.download()).text(), h.original);
});

test("CSV JSON cells reject duplicate keys, escaped aliases and ignored private fields", async (t) => {
  const h = await harness(t);
  for (const duplicate of ["sourceUrl", "source\\u0055rl"]) {
    h.reply(
      altered(h.original, (records, col) => {
        records[2][col("evidence")] = records[2][col("evidence")].replace(
          '"sourceUrl":',
          `"${duplicate}":"http://127.0.0.1/PRIVATE_SYNTHETIC","sourceUrl":`,
        );
      }),
    );
    await assert.rejects(h.download, invalid);
  }
  for (const column of ["evidence", "pending_evidence", "ranking", "methodology"]) {
    h.reply(
      altered(h.original, (records, col) => {
        const row = column === "pending_evidence" ? records[3] : records[2];
        const parsed = JSON.parse(row[col(column)]);
        (Array.isArray(parsed) ? parsed[0] : parsed).rawContent = "PRIVATE_SYNTHETIC_RAW";
        row[col(column)] = JSON.stringify(parsed);
        // Metadata must still agree in order to exercise the shared field check.
        if (["ranking", "methodology"].includes(column))
          for (const other of records.slice(1)) other[col(column)] = row[col(column)];
      }),
    );
    await assert.rejects(h.download, invalid, column);
  }
});

test("original JSON downloads cannot retain duplicate or unknown unprojected content", async (t) => {
  const h = await harness(t);
  const download = () => h.download(h.selected, h.expected, "json");
  h.reply(h.json, "json");
  assert.equal(await (await download()).text(), h.json);
  for (const value of [
    h.json.replace('"sourceUrl":', '"sourceUrl":"http://127.0.0.1/PRIVATE_SYNTHETIC","sourceUrl":'),
    h.json.replace('"sourceUrl":', '"source\\u0055rl":"http://127.0.0.1/PRIVATE_SYNTHETIC","sourceUrl":'),
    h.json.replace('"ranking":', '"ranking":{"rank":true},"ranking":'),
  ]) {
    h.reply(value, "json");
    await assert.rejects(download, invalid);
  }
  for (const target of [
    (doc) => doc,
    (doc) => doc.scope,
    (doc) => doc.ranking,
    (doc) => doc.rows[0],
    (doc) => doc.evidence[0],
    (doc) => doc.pendingEvidence[0],
    (doc) => doc.diagnostics[0],
    (doc) => doc.methodology[0],
  ]) {
    const document = JSON.parse(h.json);
    target(document).rawContent = "PRIVATE_SYNTHETIC_RAW";
    h.reply(JSON.stringify(document), "json");
    await assert.rejects(download, invalid);
  }
});

test("regular and pending proof tables require the same metadata for a shared evidence identity", async (t) => {
  const h = await harness(t);
  const consistent = altered(h.original, (records, col) => {
    const proof = JSON.parse(records[2][col("evidence")])[0];
    const pendingProofs = JSON.parse(records[3][col("pending_evidence")]);
    pendingProofs[0] = proof;
    records[3][col("pending_evidence")] = JSON.stringify(pendingProofs);
    const pending = JSON.parse(records[3][col("pending")]);
    pending.evidenceIds[0] = proof.evidenceId;
    records[3][col("pending")] = JSON.stringify(pending);
  });
  h.reply(consistent);
  assert.equal(await (await h.download()).text(), consistent);
  h.reply(
    altered(consistent, (records, col) => {
      const pendingProofs = JSON.parse(records[3][col("pending_evidence")]);
      pendingProofs[0].sourceUrl = "https://github.com/synthetic/another-proof/pull/1";
      records[3][col("pending_evidence")] = JSON.stringify(pendingProofs);
    }),
  );
  await assert.rejects(h.download, invalid);
});

test("both export formats reject negative diagnostic observations and foreign ranking identities", async (t) => {
  const h = await harness(t);
  for (const column of ["numerator", "denominator", "p75"]) {
    h.reply(
      altered(h.original, (records, col) => {
        records[2][col(column)] = "'-1";
      }),
    );
    await assert.rejects(h.download, invalid, column);
    const document = JSON.parse(h.json);
    document.diagnostics[0][column] = -1;
    h.reply(JSON.stringify(document), "json");
    await assert.rejects(() => h.download(h.selected, h.expected, "json"), invalid, column);
  }
  h.reply(
    altered(h.original, (records, col) => {
      for (const row of records.slice(1)) {
        const ranking = JSON.parse(row[col("ranking")]);
        ranking.metricId = "active_periods";
        row[col("ranking")] = JSON.stringify(ranking);
      }
    }),
  );
  await assert.rejects(h.download, invalid);
});

test("JSON diagnostics retain one row-bound pending observation per public actor", async (t) => {
  const h = await harness(t);
  const download = () => h.download(h.selected, h.expected, "json");
  const missingLegacy = JSON.parse(h.json);
  for (const diagnostic of missingLegacy.diagnostics) delete diagnostic.pending;
  h.reply(JSON.stringify(missingLegacy), "json");
  assert.equal(await (await download()).text(), JSON.stringify(missingLegacy));
  for (const change of [
    (document) => {
      document.diagnostics[0].pending = {
        schemaVersion: "leaderboard-pending/v1",
        state: "partial",
        valueClass: "qualified",
        count: 1,
        evidenceIds: ["PRIVATE_UNEXPORTED_SYNTHETIC_ID"],
      };
    },
    (document) => {
      document.diagnostics[0].pending = structuredClone(document.rows.find((row) => row.pending.count > 0).pending);
    },
    (document) => {
      document.diagnostics.push(structuredClone(document.diagnostics[0]));
    },
    (document) => {
      document.diagnostics.push({ ...document.diagnostics[0], numerator: 900 });
    },
  ]) {
    const document = JSON.parse(h.json);
    change(document);
    h.reply(JSON.stringify(document), "json");
    await assert.rejects(download, invalid);
  }
});

test("export ranking directions require literal enum values instead of coercible containers", async (t) => {
  const h = await harness(t);
  for (const direction of [["descending"], { direction: "descending" }, null, false]) {
    h.reply(
      altered(h.original, (records, col) => {
        for (const row of records.slice(1)) {
          const ranking = JSON.parse(row[col("ranking")]);
          ranking.direction = direction;
          row[col("ranking")] = JSON.stringify(ranking);
        }
      }),
    );
    await assert.rejects(h.download, invalid);
    const document = JSON.parse(h.json);
    document.ranking.direction = direction;
    h.reply(JSON.stringify(document), "json");
    await assert.rejects(() => h.download(h.selected, h.expected, "json"), invalid);
  }
});
