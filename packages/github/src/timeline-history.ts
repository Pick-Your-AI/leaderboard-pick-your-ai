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

function assertRelationshipEvent(event: unknown, repository: { id: number; slug: string }): void {
  if (!object(event) || typeof event.id !== "string" || !event.id.trim() || typeof event.createdAt !== "string")
    throw new Error("typed_history_event_unverified");
  let field: "parent" | "blockingIssue";
  switch (event.__typename) {
    case "ParentIssueAddedEvent":
    case "ParentIssueRemovedEvent":
      field = "parent";
      break;
    case "BlockedByAddedEvent":
    case "BlockedByRemovedEvent":
      field = "blockingIssue";
      break;
    default:
      throw new Error("typed_history_event_unverified");
  }
  const otherField = field === "parent" ? "blockingIssue" : "parent";
  if (event[otherField] !== undefined && event[otherField] !== null) throw new Error("typed_history_event_unverified");
  const target = event[field];
  const prefix = `https://github.com/${repository.slug}/issues/`;
  if (
    !object(target) ||
    !object(target.repository) ||
    target.repository.isPrivate !== false ||
    target.repository.databaseId !== repository.id ||
    typeof target.id !== "string" ||
    !target.id.trim() ||
    typeof target.url !== "string" ||
    !target.url.startsWith(prefix) ||
    !/^[1-9][0-9]*$/.test(target.url.slice(prefix.length)) ||
    !Number.isSafeInteger(Number(target.url.slice(prefix.length)))
  )
    throw new Error("relationship_endpoint_not_authorized");
}

/** Selected native issue/PR histories only; no reconstruction from current Project/relationship fields. */
export async function readTypedIssueHistory(options: {
  client: GithubReadClient;
  source: string;
  repository: { id: number; slug: string; allowedProjectIds?: readonly string[] };
  number: number;
  /** Project status history supports both subjects; native relationships remain issue-only. */
  subjectType?: "issue" | "pull_request";
  /** Bind collection to the stable node identity obtained from the repository inventory. */
  subjectId?: string;
  family: "relationships" | "project_history";
  scanId: string;
  /** Native event lower bound only; callers still retain their exact requested interval. */
  since?: string;
  maxPages?: number;
  assertAuthorized?: () => void;
}): Promise<TypedHistoryRecord[]> {
  if (options.since !== undefined) {
    const value = options.since;
    const date = new Date(value);
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ||
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 19) !== value.slice(0, 19)
    )
      throw new Error("invalid_typed_history_window");
  }
  const subjectType = options.subjectType ?? "issue";
  if (
    !["issue", "pull_request"].includes(subjectType) ||
    (options.family === "relationships" && subjectType !== "issue")
  )
    throw new Error("typed_history_subject_kind_unsupported");
  const subjectField = subjectType === "pull_request" ? "pullRequest" : "issue";
  const subjectPath = subjectType === "pull_request" ? "pull" : "issues";
  const subjectKey = subjectType === "pull_request" ? `pull_request:${options.number}` : options.number;
  const subjectError =
    options.family === "project_history" ? "project_subject_identity_unverified" : "typed_history_subject_unverified";
  if (
    !Number.isSafeInteger(options.number) ||
    options.number < 1 ||
    (options.subjectId !== undefined && (typeof options.subjectId !== "string" || !options.subjectId.trim()))
  )
    throw new Error(subjectError);
  const subjectUrl = `https://github.com/${options.repository.slug}/${subjectPath}/${options.number}`;
  let verifiedSubjectId = options.subjectId;
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
    // Legacy completed scans did not bind stable subject identity. Revalidate them with a new checkpoint key.
    key: `typed-history:subject-v2:${options.repository.id}:${options.family}:${subjectKey}:${options.scanId}${options.since === undefined ? "" : ":since:" + options.since}`,
    query: `query($owner:String!, $name:String!, $number:Int!, $first:Int!, $after:String${options.since === undefined ? "" : ", $since:DateTime!"}) {
      repository(owner:$owner,name:$name) { databaseId isPrivate ${subjectField}(number:$number) {
        id url timelineItems(first:$first,after:$after,itemTypes:[${types}]${options.since === undefined ? "" : ",since:$since"}) {
          nodes { __typename ${fragments} } pageInfo { hasNextPage endCursor }
        }
      } }
    }`,
    variables: {
      owner,
      name,
      number: options.number,
      ...(options.since === undefined ? {} : { since: options.since }),
    },
    maxPages: options.maxPages ?? 100,
    ...(options.assertAuthorized ? { assertAuthorized: options.assertAuthorized } : {}),
    select(data) {
      const repo = object(data) && object(data.repository) ? data.repository : null;
      const item = repo?.[subjectField];
      if (
        !repo ||
        repo.databaseId !== options.repository.id ||
        repo.isPrivate !== false ||
        !object(item) ||
        typeof item.id !== "string" ||
        !item.id.trim() ||
        (verifiedSubjectId !== undefined && item.id !== verifiedSubjectId) ||
        item.url !== subjectUrl ||
        !object(item.timelineItems) ||
        !Array.isArray(item.timelineItems.nodes) ||
        !object(item.timelineItems.pageInfo)
      )
        throw new Error(subjectError);
      verifiedSubjectId = item.id;
      const subject = { id: item.id, url: item.url as string };
      return {
        nodes: item.timelineItems.nodes.map((event): TypedHistoryRecord => {
          if (!object(event) || typeof event.id !== "string" || typeof event.createdAt !== "string")
            throw new Error("typed_history_event_unverified");
          return { event, subject };
        }),
        pageInfo: item.timelineItems.pageInfo as { hasNextPage: boolean; endCursor: string | null },
      };
    },
  });
  if (records.length > 10000) throw new Error("typed_history_budget_exceeded");
  const result: TypedHistoryRecord[] = [];
  const seen = new Set();
  for (const record of records) {
    // A resumed or completed checkpoint can return earlier pages without invoking select again.
    if (
      !object(record.subject) ||
      typeof record.subject.id !== "string" ||
      !record.subject.id.trim() ||
      record.subject.url !== subjectUrl ||
      (verifiedSubjectId !== undefined && record.subject.id !== verifiedSubjectId)
    )
      throw new Error(subjectError);
    verifiedSubjectId = record.subject.id;
    // Cached pages must prove the selected native type and its own endpoint too.
    if (options.family === "relationships") assertRelationshipEvent(record.event, options.repository);
    if (seen.has(record.event.id)) throw new Error("typed_history_duplicate_event");
    seen.add(record.event.id);
    if (options.family === "relationships") {
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
