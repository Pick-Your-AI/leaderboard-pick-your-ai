import { contributionRoleSchema, type Contribution } from "./v1/schemas.js";
import { isPullRequestMergeTargetBranch } from "./pull-request-merge-target.js";

export type PublicContributionRole = Exclude<Contribution["roles"][number], "unknown">;
export const publicContributionRoles = Object.freeze(
  contributionRoleSchema.options.filter((role): role is PublicContributionRole => role !== "unknown"),
);

/** Public materializations are exact scopes, never sums of overlapping views. */
export interface PublicScope {
  organization: string;
  repository: string | null;
  workstream: string | null;
  start: string | null;
  end: string | null;
  schemaVersion?: "public-scope/v2" | "public-scope/v3" | "public-scope/v4";
  context?: "event" | "current";
  projects?: string[];
  roles?: PublicContributionRole[];
  /** Exact native target name at merge, never the current PR base branch. */
  branch?: string;
}

export const publicScopeSchemaVersion = "public-scope/v2" as const;
export const publicRoleScopeSchemaVersion = "public-scope/v3" as const;
export const publicMergeTargetScopeSchemaVersion = "public-scope/v4" as const;
export const publicScopeProjectLimit = 100;
export const publicScopeRoleLimit = publicContributionRoles.length;
const keys = new Set([
  "organization",
  "repository",
  "workstream",
  "start",
  "end",
  "schemaVersion",
  "context",
  "projects",
  "roles",
  "branch",
]);
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

/** Canonicalize detached query/configuration input; never rewrite retained documents.
 * Explicit event + no Projects remains the original five-field scope, byte for byte.
 * Membership-only scopes retain v2. A nonempty role union requires v3, with every
 * membership and contribution-role dimension explicit. Retained v2 never acquires roles.
 */
export function canonicalPublicScope(input: unknown): PublicScope {
  const invalid = (): never => {
    throw new Error("invalid_public_scope");
  };
  if (input === null || typeof input !== "object" || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !keys.has(key)) ||
    !identifier(value.organization) ||
    (value.repository !== null && !identifier(value.repository)) ||
    (value.workstream !== null && !identifier(value.workstream)) ||
    (value.start === null) !== (value.end === null) ||
    (value.start !== null && (!instant(value.start) || !instant(value.end) || value.start >= value.end)) ||
    (value.context !== undefined && value.context !== "event" && value.context !== "current") ||
    (value.schemaVersion !== undefined &&
      value.schemaVersion !== publicScopeSchemaVersion &&
      value.schemaVersion !== publicRoleScopeSchemaVersion &&
      value.schemaVersion !== publicMergeTargetScopeSchemaVersion) ||
    (value.branch !== undefined && (!isPullRequestMergeTargetBranch(value.branch) || value.repository === null)) ||
    (value.roles !== undefined &&
      (!Array.isArray(value.roles) ||
        value.roles.length > publicScopeRoleLimit ||
        Array.from(value.roles).some((role) => !publicContributionRoles.includes(role)))) ||
    (value.projects !== undefined &&
      (!Array.isArray(value.projects) ||
        value.projects.length > publicScopeProjectLimit ||
        Array.from(value.projects).some((id) => typeof id !== "string" || !/^[A-Za-z0-9_=.:-]{1,128}$/.test(id))))
  )
    return invalid();
  const projects = [...new Set((value.projects ?? []) as string[])].sort();
  const roles = [...new Set((value.roles ?? []) as PublicContributionRole[])].sort();
  const context = value.context ?? "event";
  const membership = context === "current" || projects.length > 0;
  const version =
    value.branch !== undefined
      ? publicMergeTargetScopeSchemaVersion
      : roles.length
        ? publicRoleScopeSchemaVersion
        : membership
          ? publicScopeSchemaVersion
          : undefined;
  if (
    value.schemaVersion !== undefined &&
    (value.schemaVersion !== version ||
      value.context === undefined ||
      value.projects === undefined ||
      (value.schemaVersion === publicScopeSchemaVersion && "roles" in value) ||
      ((value.schemaVersion === publicRoleScopeSchemaVersion ||
        value.schemaVersion === publicMergeTargetScopeSchemaVersion) &&
        value.roles === undefined))
  )
    return invalid();
  return {
    organization: value.organization,
    repository: value.repository as string | null,
    workstream: value.workstream as string | null,
    start: value.start as string | null,
    end: value.end as string | null,
    ...(version ? { schemaVersion: version, context, projects } : {}),
    ...(roles.length || version === publicMergeTargetScopeSchemaVersion ? { roles } : {}),
    ...(value.branch === undefined ? {} : { branch: value.branch as string }),
  };
}

/** The original five-element key is frozen for default event scopes. */
export function publicScopeKey(input: PublicScope): string {
  const scope = canonicalPublicScope(input);
  const key: unknown[] = [scope.organization, scope.repository, scope.workstream, scope.start, scope.end];
  if (scope.schemaVersion === publicScopeSchemaVersion)
    key.push([publicScopeSchemaVersion, scope.context, scope.projects]);
  if (scope.schemaVersion === publicRoleScopeSchemaVersion)
    key.push([publicRoleScopeSchemaVersion, scope.context, scope.projects, scope.roles]);
  if (scope.schemaVersion === publicMergeTargetScopeSchemaVersion)
    key.push([publicMergeTargetScopeSchemaVersion, scope.context, scope.projects, scope.roles, scope.branch]);
  return JSON.stringify(key);
}

/** Bind every selection dimension while allowing comparison windows to differ. */
export function publicScopeFilterKey(scope: PublicScope): string {
  return publicScopeKey({ ...scope, start: null, end: null });
}

/** One query spelling is shared by boards, card links and update polling URLs. */
export function publicScopeParameters(input: PublicScope): Record<string, string> {
  const scope = canonicalPublicScope(input);
  const params: Record<string, string> = { organization: scope.organization };
  for (const key of ["repository", "workstream", "start", "end"] as const)
    if (scope[key] !== null) params[key] = scope[key];
  if (scope.schemaVersion !== undefined) {
    params.context = scope.context!;
    if (scope.projects!.length) params.project = scope.projects!.join(",");
  }
  if (scope.roles?.length) params.role = scope.roles.join(",");
  if (scope.branch !== undefined) params.branch = scope.branch;
  return params;
}
