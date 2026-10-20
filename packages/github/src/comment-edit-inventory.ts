import { createHash } from "node:crypto";
import type { GithubReadClient } from "./client.js";
import {
  parseGithubContentEditParent,
  readGithubContentEditParents,
  type ContentEditMetadata,
  type ContentEditParent,
} from "./content-edit-history.js";
import {
  githubCommentEditAuthorization,
  parseGithubCommentEditPublication,
  parseGithubCommentEditRepository,
  parseGithubCommentEditTarget,
  parseNativeGithubCommentEditRepository,
  parseNativeGithubCommentEditTarget,
  readGithubCommentEditMetadata,
  type GithubCommentEditKind,
  type GithubCommentEditMetadata,
  type GithubCommentEditPublication,
  type GithubCommentEditTarget,
} from "./comment-edit-history.js";

type Repository = GithubCommentEditMetadata["repository"];
type Connection = "issue_comments" | "pull_request_comments" | "reviews" | "review_threads" | "thread_comments";
type PageInfo = { hasNextPage: boolean; endCursor: string | null };
type Published = {
  kind: "published";
  target: GithubCommentEditTarget;
  publication: GithubCommentEditPublication;
};
type Entry = Published | { kind: "pending_review_comment"; identityDigest: string } | { kind: "thread"; id: string };
interface Selection {
  parent: ContentEditParent;
  connection: Connection;
  threadId: string | null;
}
interface Page extends Selection {
  version: "github-comment-edit-inventory-page/v1";
  repository: Repository;
  totalCount: number;
  entries: Entry[];
  pageInfo: PageInfo;
}
export interface GithubCommentEditInventoryOptions {
  client: GithubReadClient;
  source: string;
  repository: Repository;
  scanId: string;
  first?: number;
  maxPages?: number;
  /** Includes parents and all enumerated comments/reviews, including excluded pending comments. */
  maxObjects?: number;
  maxThreads?: number;
  maxEdits?: number;
  assertAuthorized: () => void;
}
export interface GithubCommentEditInventory {
  parentTotals: { issues: number; pullRequests: number };
  targetTotals: {
    publishedIssueComments: number;
    publishedPullRequestComments: number;
    submittedReviews: number;
    submittedReviewComments: number;
    excludedPendingReviewComments: number;
    reviewThreads: number;
  };
  snapshots: (ContentEditMetadata | GithubCommentEditMetadata)[];
}
interface Captured {
  client: GithubReadClient;
  source: string;
  repository: Repository;
  scanId: string;
  first: number;
  maxPages: number;
  maxObjects: number;
  maxThreads: number;
  maxEdits: number;
  assertAuthorized: () => void;
  key: string;
}

const pageVersion = "github-comment-edit-inventory-page/v1";
const fail = (reason: string): never => {
  throw new TypeError(`github_comment_inventory_${reason}`);
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: unknown, expected: readonly string[]): Record<string, unknown> => {
  if (
    !object(value) ||
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    return fail("invalid_shape");
  return value;
};
const integer = (value: unknown, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    return fail("invalid_integer");
  return value;
};
const identifier = (value: unknown): string => {
  if (typeof value !== "string" || !value.length || value.length > 256 || /[\s\u0000-\u001f\u007f]/u.test(value))
    return fail("invalid_identity");
  return value;
};
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equal = (actual: unknown, expected: unknown, reason: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(reason);
};
const identityDigest = (repository: Repository, id: string): string =>
  hash(["github-comment-edit-inventory-identity/v1", repository, id]);
const kindFor = (connection: Connection): GithubCommentEditKind => {
  if (connection === "issue_comments") return "issue_comment";
  if (connection === "pull_request_comments") return "pull_request_conversation_comment";
  if (connection === "reviews") return "pull_request_review";
  if (connection === "thread_comments") return "pull_request_review_comment";
  return fail("invalid_connection");
};
function info(value: unknown): PageInfo {
  const entry = keys(value, ["hasNextPage", "endCursor"]);
  if (
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
function nativeParent(value: unknown, expected: ContentEditParent, repository: Repository): void {
  if (!object(value) || value.__typename !== (expected.kind === "issue" ? "Issue" : "PullRequest"))
    return fail("parent_unverified");
  parseNativeGithubCommentEditRepository(value.repository, repository);
  equal(
    parseGithubContentEditParent(
      { kind: expected.kind, id: value.id, number: value.number, url: value.url },
      repository,
    ),
    expected,
    "parent_unverified",
  );
}
function nativeThread(value: unknown, parent: ContentEditParent, repository: Repository, expected?: string): string {
  if (!object(value) || value.__typename !== "PullRequestReviewThread" || parent.kind !== "pull_request")
    return fail("thread_unverified");
  const id = identifier(value.id);
  if (expected !== undefined && id !== expected) fail("thread_unverified");
  parseNativeGithubCommentEditRepository(value.repository, repository);
  nativeParent(value.pullRequest, parent, repository);
  return id;
}
function nativeEntry(value: unknown, selection: Selection, repository: Repository): Entry {
  if (selection.connection === "review_threads")
    return { kind: "thread", id: nativeThread(value, selection.parent, repository) };
  if (!object(value)) return fail("target_unverified");
  const expected = parseGithubCommentEditTarget(
    { kind: kindFor(selection.connection), id: value.id, url: value.url, parent: selection.parent },
    repository,
  );
  const target = parseNativeGithubCommentEditTarget(value, expected, repository);
  if (selection.connection === "thread_comments" && value.state === "PENDING") {
    if (value.publishedAt !== null) return fail("publication_unverified");
    // No draft text, URL or native ID is retained by this page. The domain-separated
    // digest keeps whole-inventory count/duplicate checks possible after a restart.
    return { kind: "pending_review_comment", identityDigest: identityDigest(repository, target.id) };
  }
  return {
    kind: "published",
    target,
    publication: parseGithubCommentEditPublication(
      {
        publishedAt: value.publishedAt,
        reviewState:
          selection.connection === "reviews" || selection.connection === "thread_comments" ? value.state : null,
        submittedAt: selection.connection === "reviews" ? value.submittedAt : null,
      },
      target.kind,
    ),
  };
}
function entry(value: unknown, selection: Selection, repository: Repository): Entry {
  if (selection.connection === "review_threads") {
    const selected = keys(value, ["kind", "id"]);
    if (selected.kind !== "thread") return fail("thread_unverified");
    return { kind: "thread", id: identifier(selected.id) };
  }
  if (object(value) && value.kind === "pending_review_comment") {
    const selected = keys(value, ["kind", "identityDigest"]);
    if (
      selection.connection !== "thread_comments" ||
      typeof selected.identityDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(selected.identityDigest)
    )
      return fail("target_unverified");
    return { kind: "pending_review_comment", identityDigest: selected.identityDigest };
  }
  const selected = keys(value, ["kind", "target", "publication"]);
  if (selected.kind !== "published") return fail("target_unverified");
  const target = parseGithubCommentEditTarget(selected.target, repository);
  if (target.kind !== kindFor(selection.connection)) return fail("target_unverified");
  equal(target.parent, selection.parent, "parent_unverified");
  return {
    kind: "published",
    target,
    publication: parseGithubCommentEditPublication(selected.publication, target.kind),
  };
}
function page(value: unknown, selection: Selection, options: Captured): Page {
  const selected = keys(value, [
    "version",
    "repository",
    "parent",
    "connection",
    "threadId",
    "totalCount",
    "entries",
    "pageInfo",
  ]);
  if (
    selected.version !== pageVersion ||
    selected.connection !== selection.connection ||
    selected.threadId !== selection.threadId ||
    !Array.isArray(selected.entries)
  )
    return fail("inventory_unverified");
  equal(parseGithubCommentEditRepository(selected.repository), options.repository, "repository_unverified");
  equal(parseGithubContentEditParent(selected.parent, options.repository), selection.parent, "parent_unverified");
  const total = integer(selected.totalCount, 0, Number.MAX_SAFE_INTEGER);
  if (
    total > (selection.connection === "review_threads" ? options.maxThreads : options.maxObjects) ||
    selected.entries.length > options.first
  )
    return fail("budget_exceeded");
  if (selected.entries.length > total) return fail("count_mismatch");
  return {
    version: pageVersion,
    repository: { ...options.repository },
    ...selection,
    totalCount: total,
    entries: selected.entries.map((value) => entry(value, selection, options.repository)),
    pageInfo: info(selected.pageInfo),
  };
}

const repoFields = "databaseId nameWithOwner isPrivate";
const parentFields = `__typename id number url repository { ${repoFields} }`;
function nodeFields(connection: Connection): string {
  if (connection === "review_threads")
    return `__typename id repository { ${repoFields} } pullRequest { ${parentFields} }`;
  const parents =
    connection === "issue_comments"
      ? `issue { ${parentFields} } pullRequest { id }`
      : `pullRequest { ${parentFields} }`;
  const publication = connection === "reviews" ? "state submittedAt" : connection === "thread_comments" ? "state" : "";
  return `__typename id url repository { ${repoFields} } ${parents} publishedAt ${publication}`;
}
async function readConnection(selection: Selection, options: Captured): Promise<Entry[]> {
  const field =
    selection.connection === "reviews"
      ? "reviews"
      : selection.connection === "review_threads"
        ? "reviewThreads"
        : "comments";
  const type =
    selection.threadId === null
      ? selection.parent.kind === "issue"
        ? "Issue"
        : "PullRequest"
      : "PullRequestReviewThread";
  const binding =
    selection.threadId === null
      ? parentFields
      : `__typename id repository { ${repoFields} } pullRequest { ${parentFields} }`;
  const states = selection.connection === "reviews" ? ",states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED]" : "";
  const pages = (
    await options.client.scanGraphql<Page>({
      source: options.source,
      key: `${options.key}:${hash(selection)}`,
      query: `query GithubCommentEditInventory($id:ID!, $first:Int!, $after:String) {
      node(id:$id) { __typename ... on ${type} {
        ${binding} ${field}(first:$first,after:$after${states}) {
          totalCount nodes { ${nodeFields(selection.connection)} } pageInfo { hasNextPage endCursor }
        }
      } }
    }`,
      variables: { id: selection.threadId ?? selection.parent.id },
      first: options.first,
      maxPages: options.maxPages,
      assertAuthorized: options.assertAuthorized,
      select(data) {
        options.assertAuthorized();
        const node = object(data) ? data.node : null;
        if (selection.threadId === null) nativeParent(node, selection.parent, options.repository);
        else nativeThread(node, selection.parent, options.repository, selection.threadId);
        const connection = (node as Record<string, unknown>)[field];
        if (!object(connection) || !Array.isArray(connection.nodes)) return fail("inventory_unavailable");
        const selected = page(
          {
            version: pageVersion,
            repository: options.repository,
            ...selection,
            totalCount: connection.totalCount,
            entries: connection.nodes.map((value) => nativeEntry(value, selection, options.repository)),
            pageInfo: connection.pageInfo,
          },
          selection,
          options,
        );
        return { nodes: [selected], pageInfo: selected.pageInfo };
      },
    })
  ).map((value) => page(value, selection, options));
  if (!pages.length || pages.length > options.maxPages) return fail("pagination_unverified");
  const total = pages[0]!.totalCount;
  const cursors = new Set<string>();
  for (const [index, selected] of pages.entries()) {
    if (selected.totalCount !== total) return fail("count_changed");
    if (selected.pageInfo.hasNextPage !== index < pages.length - 1) return fail("pagination_unverified");
    if (selected.pageInfo.endCursor !== null) {
      if (cursors.has(selected.pageInfo.endCursor)) return fail("pagination_unverified");
      cursors.add(selected.pageInfo.endCursor);
    }
  }
  const entries = pages.flatMap((value) => value.entries);
  if (entries.length !== total) return fail("count_mismatch");
  options.assertAuthorized();
  return entries;
}

/** Complete the parent/comment/review inventory and every retained edit history before returning any observations. */
export async function readGithubCommentEditInventory(
  input: GithubCommentEditInventoryOptions,
): Promise<GithubCommentEditInventory> {
  const repository = parseGithubCommentEditRepository(input.repository);
  const source = identifier(input.source),
    scanId = identifier(input.scanId);
  const assertAuthorized = githubCommentEditAuthorization(input.assertAuthorized);
  const options: Captured = {
    client: input.client,
    source,
    repository,
    scanId,
    first: integer(input.first ?? 100, 1, 100),
    maxPages: integer(input.maxPages ?? 100, 1, 10_000),
    maxObjects: integer(input.maxObjects ?? 10_000, 1, 10_000),
    maxThreads: integer(input.maxThreads ?? 10_000, 0, 10_000),
    maxEdits: integer(input.maxEdits ?? 10_000, 0, 10_000),
    assertAuthorized,
    key: `comment-edits:inventory-v1:${hash([source, repository, scanId])}`,
  };
  assertAuthorized();
  options.client = options.client.forRepository(repository.id);
  const parents = await readGithubContentEditParents({ ...options, maxParents: options.maxObjects });
  const snapshots: GithubCommentEditInventory["snapshots"] = [...parents.snapshots];
  const editIds = new Set<string>();
  for (const parent of parents.snapshots) for (const edit of parent.history.records ?? []) editIds.add(edit.id);
  const identities = new Set(parents.snapshots.map((value) => identityDigest(repository, value.parent.id)));
  const threads = new Set<string>();
  const selected: Published[] = [];
  const targetTotals = {
    publishedIssueComments: 0,
    publishedPullRequestComments: 0,
    submittedReviews: 0,
    submittedReviewComments: 0,
    excludedPendingReviewComments: 0,
    reviewThreads: 0,
  };
  const select = (value: Entry) => {
    if (value.kind === "thread") return fail("invalid_connection");
    const id = value.kind === "published" ? identityDigest(repository, value.target.id) : value.identityDigest;
    if (identities.has(id)) return fail("duplicate_target");
    identities.add(id);
    if (identities.size > options.maxObjects) return fail("budget_exceeded");
    if (value.kind === "pending_review_comment") {
      targetTotals.excludedPendingReviewComments++;
      return;
    }
    const field =
      value.target.kind === "issue_comment"
        ? "publishedIssueComments"
        : value.target.kind === "pull_request_conversation_comment"
          ? "publishedPullRequestComments"
          : value.target.kind === "pull_request_review"
            ? "submittedReviews"
            : "submittedReviewComments";
    targetTotals[field]++;
    selected.push(value);
  };
  for (const metadata of parents.snapshots) {
    const parent = metadata.parent;
    for (const value of await readConnection(
      { parent, connection: parent.kind === "issue" ? "issue_comments" : "pull_request_comments", threadId: null },
      options,
    ))
      select(value);
    if (parent.kind === "issue") continue;
    for (const value of await readConnection({ parent, connection: "reviews", threadId: null }, options)) select(value);
    for (const value of await readConnection({ parent, connection: "review_threads", threadId: null }, options)) {
      if (value.kind !== "thread") return fail("thread_unverified");
      if (threads.has(value.id)) return fail("duplicate_thread");
      threads.add(value.id);
      if (threads.size > options.maxThreads) return fail("budget_exceeded");
      targetTotals.reviewThreads++;
      for (const comment of await readConnection(
        { parent, connection: "thread_comments", threadId: value.id },
        options,
      ))
        select(comment);
    }
  }
  for (const value of selected) {
    const metadata = await readGithubCommentEditMetadata({
      ...options,
      target: value.target,
      maxEdits: Math.min(100, options.maxEdits - editIds.size),
    });
    equal(metadata.publication, value.publication, "publication_changed");
    for (const edit of metadata.history.records ?? []) {
      if (editIds.has(edit.id)) return fail("duplicate_edit");
      editIds.add(edit.id);
      if (editIds.size > options.maxEdits) return fail("budget_exceeded");
    }
    snapshots.push(metadata);
  }
  assertAuthorized();
  return { parentTotals: parents.parentTotals, targetTotals, snapshots };
}
