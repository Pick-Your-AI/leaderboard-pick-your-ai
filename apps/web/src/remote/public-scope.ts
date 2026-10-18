import { canonicalPublicScope, publicScopeKey, type PublicScope } from "@pick-your-ai/contracts";
import { stableJSON } from "@pick-your-ai/metrics";

/** Extract source dimensions; UI discovery, pins and display timezone stay separate. */
export function selectionScope(value: PublicScope): PublicScope {
  return canonicalPublicScope({
    organization: value.organization,
    repository: value.repository,
    workstream: value.workstream,
    start: value.start,
    end: value.end,
    ...(value.schemaVersion === undefined ? {} : { schemaVersion: value.schemaVersion }),
    ...(value.context === undefined ? {} : { context: value.context }),
    ...(value.projects === undefined ? {} : { projects: value.projects }),
    ...(value.roles === undefined ? {} : { roles: value.roles }),
  });
}

/** Retained response scopes must already be canonical. Query aliases never
 * authorize upgrading a missing response version or dropping unknown members. */
export function responseScope(value: unknown, selected: PublicScope): PublicScope {
  const scope = canonicalPublicScope(value);
  const keys = Object.keys(value as object).sort();
  if (
    stableJSON(keys) !== stableJSON(Object.keys(scope).sort()) ||
    stableJSON(value) !== stableJSON(scope) ||
    publicScopeKey(scope) !== publicScopeKey(selectionScope(selected))
  )
    throw new Error("api_scope_mismatch");
  return scope;
}

export const scopeReadVersion = (scope: PublicScope) =>
  scope.schemaVersion === "public-scope/v3"
    ? "public-read/v3"
    : scope.schemaVersion === "public-scope/v2"
      ? "public-read/v2"
      : "leaderboard/v1";
export const scopeExportVersion = (scope: PublicScope) =>
  scope.schemaVersion === "public-scope/v3"
    ? "public-export/v3"
    : scope.schemaVersion === "public-scope/v2"
      ? "public-export/v2"
      : "public-export/v1";
