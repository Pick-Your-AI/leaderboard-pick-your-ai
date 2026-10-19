import { createHash } from "node:crypto";
import { GithubClientError, type GithubReadClient } from "./client.js";

export interface PublicSubjectProjectItem {
  id: string;
  projectId: string;
  updatedAt: string;
  archived: boolean;
  /** Only configured-value identities; labels and free-text values are never retained. */
  fields: { fieldId: string; optionId: string | null }[];
}

/** A complete current association within an explicit public Project scope, including absence. */
export interface PublicSubjectProjectSnapshot {
  schemaVersion: "github-project-subject-context/v1";
  repositoryId: number;
  subjectId: string;
  subjectKind: "issue" | "pull_request";
  sourceUrl: string;
  allowedProjectIds: string[];
  items: PublicSubjectProjectItem[];
}

export interface ProjectWorkstreamMapping {
  version: string;
  projects: {
    projectId: string;
    fields: {
      fieldId: string;
      options: { optionId: string; workstreamId: string }[];
    }[];
  }[];
}

export interface ProjectMembershipContext {
  projects: string[];
  workstreams: string[];
  workstreamsKnown: boolean;
  /** Complete semantic scope proved by the approved mapping, including absent Projects. */
  workstreamScope: string[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const opaque = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_=.:\-]{1,128}$/.test(value);
const order = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
const timestamp = (value: unknown): value is string => {
  // Match the accepted UTC/millisecond profile without rolling invalid dates
  // forward or discarding finer source precision. Preserve valid source spelling.
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
};

function approvedProjects(value: readonly string[]): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 100 ||
    !value.every(opaque) ||
    new Set(value).size !== value.length
  )
    throw new Error("approved_project_scope_required");
  return [...value].sort(order);
}

function subjectKind(sourceUrl: string, slug?: string): "issue" | "pull_request" {
  if (typeof sourceUrl !== "string" || sourceUrl.length > 2048) throw new Error("project_subject_identity_unverified");
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error("project_subject_identity_unverified");
  }
  const match = parsed.pathname.match(/^\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\/(issues|pull)\/([1-9]\d*)$/);
  if (
    parsed.origin !== "https://github.com" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !match ||
    (slug !== undefined && match[1] !== slug) ||
    parsed.href !== sourceUrl
  )
    throw new Error("project_subject_identity_unverified");
  return match[2] === "issues" ? "issue" : "pull_request";
}

function canonicalSnapshot(snapshot: PublicSubjectProjectSnapshot): PublicSubjectProjectSnapshot {
  if (
    !object(snapshot) ||
    !keys(snapshot, [
      "schemaVersion",
      "repositoryId",
      "subjectId",
      "subjectKind",
      "sourceUrl",
      "allowedProjectIds",
      "items",
    ]) ||
    snapshot.schemaVersion !== "github-project-subject-context/v1" ||
    !Number.isSafeInteger(snapshot.repositoryId) ||
    snapshot.repositoryId < 1 ||
    !opaque(snapshot.subjectId) ||
    subjectKind(snapshot.sourceUrl) !== snapshot.subjectKind ||
    !Array.isArray(snapshot.items) ||
    snapshot.items.length > 100
  )
    throw new Error("project_snapshot_unverified_or_budget_exceeded");
  const allowedProjectIds = approvedProjects(snapshot.allowedProjectIds);
  const itemIds = new Set<string>();
  const projectIds = new Set<string>();
  const items = snapshot.items.map((item) => {
    if (
      !object(item) ||
      !keys(item, ["id", "projectId", "updatedAt", "archived", "fields"]) ||
      !opaque(item.id) ||
      !opaque(item.projectId) ||
      !allowedProjectIds.includes(item.projectId) ||
      itemIds.has(item.id) ||
      projectIds.has(item.projectId) ||
      !timestamp(item.updatedAt) ||
      typeof item.archived !== "boolean" ||
      !Array.isArray(item.fields) ||
      item.fields.length > 10000
    )
      throw new Error("project_snapshot_unverified_or_budget_exceeded");
    itemIds.add(item.id);
    projectIds.add(item.projectId);
    const fieldIds = new Set<string>();
    const fields = item.fields.map((field) => {
      if (
        !object(field) ||
        !keys(field, ["fieldId", "optionId"]) ||
        !opaque(field.fieldId) ||
        !(field.optionId === null || opaque(field.optionId)) ||
        fieldIds.has(field.fieldId)
      )
        throw new Error("project_snapshot_unverified_or_budget_exceeded");
      fieldIds.add(field.fieldId);
      return { fieldId: field.fieldId, optionId: field.optionId };
    });
    return {
      id: item.id,
      projectId: item.projectId,
      updatedAt: item.updatedAt,
      archived: item.archived,
      fields: fields.sort((left, right) => order(left.fieldId, right.fieldId)),
    };
  });
  return {
    schemaVersion: "github-project-subject-context/v1",
    repositoryId: snapshot.repositoryId,
    subjectId: snapshot.subjectId,
    subjectKind: snapshot.subjectKind,
    sourceUrl: snapshot.sourceUrl,
    allowedProjectIds,
    items: items.sort((left, right) => order(left.id, right.id)),
  };
}

/** Bind the entire minimized snapshot and its approved scope, independent of connection ordering. */
export function projectSubjectSnapshotRevision(snapshot: PublicSubjectProjectSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalSnapshot(snapshot)))
    .digest("hex");
}

/** Return a canonical detached mapping; names and positional option indexes cannot supply identity. */
export function validateProjectWorkstreamMapping(
  value: unknown,
  allowedProjectIds: readonly string[],
): ProjectWorkstreamMapping {
  const approved = approvedProjects(allowedProjectIds);
  if (
    !object(value) ||
    !keys(value, ["version", "projects"]) ||
    typeof value.version !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,127}$/.test(value.version) ||
    !Array.isArray(value.projects) ||
    value.projects.length > 100
  )
    throw new Error("invalid_project_workstream_mapping");
  const projectIds = new Set<string>();
  const globalFieldIds = new Set<string>();
  let optionCount = 0;
  const projects = value.projects.map((project) => {
    if (
      !object(project) ||
      !keys(project, ["projectId", "fields"]) ||
      !opaque(project.projectId) ||
      !approved.includes(project.projectId) ||
      projectIds.has(project.projectId) ||
      !Array.isArray(project.fields) ||
      !project.fields.length ||
      project.fields.length > 100
    )
      throw new Error("invalid_project_workstream_mapping");
    projectIds.add(project.projectId);
    const fields = project.fields.map((field) => {
      if (
        !object(field) ||
        !keys(field, ["fieldId", "options"]) ||
        !opaque(field.fieldId) ||
        globalFieldIds.has(field.fieldId) ||
        !Array.isArray(field.options) ||
        field.options.length > 1000
      )
        throw new Error("invalid_project_workstream_mapping");
      globalFieldIds.add(field.fieldId);
      const optionIds = new Set<string>();
      const options = field.options.map((option) => {
        if (
          !object(option) ||
          !keys(option, ["optionId", "workstreamId"]) ||
          !opaque(option.optionId) ||
          !opaque(option.workstreamId) ||
          optionIds.has(option.optionId) ||
          ++optionCount > 10000
        )
          throw new Error("invalid_project_workstream_mapping");
        optionIds.add(option.optionId);
        return { optionId: option.optionId, workstreamId: option.workstreamId };
      });
      return { fieldId: field.fieldId, options: options.sort((left, right) => order(left.optionId, right.optionId)) };
    });
    return { projectId: project.projectId, fields: fields.sort((left, right) => order(left.fieldId, right.fieldId)) };
  });
  return { version: value.version, projects: projects.sort((left, right) => order(left.projectId, right.projectId)) };
}

/** Current association only: no editor, event time, historical membership, or additional contribution. */
export function projectContextFromSnapshot(
  snapshot: PublicSubjectProjectSnapshot,
  mapping?: ProjectWorkstreamMapping,
): ProjectMembershipContext {
  const current = canonicalSnapshot(snapshot);
  const configured =
    mapping === undefined ? undefined : validateProjectWorkstreamMapping(mapping, current.allowedProjectIds);
  const workstreamScope = [
    ...new Set(
      (configured?.projects ?? []).flatMap((project) =>
        project.fields.flatMap((field) => field.options.map((option) => option.workstreamId)),
      ),
    ),
  ].sort(order);
  const projects = current.items.map((item) => item.projectId).sort(order);
  const workstreams = new Set<string>();
  let workstreamsKnown = true;
  for (const item of current.items) {
    const project = configured?.projects.find((entry) => entry.projectId === item.projectId);
    if (!project) {
      workstreamsKnown = false;
      continue;
    }
    for (const field of project.fields) {
      const selected = item.fields.find((entry) => entry.fieldId === field.fieldId);
      const option = field.options.find((entry) => selected?.optionId === entry.optionId);
      // Missing/null fields also occur when schema or source detail is unavailable.
      // An explicit current schema proof is needed before treating these as known empty.
      if (option) workstreams.add(option.workstreamId);
      else workstreamsKnown = false;
    }
  }
  return { projects, workstreams: [...workstreams].sort(order), workstreamsKnown, workstreamScope };
}

type Membership = Omit<PublicSubjectProjectItem, "fields">;
type SingleSelect = PublicSubjectProjectItem["fields"][number];

/**
 * Read every page for one native issue/PR, including an explicit empty scoped membership.
 * Compare membership before/after hydration; this is an observed read window, not a GitHub transaction.
 * Legacy Project-item snapshots intentionally retain their separate schema and fingerprint.
 */
export async function readPublicSubjectProjectSnapshot(options: {
  client: GithubReadClient;
  source: string;
  repository: { id: number; slug: string };
  subjectId: string;
  sourceUrl: string;
  allowedProjectIds: readonly string[];
  scanId: string;
  maxPages?: number;
  assertAuthorized?: () => void;
}): Promise<PublicSubjectProjectSnapshot> {
  const approved = approvedProjects(options.allowedProjectIds);
  if (typeof options.repository.slug !== "string" || !options.repository.slug)
    throw new Error("project_subject_identity_unverified");
  const kind = subjectKind(options.sourceUrl, options.repository.slug);
  const typename = kind === "issue" ? "Issue" : "PullRequest";
  const maxPages = options.maxPages ?? 100;
  if (
    !Number.isSafeInteger(options.repository.id) ||
    options.repository.id < 1 ||
    !opaque(options.subjectId) ||
    !opaque(options.scanId) ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 100
  )
    throw new Error("project_subject_identity_unverified");
  const authorize = options.assertAuthorized;
  const binding = (value: unknown) => {
    if (
      !object(value) ||
      value.__typename !== typename ||
      value.id !== options.subjectId ||
      value.url !== options.sourceUrl ||
      !object(value.repository) ||
      value.repository.databaseId !== options.repository.id ||
      value.repository.isPrivate !== false
    )
      throw new Error("project_subject_identity_unverified");
    return value;
  };
  const publicScope = async () => {
    const result = await options.client.graphql<{ nodes?: unknown }>(
      options.source,
      `query PublicProjectContextScope($ids:[ID!]!) { nodes(ids:$ids) { ... on ProjectV2 { id public } } }`,
      { ids: approved },
      authorize,
    );
    if (
      !Array.isArray(result.nodes) ||
      result.nodes.length !== approved.length ||
      !result.nodes.every((project) => object(project) && opaque(project.id) && project.public === true) ||
      JSON.stringify(result.nodes.map((project) => project.id).sort(order)) !== JSON.stringify(approved)
    )
      throw new Error("project_not_authorized");
  };
  const metadata = (value: unknown): Membership | null => {
    if (!object(value) || !object(value.project) || !opaque(value.project.id))
      throw new Error("project_public_scope_unverified");
    // Never hydrate or persist the membership of a Project outside the explicit scope.
    if (!approved.includes(value.project.id)) return null;
    if (value.project.public !== true) throw new Error("project_not_authorized");
    if (!opaque(value.id) || !timestamp(value.updatedAt) || typeof value.isArchived !== "boolean")
      throw new Error("project_public_subject_unverified");
    return { id: value.id, projectId: value.project.id, updatedAt: value.updatedAt, archived: value.isArchived };
  };
  const connection = (value: unknown, previousCount: number | undefined) => {
    if (
      !object(value) ||
      !Array.isArray(value.nodes) ||
      !value.nodes.every(object) ||
      !object(value.pageInfo) ||
      typeof value.pageInfo.hasNextPage !== "boolean" ||
      !(value.pageInfo.endCursor === null || typeof value.pageInfo.endCursor === "string") ||
      !Number.isSafeInteger(value.totalCount) ||
      (value.totalCount as number) < 0 ||
      (value.totalCount as number) > 10000
    )
      throw new Error("project_connection_unavailable_or_budget_exceeded");
    if (previousCount !== undefined && previousCount !== value.totalCount)
      throw new Error("project_snapshot_changed_during_scan");
    return {
      nodes: value.nodes,
      totalCount: value.totalCount as number,
      pageInfo: value.pageInfo as { hasNextPage: boolean; endCursor: string | null },
    };
  };
  const membership = async (phase: "before" | "after"): Promise<Membership[]> => {
    let totalCount: number | undefined;
    const nodes = await options.client.scanGraphql<Membership | null>({
      source: options.source,
      key: `project-subject-context/v1:${options.repository.id}:${options.scanId}:${options.subjectId}:${phase}`,
      refresh: true,
      query: `query PublicSubjectProjectMembership($id:ID!, $first:Int!, $after:String) {
        node(id:$id) { __typename
          ... on ${typename} { id url repository { databaseId isPrivate }
            projectItems(first:$first, after:$after, includeArchived:true) {
              nodes { id updatedAt isArchived project { id public } }
              totalCount pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      variables: { id: options.subjectId },
      maxPages,
      ...(authorize ? { assertAuthorized: authorize } : {}),
      select(data) {
        const subject = binding(object(data) ? data.node : undefined);
        const page = connection(subject.projectItems, totalCount);
        totalCount = page.totalCount;
        return { nodes: page.nodes.map(metadata), pageInfo: page.pageInfo };
      },
    });
    if (totalCount === undefined || nodes.length !== totalCount)
      throw new Error("project_snapshot_unverified_or_budget_exceeded");
    const selected = nodes.filter((node): node is Membership => node !== null);
    if (
      selected.length > approved.length ||
      new Set(selected.map((node) => node.id)).size !== selected.length ||
      new Set(selected.map((node) => node.projectId)).size !== selected.length
    )
      throw new Error("project_snapshot_changed_during_scan");
    return selected.sort((left, right) => order(left.id, right.id));
  };
  try {
    authorize?.();
    await publicScope();
    const before = await membership("before");
    const items: PublicSubjectProjectItem[] = [];
    for (const member of before) {
      let totalCount: number | undefined;
      const fields = await options.client.scanGraphql<SingleSelect | null>({
        source: options.source,
        key: `project-subject-context/v1:${options.repository.id}:${options.scanId}:${member.id}:fields`,
        refresh: true,
        query: `query PublicSubjectProjectFields($id:ID!, $first:Int!, $after:String) {
          node(id:$id) { ... on ProjectV2Item {
            id updatedAt isArchived project { id public }
            content { __typename
              ... on Issue { id url repository { databaseId isPrivate } }
              ... on PullRequest { id url repository { databaseId isPrivate } }
            }
            fieldValues(first:$first, after:$after) {
              nodes { __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  field { ... on ProjectV2SingleSelectField { id } } optionId
                }
              }
              totalCount pageInfo { hasNextPage endCursor }
            }
          } }
        }`,
        variables: { id: member.id },
        maxPages,
        ...(authorize ? { assertAuthorized: authorize } : {}),
        select(data) {
          const item = object(data) && object(data.node) ? data.node : undefined;
          if (!item) throw new Error("project_public_subject_unverified");
          binding(item.content);
          if (JSON.stringify(metadata(item)) !== JSON.stringify(member))
            throw new Error("project_snapshot_changed_during_scan");
          const page = connection(item.fieldValues, totalCount);
          totalCount = page.totalCount;
          return {
            nodes: page.nodes.map((value): SingleSelect | null => {
              if (typeof value.__typename !== "string") throw new Error("project_field_connection_unavailable");
              if (value.__typename !== "ProjectV2ItemFieldSingleSelectValue") return null;
              if (
                !object(value.field) ||
                !opaque(value.field.id) ||
                !(value.optionId === null || opaque(value.optionId))
              )
                throw new Error("project_field_connection_unavailable");
              return { fieldId: value.field.id, optionId: value.optionId };
            }),
            pageInfo: page.pageInfo,
          };
        },
      });
      if (totalCount === undefined || fields.length !== totalCount)
        throw new Error("project_snapshot_unverified_or_budget_exceeded");
      const selected = fields.filter((field): field is SingleSelect => field !== null);
      if (new Set(selected.map((field) => field.fieldId)).size !== selected.length)
        throw new Error("project_snapshot_changed_during_scan");
      items.push({ ...member, fields: selected });
    }
    const after = await membership("after");
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("project_snapshot_changed_during_scan");
    await publicScope();
    authorize?.();
    return canonicalSnapshot({
      schemaVersion: "github-project-subject-context/v1",
      repositoryId: options.repository.id,
      subjectId: options.subjectId,
      subjectKind: kind,
      sourceUrl: options.sourceUrl,
      allowedProjectIds: approved,
      items,
    });
  } catch (error) {
    if (
      error instanceof GithubClientError &&
      ["authentication_required", "permission_denied", "not_found_or_hidden"].includes(error.outcome.kind)
    )
      throw new Error("project_not_authorized");
    throw error;
  }
}
