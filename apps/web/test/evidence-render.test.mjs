import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { evidence, selection } from "../src/remote/client.ts";

// Exercise the real shared TSX renderer without a browser or a copied test renderer.
const source = new URL("../src/remote/Evidence.tsx", import.meta.url);
const transformed = await transformWithOxc(await readFile(source, "utf8"), fileURLToPath(source), {
  jsx: { runtime: "classic" },
});
const compiled = transformed.code.replace(/from "([^"]+)"/g, (_match, specifier) => {
  const url = specifier.startsWith(".") ? new URL(specifier, source) : import.meta.resolve(specifier);
  return `from ${JSON.stringify(typeof url === "string" ? url : url.href)}`;
});
const { Receipt } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const sourceAt = "2026-10-01T00:00:00.000Z",
  collectedAt = "2026-10-03T00:00:00.000Z",
  acceptedAt = "2026-10-02T00:00:00.000Z";
const base = {
  artifact: {
    schemaVersion: "leaderboard/v1",
    source: "github",
    kind: "issue",
    stableId: "i1",
    repositoryId: "r1",
    visibility: "public",
    publicUrl: "https://github.com/synthetic/example/issues/1",
  },
  contribution: {
    schemaVersion: "leaderboard/v1",
    contributionId: "e1",
    canonicalEventId: "event1",
    artifactId: "i1",
    actorId: "a1",
    roles: ["reporter"],
    qualification: "eligible",
    metricIds: ["issues_opened"],
    reasonCodes: ["public_observed_work"],
  },
  occurredAt: sourceAt,
  sourceRevision: null,
  sourceRevisionUrl: null,
};
const metadata = {
  schemaVersion: "leaderboard-evidence/v1",
  artifactTitle: { value: '<img src=x onerror="alert(1)"> title', basis: "as_collected", collectedAt },
  sourceAction: "artifact_created",
  sourceOccurredAt: sourceAt,
  observedAt: collectedAt,
  activityState: "observed",
  acceptedAt: null,
  history: {
    coverage: "partial",
    records: [
      {
        kind: "correction",
        occurredAt: null,
        publicUrl: "https://github.com/synthetic/example/issues/1#issuecomment-2",
      },
    ],
  },
};
function render(value) {
  return renderToStaticMarkup(
    React.createElement(Receipt, { value: evidence(value), selected: selection("?snapshot=s1") }),
  );
}

test("shared public Receipt escapes collected labels and distinguishes occurrence, collection, acceptance and partial history", () => {
  const html = render({ ...base, evidenceMetadata: metadata });
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; title/);
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /not an event-time title/);
  assert.match(html, /artifact created/);
  assert.match(html, /No acceptance time is supplied for observed or in-progress work/);
  assert.match(html, /Partial public history only/);
  assert.match(html, /missing records do not establish/);
  assert.match(html, /Public correction/);
  assert.match(html, /Unknown record time/);
  const accepted = render({
    ...base,
    evidenceMetadata: { ...metadata, sourceAction: "recognition_accepted", activityState: "accepted", acceptedAt },
  });
  assert.match(accepted, /recognition accepted/);
  assert.ok(accepted.toLowerCase().includes(`datetime="${acceptedAt.toLowerCase()}"`));
  assert.ok(accepted.toLowerCase().includes(`datetime="${sourceAt.toLowerCase()}"`));
  assert.ok(accepted.toLowerCase().includes(`datetime="${collectedAt.toLowerCase()}"`));
  assert.match(accepted, /Independent recognition receipt/);
});

test("legacy shared Receipt keeps unavailable title, action, clocks and history explicitly unknown", () => {
  const html = render(base);
  assert.match(html, /Not supplied by the public evidence API/);
  assert.match(html, /Action details are not supplied/);
  assert.match(html, /Unknown collection time/);
  assert.match(html, /Unknown; neither acceptance nor its time can be inferred/);
  assert.match(html, /does not establish a complete history/);
});

test("shared Receipt renders measure membership canonically without changing source arrays", () => {
  const metricIds = ["pr_opened", "documentation"];
  const forward = render({ ...base, contribution: { ...base.contribution, metricIds } });
  const reverse = render({ ...base, contribution: { ...base.contribution, metricIds: [...metricIds].reverse() } });
  assert.equal(forward, reverse);
  assert.deepEqual(metricIds, ["pr_opened", "documentation"]);
  assert.ok(forward.indexOf(">documentation</a>") < forward.indexOf(">pr_opened</a>"));
});

test("shared Receipt explains reviewed maintenance facets without schema codes or extra count", () => {
  const value = {
    ...base,
    activityState: "accepted",
    contribution: {
      ...base.contribution,
      metricIds: ["maintenance"],
      reasonCodes: [
        "independent_recognition_receipt",
        "maintenance_classification_policy:maintenance-classification/v1",
        "maintenance_kind:dependency_maintenance",
        "maintenance_kind:build_fix",
        "maintenance_kind:accepted_bug_fix",
      ],
    },
  };
  const html = render(value);
  for (const label of [
    "Dependency maintenance",
    "Build fix",
    "Accepted bug fix",
    "do not add counted units",
    "Omitted kinds remain unknown",
  ])
    assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /maintenance_kind:|maintenance_classification_policy:|maintenance-classification\/v1/);
  const generic = render({
    ...value,
    contribution: { ...value.contribution, reasonCodes: ["independent_recognition_receipt"] },
  });
  assert.match(generic, /Not established; omitted kinds remain unknown/);
  const invalid = render({
    ...value,
    contribution: {
      ...value.contribution,
      reasonCodes: [...value.contribution.reasonCodes, "maintenance_kind:green_workflow"],
    },
  });
  assert.match(invalid, /Classification unavailable: inconsistent public proof/);
  assert.doesNotMatch(invalid, /Dependency maintenance|Build fix|Accepted bug fix/);
});
