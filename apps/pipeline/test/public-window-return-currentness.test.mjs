import assert from "node:assert/strict";
import test from "node:test";
import { harness, components, publicScope } from "./harness.mjs";

const { canonicalPublicScope, publicScopeParameters, publicScopeKey } = components.contracts;
const cutoff = "2026-10-18T12:00:00.000Z";
const scope = canonicalPublicScope({ ...publicScope, repository: "2", context: "current", roles: ["reporter"] });
const url = `/api/v1/windows?${new URLSearchParams(publicScopeParameters(scope))}`;

for (const changed of ["unchanged", "head", "index", "approval"])
  test(`actual discovery transaction return retains ${changed} authority`, async (t) => {
    let approved = true;
    const h = await harness(t, {
      verifyConfiguration: async () => approved,
      configure(config) {
        config.scopes = [{ ...scope, period: "30d" }];
      },
      transformPayloads(payloads) {
        return payloads.map((payload, index) => ({
          ...payload,
          created_at: new Date(Date.parse(cutoff) - (index === 0 ? 2 : 45) * 86400000).toISOString(),
          updated_at: new Date(Date.parse(cutoff) - 86400000).toISOString(),
        }));
      },
    });
    const publication = await h.runtime.runOnce({ cutoff });
    assert.equal(publication.state, "published");
    assert.equal(publication.publications.length, 1);
    const before = await h.runtime.app.inject(url);
    assert.equal(before.statusCode, 200, before.body);
    const window = before.json().windows[0];
    assert.equal(window.snapshotId, publication.publications[0].snapshotId);
    const reads = { ...h.githubReads };
    const initial = h.controlsStore.read();
    const transaction = h.db.transaction.bind(h.db);
    let completed = 0;
    h.db.transaction = async (work) => {
      const result = await transaction(work);
      assert.equal(result.windows[0].read.selected.snapshot.snapshotId, window.snapshotId);
      completed++;
      if (changed === "approval") approved = false;
      else if (changed !== "unchanged")
        h.controlsStore.transaction((state) => {
          if (changed === "head") delete state.pipelineHeads[publicScopeKey(window.scope)];
          else delete state.pipelineWindowIndex;
        });
      return result;
    };
    let response;
    try {
      response = await h.runtime.app.inject(url);
    } finally {
      h.db.transaction = transaction;
    }
    assert.equal(completed, 1, "mutation follows the completed actual PGlite transaction, before its adapter returns");
    assert.deepEqual(h.githubReads, reads, "a public read must not collect source data");
    if (changed === "unchanged") {
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), before.json());
      assert.deepEqual(h.controlsStore.read(), initial);
    } else {
      const subsequent = await h.runtime.app.inject(url);
      if (changed === "index") {
        assert.equal(subsequent.statusCode, 200, subsequent.body);
        assert.deepEqual(subsequent.json().windows, []);
      } else assert.equal(subsequent.statusCode, 503, subsequent.body);
      assert.equal(response.statusCode, 503, "the same read returned confirmed pointers after its authority changed");
      assert.equal(response.json().windows, undefined);
    }
  });
