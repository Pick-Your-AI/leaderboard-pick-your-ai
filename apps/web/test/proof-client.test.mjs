import assert from "node:assert/strict";
import test from "node:test";
import { parameters, selection, uiHref } from "../src/remote/client.ts";
import { isProofTransition, proofHref, withoutProof } from "../src/remote/proof.ts";

test("drawer links pin exact board scope and cursor without leaking the UI selection into API or permanent links", () => {
  const value = selection(
    "?ui=api&snapshot=s1&repository=r1&workstream=w1&metric=pr_opened&limit=1&cursor=old.signature",
  );
  const href = new URL(proofHref("/leaderboards/pr_opened", value, "e-1"), "https://example.invalid");
  assert.equal(href.searchParams.get("proof"), "e-1");
  assert.equal(href.searchParams.get("snapshot"), "s1");
  assert.equal(href.searchParams.get("cursor"), "old.signature");
  assert.equal(href.searchParams.get("repository"), "r1");
  assert.equal(href.searchParams.get("workstream"), "w1");
  const selected = selection(href.search);
  assert.equal(selected.proof, "e-1");
  assert.equal(parameters(selected).get("proof"), null);
  assert.equal(new URL(uiHref("/contributions/e-1", selected), href).searchParams.get("proof"), null);
  assert.throws(() => proofHref("/leaderboards/pr_opened", { ...value, snapshot: null }, "e-1"));
  for (const query of ["?proof=", "?proof=a&proof=b", "?proof=bad%20id", "?proof=" + "a".repeat(201)])
    assert.throws(() => selection(query));
});

test("permanent proof links retain category for the return profile without filtering evidence requests", () => {
  const selected = selection(
    "?ui=api&snapshot=s1&repository=r1&workstream=w1&category=maintenance&search=alice&metric=pr_opened&limit=20&cursor=old.signature&proof=e-1",
  );
  const before = structuredClone(selected);
  const proof = new URL(uiHref("/contributions/e-1", selected, { cursor: null }), "https://example.invalid");
  const restored = selection(proof.search);
  for (const key of ["snapshot", "repository", "workstream", "metric", "limit", "category"])
    assert.equal(restored[key], selected[key], key);
  for (const key of ["cursor", "proof", "search"]) assert.equal(proof.searchParams.has(key), false, key);
  const request = parameters(restored);
  assert.equal(request.has("category"), false);
  assert.equal(request.toString(), parameters({ ...restored, category: null }).toString());
  const profile = new URL(uiHref("/contributors/a1", restored), proof);
  const returned = selection(profile.search);
  for (const key of ["snapshot", "repository", "workstream", "metric", "limit", "category"])
    assert.equal(returned[key], selected[key], key);
  assert.equal(profile.searchParams.has("cursor"), false);
  for (const path of ["/leaderboards/pr_opened", "/methodology/pr_opened"])
    assert.equal(new URL(uiHref(path, restored), proof).searchParams.has("category"), false);
  const unfiltered = new URL(uiHref("/contributions/e-1", { ...selected, category: null }), proof);
  assert.equal(unfiltered.searchParams.has("category"), false);
  assert.deepEqual(selected, before);
});

test("drawer-only Back/Forward retains background DOM only for identical pinned context", () => {
  const board = { pathname: "/leaderboards/pr_opened", search: "?snapshot=s1&cursor=x.y&repository=r1" };
  const drawer = { ...board, search: board.search + "&proof=e-1" };
  assert.equal(isProofTransition(board, drawer), true);
  assert.equal(isProofTransition(drawer, board), true);
  assert.equal(withoutProof(board), withoutProof(drawer));
  assert.equal(isProofTransition(drawer, { ...board, search: "?snapshot=s2&cursor=x.y&repository=r1" }), false);
  assert.equal(isProofTransition(drawer, { ...board, search: "?snapshot=s1&cursor=z.y&repository=r1" }), false);
  assert.equal(isProofTransition(board, board), false);
});

test("proof parser retains strict versioned public metadata and rejects contradictory acceptance or private history fields", async () => {
  const { evidence } = await import("../src/remote/client.ts");
  const at = "2026-10-01T00:00:00.000Z";
  const value = {
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
      reasonCodes: [],
    },
    occurredAt: at,
    sourceRevision: null,
    sourceRevisionUrl: null,
    evidenceMetadata: {
      schemaVersion: "leaderboard-evidence/v1",
      artifactTitle: { value: "Literal <script> title", basis: "as_collected", collectedAt: at },
      sourceAction: "artifact_created",
      sourceOccurredAt: at,
      observedAt: at,
      activityState: "observed",
      acceptedAt: null,
      history: { coverage: "not_supplied", records: [] },
    },
  };
  const parsed = evidence(value);
  assert.deepEqual(parsed.evidenceMetadata, value.evidenceMetadata);
  assert.equal(parsed.activityState, "observed");
  assert.equal(parsed.observedAt, at);
  assert.throws(() => evidence({ ...value, activityState: "accepted" }));
  assert.throws(() => evidence({ ...value, evidenceMetadata: { ...value.evidenceMetadata, acceptedAt: at } }));
  assert.throws(() =>
    evidence({
      ...value,
      evidenceMetadata: {
        ...value.evidenceMetadata,
        history: {
          coverage: "partial",
          records: [
            { kind: "correction", occurredAt: null, publicUrl: value.artifact.publicUrl, privateBody: "secret" },
          ],
        },
      },
    }),
  );
  const accepted = {
    ...value,
    evidenceMetadata: {
      ...value.evidenceMetadata,
      activityState: "accepted",
      sourceAction: "recognition_accepted",
      acceptedAt: at,
    },
  };
  assert.equal(evidence(accepted).evidenceMetadata.acceptedAt, at);
  assert.throws(() => evidence({ ...accepted, contribution: { ...value.contribution, qualification: "ineligible" } }));
});
