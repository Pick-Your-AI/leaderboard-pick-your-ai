import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { activity, activityDetail, selection } from "../src/remote/client.ts";

// Transform the actual shared renderers in memory; no copied component or browser.
async function rendererUrl(source, replacements = new Map()) {
  const transformed = await transformWithOxc(await readFile(source, "utf8"), fileURLToPath(source), {
    jsx: { runtime: "classic" },
  });
  const code = transformed.code.replace(/from "([^"]+)"/g, (_match, specifier) => {
    const target =
      replacements.get(specifier) ??
      (specifier.startsWith(".") ? new URL(specifier, source).href : import.meta.resolve(specifier));
    return `from ${JSON.stringify(target)}`;
  });
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}
const receipt = await rendererUrl(new URL("../src/remote/Evidence.tsx", import.meta.url));
const { ActivityFeed, ActivityProofs } = await import(
  await rendererUrl(new URL("../src/remote/Activity.tsx", import.meta.url), new Map([["./Evidence.tsx", receipt]]))
);
const at = "2026-10-17T12:00:00.000Z";
const selected = selection("?category=pr_opened&snapshot=synthetic-snapshot&limit=1");
const base = {
  schemaVersion: "leaderboard/v1",
  snapshotId: "synthetic-snapshot",
  revision: 1,
  generatedAt: at,
  metricDefinitionVersion: "candidate-0.1.1",
  computationVersion: "synthetic",
  policyVersion: "synthetic-policy",
  head: { snapshotId: "synthetic-snapshot", revision: 1, publishedAt: at },
  scope: { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null },
  coverage: [],
  category: "pr_opened",
  groupingVersion: "actor-repository-state-utc-hour-v1",
  previewLimit: 5,
  correctionHistory: "not_supplied",
  nextCursor: null,
};
function renderers(occurredAt, observedAt) {
  const group = {
    groupId: "a".repeat(64),
    actorId: "synthetic-actor",
    actor: {
      schemaVersion: "leaderboard/v1",
      identityState: "resolved",
      githubNodeId: "synthetic-actor",
      login: "synthetic-actor",
      kind: "user",
      executionMode: "unknown",
    },
    repositoryId: "synthetic-repo",
    activityState: "observed",
    latestOccurredAt: occurredAt,
    earliestOccurredAt: occurredAt,
    firstCollectedAt: observedAt,
    lastCollectedAt: observedAt,
    unknownCollectionCount: observedAt === null ? 1 : 0,
    artifactCount: 1,
    factCount: 1,
    proofCount: 1,
    categoryIds: ["pr_opened"],
    artifactPreview: [
      {
        artifactId: "synthetic-artifact",
        kind: "pull_request",
        publicUrl: "https://github.com/synthetic/example/pull/1",
      },
    ],
  };
  const proof = {
    canonicalFactId: "b".repeat(64),
    activityState: "observed",
    observedAt,
    occurredAt,
    sourceRevision: null,
    sourceRevisionUrl: null,
    artifact: {
      schemaVersion: "leaderboard/v1",
      source: "github",
      stableId: "synthetic-artifact",
      repositoryId: "synthetic-repo",
      kind: "pull_request",
      visibility: "public",
      publicUrl: group.artifactPreview[0].publicUrl,
    },
    contribution: {
      schemaVersion: "leaderboard/v1",
      contributionId: "synthetic-proof",
      canonicalEventId: "synthetic-event",
      artifactId: "synthetic-artifact",
      actorId: "synthetic-actor",
      roles: ["author"],
      qualification: "eligible",
      metricIds: ["pr_opened"],
      reasonCodes: ["synthetic_observed_work"],
    },
  };
  const inputs = [
    { component: ActivityFeed, data: { ...base, groups: [group], totalGroups: 1 }, parse: activity },
    { component: ActivityProofs, data: { ...base, group, proofs: [proof] }, parse: activityDetail },
  ];
  return inputs.map(({ component, data, parse }) => {
    const before = structuredClone(data);
    const html = renderToStaticMarkup(React.createElement(component, { value: parse(data, selected), selected }));
    assert.deepEqual(data, before, "reading and rendering must preserve source timestamps");
    return html;
  });
}

test("activity feed and proofs disclose collection after an action within the same millisecond", () => {
  const occurredAt = "2026-10-17T10:00:00.0001Z";
  for (const observedAt of ["2026-10-17T10:00:00.0009Z", "2026-10-17T06:00:00.0009-04:00"]) {
    for (const html of renderers(occurredAt, observedAt)) {
      assert.match(html, /Collection occurred after the action; this may be a delayed import\./);
      assert.ok(html.includes(`dateTime="${occurredAt}"`));
      assert.ok(html.includes(`dateTime="${observedAt}"`));
    }
  }
});

test("activity feed and proofs do not infer delay for equivalent or earlier collection instants", () => {
  for (const [occurredAt, observedAt] of [
    ["2026-10-17T10:00:00.0001Z", "2026-10-17T06:00:00.000100-04:00"],
    ["2026-10-17T10:00:00.0009Z", "2026-10-17T06:00:00.0001-04:00"],
    ["2026-10-17T10:00:00Z", "2026-10-17T06:00:00.000-04:00"],
  ]) {
    for (const html of renderers(occurredAt, observedAt)) assert.doesNotMatch(html, /may be a delayed import/);
  }
});

test("unknown activity clocks remain unknown without inferred collection delay", () => {
  for (const times of [
    [null, at],
    [at, null],
    [null, null],
  ]) {
    for (const html of renderers(...times)) {
      assert.match(html, /Unknown/);
      assert.doesNotMatch(html, /may be a delayed import/);
    }
  }
});
