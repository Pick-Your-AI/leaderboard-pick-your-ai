import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../dist/app.js";
import { projectRead } from "../dist/public-source.js";
import { readFixture, at } from "../../../tests/fixtures/pending-metric.mjs";

// Synthetic contradictions in already supplied identities; no account-linking inference.
const collections = ["evidence", "portfolioEvidence", "pendingEvidence"];
const dispositions = ["private", "unknown", "deleted", "unavailable"];

function copyInto(input, collection, differentContribution = false) {
  const primary = input.selected.evidence[0];
  const copy = structuredClone(primary);
  if (differentContribution) copy.contribution.contributionId += ":visibility-copy";
  if (collection !== "evidence") {
    copy.activityState = collection === "pendingEvidence" ? "pending" : "accepted";
    copy.observedAt = at;
  }
  input.selected[collection] ??= [];
  input.selected[collection].push(copy);
  return { primary, copy };
}

function hide(entry, visibility, identity = "both") {
  entry.artifact.visibility = visibility;
  delete entry.artifact.publicUrl;
  if (identity === "artifact") entry.contribution.artifactId = null;
  if (identity === "contribution") delete entry.artifact.stableId;
}

function rejects(input) {
  assert.throws(() => projectRead(input, input.selected.scope, null), {
    status: 503,
    code: "public_projection_unavailable",
  });
}

for (const visibility of dispositions) {
  for (const collection of ["portfolioEvidence", "pendingEvidence"]) {
    test(`${visibility} copies of one contribution conflict across primary and ${collection}`, () => {
      for (const nonPublicPrimary of [false, true]) {
        const input = readFixture();
        const { primary, copy } = copyInto(input, collection);
        hide(nonPublicPrimary ? primary : copy, visibility);
        rejects(input);
      }
    });
  }

  for (const collection of collections) {
    test(`${visibility} artifact copies with different contribution IDs conflict in ${collection}`, () => {
      for (const nonPublicPrimary of [false, true]) {
        for (const identity of ["both", "artifact", "contribution"]) {
          const input = readFixture();
          const { primary, copy } = copyInto(input, collection, true);
          hide(nonPublicPrimary ? primary : copy, visibility, identity);
          rejects(input);
        }
      }
    });
  }
}

for (const collection of collections) {
  test(`matching visibility permits different contributions to one artifact in ${collection}`, () => {
    const input = readFixture();
    copyInto(input, collection, true);
    const projected = projectRead(input, input.selected.scope, null);
    assert.equal(projected.selected.rows.length, input.selected.rows.length);
    assert.equal(projected.selected.evidence.length, input.selected.evidence.length);
  });

  test(`matching private copies in ${collection} preserve unrelated public contributors`, () => {
    const input = readFixture();
    const { primary, copy } = copyInto(input, collection, true);
    const removedActor = primary.contribution.actorId;
    hide(primary, "private");
    hide(copy, "private");
    const projected = projectRead(input, input.selected.scope, null);
    assert.ok(projected.selected.rows.length > 0);
    assert.ok(projected.selected.rows.every((row) => row.actorId !== removedActor));
    assert.ok(projected.selected.evidence.every((entry) => entry.artifact.stableId !== primary.artifact.stableId));
    assert.ok(projected.selected.evidence.some((entry) => entry.contribution.actorId !== removedActor));
  });
}

test("distinct non-public proofs without known artifact IDs do not become one shared identity", () => {
  const input = readFixture();
  for (const [index, visibility] of ["private", "unknown"].entries()) {
    const copy = structuredClone(input.selected.evidence[0]);
    copy.contribution.contributionId += `:unidentified-${index}`;
    hide(copy, visibility);
    delete copy.artifact.stableId;
    copy.contribution.artifactId = null;
    input.selected.evidence.push(copy);
  }
  const projected = projectRead(input, input.selected.scope, null);
  assert.equal(projected.selected.rows.length, input.selected.rows.length);
  assert.equal(projected.selected.evidence.length, input.selected.evidence.length - 2);
});

for (const collection of ["portfolioEvidence", "pendingEvidence"]) {
  test(`a private artifact copy in ${collection} invalidates conditional public responses`, async (t) => {
    const input = readFixture();
    const app = createService({
      now: () => Date.parse(at),
      source: {
        async read() {
          return structuredClone(input);
        },
      },
    });
    t.after(() => app.close());
    const actorId = input.selected.actors[0].actorId;
    const proofId = input.selected.evidence[0].contribution.contributionId;
    const paths = [
      "/api/v1/boards?metric=pr_merged",
      "/api/v1/contributors",
      `/api/v1/contributors/${actorId}`,
      `/api/v1/evidence/${proofId}`,
      "/api/v1/exports?metric=pr_merged&format=json",
      "/api/v1/exports?metric=pr_merged&format=csv",
      "/api/v1/health",
      "/api/v1/updates",
    ];
    const previous = new Map();
    for (const path of paths) {
      for (const pin of path === "/api/v1/updates" ? [false] : [false, true]) {
        const url = pin ? `${path}${path.includes("?") ? "&" : "?"}snapshot=${input.head.snapshotId}` : path;
        const response = await app.inject(url);
        assert.equal(response.statusCode, 200, url);
        previous.set(url, response.headers.etag);
      }
    }
    const { copy } = copyInto(input, collection, true);
    hide(copy, "private");
    for (const [url, etag] of previous) {
      const response = await app.inject({ url, headers: etag ? { "if-none-match": etag } : {} });
      assert.equal(response.statusCode, 503, url);
      assert.deepEqual(response.json(), { error: "public_projection_unavailable" });
      assert.equal(response.headers["cache-control"], "no-store");
    }
  });
}

function addNormalizedPrimaryDuplicate(input, visibility, first, differentArtifact) {
  const primary = input.selected.evidence[0];
  const copy = structuredClone(primary);
  copy.contribution.contributionId = " \t" + primary.contribution.contributionId + "\n ";
  if (differentArtifact) {
    copy.artifact.stableId += ":normalized-copy";
    copy.contribution.artifactId = copy.artifact.stableId;
    copy.artifact.publicUrl = "https://github.com/synthetic-org/synthetic-repo/pull/9999";
  }
  if (visibility !== "public") {
    hide(primary, visibility);
    hide(copy, visibility);
  }
  if (first) input.selected.evidence.unshift(copy);
  else input.selected.evidence.push(copy);
}

for (const visibility of ["public", ...dispositions]) {
  test(`matching ${visibility} primary proofs cannot share a normalized contribution ID`, () => {
    for (const first of [false, true]) {
      for (const differentArtifact of [false, true]) {
        const input = readFixture();
        addNormalizedPrimaryDuplicate(input, visibility, first, differentArtifact);
        rejects(input);
      }
    }
  });
}

test("a unique primary proof retains the contribution schema's whitespace normalization", () => {
  const input = readFixture();
  const proofId = input.selected.evidence[0].contribution.contributionId;
  input.selected.evidence[0].contribution.contributionId = " \t" + proofId + "\n ";
  const projected = projectRead(input, input.selected.scope, null);
  assert.equal(projected.selected.evidence[0].contribution.contributionId, proofId);
  assert.equal(projected.selected.rows.length, input.selected.rows.length);
  assert.equal(projected.selected.evidence.length, input.selected.evidence.length);
});

test("normalized primary proof collisions cannot reuse current or pinned conditional responses", async (t) => {
  for (const first of [false, true]) {
    const input = readFixture();
    const app = createService({
      now: () => Date.parse(at),
      source: {
        async read() {
          return structuredClone(input);
        },
      },
    });
    t.after(() => app.close());
    const actorId = input.selected.actors[0].actorId;
    const proofId = input.selected.evidence[0].contribution.contributionId;
    const paths = [
      "/api/v1/boards?metric=pr_merged",
      "/api/v1/contributors",
      `/api/v1/contributors/${actorId}`,
      `/api/v1/evidence/${proofId}`,
      "/api/v1/exports?metric=pr_merged&format=json",
      "/api/v1/exports?metric=pr_merged&format=csv",
      "/api/v1/health",
      "/api/v1/updates",
    ];
    const previous = new Map();
    for (const path of paths) {
      for (const pin of path === "/api/v1/updates" ? [false] : [false, true]) {
        const url = pin ? `${path}${path.includes("?") ? "&" : "?"}snapshot=${input.head.snapshotId}` : path;
        const response = await app.inject(url);
        assert.equal(response.statusCode, 200, url);
        previous.set(url, response.headers.etag);
      }
    }
    addNormalizedPrimaryDuplicate(input, "public", first, true);
    for (const [url, etag] of previous) {
      const response = await app.inject({ url, headers: etag ? { "if-none-match": etag } : {} });
      assert.equal(response.statusCode, 503, url);
      assert.deepEqual(response.json(), { error: "public_projection_unavailable" });
      assert.equal(response.headers["cache-control"], "no-store");
    }
  }
});
