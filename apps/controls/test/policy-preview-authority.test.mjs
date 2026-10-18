import test from "node:test";
import assert from "node:assert/strict";
import { createPolicyPreviewAuthority, previewAuthorityLimitsV1 } from "../src/policy-preview-authority.mjs";

test("local preview authority starts empty, binds exact identities, expires and requires advancing revisions", () => {
  let now = 1000;
  const cache = createPolicyPreviewAuthority({ now: () => now });
  const hash = "a".repeat(64),
    request = { configurationHash: hash, actorId: "201", roleVersion: "roster-1" };
  const state = {
    schemaVersion: previewAuthorityLimitsV1.schemaVersion,
    revision: 1,
    validUntil: 2000,
    configurationHashes: [hash],
    reviewers: [{ actorId: "201", roleVersion: "roster-1" }],
  };
  assert.equal(cache.isCurrent(request), false);
  cache.replace(state);
  assert.equal(cache.isCurrent(request), true);
  assert.equal(cache.isCurrent({ ...request, roleVersion: "roster-2" }), false);
  assert.equal(cache.isCurrent({ ...request, actorId: "999", roleVersion: undefined }), false);
  assert.equal(cache.isCurrent({ ...request, configurationHash: "b".repeat(64) }), false);
  assert.throws(() => cache.replace(state), /revision must advance/);
  assert.throws(() => cache.replace({ ...state, revision: 2, validUntil: now + 60_001 }), /lifetime/);
  assert.throws(
    () => cache.replace({ ...state, revision: 2, reviewers: [...state.reviewers, ...state.reviewers] }),
    /reviewer authority/,
  );
  now = 2000;
  assert.equal(cache.isCurrent(request), false);
  cache.replace({ ...state, revision: 2, validUntil: 3000 });
  assert.equal(cache.isCurrent(request), true);
  cache.replace({ ...state, revision: 3, validUntil: 3000, reviewers: [] });
  assert.equal(cache.isCurrent(request), false);
  cache.replace({ ...state, revision: 4, validUntil: 3000, configurationHashes: [] });
  assert.equal(cache.isCurrent(request), false);
});
