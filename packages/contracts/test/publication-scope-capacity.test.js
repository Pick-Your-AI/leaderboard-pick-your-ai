import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalPublicScope,
  publicScopeKey,
  publicScopeProjectLimit,
  publicContributionRoles,
} from "../dist/index.js";
import { maximalPublicationScopeCases } from "../../../tests/fixtures/publication-scope-capacity.mjs";

test("publication capacity fixtures are the exact maximal legacy, v2 and v3 canonical keys", () => {
  for (const { name, scope, scopeKey } of maximalPublicationScopeCases()) {
    assert.deepEqual(canonicalPublicScope(scope), scope, name);
    assert.equal(publicScopeKey(scope), scopeKey, name);
    for (const key of ["organization", "repository", "workstream"]) {
      assert.equal(scope[key].length, 200);
      assert.throws(() => canonicalPublicScope({ ...scope, [key]: scope[key] + "X" }), /invalid_public_scope/);
    }
    if (scope.projects) {
      assert.equal(scope.projects.length, publicScopeProjectLimit);
      assert.equal(new Set(scope.projects).size, publicScopeProjectLimit);
      assert.ok(scope.projects.every((id) => id.length === 128));
      assert.throws(
        () => canonicalPublicScope({ ...scope, projects: [...scope.projects, "SYNTHETIC_EXTRA"] }),
        /invalid_public_scope/,
      );
      assert.throws(
        () => canonicalPublicScope({ ...scope, projects: [scope.projects[0] + "X", ...scope.projects.slice(1)] }),
        /invalid_public_scope/,
      );
    }
    if (scope.roles) assert.deepEqual(scope.roles, [...publicContributionRoles].sort());
  }
  assert.deepEqual(
    maximalPublicationScopeCases().map(({ scopeKey }) => scopeKey.length),
    [664, 13796, 13895],
  );
});
