import { createHash } from "node:crypto";
import type { GithubReadClient } from "./client.js";

export type ContentEditActor =
  null | { kind: "User" | "Bot"; id: string; databaseId: number | null } | { kind: "unknown"; typename: string };

export interface NativeContentEdit {
  id: string;
  createdAt: string;
  editedAt: string;
  updatedAt: string;
  editor: ContentEditActor;
  deletedAt: string | null;
  deletedBy: ContentEditActor;
}

export interface ContentEditParent {
  kind: "issue" | "pull_request";
  id: string;
  number: number;
  url: string;
}

export interface ContentEditMetadata {
  version: "github-content-edit-metadata/v1";
  parent: ContentEditParent;
  includesCreatedEdit: boolean;
  history:
    | { availability: "available"; retainedTotalCount: number; records: NativeContentEdit[] }
    | { availability: "unavailable"; retainedTotalCount: null; records: null };
}

export interface ContentEditParentInventory {
  parentTotals: { issues: number; pullRequests: number };
  snapshots: ContentEditMetadata[];
}

export interface ContentEditReadOptions {
  client: GithubReadClient;
  source: string;
  repository: { id: number; slug: string };
  scanId: string;
  first?: number;
  maxPages?: number;
  maxParents?: number;
  maxEdits?: number;
  assertAuthorized?: () => void;
}

type Repository = ContentEditReadOptions["repository"];
type Kind = ContentEditParent["kind"];
type PageInfo = { hasNextPage: boolean; endCursor: string | null };
interface ParentPage {
  version: "github-content-edit-parent-page/v1";
  repository: Repository;
  kind: Kind;
  totalCount: number;
  parents: ContentEditParent[];
  pageInfo: PageInfo;
}
interface EditPage {
  version: "github-content-edit-metadata-page/v1";
  repository: Repository;
  parent: ContentEditParent;
  includesCreatedEdit: boolean;
  availability: "available" | "unavailable";
  retainedTotalCount: number | null;
  records: NativeContentEdit[] | null;
  pageInfo: PageInfo;
}
interface Captured {
  client: GithubReadClient;
  source: string;
  repository: Repository;
  scanId: string;
  first: number;
  maxPages: number;
  maxParents: number;
  maxEdits: number;
  assertAuthorized: (() => void) | undefined;
  key: string;
}

const version = "github-content-edit-metadata/v1";
const revisionPrefix = "gh-content-edit-v1:";
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (reason: string): never => {
  throw new TypeError(`github_content_edit_${reason}`);
};
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const keys = (value: unknown, expected: readonly string[]): Record<string, unknown> => {
  if (
    !object(value) ||
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    return fail("invalid_shape");
  return value;
};
const integer = (value: unknown, minimum: number, maximum: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    return fail("invalid_integer");
  return value;
};
// IDs are opaque, bounded native values. No identity is synthesized from a login or URL.
const identifier = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\s\u0000-\u001f\u007f]/u.test(value))
    return fail("invalid_identity");
  return value;
};
const typename = (value: unknown): string => {
  if (typeof value !== "string" || !/^[_A-Za-z][_0-9A-Za-z]{0,127}$/.test(value)) return fail("invalid_actor");
  return value;
};
const timestamp = (value: unknown): string => {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))
    return fail("invalid_timestamp");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19))
    return fail("invalid_timestamp");
  return date.toISOString();
};

function actor(value: unknown): ContentEditActor {
  if (value === null) return null;
  if (!object(value)) return fail("invalid_actor");
  if (value.kind === "unknown") {
    const entry = keys(value, ["kind", "typename"]);
    const type = typename(entry.typename);
    if (type === "User" || type === "Bot") return fail("invalid_actor");
    return { kind: "unknown", typename: type };
  }
  const entry = keys(value, ["kind", "id", "databaseId"]);
  if (entry.kind !== "User" && entry.kind !== "Bot") return fail("invalid_actor");
  return {
    kind: entry.kind,
    id: identifier(entry.id),
    databaseId: entry.databaseId === null ? null : integer(entry.databaseId, 1, Number.MAX_SAFE_INTEGER),
  };
}

function nativeActor(value: unknown): ContentEditActor {
  if (value === null) return null;
  if (!object(value)) return fail("invalid_actor");
  const type = typename(value.__typename);
  return actor(
    type === "User" || type === "Bot"
      ? { kind: type, id: value.id, databaseId: value.databaseId }
      : { kind: "unknown", typename: type },
  );
}

function edit(value: unknown): NativeContentEdit {
  const entry = keys(value, ["id", "createdAt", "editedAt", "updatedAt", "editor", "deletedAt", "deletedBy"]);
  return {
    id: identifier(entry.id),
    createdAt: timestamp(entry.createdAt),
    editedAt: timestamp(entry.editedAt),
    updatedAt: timestamp(entry.updatedAt),
    editor: actor(entry.editor),
    deletedAt: entry.deletedAt === null ? null : timestamp(entry.deletedAt),
    deletedBy: actor(entry.deletedBy),
  };
}

export function parseNativeGithubContentEditRecord(value: unknown): NativeContentEdit {
  if (!object(value) || value.__typename !== "UserContentEdit") return fail("history_unverified");
  return edit({
    id: value.id,
    createdAt: value.createdAt,
    editedAt: value.editedAt,
    updatedAt: value.updatedAt,
    editor: nativeActor(value.editor),
    deletedAt: value.deletedAt,
    deletedBy: nativeActor(value.deletedBy),
  });
}

export function parseGithubContentEditParent(value: unknown, repository?: Repository): ContentEditParent {
  const entry = keys(value, ["kind", "id", "number", "url"]);
  if (entry.kind !== "issue" && entry.kind !== "pull_request") return fail("parent_unverified");
  const number = integer(entry.number, 1, Number.MAX_SAFE_INTEGER);
  const route = entry.kind === "issue" ? "issues" : "pull";
  if (typeof entry.url !== "string") return fail("parent_unverified");
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(issues|pull)\/([1-9][0-9]*)$/.exec(
    entry.url,
  );
  if (
    !match ||
    match[0] !== entry.url ||
    match[2] !== route ||
    match[3] !== String(number) ||
    (repository !== undefined && match[1] !== repository.slug)
  )
    return fail("parent_unverified");
  return { kind: entry.kind, id: identifier(entry.id), number, url: entry.url };
}

function nativeParent(value: unknown, kind: Kind, repository: Repository): ContentEditParent {
  if (!object(value) || value.__typename !== (kind === "issue" ? "Issue" : "PullRequest"))
    return fail("parent_unverified");
  return parseGithubContentEditParent({ kind, id: value.id, number: value.number, url: value.url }, repository);
}

function sameParent(value: ContentEditParent, expected: ContentEditParent): void {
  if (
    value.kind !== expected.kind ||
    value.id !== expected.id ||
    value.number !== expected.number ||
    value.url !== expected.url
  )
    fail("parent_unverified");
}

function records(value: unknown, maximum: number): NativeContentEdit[] {
  if (!Array.isArray(value)) return fail("history_unverified");
  if (value.length > maximum) return fail("budget_exceeded");
  const result = value.map(edit);
  const seen = new Set<string>();
  for (const entry of result) {
    if (seen.has(entry.id)) fail("duplicate_edit");
    seen.add(entry.id);
  }
  return result.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** Closed edit values shared by the parent and bound-comment readers; no body or diff survives. */
export function parseGithubContentEditHistory(value: unknown): ContentEditMetadata["history"] {
  const history = keys(value, ["availability", "retainedTotalCount", "records"]);
  if (history.availability === "unavailable") {
    if (history.retainedTotalCount !== null || history.records !== null) return fail("history_unverified");
    return { availability: "unavailable", retainedTotalCount: null, records: null };
  }
  if (history.availability !== "available") return fail("history_unverified");
  const count = integer(history.retainedTotalCount, 0, 100);
  const selected = records(history.records, 100);
  if (selected.length !== count) return fail("count_mismatch");
  return { availability: "available", retainedTotalCount: count, records: selected };
}

/** Closed metadata for private persistence and revision verification; no raw response fields survive. */
export function parseGithubContentEditMetadata(value: unknown): ContentEditMetadata {
  const entry = keys(value, ["version", "parent", "includesCreatedEdit", "history"]);
  if (entry.version !== version || typeof entry.includesCreatedEdit !== "boolean") return fail("history_unverified");
  const selectedParent = parseGithubContentEditParent(entry.parent);
  return {
    version,
    parent: selectedParent,
    includesCreatedEdit: entry.includesCreatedEdit,
    history: parseGithubContentEditHistory(entry.history),
  };
}

function capture(options: ContentEditReadOptions): Captured {
  const { client, source, repository: requested, scanId, assertAuthorized } = options;
  const repository = { id: integer(requested.id, 1, Number.MAX_SAFE_INTEGER), slug: requested.slug };
  if (
    typeof repository.slug !== "string" ||
    repository.slug.length > 256 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.slug) ||
    repository.slug.split("/").some((part) => part === "." || part === "..")
  )
    return fail("invalid_repository");
  identifier(source);
  identifier(scanId);
  if (assertAuthorized !== undefined && typeof assertAuthorized !== "function") return fail("invalid_input");
  const first = integer(options.first ?? 100, 1, 100);
  const maxPages = integer(options.maxPages ?? 100, 1, 10_000);
  const maxParents = integer(options.maxParents ?? 10_000, 1, 10_000);
  const maxEdits = integer(options.maxEdits ?? 10_000, 0, 10_000);
  return {
    client: client.forRepository(repository.id),
    source,
    repository,
    scanId,
    first,
    maxPages,
    maxParents,
    maxEdits,
    assertAuthorized,
    key: `content-edits:metadata-v1:${hash([source, repository.id, repository.slug, scanId])}`,
  };
}

function repository(value: unknown, expected: Repository, closed = false): Repository {
  const entry = closed ? keys(value, ["id", "slug"]) : value;
  if (
    !object(entry) ||
    (closed
      ? entry.id !== expected.id || entry.slug !== expected.slug
      : entry.databaseId !== expected.id || entry.isPrivate !== false)
  )
    return fail("repository_unverified");
  return { ...expected };
}

function pageInfo(value: unknown, closed = false): PageInfo {
  const entry = closed ? keys(value, ["hasNextPage", "endCursor"]) : value;
  if (
    !object(entry) ||
    typeof entry.hasNextPage !== "boolean" ||
    !(
      entry.endCursor === null ||
      (typeof entry.endCursor === "string" && entry.endCursor.length > 0 && entry.endCursor.length <= 4096)
    ) ||
    (entry.hasNextPage && entry.endCursor === null)
  )
    return fail("pagination_unverified");
  return { hasNextPage: entry.hasNextPage, endCursor: entry.endCursor };
}

function pageSequence(pages: readonly { pageInfo: PageInfo }[], maximum: number): void {
  if (pages.length === 0) fail("pagination_unverified");
  if (pages.length > maximum) fail("budget_exceeded");
  const cursors = new Set<string>();
  for (const [index, page] of pages.entries()) {
    if (page.pageInfo.hasNextPage !== index < pages.length - 1) fail("pagination_unverified");
    if (page.pageInfo.endCursor !== null) {
      if (cursors.has(page.pageInfo.endCursor)) fail("pagination_unverified");
      cursors.add(page.pageInfo.endCursor);
    }
  }
}

function parentPage(value: unknown, kind: Kind, options: Captured): ParentPage {
  const entry = keys(value, ["version", "repository", "kind", "totalCount", "parents", "pageInfo"]);
  if (entry.version !== "github-content-edit-parent-page/v1" || entry.kind !== kind || !Array.isArray(entry.parents))
    return fail("parent_unverified");
  const count = integer(entry.totalCount, 0, Number.MAX_SAFE_INTEGER);
  if (count > options.maxParents || entry.parents.length > options.first) return fail("budget_exceeded");
  const parents = entry.parents.map((item) => {
    const result = parseGithubContentEditParent(item, options.repository);
    if (result.kind !== kind) fail("parent_unverified");
    return result;
  });
  if (parents.length > count) fail("count_mismatch");
  return {
    version: "github-content-edit-parent-page/v1",
    repository: repository(entry.repository, options.repository, true),
    kind,
    totalCount: count,
    parents,
    pageInfo: pageInfo(entry.pageInfo, true),
  };
}

async function parentsFor(kind: Kind, options: Captured): Promise<{ total: number; parents: ContentEditParent[] }> {
  const field = kind === "issue" ? "issues" : "pullRequests";
  const states = kind === "issue" ? "OPEN,CLOSED" : "OPEN,CLOSED,MERGED";
  const [owner, name] = options.repository.slug.split("/");
  const pages = (
    await options.client.scanGraphql<ParentPage>({
      source: options.source,
      key: `${options.key}:parents:${kind}`,
      query: `query GithubContentEditParents($owner:String!, $name:String!, $first:Int!, $after:String) {
      repository(owner:$owner,name:$name) { databaseId isPrivate ${field}(first:$first,after:$after,states:[${states}]) {
        totalCount nodes { __typename id number url } pageInfo { hasNextPage endCursor }
      } }
    }`,
      variables: { owner, name },
      first: options.first,
      maxPages: options.maxPages,
      ...(options.assertAuthorized ? { assertAuthorized: options.assertAuthorized } : {}),
      select(data) {
        const repo = object(data) ? data.repository : null;
        repository(repo, options.repository);
        const connection = (repo as Record<string, unknown>)[field];
        if (!object(connection) || !Array.isArray(connection.nodes)) return fail("parent_unverified");
        const selected = parentPage(
          {
            version: "github-content-edit-parent-page/v1",
            repository: options.repository,
            kind,
            totalCount: connection.totalCount,
            parents: connection.nodes.map((item) => nativeParent(item, kind, options.repository)),
            pageInfo: pageInfo(connection.pageInfo),
          },
          kind,
          options,
        );
        return { nodes: [selected], pageInfo: selected.pageInfo };
      },
    })
  ).map((value) => parentPage(value, kind, options));
  pageSequence(pages, options.maxPages);
  const total = pages[0]!.totalCount;
  if (pages.some((page) => page.totalCount !== total)) fail("count_mismatch");
  const parents = pages.flatMap((page) => page.parents);
  if (parents.length !== total) fail("count_mismatch");
  return { total, parents };
}

function editPage(value: unknown, expected: ContentEditParent, options: Captured): EditPage {
  const entry = keys(value, [
    "version",
    "repository",
    "parent",
    "includesCreatedEdit",
    "availability",
    "retainedTotalCount",
    "records",
    "pageInfo",
  ]);
  if (entry.version !== "github-content-edit-metadata-page/v1" || typeof entry.includesCreatedEdit !== "boolean")
    return fail("history_unverified");
  const selectedParent = parseGithubContentEditParent(entry.parent, options.repository);
  sameParent(selectedParent, expected);
  const info = pageInfo(entry.pageInfo, true);
  const repo = repository(entry.repository, options.repository, true);
  if (entry.availability === "unavailable") {
    if (entry.retainedTotalCount !== null || entry.records !== null || info.hasNextPage || info.endCursor !== null)
      return fail("history_unverified");
    return {
      version: "github-content-edit-metadata-page/v1",
      repository: repo,
      parent: selectedParent,
      includesCreatedEdit: entry.includesCreatedEdit,
      availability: "unavailable",
      retainedTotalCount: null,
      records: null,
      pageInfo: info,
    };
  }
  if (entry.availability !== "available") return fail("history_unverified");
  const count = integer(entry.retainedTotalCount, 0, Number.MAX_SAFE_INTEGER);
  if (count > 100 || count > options.maxEdits) return fail("budget_exceeded");
  const selected = records(entry.records, options.first);
  if (selected.length > count) fail("count_mismatch");
  return {
    version: "github-content-edit-metadata-page/v1",
    repository: repo,
    parent: selectedParent,
    includesCreatedEdit: entry.includesCreatedEdit,
    availability: "available",
    retainedTotalCount: count,
    records: selected,
    pageInfo: info,
  };
}

const actorFields = "__typename ... on User { id databaseId } ... on Bot { id databaseId }";

async function metadataFor(expected: ContentEditParent, options: Captured): Promise<ContentEditMetadata> {
  const field = expected.kind === "issue" ? "issue" : "pullRequest";
  const [owner, name] = options.repository.slug.split("/");
  const pages = (
    await options.client.scanGraphql<EditPage>({
      source: options.source,
      key: `${options.key}:parent:${hash([expected.kind, expected.id, expected.number, expected.url])}:edits`,
      query: `query GithubContentEditMetadata($owner:String!, $name:String!, $number:Int!, $first:Int!, $after:String) {
      repository(owner:$owner,name:$name) { databaseId isPrivate ${field}(number:$number) {
        __typename id number url includesCreatedEdit userContentEdits(first:$first,after:$after) {
          totalCount nodes { __typename id createdAt editedAt updatedAt editor { ${actorFields} } deletedAt deletedBy { ${actorFields} } }
          pageInfo { hasNextPage endCursor }
        }
      } }
    }`,
      variables: { owner, name, number: expected.number },
      first: options.first,
      maxPages: options.maxPages,
      ...(options.assertAuthorized ? { assertAuthorized: options.assertAuthorized } : {}),
      select(data) {
        const repo = object(data) ? data.repository : null;
        repository(repo, options.repository);
        const item = (repo as Record<string, unknown>)[field];
        const selectedParent = nativeParent(item, expected.kind, options.repository);
        sameParent(selectedParent, expected);
        const native = item as Record<string, unknown>;
        const connection = native.userContentEdits;
        if (connection !== null && (!object(connection) || !Array.isArray(connection.nodes)))
          return fail("history_unverified");
        const selected = editPage(
          {
            version: "github-content-edit-metadata-page/v1",
            repository: options.repository,
            parent: selectedParent,
            includesCreatedEdit: native.includesCreatedEdit,
            availability: connection === null ? "unavailable" : "available",
            retainedTotalCount: connection === null ? null : connection.totalCount,
            records:
              connection === null ? null : (connection.nodes as unknown[]).map(parseNativeGithubContentEditRecord),
            pageInfo: connection === null ? { hasNextPage: false, endCursor: null } : pageInfo(connection.pageInfo),
          },
          expected,
          options,
        );
        return { nodes: [selected], pageInfo: selected.pageInfo };
      },
    })
  ).map((value) => editPage(value, expected, options));
  pageSequence(pages, options.maxPages);
  const first = pages[0]!;
  if (
    pages.some(
      (page) =>
        page.includesCreatedEdit !== first.includesCreatedEdit ||
        page.availability !== first.availability ||
        page.retainedTotalCount !== first.retainedTotalCount,
    )
  )
    fail("count_mismatch");
  if (first.availability === "unavailable" && pages.length !== 1) fail("history_unverified");
  const metadata = parseGithubContentEditMetadata({
    version,
    parent: expected,
    includesCreatedEdit: first.includesCreatedEdit,
    history:
      first.availability === "unavailable"
        ? { availability: "unavailable", retainedTotalCount: null, records: null }
        : {
            availability: "available",
            retainedTotalCount: first.retainedTotalCount,
            records: pages.flatMap((page) => page.records ?? []),
          },
  });
  options.assertAuthorized?.();
  return metadata;
}

/** Read one native parent under an immutable, repository-scoped metadata checkpoint namespace. */
export async function readGithubContentEditMetadata(
  options: ContentEditReadOptions & { parent: ContentEditParent },
): Promise<ContentEditMetadata> {
  const captured = capture(options);
  const expected = parseGithubContentEditParent(options.parent, captured.repository);
  return metadataFor(expected, captured);
}

/** Reconcile both parent inventories and all available child metadata before returning any snapshots. */
export async function readGithubContentEditParents(
  options: ContentEditReadOptions,
): Promise<ContentEditParentInventory> {
  const captured = capture(options);
  const issues = await parentsFor("issue", captured);
  const pullRequests = await parentsFor("pull_request", captured);
  if (issues.total + pullRequests.total > captured.maxParents) fail("budget_exceeded");
  const parents = [...issues.parents, ...pullRequests.parents];
  const parentIds = new Set<string>();
  const parentNumbers = new Set<number>();
  for (const item of parents) {
    if (parentIds.has(item.id) || parentNumbers.has(item.number)) fail("duplicate_parent");
    parentIds.add(item.id);
    parentNumbers.add(item.number);
  }
  const snapshots: ContentEditMetadata[] = [];
  const editIds = new Set<string>();
  for (const item of parents) {
    const metadata = await metadataFor(item, captured);
    for (const record of metadata.history.records ?? []) {
      if (editIds.has(record.id)) fail("duplicate_edit");
      editIds.add(record.id);
      if (editIds.size > captured.maxEdits) fail("budget_exceeded");
    }
    snapshots.push(metadata);
  }
  captured.assertAuthorized?.();
  return { parentTotals: { issues: issues.total, pullRequests: pullRequests.total }, snapshots };
}

/** Metadata identity is separate from the immutable observation identity; neither contains body or diff text. */
export function githubContentEditRevision(metadata: ContentEditMetadata, scanId: string): string {
  const selected = parseGithubContentEditMetadata(metadata);
  identifier(scanId);
  return `${revisionPrefix}${hash(selected)}.${hash([revisionPrefix, scanId]).slice(0, 32)}`;
}

export function verifyGithubContentEditRevision(metadata: unknown, revision: string): boolean {
  const match =
    typeof revision === "string" ? /^gh-content-edit-v1:([a-f0-9]{64})\.([a-f0-9]{32})$/.exec(revision) : null;
  if (!match || match[0] !== revision) return false;
  try {
    return match[1] === hash(parseGithubContentEditMetadata(metadata));
  } catch {
    return false;
  }
}
