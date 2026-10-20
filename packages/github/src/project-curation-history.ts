import { createHash } from "node:crypto";
import type { GithubReadClient } from "./client.js";
import { assertPublicProjects } from "./project-snapshots.js";

export const projectCurationNormalizationVersion = "project-curation-history/v1";

export interface ProjectCurationRecord {
  subject: { id: string; url: string; kind: "issue" | "pull_request" };
  event: {
    id: string;
    __typename: "AddedToProjectV2Event" | "RemovedFromProjectV2Event";
    createdAt: string;
    wasAutomated: boolean;
    actor: Record<string, unknown> | null;
    project: { id: string; public: true };
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nativeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_=.:\-]{1,128}$/.test(value);
}
function sourceTime(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19)
    ? parsed.toISOString()
    : null;
}
function actor(value: unknown): Record<string, unknown> | null {
  if (!object(value)) return null;
  // Missing identity stays unknown. Do not infer an actor from a creator,
  // assignee, login or current Project item, and never retain arbitrary fields.
  return {
    ...(typeof value.__typename === "string" && /^[A-Za-z]{1,32}$/.test(value.__typename)
      ? { __typename: value.__typename }
      : {}),
    ...(nativeId(value.id) ? { id: value.id } : {}),
    ...(typeof value.databaseId === "number" && Number.isSafeInteger(value.databaseId) && value.databaseId > 0
      ? { databaseId: value.databaseId }
      : {}),
    ...(typeof value.login === "string" && /^[A-Za-z0-9_\-\[\]]{1,100}$/.test(value.login)
      ? { login: value.login }
      : {}),
  };
}

export function projectCurationHistoryRevision(record: ProjectCurationRecord): string {
  return createHash("sha256")
    .update(JSON.stringify([projectCurationNormalizationVersion, record]))
    .digest("hex");
}

/** Native add/remove events have no ProjectV2Item ID. Bind the actual subject,
 * Project and event; never synthesize a PVTI identity from a current snapshot.
 * This independent capability does not broaden the existing status reader.
 */
export async function readProjectCurationHistory(options: {
  client: GithubReadClient;
  source: string;
  repository: { id: number; slug: string; allowedProjectIds?: readonly string[] };
  number: number;
  subjectType: "issue" | "pull_request";
  subjectId: string;
  scanId: string;
  maxPages?: number;
  assertAuthorized?: () => void;
}): Promise<ProjectCurationRecord[]> {
  const { number, subjectType, subjectId, scanId, source, assertAuthorized } = options;
  // Capture the exact native scope before the first awaited transport callback.
  const repository = {
    id: options.repository.id,
    slug: options.repository.slug,
    allowedProjectIds: [...(options.repository.allowedProjectIds ?? [])],
  };
  const maxPages = options.maxPages ?? 100;
  if (
    !Number.isSafeInteger(repository.id) ||
    repository.id < 1 ||
    !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository.slug) ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !["issue", "pull_request"].includes(subjectType) ||
    !nativeId(subjectId) ||
    typeof scanId !== "string" ||
    !scanId.length ||
    scanId.length > 512 ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 1000
  )
    throw new Error("project_curation_subject_identity_unverified");
  const client = options.client.forRepository(repository.id);
  const allowedProjectIds = [...(repository.allowedProjectIds ?? [])];
  const [owner, name] = repository.slug.split("/");
  const field = subjectType === "issue" ? "issue" : "pullRequest";
  const expected = {
    id: subjectId,
    url: "https://github.com/" + repository.slug + "/" + (subjectType === "issue" ? "issues/" : "pull/") + number,
    kind: subjectType,
  };
  const readSubject = (data: unknown) => {
    const repo = object(data) && object(data.repository) ? data.repository : null;
    const rawSubject = repo?.[field];
    const subject = object(rawSubject) ? rawSubject : null;
    if (!repo || repo.databaseId !== repository.id || repo.isPrivate !== false)
      throw new Error("project_curation_scope_unverified");
    if (!subject || subject.id !== expected.id || subject.url !== expected.url)
      throw new Error("project_curation_subject_identity_unverified");
    return subject;
  };
  const readEvent = (value: unknown): ProjectCurationRecord | null => {
    const createdAt = object(value) ? sourceTime(value.createdAt) : null;
    if (
      !object(value) ||
      !nativeId(value.id) ||
      (value.__typename !== "AddedToProjectV2Event" && value.__typename !== "RemovedFromProjectV2Event") ||
      createdAt === null ||
      typeof value.wasAutomated !== "boolean"
    )
      throw new Error("project_curation_event_unverified");
    if (!object(value.project) || !nativeId(value.project.id)) throw new Error("project_curation_scope_unverified");
    if (!allowedProjectIds.includes(value.project.id)) return null;
    if (value.project.public !== true) throw new Error("project_curation_scope_unverified");
    return {
      subject: { ...expected },
      event: {
        id: value.id,
        __typename: value.__typename,
        createdAt,
        wasAutomated: value.wasAutomated,
        actor: actor(value.actor),
        project: { id: value.project.id, public: true },
      },
    };
  };
  await assertPublicProjects({ client, source, allowedProjectIds, ...(assertAuthorized ? { assertAuthorized } : {}) });
  const fields =
    "id createdAt wasAutomated project { id public } " +
    "actor { __typename login ... on User { id databaseId } ... on Bot { id databaseId } }";
  let scanned = 0;
  const seen = new Set<string>();
  const records = await client.scanGraphql<ProjectCurationRecord>({
    source,
    key: "project-curation:subject-v1:" + JSON.stringify([repository.id, subjectType, number, subjectId, scanId]),
    query:
      "query($owner:String!, $name:String!, $number:Int!, $first:Int!, $after:String) {" +
      " repository(owner:$owner, name:$name) { databaseId isPrivate " +
      field +
      "(number:$number) { id url " +
      "timelineItems(first:$first, after:$after, itemTypes:[ADDED_TO_PROJECT_V2_EVENT,REMOVED_FROM_PROJECT_V2_EVENT]) {" +
      " nodes { __typename ... on AddedToProjectV2Event { " +
      fields +
      " } ... on RemovedFromProjectV2Event { " +
      fields +
      " } } pageInfo { hasNextPage endCursor } } } } }",
    variables: { owner, name, number },
    first: 100,
    maxPages,
    refresh: true,
    ...(assertAuthorized ? { assertAuthorized } : {}),
    select(data) {
      const subject = readSubject(data);
      const connection = object(subject.timelineItems) ? subject.timelineItems : null;
      const pageInfo = connection && object(connection.pageInfo) ? connection.pageInfo : null;
      if (
        !connection ||
        !Array.isArray(connection.nodes) ||
        connection.nodes.length > 100 ||
        !pageInfo ||
        typeof pageInfo.hasNextPage !== "boolean" ||
        !(pageInfo.endCursor === null || typeof pageInfo.endCursor === "string") ||
        (pageInfo.hasNextPage && !pageInfo.endCursor)
      )
        throw new Error("project_curation_event_unverified");
      scanned += connection.nodes.length;
      if (scanned > 10000) throw new Error("project_curation_history_budget_exceeded");
      const nodes: ProjectCurationRecord[] = [];
      for (const value of connection.nodes) {
        const record = readEvent(value);
        if (!object(value) || !nativeId(value.id) || seen.has(value.id))
          throw new Error("project_curation_event_identity_ambiguous");
        seen.add(value.id);
        if (record) nodes.push(record);
      }
      return { nodes, pageInfo: { hasNextPage: pageInfo.hasNextPage, endCursor: pageInfo.endCursor } };
    },
  });
  if (!Array.isArray(records) || records.length > 10000) throw new Error("project_curation_history_budget_exceeded");
  // Validate returned records independently of the scan callback/checkpoint.
  const retained = new Set<string>();
  const checked: ProjectCurationRecord[] = [];
  for (const value of records) {
    if (
      !object(value) ||
      !object(value.subject) ||
      value.subject.id !== expected.id ||
      value.subject.url !== expected.url ||
      value.subject.kind !== expected.kind
    )
      throw new Error("project_curation_subject_identity_unverified");
    const record = readEvent(value.event);
    if (!record || retained.has(record.event.id)) throw new Error("project_curation_event_identity_ambiguous");
    retained.add(record.event.id);
    checked.push(record);
  }
  readSubject(
    await client.graphql(
      source,
      "query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner, name:$name) {" +
        " databaseId isPrivate " +
        field +
        "(number:$number) { id url } } }",
      { owner, name, number },
      assertAuthorized,
    ),
  );
  await assertPublicProjects({ client, source, allowedProjectIds, ...(assertAuthorized ? { assertAuthorized } : {}) });
  assertAuthorized?.();
  return checked;
}
