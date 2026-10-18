/** Public materializations are exact scopes, never sums of overlapping views. */
export interface PublicScope {
  organization: string;
  repository: string | null;
  workstream: string | null;
  start: string | null;
  end: string | null;
  schemaVersion?: "public-scope/v2";
  context?: "event" | "current";
  projects?: string[];
}

export const publicScopeSchemaVersion = "public-scope/v2" as const;
export const publicScopeProjectLimit = 100;
const keys = new Set([
  "organization",
  "repository",
  "workstream",
  "start",
  "end",
  "schemaVersion",
  "context",
  "projects",
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
 * New materializations carry a version and both membership dimensions explicitly.
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
    (value.schemaVersion !== undefined && value.schemaVersion !== publicScopeSchemaVersion) ||
    (value.projects !== undefined &&
      (!Array.isArray(value.projects) ||
        value.projects.length > publicScopeProjectLimit ||
        value.projects.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_=.:-]{1,128}$/.test(id))))
  )
    return invalid();
  const projects = [...new Set((value.projects ?? []) as string[])].sort();
  const context = value.context ?? "event";
  const extended = context === "current" || projects.length > 0;
  if (value.schemaVersion !== undefined && (!extended || value.context === undefined || value.projects === undefined))
    return invalid();
  return {
    organization: value.organization,
    repository: value.repository as string | null,
    workstream: value.workstream as string | null,
    start: value.start as string | null,
    end: value.end as string | null,
    ...(extended ? { schemaVersion: publicScopeSchemaVersion, context, projects } : {}),
  };
}

/** The original five-element key is frozen for default event scopes. */
export function publicScopeKey(input: PublicScope): string {
  const scope = canonicalPublicScope(input);
  const key: unknown[] = [scope.organization, scope.repository, scope.workstream, scope.start, scope.end];
  if (scope.schemaVersion === publicScopeSchemaVersion)
    key.push([publicScopeSchemaVersion, scope.context, scope.projects]);
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
  if (scope.schemaVersion === publicScopeSchemaVersion) {
    params.context = scope.context!;
    if (scope.projects!.length) params.project = scope.projects!.join(",");
  }
  return params;
}
