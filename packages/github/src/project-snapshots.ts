import { createHash } from "node:crypto";
import { GithubClientError, type GithubReadClient } from "./client.js";

export interface PublicProjectSnapshot {
  id: string;
  projectId: string;
  sourceUrl: string;
  updatedAt: string;
  archived: boolean;
  /** Only field identities/types; no field values or inferred historic editors. */
  fields: Record<string, unknown>[];
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const fieldIdentity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128 && !/[^A-Za-z0-9_=.:+\/-]/.test(value);

function projectFieldIdentity(value: Record<string, unknown>): Record<string, unknown> {
  const typename = value.__typename;
  if (
    !Object.hasOwn(value, "__typename") ||
    typeof typename !== "string" ||
    typename.length > 128 ||
    !/^ProjectV2ItemField[A-Za-z]+Value(?![\s\S])/.test(typename)
  )
    throw new Error("project_field_identity_unverified");
  if (
    ![
      "ProjectV2ItemFieldSingleSelectValue",
      "ProjectV2ItemFieldNumberValue",
      "ProjectV2ItemFieldDateValue",
    ].includes(typename)
  )
    return { __typename: typename };
  const id = value.id;
  const field = value.field;
  if (
    !Object.hasOwn(value, "id") ||
    !Object.hasOwn(value, "field") ||
    !fieldIdentity(id) ||
    !object(field) ||
    !Object.hasOwn(field, "id") ||
    !fieldIdentity(field.id)
  )
    throw new Error("project_field_identity_unverified");
  // Preserve the key order of already-minimal snapshots and their revisions.
  // The selected page is checkpointed before the normalizer checks its revision.
  const selected: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key === "__typename") selected[key] = typename;
    else if (key === "id") selected[key] = id;
    else if (key === "field") selected[key] = { id: field.id };
  }
  return selected;
}
export const projectSnapshotRevision = (snapshot: PublicProjectSnapshot): string =>
  createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

/** Verify every explicitly approved Project even when no current membership is visible. */
export async function assertPublicProjects(options: {
  client: GithubReadClient;
  source: string;
  allowedProjectIds: readonly string[];
  assertAuthorized?: () => void;
}): Promise<void> {
  if (
    !Array.isArray(options.allowedProjectIds) ||
    !options.allowedProjectIds.length ||
    options.allowedProjectIds.length > 100 ||
    !options.allowedProjectIds.every((id) => typeof id === "string" && /^[A-Za-z0-9_=.-]{1,128}$/.test(id))
  )
    throw new Error("approved_project_scope_required");
  for (const id of options.allowedProjectIds) {
    let result;
    try {
      result = await options.client.graphql<{ node?: { id?: string; public?: boolean } }>(
        options.source,
        `query($id:ID!) { node(id:$id) { ... on ProjectV2 { id public } } }`,
        { id },
        options.assertAuthorized,
      );
    } catch (error) {
      if (
        error instanceof GithubClientError &&
        ["authentication_required", "permission_denied", "not_found_or_hidden"].includes(error.outcome.kind)
      )
        throw new Error("project_not_authorized");
      throw error;
    }
    if (result.node?.id !== id || result.node?.public !== true) throw new Error("project_not_authorized");
  }
}

/** Read one complete public Project item snapshot through bounded nested pagination. */
export async function readPublicProjectSnapshot(options: {
  client: GithubReadClient;
  source: string;
  repository: { id: number; slug: string };
  itemId: string;
  allowedProjectIds: readonly string[];
  scanId: string;
  maxPages?: number;
  assertAuthorized?: () => void;
}): Promise<PublicProjectSnapshot> {
  if (
    !Array.isArray(options.allowedProjectIds) ||
    !options.allowedProjectIds.length ||
    !options.allowedProjectIds.every((id) => typeof id === "string" && /^[A-Za-z0-9_=.-]{1,128}$/.test(id))
  )
    throw new Error("approved_project_scope_required");
  const probe = await options.client.graphql<{ node?: { project?: { id?: string; public?: boolean } } }>(
    options.source,
    `query($id:ID!) { node(id:$id) { ... on ProjectV2Item { project { id public } } } }`,
    { id: options.itemId },
    options.assertAuthorized,
  );
  if (
    probe.node?.project?.public !== true ||
    !probe.node.project.id ||
    !options.allowedProjectIds.includes(probe.node.project.id)
  )
    throw new Error("project_not_authorized");
  const approvedProjectId = probe.node.project.id;
  let snapshot: Omit<PublicProjectSnapshot, "fields"> | undefined;
  const fields = await options.client.scanGraphql<Record<string, unknown>>({
    refresh: true,
    source: options.source,
    key: `project-item:${options.repository.id}:${options.scanId}:${options.itemId}`,
    query: `query($id:ID!, $first:Int!, $after:String) {
      node(id:$id) { ... on ProjectV2Item {
        id updatedAt isArchived project { id public }
        content { ... on Issue { url repository { databaseId isPrivate } } ... on PullRequest { url repository { databaseId isPrivate } } }
        fieldValues(first:$first, after:$after) {
          nodes { __typename
            ... on ProjectV2ItemFieldSingleSelectValue { id field { ... on ProjectV2SingleSelectField { id } } }
            ... on ProjectV2ItemFieldNumberValue { id field { ... on ProjectV2Field { id } } }
            ... on ProjectV2ItemFieldDateValue { id field { ... on ProjectV2Field { id } } }
          }
          pageInfo { hasNextPage endCursor }
        }
      } }
    }`,
    variables: { id: options.itemId },
    maxPages: options.maxPages ?? 100,
    ...(options.assertAuthorized ? { assertAuthorized: options.assertAuthorized } : {}),
    select(data) {
      const item = object(data) && object(data.node) ? data.node : null;
      if (
        !item ||
        item.id !== options.itemId ||
        !object(item.project) ||
        item.project.public !== true ||
        item.project.id !== approvedProjectId ||
        typeof item.project.id !== "string" ||
        !object(item.content) ||
        !object(item.content.repository) ||
        item.content.repository.databaseId !== options.repository.id ||
        item.content.repository.isPrivate !== false ||
        typeof item.content.url !== "string" ||
        !item.content.url.startsWith(`https://github.com/${options.repository.slug}/`) ||
        typeof item.updatedAt !== "string" ||
        typeof item.isArchived !== "boolean"
      )
        throw new Error("project_public_subject_unverified");
      const next = {
        id: options.itemId,
        projectId: item.project.id,
        sourceUrl: item.content.url,
        updatedAt: item.updatedAt,
        archived: item.isArchived,
      };
      if (snapshot && JSON.stringify(snapshot) !== JSON.stringify(next))
        throw new Error("project_snapshot_changed_during_scan");
      snapshot = next;
      if (
        !object(item.fieldValues) ||
        !Array.isArray(item.fieldValues.nodes) ||
        !object(item.fieldValues.pageInfo) ||
        !item.fieldValues.nodes.every(object)
      )
        throw new Error("project_field_connection_unavailable");
      return {
        nodes: item.fieldValues.nodes.map(projectFieldIdentity),
        pageInfo: item.fieldValues.pageInfo as { hasNextPage: boolean; endCursor: string | null },
      };
    },
  });
  // Completed checkpoint reads may skip select; refresh ensures scope and snapshot
  // metadata are revalidated rather than trusting a connection cache alone.
  if (!snapshot || fields.length > 10000) throw new Error("project_snapshot_unverified_or_budget_exceeded");
  return { ...snapshot, fields };
}
