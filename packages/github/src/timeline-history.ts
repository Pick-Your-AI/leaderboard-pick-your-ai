import { createHash } from "node:crypto";
import { assertPublicProjects } from "./project-snapshots.js";
import type { GithubReadClient } from "./client.js";
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export interface TypedHistoryRecord {
  event: Record<string, unknown>;
  subject: { id: string; url: string };
}
export const typedHistoryRevision = (value: TypedHistoryRecord): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Selected native histories only; no reconstruction from current Project/relationship fields. */
export async function readTypedIssueHistory(options: {
  client: GithubReadClient;
  source: string;
  repository: { id: number; slug: string; allowedProjectIds?: readonly string[] };
  number: number;
  family: "relationships" | "project_history";
  scanId: string;
  maxPages?: number;
  assertAuthorized?: () => void;
}): Promise<TypedHistoryRecord[]> {
  if (
    options.family === "project_history" &&
    (!Array.isArray(options.repository.allowedProjectIds) ||
      !options.repository.allowedProjectIds.length ||
      !options.repository.allowedProjectIds.every(
        (id) => typeof id === "string" && /^[A-Za-z0-9_=.-]{1,128}$/.test(id),
      ))
  )
    throw new Error("approved_project_scope_required");
  if (options.family === "project_history")
    await assertPublicProjects({
      client: options.client,
      source: options.source,
      allowedProjectIds: options.repository.allowedProjectIds ?? [],
      ...(options.assertAuthorized ? { assertAuthorized: options.assertAuthorized } : {}),
    });
  const [owner, name] = options.repository.slug.split("/");
  const actor = "actor { __typename login ... on User { id databaseId } ... on Bot { id databaseId } }";
  const endpoints = "id url repository { databaseId isPrivate }";
  const fragments =
    options.family === "relationships"
      ? `
    ... on ParentIssueAddedEvent { id createdAt ${actor} parent { ${endpoints} } }
    ... on ParentIssueRemovedEvent { id createdAt ${actor} parent { ${endpoints} } }
    ... on BlockedByAddedEvent { id createdAt ${actor} blockingIssue { ${endpoints} } }
    ... on BlockedByRemovedEvent { id createdAt ${actor} blockingIssue { ${endpoints} } }
  `
      : `... on ProjectV2ItemStatusChangedEvent { id createdAt wasAutomated ${actor} project { id public } }`;
  const types =
    options.family === "relationships"
      ? "PARENT_ISSUE_ADDED_EVENT,PARENT_ISSUE_REMOVED_EVENT,BLOCKED_BY_ADDED_EVENT,BLOCKED_BY_REMOVED_EVENT"
      : "PROJECT_V2_ITEM_STATUS_CHANGED_EVENT";
  const records = await options.client.scanGraphql<TypedHistoryRecord>({
    source: options.source,
    key: `typed-history:${options.repository.id}:${options.family}:${options.number}:${options.scanId}`,
    query: `query($owner:String!, $name:String!, $number:Int!, $first:Int!, $after:String) {
      repository(owner:$owner,name:$name) { databaseId isPrivate issue(number:$number) {
        id url timelineItems(first:$first,after:$after,itemTypes:[${types}]) {
          nodes { __typename ${fragments} } pageInfo { hasNextPage endCursor }
        }
      } }
    }`,
    variables: { owner, name, number: options.number },
    maxPages: options.maxPages ?? 100,
    ...(options.assertAuthorized ? { assertAuthorized: options.assertAuthorized } : {}),
    select(data) {
      const repo = object(data) && object(data.repository) ? data.repository : null;
      if (
        !repo ||
        repo.databaseId !== options.repository.id ||
        repo.isPrivate !== false ||
        !object(repo.issue) ||
        typeof repo.issue.id !== "string" ||
        repo.issue.url !== `https://github.com/${options.repository.slug}/issues/${options.number}` ||
        !object(repo.issue.timelineItems) ||
        !Array.isArray(repo.issue.timelineItems.nodes) ||
        !object(repo.issue.timelineItems.pageInfo)
      )
        throw new Error("typed_history_subject_unverified");
      const subject = { id: repo.issue.id, url: repo.issue.url as string };
      return {
        nodes: repo.issue.timelineItems.nodes.map((event): TypedHistoryRecord => {
          if (!object(event) || typeof event.id !== "string" || typeof event.createdAt !== "string")
            throw new Error("typed_history_event_unverified");
          return { event, subject };
        }),
        pageInfo: repo.issue.timelineItems.pageInfo as { hasNextPage: boolean; endCursor: string | null },
      };
    },
  });
  if (records.length > 10000) throw new Error("typed_history_budget_exceeded");
  const result: TypedHistoryRecord[] = [];
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.event.id)) throw new Error("typed_history_duplicate_event");
    seen.add(record.event.id);
    if (options.family === "relationships") {
      const target = record.event.parent ?? record.event.blockingIssue;
      if (
        !object(target) ||
        !object(target.repository) ||
        target.repository.isPrivate !== false ||
        target.repository.databaseId !== options.repository.id ||
        typeof target.id !== "string" ||
        typeof target.url !== "string" ||
        !target.url.startsWith(`https://github.com/${options.repository.slug}/issues/`)
      )
        throw new Error("relationship_endpoint_not_authorized");
      result.push(record);
    } else {
      const project = record.event.project;
      if (!object(project) || !options.repository.allowedProjectIds?.includes(String(project.id))) continue;
      if (project.public !== true) throw new Error("project_public_scope_unverified");
      const data = await options.client.graphql<{ node?: Record<string, unknown> }>(
        options.source,
        `query($id:ID!) { node(id:$id) { ... on ProjectV2ItemStatusChangedEvent { id createdAt wasAutomated ${actor} previousStatus status project { id public } } } }`,
        { id: record.event.id },
        options.assertAuthorized,
      );
      const detail = data.node;
      if (
        !detail ||
        detail.id !== record.event.id ||
        detail.createdAt !== record.event.createdAt ||
        detail.wasAutomated !== record.event.wasAutomated ||
        typeof detail.wasAutomated !== "boolean" ||
        !object(detail.project) ||
        detail.project.id !== project.id ||
        detail.project.public !== true ||
        typeof detail.previousStatus !== "string" ||
        typeof detail.status !== "string"
      )
        throw new Error("project_history_scope_unverified");
      result.push({ ...record, event: { ...detail, __typename: record.event.__typename } });
    }
  }
  return result;
}
