import { createHash } from "node:crypto";
import { isPromise } from "node:util/types";
import type { GithubReadClient } from "./client.js";
import {
  parseGithubContentEditHistory,
  parseGithubContentEditParent,
  parseNativeGithubContentEditRecord,
  type ContentEditMetadata,
  type ContentEditParent,
} from "./content-edit-history.js";

export type GithubCommentEditKind =
  "issue_comment" | "pull_request_conversation_comment" | "pull_request_review" | "pull_request_review_comment";

export interface GithubCommentEditTarget {
  kind: GithubCommentEditKind;
  id: string;
  url: string;
  parent: ContentEditParent;
}

type Repository = { id: number; slug: string };
type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
export interface GithubCommentEditPublication {
  publishedAt: string;
  reviewState: ReviewState | "SUBMITTED" | null;
  submittedAt: string | null;
}

export interface GithubCommentEditMetadata {
  version: "github-comment-edit-metadata/v1";
  repository: Repository;
  target: GithubCommentEditTarget;
  publication: GithubCommentEditPublication;
  includesCreatedEdit: boolean;
  history: ContentEditMetadata["history"];
}

export interface GithubCommentEditReadOptions {
  client: GithubReadClient;
  source: string;
  repository: Repository;
  target: GithubCommentEditTarget;
  scanId: string;
  first?: number;
  maxPages?: number;
  maxEdits?: number;
  /** A current synchronous host/repository check; absence never grants access. */
  assertAuthorized: () => void;
}

type PageInfo = { hasNextPage: boolean; endCursor: string | null };
type Base = Omit<GithubCommentEditMetadata, "version" | "history">;
interface Page extends Base {
  version: "github-comment-edit-metadata-page/v1";
  history: ContentEditMetadata["history"];
  pageInfo: PageInfo;
}

const version = "github-comment-edit-metadata/v1";
const pageVersion = "github-comment-edit-metadata-page/v1";
// The existing collection boundary reserves gh-content-edit-* and rejects this
// format. A reader result cannot silently activate the old production inventory.
const revisionPrefix = "gh-content-edit-comment-v1:";
const submittedReviews = new Set<unknown>(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (reason: string): never => {
  throw new TypeError(`github_comment_edit_${reason}`);
};
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const keys = (value: unknown, names: readonly string[]): Record<string, unknown> => {
  if (!object(value) || Object.keys(value).length !== names.length || names.some((name) => !Object.hasOwn(value, name)))
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
const timestamp = (value: unknown): string => {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))
    return fail("invalid_timestamp");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19))
    return fail("invalid_timestamp");
  return date.toISOString();
};

export function parseGithubCommentEditRepository(value: unknown): Repository {
  const entry = keys(value, ["id", "slug"]);
  if (
    typeof entry.slug !== "string" ||
    entry.slug.length > 256 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.slug) ||
    entry.slug.split("/").some((part) => part === "." || part === "..")
  )
    return fail("repository_unverified");
  return { id: integer(entry.id, 1, Number.MAX_SAFE_INTEGER), slug: entry.slug };
}

export function parseNativeGithubCommentEditRepository(value: unknown, expected: Repository): Repository {
  if (
    !object(value) ||
    value.databaseId !== expected.id ||
    value.nameWithOwner !== expected.slug ||
    value.isPrivate !== false
  )
    return fail("repository_unverified");
  return { ...expected };
}

export function parseGithubCommentEditTarget(value: unknown, repo: Repository): GithubCommentEditTarget {
  const entry = keys(value, ["kind", "id", "url", "parent"]);
  if (
    ![
      "issue_comment",
      "pull_request_conversation_comment",
      "pull_request_review",
      "pull_request_review_comment",
    ].includes(entry.kind as string)
  )
    return fail("target_unverified");
  const kind = entry.kind as GithubCommentEditKind;
  const parent = parseGithubContentEditParent(entry.parent, repo);
  if (parent.kind !== (kind === "issue_comment" ? "issue" : "pull_request")) return fail("target_unverified");
  const fragment =
    kind === "pull_request_review"
      ? /^#pullrequestreview-[1-9][0-9]{0,19}$/
      : kind === "pull_request_review_comment"
        ? /^#(?:discussion_r|r)[1-9][0-9]{0,19}$/
        : /^#issuecomment-[1-9][0-9]{0,19}$/;
  if (typeof entry.url !== "string" || !entry.url.startsWith(parent.url)) return fail("target_unverified");
  const suffix = entry.url.slice(parent.url.length),
    match = fragment.exec(suffix);
  if (!match || match[0] !== suffix) return fail("target_unverified");
  return { kind, id: identifier(entry.id), url: entry.url, parent };
}

export function parseGithubCommentEditPublication(
  value: unknown,
  kind: GithubCommentEditKind,
): GithubCommentEditPublication {
  const entry = keys(value, ["publishedAt", "reviewState", "submittedAt"]);
  const publishedAt = timestamp(entry.publishedAt);
  if (kind === "pull_request_review") {
    if (!submittedReviews.has(entry.reviewState)) return fail("target_not_published");
    return { publishedAt, reviewState: entry.reviewState as ReviewState, submittedAt: timestamp(entry.submittedAt) };
  }
  if (entry.submittedAt !== null || entry.reviewState !== (kind === "pull_request_review_comment" ? "SUBMITTED" : null))
    return fail("target_not_published");
  return { publishedAt, reviewState: kind === "pull_request_review_comment" ? "SUBMITTED" : null, submittedAt: null };
}

function base(entry: Record<string, unknown>): Base {
  const repo = parseGithubCommentEditRepository(entry.repository);
  const selected = parseGithubCommentEditTarget(entry.target, repo);
  if (typeof entry.includesCreatedEdit !== "boolean") return fail("history_unverified");
  return {
    repository: repo,
    target: selected,
    publication: parseGithubCommentEditPublication(entry.publication, selected.kind),
    includesCreatedEdit: entry.includesCreatedEdit,
  };
}

/** Private values only. A validated digest or publication field is not host authority. */
export function parseGithubCommentEditMetadata(value: unknown): GithubCommentEditMetadata {
  const entry = keys(value, ["version", "repository", "target", "publication", "includesCreatedEdit", "history"]);
  if (entry.version !== version) return fail("history_unverified");
  return { version, ...base(entry), history: parseGithubContentEditHistory(entry.history) };
}

function pageInfo(value: unknown): PageInfo {
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

function page(
  value: unknown,
  expected: { repository: Repository; target: GithubCommentEditTarget },
  first: number,
  maxEdits: number,
): Page {
  const entry = keys(value, [
    "version",
    "repository",
    "target",
    "publication",
    "includesCreatedEdit",
    "history",
    "pageInfo",
  ]);
  if (entry.version !== pageVersion) return fail("history_unverified");
  const selected = base(entry);
  if (
    JSON.stringify(selected.repository) !== JSON.stringify(expected.repository) ||
    JSON.stringify(selected.target) !== JSON.stringify(expected.target)
  )
    return fail("target_unverified");
  const info = pageInfo(entry.pageInfo);
  const history = keys(entry.history, ["availability", "retainedTotalCount", "records"]);
  if (history.availability === "unavailable") {
    const unavailable = parseGithubContentEditHistory(history);
    if (info.hasNextPage || info.endCursor !== null) return fail("pagination_unverified");
    return { version: pageVersion, ...selected, history: unavailable, pageInfo: info };
  }
  if (history.availability !== "available" || !Array.isArray(history.records)) return fail("history_unverified");
  const count = integer(history.retainedTotalCount, 0, 100);
  if (count > maxEdits || history.records.length > first || history.records.length > count)
    return fail("budget_exceeded");
  const validated = parseGithubContentEditHistory({
    availability: "available",
    retainedTotalCount: history.records.length,
    records: history.records,
  });
  if (validated.availability !== "available") return fail("history_unverified");
  return { version: pageVersion, ...selected, history: { ...validated, retainedTotalCount: count }, pageInfo: info };
}

export function parseNativeGithubCommentEditTarget(
  value: unknown,
  expected: GithubCommentEditTarget,
  repo: Repository,
): GithubCommentEditTarget {
  const type =
    expected.kind === "pull_request_review"
      ? "PullRequestReview"
      : expected.kind === "pull_request_review_comment"
        ? "PullRequestReviewComment"
        : "IssueComment";
  if (!object(value) || value.__typename !== type) return fail("target_unverified");
  parseNativeGithubCommentEditRepository(value.repository, repo);
  if (expected.kind === "issue_comment" && value.pullRequest !== null) return fail("target_unverified");
  const parent = value[expected.kind === "issue_comment" ? "issue" : "pullRequest"];
  if (!object(parent) || parent.__typename !== (expected.parent.kind === "issue" ? "Issue" : "PullRequest"))
    return fail("target_unverified");
  parseNativeGithubCommentEditRepository(parent.repository, repo);
  const selected = parseGithubCommentEditTarget(
    {
      kind: expected.kind,
      id: value.id,
      url: value.url,
      parent: { kind: expected.parent.kind, id: parent.id, number: parent.number, url: parent.url },
    },
    repo,
  );
  if (JSON.stringify(selected) !== JSON.stringify(expected)) return fail("target_unverified");
  return selected;
}

/** A shared current fence for the bound reader and its separately versioned inventory. */
export function githubCommentEditAuthorization(guard: unknown): () => void {
  if (typeof guard !== "function") return fail("authorization_required");
  return () => {
    let result: unknown;
    try {
      result = guard();
    } catch {
      return fail("authorization_unavailable");
    }
    if (result !== undefined) {
      // Reject an accidentally asynchronous guard before I/O, while observing a
      // native rejected Promise so it cannot escape as an unhandled rejection.
      if (isPromise(result)) {
        try {
          void Promise.prototype.then.call(
            result,
            () => {},
            () => {},
          );
        } catch {
          /* Invalid guard remains denied. */
        }
      }
      fail("authorization_must_be_synchronous");
    }
  };
}

/** Read a supplied native target, not an inventory. No default source is enabled here. */
export async function readGithubCommentEditMetadata(
  options: GithubCommentEditReadOptions,
): Promise<GithubCommentEditMetadata> {
  const repo = parseGithubCommentEditRepository(options.repository);
  const selected = parseGithubCommentEditTarget(options.target, repo);
  const source = identifier(options.source),
    scanId = identifier(options.scanId);
  const first = integer(options.first ?? 100, 1, 100);
  const maxPages = integer(options.maxPages ?? 100, 1, 10_000);
  const maxEdits = integer(options.maxEdits ?? 100, 0, 100);
  const authorize = githubCommentEditAuthorization(options.assertAuthorized);
  authorize();
  const client = options.client.forRepository(repo.id);
  const type =
    selected.kind === "pull_request_review"
      ? "PullRequestReview"
      : selected.kind === "pull_request_review_comment"
        ? "PullRequestReviewComment"
        : "IssueComment";
  const repoFields = "databaseId nameWithOwner isPrivate";
  const parentFields = `__typename id number url repository { ${repoFields} }`;
  const parentSelection =
    selected.kind === "issue_comment"
      ? `issue { ${parentFields} } pullRequest { id }`
      : `pullRequest { ${parentFields} }`;
  const reviewSelection =
    selected.kind === "pull_request_review"
      ? "state submittedAt"
      : selected.kind === "pull_request_review_comment"
        ? "state"
        : "";
  const actors = "__typename ... on User { id databaseId } ... on Bot { id databaseId }";
  const pages = (
    await client.scanGraphql<Page>({
      source,
      key: `comment-edits:metadata-v1:${hash([source, repo, scanId, selected])}`,
      query: `query GithubCommentEditMetadata($id:ID!, $first:Int!, $after:String) {
      node(id:$id) { __typename ... on ${type} {
        id url repository { ${repoFields} } ${parentSelection}
        publishedAt ${reviewSelection} includesCreatedEdit userContentEdits(first:$first,after:$after) {
          totalCount nodes { __typename id createdAt editedAt updatedAt editor { ${actors} } deletedAt deletedBy { ${actors} } }
          pageInfo { hasNextPage endCursor }
        }
      } }
    }`,
      variables: { id: selected.id },
      first,
      maxPages,
      assertAuthorized: authorize,
      select(data) {
        authorize();
        const node = object(data) ? data.node : null;
        const actualTarget = parseNativeGithubCommentEditTarget(node, selected, repo);
        const native = node as Record<string, unknown>;
        const connection = native.userContentEdits;
        if (connection !== null && (!object(connection) || !Array.isArray(connection.nodes)))
          return fail("history_unverified");
        const actual = page(
          {
            version: pageVersion,
            repository: repo,
            target: actualTarget,
            publication: {
              publishedAt: native.publishedAt,
              reviewState:
                selected.kind === "pull_request_review" || selected.kind === "pull_request_review_comment"
                  ? native.state
                  : null,
              submittedAt: selected.kind === "pull_request_review" ? native.submittedAt : null,
            },
            includesCreatedEdit: native.includesCreatedEdit,
            history:
              connection === null
                ? { availability: "unavailable", retainedTotalCount: null, records: null }
                : {
                    availability: "available",
                    retainedTotalCount: connection.totalCount,
                    records: (connection.nodes as unknown[]).map(parseNativeGithubContentEditRecord),
                  },
            pageInfo: connection === null ? { hasNextPage: false, endCursor: null } : connection.pageInfo,
          },
          { repository: repo, target: selected },
          first,
          maxEdits,
        );
        return { nodes: [actual], pageInfo: actual.pageInfo };
      },
    })
  ).map((value) => page(value, { repository: repo, target: selected }, first, maxEdits));
  if (!pages.length || pages.length > maxPages) return fail("pagination_unverified");
  const initial = pages[0]!;
  const cursors = new Set<string>();
  for (const [index, current] of pages.entries()) {
    if (current.pageInfo.hasNextPage !== index < pages.length - 1) return fail("pagination_unverified");
    if (current.pageInfo.endCursor !== null) {
      if (cursors.has(current.pageInfo.endCursor)) return fail("pagination_unverified");
      cursors.add(current.pageInfo.endCursor);
    }
    if (
      JSON.stringify(current.publication) !== JSON.stringify(initial.publication) ||
      current.includesCreatedEdit !== initial.includesCreatedEdit ||
      current.history.availability !== initial.history.availability ||
      current.history.retainedTotalCount !== initial.history.retainedTotalCount
    )
      return fail("history_changed");
  }
  if (initial.history.availability === "unavailable" && pages.length !== 1) return fail("history_changed");
  const result = parseGithubCommentEditMetadata({
    version,
    repository: repo,
    target: selected,
    publication: initial.publication,
    includesCreatedEdit: initial.includesCreatedEdit,
    history:
      initial.history.availability === "unavailable"
        ? initial.history
        : {
            availability: "available",
            retainedTotalCount: initial.history.retainedTotalCount,
            records: pages.flatMap((value) => value.history.records ?? []),
          },
  });
  authorize();
  return result;
}

/** Semantic identity only: it neither authenticates a target nor grants collection authority. */
export function githubCommentEditRevision(metadata: GithubCommentEditMetadata, scanId: string): string {
  const selected = parseGithubCommentEditMetadata(metadata);
  identifier(scanId);
  return `${revisionPrefix}${hash(selected)}.${hash([revisionPrefix, scanId]).slice(0, 32)}`;
}

export function verifyGithubCommentEditRevision(metadata: unknown, revision: string): boolean {
  const match =
    typeof revision === "string" ? /^gh-content-edit-comment-v1:([a-f0-9]{64})\.([a-f0-9]{32})$/.exec(revision) : null;
  if (!match || match[0] !== revision) return false;
  try {
    return match[1] === hash(parseGithubCommentEditMetadata(metadata));
  } catch {
    return false;
  }
}
