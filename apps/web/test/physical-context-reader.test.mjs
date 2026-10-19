import assert from "node:assert/strict";
import test from "node:test";
import { publicPhysicalContextSchema } from "@pick-your-ai/contracts";
import { board, selection, validateExport } from "../src/remote/client.ts";
import { parseCSVExport } from "../src/remote/csv-export.ts";
import { parseExportJSON } from "../src/remote/export-json.ts";
import { createPhysicalContextHarness, physicalSnapshotId } from "../../../tests/fixtures/physical-context.mjs";

async function documents(t) {
  const h = createPhysicalContextHarness();
  t.after(() => h.app.close());
  const query = `metric=pr_lines_added&snapshot=${physicalSnapshotId}`;
  const responses = await Promise.all([
    h.app.inject(`/api/v1/boards?${query}`),
    h.app.inject(`/api/v1/exports?${query}&format=json`),
    h.app.inject(`/api/v1/exports?${query}&format=csv`),
  ]);
  for (const response of responses) assert.equal(response.statusCode, 200, response.body);
  const result = {
    selected: selection(query),
    board: responses[0].json(),
    json: responses[1].body,
    csv: responses[2].body,
  };
  result.metric = result.board.metric;
  assert.doesNotThrow(() => board(result.board, result.selected));
  validateExport(parseExportJSON(result.json), result.selected, result.metric);
  validateExport(parseCSVExport(result.csv, result.metric, 20), result.selected, result.metric);
  return result;
}

// Rewrite actual quoted service cells; do not reuse the production CSV decoder.
function rewriteCSV(raw, mutate) {
  const rows = [],
    pattern = /"((?:[^"]|"")*)"(,|\r\n)/gy;
  let row = [];
  while (pattern.lastIndex < raw.length) {
    const match = pattern.exec(raw);
    assert.ok(match);
    row.push(match[1].replaceAll('""', '"'));
    if (match[2] === "\r\n") {
      rows.push(row);
      row = [];
    }
  }
  assert.equal(row.length, 0);
  assert.ok(rows.length >= 3);
  mutate(rows);
  return rows.map((cells) => cells.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",") + "\r\n").join("");
}
function replaceContext(raw, mutate) {
  return rewriteCSV(raw, (rows) => {
    const index = rows[0].indexOf("physical_context");
    assert.ok(index >= 0);
    const context = JSON.parse(rows[2][index]);
    mutate(context);
    rows[2][index] = JSON.stringify(context);
  });
}

for (const [beforeWidth, afterWidth] of [
  [40, 40],
  [64, 64],
  [40, 64],
  [64, 40],
])
  test(`physical ${beforeWidth}/${afterWidth} pins agree in the public schema, board, JSON and CSV`, async (t) => {
    const h = await documents(t);
    const mutate = (context) => {
      const sample = context.samples[0];
      sample.before = "b".repeat(beforeWidth);
      sample.after = "c".repeat(afterWidth);
      const base = sample.sourceUrl.replace(/\/pull\/[1-9]\d*$/, "/commit/");
      sample.beforeUrl = base + sample.before;
      sample.afterUrl = base + sample.after;
    };
    const changedBoard = structuredClone(h.board);
    mutate(changedBoard.rows[0].physicalContext);
    const changedJSON = JSON.parse(h.json);
    mutate(changedJSON.rows[0].physicalContext);
    const readers = [
      () => board(changedBoard, h.selected),
      () => validateExport(parseExportJSON(JSON.stringify(changedJSON)), h.selected, h.metric),
      () => validateExport(parseCSVExport(replaceContext(h.csv, mutate), h.metric, 20), h.selected, h.metric),
    ];
    const admitted = beforeWidth === afterWidth;
    assert.equal(publicPhysicalContextSchema.safeParse(changedBoard.rows[0].physicalContext).success, admitted);
    for (const read of readers)
      if (admitted) assert.doesNotThrow(read);
      else assert.throws(read, /invalid_physical_context/);
    assert.deepEqual(changedBoard.rows[0].value, h.board.rows[0].value);
    assert.deepEqual(changedBoard.rows[0].physicalContext.summary, h.board.rows[0].physicalContext.summary);
  });

const substitutions = [
  [
    "snapshot",
    (context) => {
      context.snapshotId = "another-synthetic-snapshot";
    },
  ],
  [
    "actor",
    (context) => {
      context.actorId = "202";
    },
  ],
  [
    "metric",
    (context) => {
      context.metricId = "pr_lines_removed";
    },
  ],
  [
    "policy",
    (context) => {
      context.policySignature = "a".repeat(64);
    },
  ],
  [
    "selected evidence",
    (context) => {
      context.samples[0].evidenceIds[0] = `gh:${"a".repeat(64)}`;
    },
  ],
  [
    "before URL",
    (context) => {
      context.samples[0].beforeUrl += "?latest=true";
    },
  ],
  [
    "same before/after revision",
    (context) => {
      context.samples[0].after = context.samples[0].before;
      context.samples[0].afterUrl = context.samples[0].beforeUrl;
    },
  ],
  [
    "future integration",
    (context) => {
      context.samples[0].integratedAt = "2026-10-20T00:00:00.000Z";
    },
  ],
  [
    "duplicate sample",
    (context) => {
      context.samples.push(structuredClone(context.samples[0]));
      context.sampleCount++;
      context.unitCount++;
    },
  ],
  [
    "unknown with retained counts",
    (context) => {
      context.state = "unknown";
      context.reason = "current_context_unavailable";
    },
  ],
  [
    "extra private provenance",
    (context) => {
      context.canonicalIntegrationId = "synthetic-private-unit";
    },
  ],
  [
    "coherent quantity substitution",
    (context) => {
      for (const bucket of ["raw", "eligible"]) {
        context.summary[bucket].additions++;
        context.summary.classes.source[bucket].additions++;
      }
      assert.equal(publicPhysicalContextSchema.safeParse(context).success, true);
    },
  ],
];
for (const [name, mutate] of substitutions)
  test(`${name} cannot replace a row's physical context in board, serialized JSON or CSV`, async (t) => {
    const h = await documents(t);
    const changedBoard = structuredClone(h.board);
    mutate(changedBoard.rows[0].physicalContext);
    assert.throws(() => board(changedBoard, h.selected), /invalid_physical_context/);
    const changedJSON = JSON.parse(h.json);
    mutate(changedJSON.rows[0].physicalContext);
    assert.throws(
      () => validateExport(parseExportJSON(JSON.stringify(changedJSON)), h.selected, h.metric),
      /invalid_physical_context/,
    );
    assert.throws(
      () => validateExport(parseCSVExport(replaceContext(h.csv, mutate), h.metric, 20), h.selected, h.metric),
      /invalid_physical_context/,
    );
  });

test("serialized export context remains bound to its actual minimized source proof", async (t) => {
  const h = await documents(t);
  for (const change of [
    (proof) => {
      proof.repositoryId = "999";
    },
    (proof) => {
      proof.sourceUrl = proof.sourceUrl.replace(/\/pull\/\d+$/, "/pull/999");
    },
    (proof) => {
      proof.occurredAt = "2026-10-07T12:00:00.000Z";
    },
  ]) {
    const data = JSON.parse(h.json);
    change(data.evidence[0]);
    assert.throws(
      () => validateExport(parseExportJSON(JSON.stringify(data)), h.selected, h.metric),
      /invalid_physical_context/,
    );
    const csv = rewriteCSV(h.csv, (rows) => {
      const column = rows[0].indexOf("evidence"),
        evidence = JSON.parse(rows[2][column]);
      change(evidence[0]);
      rows[2][column] = JSON.stringify(evidence);
    });
    assert.throws(
      () => validateExport(parseCSVExport(csv, h.metric, 20), h.selected, h.metric),
      /invalid_physical_context/,
    );
  }
});

test("duplicate physical JSON keys and unexpected CSV columns are rejected before download acceptance", async (t) => {
  const h = await documents(t);
  const original = JSON.stringify(JSON.parse(h.json).rows[0].physicalContext);
  const duplicate = original.slice(0, -1) + ',"state":"available"}';
  assert.equal(h.json.split(original).length, 2);
  assert.throws(() => parseExportJSON(h.json.replace(original, duplicate)));
  const csv = rewriteCSV(h.csv, (rows) => {
    const column = rows[0].indexOf("physical_context");
    rows[2][column] = duplicate;
  });
  assert.throws(() => parseCSVExport(csv, h.metric, 20));
  assert.throws(() =>
    parseCSVExport(
      rewriteCSV(h.csv, (rows) => {
        rows[0].push("private_context");
        for (const row of rows.slice(1)) row.push("");
      }),
      h.metric,
      20,
    ),
  );
});

test("v4 explicit null stays unavailable and cannot silently remove its versioned context column", async (t) => {
  const h = await documents(t),
    data = JSON.parse(h.json);
  data.rows[0].physicalContext = null;
  validateExport(parseExportJSON(JSON.stringify(data)), h.selected, h.metric);
  const csv = rewriteCSV(h.csv, (rows) => {
    rows[2][rows[0].indexOf("physical_context")] = "null";
  });
  validateExport(parseCSVExport(csv, h.metric, 20), h.selected, h.metric);
  delete data.rows[0].physicalContext;
  assert.throws(
    () => validateExport(parseExportJSON(JSON.stringify(data)), h.selected, h.metric),
    /invalid_export_response/,
  );
  assert.throws(() =>
    parseCSVExport(
      rewriteCSV(h.csv, (rows) => {
        const index = rows[0].indexOf("physical_context");
        for (const row of rows) row.splice(index, 1);
      }),
      h.metric,
      20,
    ),
  );
});
