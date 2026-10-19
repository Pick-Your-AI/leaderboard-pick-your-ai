import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../../service/dist/app.js";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import { selection, profile } from "../src/remote/client.ts";
import {
  participationHistory,
  participationFirstProof,
  participationHistoryParameters,
  participationHistoryPath,
  participationFirstProofPath,
} from "../src/remote/participation-history-client.ts";
import {
  participationHistorySource,
  historyPath,
  historyQuery,
  historyCutoff,
} from "../../../tests/fixtures/participation-history.mjs";

async function fixture(t, query = historyQuery) {
  const input = participationHistorySource();
  const app = createService({ source: input.source });
  t.after(() => app.close());
  const selected = selection("?" + query);
  const parentResponse = await app.inject(`/api/v1/contributors/101?${query}`);
  assert.equal(parentResponse.statusCode, 200, parentResponse.body);
  const parent = profile(parentResponse.json(), selected);
  const response = await app.inject(`/api/v1/contributors/101/participation-history?${query}`);
  assert.equal(response.statusCode, 200, response.body);
  return { ...input, app, selected, parent, body: response.json() };
}
const decode = (f, body = f.body) => participationHistory(body, f.selected, "101", f.parent, metricRegistryV1.metrics);

test("the strict reader accepts actual service history and an out-of-scope first proof", async (t) => {
  const f = await fixture(t),
    value = decode(f);
  assert.equal(value.history.state, "known");
  const params = participationHistoryParameters(f.selected, f.parent.snapshotId);
  const path = participationFirstProofPath("101", value.history);
  const proof = await f.app.inject(`/api/v1/${path}?${params}`);
  assert.equal(proof.statusCode, 200, proof.body);
  assert.deepEqual(
    participationFirstProof(
      proof.json(),
      { ...f.selected, snapshot: f.parent.snapshotId },
      value,
      metricRegistryV1.metrics,
    ).history,
    value.history,
  );
  assert.equal(value.history.firstProof.proof.repositoryId, "3");
  assert.deepEqual(value.history.firstProof.proof.roles, ["reviewer"]);
});

test("history parameters preserve v3 source scope and exclude unrelated board, timeline and display state", () => {
  const selected = selection(
    `?${historyQuery}&project=P_synthetic&context=current&role=author&actors=user&category=pr_merged&compare=earlier&metric=pr_merged&limit=1&search=someone&tz=America%2FNew_York`,
    { comparison: true },
  );
  const params = participationHistoryParameters(selected, "synthetic-history-selected");
  assert.equal(params.get("role"), "author");
  assert.equal(params.get("context"), "current");
  assert.equal(params.get("project"), "P_synthetic");
  assert.equal(params.get("category"), "pr_merged");
  assert.equal(params.get("snapshot"), "synthetic-history-selected");
  for (const key of ["compare", "metric", "limit", "cursor", "search", "tz"]) assert.equal(params.has(key), false, key);
  assert.throws(() => participationHistoryParameters({ ...selected, snapshot: "other" }, "synthetic-history-selected"));
});

test("the reader binds the exact parent snapshot, revision, definitions, controls and profile lens", async (t) => {
  const f = await fixture(t, historyQuery + "&role=author&category=pr_merged");
  for (const change of [
    (v) => {
      v.snapshotId = "other";
    },
    (v) => {
      v.revision++;
    },
    (v) => {
      v.policyVersion = "other";
    },
    (v) => {
      v.metricDefinitionVersion = "other";
    },
    (v) => {
      v.computationVersion = "other";
    },
    (v) => {
      v.generatedAt = "2026-10-18T00:00:01.000Z";
    },
    (v) => {
      v.scope.roles = ["reviewer"];
    },
    (v) => {
      v.actorFilter = "user";
    },
    (v) => {
      v.actorId = "102";
    },
    (v) => {
      v.profileCategory = null;
    },
  ]) {
    const value = structuredClone(f.body);
    change(value);
    assert.throws(() => decode(f, value));
  }
});

test("closed history, coverage, proof and metadata structures reject private or fabricated extra fields", async (t) => {
  const f = await fixture(t);
  for (const change of [
    (v) => {
      v.admission = "private";
    },
    (v) => {
      v.history.basis.decisionId = "private";
    },
    (v) => {
      v.history.firstProof.proof.rawContent = "private";
    },
    (v) => {
      v.history.basis.sourceInventory[0].approvalReceipt = "private";
    },
    (v) => {
      v.head.currentAuthorization = "private";
    },
    (v) => {
      v.methodology[0].privateReviewer = "private";
    },
    (v) => {
      v.coverage[0].privateError = "private";
    },
    (v) => {
      v.history.ranked = true;
    },
  ]) {
    const value = structuredClone(f.body);
    change(value);
    assert.throws(() => decode(f, value));
  }
});

test("first proof, admitted universe and claimed newcomer status are independently cross-checked", async (t) => {
  const f = await fixture(t);
  for (const change of [
    (v) => {
      v.history.newcomer = true;
    },
    (v) => {
      v.history.firstProof.proof.actorId = "102";
    },
    (v) => {
      v.history.firstProof.proof.repositoryId = "missing-repository";
    },
    (v) => {
      v.history.firstProof.source = "github_graphql";
    },
    (v) => {
      v.history.firstProof.proof.roles = ["unknown"];
    },
    (v) => {
      v.history.firstProof.proof.metricIds = ["not-a-category"];
    },
    (v) => {
      v.history.basis.scope.repository = "2";
    },
    (v) => {
      v.history.basis.cutoff = "2026-10-18T00:00:00.000000001Z";
    },
    (v) => {
      v.history.basis.sourceInventory.push(structuredClone(v.history.basis.sourceInventory[0]));
    },
    (v) => {
      v.history.basis.policies[0].signature = "e".repeat(64);
    },
    (v) => {
      v.history.firstProof.observedAt = "2026-01-01T00:00:00.000Z";
    },
  ]) {
    const value = structuredClone(f.body);
    change(value);
    assert.throws(() => decode(f, value));
  }
});

test("opaque artifact IDs retain exact spelling while route IDs and source URLs stay restricted", async (t) => {
  const f = await fixture(t);
  for (const artifactId of ["synthetic:opaque+/==", "a".repeat(2048), "synthetic\u0000record"]) {
    const body = structuredClone(f.body);
    body.history.firstProof.proof.artifactId = artifactId;
    assert.equal(decode(f, body).history.firstProof.proof.artifactId, artifactId);
  }
  for (const change of [
    (v) => {
      v.history.firstProof.proof.actorId = "..";
    },
    (v) => {
      v.history.firstProof.proof.contributionId = "../another";
    },
    (v) => {
      v.history.firstProof.proof.sourceUrl = "https://github.com.evil.invalid/org/repo";
    },
    (v) => {
      v.history.firstProof.proof.sourceUrl = "https://github.com/org/repo?private=1";
    },
  ]) {
    const value = structuredClone(f.body);
    change(value);
    assert.throws(() => decode(f, value));
  }
  assert.throws(() => participationHistoryPath(".."));
  assert.throws(() => participationFirstProofPath("102", decode(f).history));
});

test("history-only changes cannot substitute a newly valid proof under the old first-proof action", async (t) => {
  const f = await fixture(t),
    before = decode(f);
  f.state.pair.history.dataset.backfillRevision = "synthetic-replacement";
  const updated = (await f.app.inject(historyPath)).json();
  assert.equal(decode(f, updated).history.state, "known");
  assert.throws(() => participationFirstProof(updated, f.selected, before, metricRegistryV1.metrics));
  const malicious = structuredClone(f.body);
  malicious.history.firstProof.proof.contributionId = "another-valid-route-id";
  assert.throws(() => participationFirstProof(malicious, f.selected, before, metricRegistryV1.metrics));
});

test("unknown service history and all-time period assessment cannot acquire a fabricated Boolean", async (t) => {
  const f = await fixture(t, "");
  assert.equal(decode(f).history.newcomer, null);
  f.state.authorized = false;
  const body = (await f.app.inject("/api/v1/contributors/101/participation-history")).json();
  const value = decode(f, body);
  assert.equal(value.history.state, "unknown");
  const changed = structuredClone(body);
  changed.history.newcomer = false;
  assert.throws(() => decode(f, changed));
  assert.throws(() => participationFirstProofPath("101", value.history));
  const future = structuredClone(f.body);
  future.history.basis.cutoff = historyCutoff;
  future.history.periodReason = null;
  future.history.newcomer = false;
  assert.throws(() => decode(f, future));
});

test("the reader and proof route require full-string history hashes and source identifiers", async (t) => {
  const f = await fixture(t);
  for (const change of [
    (v) => {
      v.history.historyKey += "\n";
    },
    (v) => {
      v.history.basis.policies[0].signature += "\n";
    },
    (v) => {
      v.history.basis.policies[0].version += "\n";
    },
    (v) => {
      v.history.basis.sourceInventory[0].repositoryId += "\n";
    },
  ]) {
    const value = structuredClone(f.body);
    change(value);
    assert.throws(() => decode(f, value));
  }
  assert.throws(() => participationHistoryPath("101\n"));
  const history = structuredClone(decode(f).history);
  history.historyKey += "\n";
  assert.throws(() => participationFirstProofPath("101", history));
});

test("the reader bounds the complete valid response before retaining a large exact opaque proof", async (t) => {
  const f = await fixture(t),
    body = structuredClone(f.body);
  const length = 1_500_000 - Buffer.byteLength(JSON.stringify(body)) + body.history.firstProof.proof.artifactId.length;
  body.history.firstProof.proof.artifactId = "s".repeat(length);
  assert.equal(Buffer.byteLength(JSON.stringify(body)), 1_500_000);
  assert.equal(decode(f, body).history.firstProof.proof.artifactId.length, length);
  body.history.firstProof.proof.artifactId += "x";
  assert.throws(() => decode(f, body));
});
