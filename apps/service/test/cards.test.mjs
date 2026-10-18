import test from "node:test";
import assert from "node:assert/strict";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import { createService } from "../dist/app.js";
import { readFixture, at } from "../../../tests/fixtures/pending-metric.mjs";

// Reuse the accepted synthetic publication fixture. Alternative metric values below
// are explicit serializer inputs, not computed measurements or contributor evidence.
function fixture(metricId = "pr_merged") {
  const value = readFixture();
  for (const row of value.selected.rows) row.result.metricId = metricId;
  for (const entry of [...value.selected.evidence, ...value.selected.pendingEvidence])
    entry.contribution.metricIds = [metricId];
  for (const entry of value.selected.diagnostics) entry.metricId = metricId;
  for (const entry of value.selected.methodology) entry.metricId = metricId;
  value.selected.ranking = [{ metricId, direction: "descending", rank: false }];
  return value;
}
function harness(t, value = fixture()) {
  const app = createService({
    now: () => Date.parse(at),
    source: { read: async () => structuredClone(value) },
  });
  t.after(() => app.close());
  return { app, value };
}
const subject = (value) => value.selected.rows.find((row) => row.actorId === "101");
function url(metric, image = false) {
  return "/api/v1/cards/101" + (image ? "/image" : "") + "?metric=" + metric + "&snapshot=synthetic-pending-1";
}
function field(body, label, value, image) {
  const expected = image ? label + ": " + value : "<dt>" + label + "</dt><dd>" + value + "</dd>";
  assert.ok(body.includes(expected), "Missing exact card context: " + expected);
}

test("HTML and SVG cards retain the exact count, duration and proportion definition without unit conversion", async (t) => {
  for (const [metricId, amount] of [
    ["pr_merged", 14],
    ["review_wait", 1.5],
    ["pr_accepted_rate", 0.625],
  ]) {
    await t.test(metricId, async (t) => {
      const value = fixture(metricId);
      subject(value).result.value = amount;
      const { app } = harness(t, value);
      const metric = metricRegistryV1.metrics.find((entry) => entry.id === metricId);
      for (const image of [false, true]) {
        const response = await app.inject(url(metricId, image));
        assert.equal(response.statusCode, 200, response.body);
        field(response.body, "Unit", metric.definition.unit, image);
        field(response.body, "Aggregation", metric.definition.aggregation, image);
        field(response.body, "Definition event clock", metric.definition.event_clock, image);
        assert.ok(response.body.includes(String(amount) + " (partial)"));
        assert.equal(response.headers["cache-control"], "no-store");
        if (metricId === "pr_accepted_rate") assert.ok(!response.body.includes("62.5%"));
      }
    });
  }
});

test("card diagnostics bind to the exact actor and metric and preserve supplied zeros and nulls", async (t) => {
  const value = fixture("review_wait");
  subject(value).result.value = 1.5;
  value.selected.rows.push({
    actorId: "101",
    result: { ...subject(value).result, metricId: "pr_merged", value: 0 },
    evidenceIds: [],
  });
  value.selected.ranking.push({ metricId: "pr_merged", direction: "descending", rank: false });
  value.selected.diagnostics = [
    {
      metricId: "pr_merged",
      actorId: "101",
      numerator: 9876,
      denominator: 9876,
      sampleCount: 9876,
      censored: 9876,
      missingReadiness: 9876,
      p75: 9876,
    },
    {
      metricId: "review_wait",
      actorId: "102",
      numerator: 8765,
      denominator: 8765,
      sampleCount: 8765,
      censored: 8765,
      missingReadiness: 8765,
      p75: 8765,
    },
    {
      metricId: "review_wait",
      actorId: "101",
      numerator: 0,
      denominator: null,
      sampleCount: 14,
      censored: 7,
      missingReadiness: 0,
      p75: 3.75,
    },
  ];
  const { app } = harness(t, value);
  for (const image of [false, true]) {
    const response = await app.inject(url("review_wait", image));
    assert.equal(response.statusCode, 200, response.body);
    for (const [label, expected] of [
      ["Numerator", "0"],
      ["Denominator", "unknown"],
      ["Samples", "14"],
      ["Censored", "7"],
      ["Missing readiness", "0"],
      ["p75", "3.75"],
    ])
      field(response.body, label, expected, image);
    assert.doesNotMatch(response.body, /9876|8765/);
  }
});

test("missing card diagnostics and pending metadata remain unknown rather than inferred from the value or evidence", async (t) => {
  const value = fixture();
  delete value.selected.diagnostics;
  delete subject(value).pending;
  const { app } = harness(t, value);
  for (const image of [false, true]) {
    const response = await app.inject(url("pr_merged", image));
    assert.equal(response.statusCode, 200, response.body);
    for (const label of ["Numerator", "Denominator", "Samples", "Censored", "Missing readiness", "p75"])
      field(response.body, label, "unknown", image);
    field(response.body, "Pending", "unknown (unknown)", image);
    field(response.body, "Value class", "unknown", image);
  }
});

test("cards preserve partial pending context and current suppression makes it unknown before cached historic reads", async (t) => {
  const { app, value } = harness(t);
  for (const image of [false, true]) {
    const response = await app.inject(url("pr_merged", image));
    assert.equal(response.statusCode, 200, response.body);
    field(response.body, "Pending", "3 (partial)", image);
    field(response.body, "Value class", "qualified", image);
    value.controls.suppressedArtifactIds = [value.selected.pendingEvidence[0].artifact.stableId];
    const changed = await app.inject({
      url: url("pr_merged", image),
      headers: { "if-none-match": response.headers.etag },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    field(changed.body, "Pending", "unknown (unknown)", image);
    field(changed.body, "Value class", "qualified", image);
    value.controls.suppressedArtifactIds = [];
  }
  value.controls.suppressedActorIds = ["101"];
  for (const image of [false, true]) {
    const response = await app.inject(url("pr_merged", image));
    assert.equal(response.statusCode, 404);
    assert.doesNotMatch(response.body, /synthetic-pending-101|Samples|Numerator|Value class/);
  }
});

test("unknown card values stay unavailable while an explicit measured zero and zero samples remain zero", async (t) => {
  const value = fixture("review_wait");
  subject(value).result.state = "unavailable";
  delete subject(value).result.value;
  Object.assign(
    value.selected.diagnostics.find((entry) => entry.actorId === "101"),
    {
      numerator: null,
      denominator: null,
      sampleCount: 0,
      censored: 3,
      missingReadiness: 2,
      p75: null,
    },
  );
  const { app } = harness(t, value);
  for (const image of [false, true]) {
    const response = await app.inject(url("review_wait", image));
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(response.body.includes("unavailable"));
    field(response.body, "Samples", "0", image);
    field(response.body, "p75", "unknown", image);
  }
  subject(value).result.state = "measured";
  subject(value).result.value = 0;
  subject(value).result.coverage = {
    ...subject(value).result.coverage,
    state: "complete",
    windowStart: "2026-10-01T00:00:00.000Z",
    windowEnd: "2026-11-01T00:00:00.000Z",
  };
  for (const image of [false, true]) {
    const response = await app.inject(url("review_wait", image));
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(response.body.includes("0 (measured)"));
    field(response.body, "Samples", "0", image);
  }
});

test("card source counts describe distinct public links without collapsing review evidence", async (t) => {
  for (const sourceCount of [1, 2, 3]) {
    await t.test(`${sourceCount} distinct sources`, async (t) => {
      const value = fixture("review_rounds");
      const entries = value.selected.evidence.filter((entry) => entry.contribution.actorId === "101");
      const artifacts = entries.slice(0, sourceCount).map((entry) => structuredClone(entry.artifact));
      for (const [index, entry] of entries.entries()) {
        entry.artifact = structuredClone(artifacts[index % sourceCount]);
        entry.contribution.artifactId = entry.artifact.stableId;
        entry.contribution.roles = ["reviewer"];
      }
      const original = structuredClone(value);
      const { app } = harness(t, value);
      const html = await app.inject(url("review_rounds"));
      const image = await app.inject(url("review_rounds", true));
      assert.equal(html.statusCode, 200, html.body);
      assert.equal(image.statusCode, 200, image.body);
      const sourceList = html.body.split("<h2>Public sources</h2>")[1];
      assert.equal((sourceList.match(/<li>/g) ?? []).length, sourceCount);
      for (const artifact of artifacts) assert.ok(sourceList.includes(artifact.publicUrl));
      const expected =
        `Source: ${artifacts[0].publicUrl}` + (sourceCount > 1 ? ` (+${sourceCount - 1} more in portfolio)` : "");
      assert.ok(image.body.includes(`${expected}</text>`), image.body);
      assert.ok(image.body.split("</desc>")[0].includes(expected), "accessible source count agrees with visible text");
      if (sourceCount === 1) assert.doesNotMatch(image.body, /more in portfolio/);
      for (const response of [html, image]) {
        assert.ok(response.body.includes("14 (partial)"));
        assert.equal(response.headers["cache-control"], "no-store");
      }
      const profile = await app.inject("/api/v1/contributors/101?metric=review_rounds&snapshot=synthetic-pending-1");
      assert.equal(profile.statusCode, 200, profile.body);
      assert.equal(profile.json().results[0].value, 14);
      assert.equal(profile.json().evidenceCount, 14);
      assert.equal(new Set(profile.json().evidenceIds).size, 14);
      assert.deepEqual(value, original, "source presentation must not rewrite stored evidence or counts");
      value.controls.suppressedArtifactIds = [artifacts[0].stableId];
      for (const image of [false, true]) {
        const suppressed = await app.inject(url("review_rounds", image));
        assert.equal(suppressed.statusCode, 404);
        assert.doesNotMatch(suppressed.body, /synthetic-repo|Source:|Public sources/);
      }
    });
  }
});
