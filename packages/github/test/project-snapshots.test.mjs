import assert from "node:assert/strict";
import test from "node:test";
import { syntheticRepositoryClient } from "./synthetic-client.mjs";
import { readPublicProjectSnapshot, projectSnapshotRevision, createGithubEvidenceNormalizer } from "../dist/index.js";
const repository = { id: 2, slug: "synthetic-owner/repository", allowedProjectIds: ["PVT_synthetic"] };
const item = () => ({
  id: "PVTI_synthetic",
  updatedAt: "2026-10-07T10:00:00Z",
  isArchived: false,
  project: { id: "PVT_synthetic", public: true },
  content: { url: `https://github.com/${repository.slug}/issues/20`, repository: { databaseId: 2, isPrivate: false } },
  fieldValues: {
    nodes: [
      {
        __typename: "ProjectV2ItemFieldSingleSelectValue",
        id: "PVTF_synthetic",
        field: { id: "PVTSSF_synthetic" },
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
});
const options = (client) => ({
  client,
  allowedProjectIds: ["PVT_synthetic"],
  source: "synthetic",
  repository,
  itemId: "PVTI_synthetic",
  scanId: "synthetic-scan",
});

test("Project fields are current-only snapshots and never fabricated editor credit", async () => {
  const client = {
    graphql: async () => ({ node: { project: { id: "PVT_synthetic", public: true } } }),
    scanGraphql: async (scan) => scan.select({ node: item() }).nodes,
  };
  const snapshot = await readPublicProjectSnapshot(options(client));
  assert.equal(snapshot.fields[0].id, "PVTF_synthetic");
  const normalize = createGithubEvidenceNormalizer({
    client: syntheticRepositoryClient(repository.id, client),
    source: "synthetic",
    allowedRepositoryIds: [2],
    allowedProjectIds: ["PVT_synthetic"],
    isSynthetic: true,
  });
  const output = await normalize({
    repository,
    family: "project_current",
    factKey: "synthetic-project",
    observedAt: "2026-10-08T10:00:00Z",
    policyVersion: "synthetic/v1",
    fact: {
      subjectId: snapshot.id,
      sourceRevision: projectSnapshotRevision(snapshot),
      sourceUrl: snapshot.sourceUrl,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "present",
    },
  });
  assert.equal(output.facts.length, 0);
  assert.match(output.reasons[0], /does_not_prove_editor_or_time/);
  assert.equal(output.observations[0].actorId, null);
  assert.equal(output.observations[0].occurredAt, null);
});

test("private, cross-repository and changing nested Project snapshots fail closed", async () => {
  for (const value of [
    { ...item(), project: { id: "PVT_synthetic", public: false } },
    { ...item(), content: { ...item().content, repository: { databaseId: 3, isPrivate: false } } },
    { ...item(), content: { ...item().content, repository: { databaseId: 2, isPrivate: true } } },
  ]) {
    const client = {
      graphql: async () => ({ node: { project: { id: "PVT_synthetic", public: true } } }),
      scanGraphql: async (scan) => scan.select({ node: value }).nodes,
    };
    await assert.rejects(readPublicProjectSnapshot(options(client)), /project_public_subject_unverified/);
  }
  const client = {
    graphql: async () => ({ node: { project: { id: "PVT_synthetic", public: true } } }),
    scanGraphql: async (scan) => {
      scan.select({ node: item() });
      return scan.select({ node: { ...item(), updatedAt: "2026-10-08T10:00:00Z" } }).nodes;
    },
  };
  await assert.rejects(readPublicProjectSnapshot(options(client)), /changed_during_scan/);
});

test("unapproved Project scope is rejected before any field request", async () => {
  let reads = 0;
  const client = {
    graphql: async () => ({ node: { project: { id: "PVT_other", public: true } } }),
    scanGraphql: async () => {
      reads++;
      return [];
    },
  };
  await assert.rejects(readPublicProjectSnapshot(options(client)), /project_not_authorized/);
  assert.equal(reads, 0);
  await assert.rejects(
    readPublicProjectSnapshot({ ...options(client), allowedProjectIds: [] }),
    /approved_project_scope_required/,
  );
});

test("Project approvals cannot be a substring-matched string", async () => {
  const client = {
    graphql: async () => {
      throw Error("must not read");
    },
  };
  await assert.rejects(
    readPublicProjectSnapshot({ ...options(client), allowedProjectIds: "prefix-PVT_synthetic-suffix" }),
    /approved_project_scope_required/,
  );
});

test("approved Project probes reject hidden nodes and authorization failures", async () => {
  const { assertPublicProjects, GithubClientError } = await import("../dist/index.js");
  for (const client of [
    { graphql: async () => ({ node: null }) },
    {
      graphql: async () => {
        throw new GithubClientError({ kind: "permission_denied", visibility: "unknown", status: 403 }, "synthetic");
      },
    },
  ])
    await assert.rejects(
      assertPublicProjects({ client, source: "synthetic", allowedProjectIds: ["PVT_synthetic"] }),
      /project_not_authorized/,
    );
});
