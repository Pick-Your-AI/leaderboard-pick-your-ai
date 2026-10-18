import { createHash } from "node:crypto";
import type { GithubReadClient } from "./client.js";

export interface PublicProjectSnapshot {
  id: string;
  projectId: string;
  sourceUrl: string;
  updatedAt: string;
  archived: boolean;
  /** No text, owners or inferred historic editors are retained. */
  fields: Record<string, unknown>[];
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const projectSnapshotRevision = (snapshot: PublicProjectSnapshot): string =>
  createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

/** Read one complete public Project item snapshot through bounded nested pagination. */
export async function readPublicProjectSnapshot(options: {
  client: GithubReadClient;
  source: string;
  repository: { id: number; slug: string };
  itemId: string;
  scanId: string;
  maxPages?: number;
  assertAuthorized?: () => void;
}): Promise<PublicProjectSnapshot> {
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
            ... on ProjectV2ItemFieldSingleSelectValue { id optionId field { ... on ProjectV2SingleSelectField { id } } }
            ... on ProjectV2ItemFieldNumberValue { id number field { ... on ProjectV2Field { id } } }
            ... on ProjectV2ItemFieldDateValue { id date field { ... on ProjectV2Field { id } } }
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
        nodes: item.fieldValues.nodes,
        pageInfo: item.fieldValues.pageInfo as { hasNextPage: boolean; endCursor: string | null },
      };
    },
  });
  // Completed checkpoint reads may skip select; refresh ensures scope and snapshot
  // metadata are revalidated rather than trusting a connection cache alone.
  if (!snapshot || fields.length > 10000) throw new Error("project_snapshot_unverified_or_budget_exceeded");
  return { ...snapshot, fields };
}
