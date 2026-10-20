import { createHash } from "node:crypto";
import { types as nativeTypes } from "node:util";
import {
  compareSourceInstants,
  pullRequestDecisionBindingSchema,
  pullRequestDecisionGenerationSchema,
  pullRequestDecisionHistoryPayloadSchema,
  pullRequestDecisionHistorySchema,
  pullRequestDecisionHistoryVersion,
  pullRequestDecisionHistoryLimits,
  pullRequestDecisionInstantSchema,
  pullRequestDecisionClocksValid,
  type PullRequestDecisionBinding,
  type PullRequestDecisionGeneration,
  type PullRequestDecisionHistory,
  type PullRequestDecisionHistoryPayload,
  type PullRequestDecisionEvent,
  type PullRequestDecisionUnavailable,
  type PullRequestDecisionUnavailableReason,
} from "@pick-your-ai/contracts";
import { GithubClientError, type GithubReadClient } from "./client.js";

type Anchor = PullRequestDecisionHistory["capture"]["before"];
type Expected = { binding: PullRequestDecisionBinding; generation: PullRequestDecisionGeneration };
type Captured = { status: "captured"; receipt: PullRequestDecisionHistory };
export interface PullRequestDecisionHistoryOptions {
  client: GithubReadClient;
  source: string;
  repository: PullRequestDecisionBinding["repository"];
  pullNumber: number;
  expectedSubject: PullRequestDecisionBinding["subject"];
  semanticRevision: string;
  scanId: string;
  asOf: string;
  now: () => string;
  assertAuthorized: () => void;
  maxPages?: number;
}
export type PullRequestDecisionSelection =
  | {
      status: "selected";
      unitKey: string;
      asOf: string;
      cutoffMode: "exclusive";
      outcome: "merged" | "closed_unmerged" | "pending";
      decisionAt: string | null;
      authorId: string | null;
      sourceEventIds: string[];
      proofDigest: string;
    }
  | { status: "not_yet_created"; proofDigest: string }
  | PullRequestDecisionUnavailable;

class Unavailable extends Error {
  constructor(readonly reason: PullRequestDecisionUnavailableReason) {
    super(reason);
  }
}
function fail(reason: PullRequestDecisionUnavailableReason): never {
  throw new Unavailable(reason);
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const sameTime = (left: string | null, right: string | null): boolean =>
  left === null || right === null ? left === right : compareSourceInstants(left, right) === 0;

/** Detach JSON data without invoking accessor/toJSON hooks or admitting unbounded containers. */
function dataSnapshot(value: unknown): unknown {
  let entries = 0;
  let bytes = 0;
  const active = new Set<object>();
  const visit = (entry: unknown, depth: number): unknown => {
    if (++entries > 150_000 || depth > 16) fail("budget_exceeded");
    if (nativeTypes.isProxy(entry)) fail("invalid_receipt");
    if (entry === null || typeof entry === "boolean") return entry;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) fail("invalid_receipt");
      return entry;
    }
    if (typeof entry === "string") {
      bytes += Buffer.byteLength(entry);
      if (bytes > pullRequestDecisionHistoryLimits.bytes) fail("budget_exceeded");
      return entry;
    }
    if (!object(entry) && !Array.isArray(entry)) fail("invalid_receipt");
    if (active.has(entry)) fail("invalid_receipt");
    const array = Array.isArray(entry);
    if (!array && Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null)
      fail("invalid_receipt");
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (Reflect.ownKeys(entry).some((key) => typeof key !== "string")) fail("invalid_receipt");
    if (array && entry.length > pullRequestDecisionHistoryLimits.events) fail("budget_exceeded");
    const keys = Object.keys(descriptors).filter((key) => !(array && key === "length"));
    if (!array && keys.length > 32) fail("invalid_receipt");
    if (array && (keys.length !== entry.length || keys.some((key, index) => key !== String(index))))
      fail("invalid_receipt");
    active.add(entry);
    const result: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor) || !descriptor.enumerable) fail("invalid_receipt");
      const copied = visit(descriptor.value, depth + 1);
      if (array) (result as unknown[]).push(copied);
      else (result as Record<string, unknown>)[key] = copied;
    }
    active.delete(entry);
    return result;
  };
  const copy = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(copy)) > pullRequestDecisionHistoryLimits.bytes) fail("budget_exceeded");
  return copy;
}
function drainUnexpectedPromise(value: unknown, seen = new WeakSet<object>()): void {
  // Invalid synchronous callback results must not invoke foreign then getters.
  if (!nativeTypes.isPromise(value) || seen.has(value)) return;
  seen.add(value);
  try {
    void Promise.prototype.then.call(
      value,
      () => undefined,
      (reason) => drainUnexpectedPromise(reason, seen),
    );
  } catch {
    // Promise constructor/species behavior belongs to the trusted host.
  }
}

function result<T>(operation: () => T): T | PullRequestDecisionUnavailable {
  try {
    return operation();
  } catch (error) {
    if (error instanceof Unavailable) return { status: "unavailable", reason: error.reason };
    throw error;
  }
}
function digest(payload: PullRequestDecisionHistoryPayload): string {
  return createHash("sha256")
    .update(pullRequestDecisionHistoryVersion + "\n")
    .update(JSON.stringify(payload))
    .digest("hex");
}
type Replay = { outcome: "pending" | "closed_unmerged" | "merged"; decisionAt: string | null; ids: string[] };
function replay(history: readonly PullRequestDecisionEvent[], asOf: string | null): Replay {
  const events = [...history].sort((a, b) => compareSourceInstants(a.createdAt, b.createdAt));
  let current: Replay = { outcome: "pending", decisionAt: null, ids: [] };
  for (let index = 0; index < events.length;) {
    const first = events[index]!;
    const group: PullRequestDecisionEvent[] = [];
    while (index < events.length && compareSourceInstants(events[index]!.createdAt, first.createdAt) === 0)
      group.push(events[index++]!);
    if (asOf !== null && compareSourceInstants(first.createdAt, asOf) >= 0) break;
    const kinds = new Set(group.map((entry) => entry.kind));
    const closure = group.length === 2 && kinds.has("closed") && kinds.has("merged");
    if (group.length !== 1 && !closure) fail("history_ambiguous");
    if (current.outcome === "merged") fail("history_inconsistent");
    const ids = group.map((entry) => entry.id).sort();
    if (closure || first.kind === "merged") {
      if (current.outcome !== "pending") fail("history_inconsistent");
      // Equivalent timestamp spellings retain the actual native merge spelling.
      const merged = group.find((entry) => entry.kind === "merged")!;
      current = { outcome: "merged", decisionAt: merged.createdAt, ids };
    } else if (first.kind === "closed") {
      if (current.outcome !== "pending") fail("history_inconsistent");
      current = { outcome: "closed_unmerged", decisionAt: first.createdAt, ids };
    } else {
      if (current.outcome !== "closed_unmerged") fail("history_inconsistent");
      current = { outcome: "pending", decisionAt: null, ids };
    }
  }
  return current;
}
function validatePayload(value: PullRequestDecisionHistoryPayload): void {
  const { history, capture, pagination, binding } = value;
  if (!equal(capture.before, capture.after)) fail("history_changed");
  if (!pullRequestDecisionClocksValid(value)) fail("clock_inconsistent");
  const total = pagination.totalCount;
  if (history.length !== total || pagination.consumedCount !== total || capture.before.totalCount !== total)
    fail("history_incomplete");
  let consumed = 0;
  let cursor: string | null = null;
  const cursors = new Set<string>();
  for (const [index, page] of pagination.pages.entries()) {
    if (
      page.after !== cursor ||
      page.count > 100 ||
      page.filteredCount !== total - consumed ||
      page.count > page.filteredCount ||
      page.hasNextPage !== consumed + page.count < total ||
      (page.count === 0 && (total !== 0 || page.endCursor !== null)) ||
      (page.count !== 0 && (page.endCursor === null || cursors.has(page.endCursor))) ||
      (index < pagination.pages.length - 1 && !page.hasNextPage)
    )
      fail("history_incomplete");
    if (page.endCursor !== null) cursors.add(page.endCursor);
    consumed += page.count;
    cursor = page.endCursor;
  }
  if (consumed !== total || pagination.pages.at(-1)!.hasNextPage) fail("history_incomplete");
  const ids = new Set<string>();
  for (const event of history) {
    if (event.subjectId !== binding.subject.id) fail("binding_mismatch");
    if (ids.has(event.id)) fail("history_inconsistent");
    ids.add(event.id);
  }
  const last = replay(history, null);
  const anchor = capture.after;
  if (
    (last.outcome === "pending" && (anchor.state !== "OPEN" || anchor.closedAt !== null || anchor.mergedAt !== null)) ||
    (last.outcome === "closed_unmerged" &&
      (anchor.state !== "CLOSED" || !sameTime(anchor.closedAt, last.decisionAt) || anchor.mergedAt !== null)) ||
    (last.outcome === "merged" &&
      (anchor.state !== "MERGED" ||
        !sameTime(anchor.closedAt, last.decisionAt) ||
        !sameTime(anchor.mergedAt, last.decisionAt)))
  )
    fail("history_inconsistent");
}
function parsedReceipt(value: unknown): PullRequestDecisionHistory {
  const parsed = pullRequestDecisionHistorySchema.safeParse(dataSnapshot(value));
  if (!parsed.success) fail("invalid_receipt");
  const { digest: claimed, ...payload } = parsed.data;
  if (digest(payload) !== claimed) fail("digest_mismatch");
  validatePayload(payload);
  return parsed.data;
}

/** Integrity and exact binding only. A matching digest does not establish protected-host authority. */
export function validatePullRequestDecisionHistory(
  value: unknown,
  expected: Expected,
): { status: "validated"; receipt: PullRequestDecisionHistory } | PullRequestDecisionUnavailable {
  return result(() => {
    const detached = dataSnapshot(expected);
    if (!object(detached) || Object.keys(detached).sort().join(",") !== "binding,generation") fail("invalid_request");
    const binding = pullRequestDecisionBindingSchema.safeParse(detached.binding);
    const generation = pullRequestDecisionGenerationSchema.safeParse(detached.generation);
    if (!binding.success || !generation.success) fail("invalid_request");
    const receipt = parsedReceipt(value);
    if (!equal(receipt.binding, binding.data) || !equal(receipt.generation, generation.data)) fail("binding_mismatch");
    return { status: "validated" as const, receipt };
  });
}

/** Select one historical state before filtering decisions into any reporting window.
 * An earlier window reuses the original capture; it never changes its generation or digest.
 */
export function selectPullRequestDecisionAsOf(value: unknown, asOf?: string): PullRequestDecisionSelection {
  return result(() => {
    const receipt = parsedReceipt(value);
    const { binding, generation } = receipt;
    const target = asOf === undefined ? generation.asOf : asOf;
    if (
      !pullRequestDecisionInstantSchema.safeParse(target).success ||
      compareSourceInstants(target, generation.asOf) > 0
    )
      fail("invalid_request");
    if (compareSourceInstants(binding.subject.createdAt, target) >= 0)
      return { status: "not_yet_created" as const, proofDigest: receipt.digest };
    const selected = replay(receipt.history, target);
    return {
      status: "selected" as const,
      unitKey: "github:" + binding.repository.id + ":pull_request:" + binding.subject.id,
      asOf: target,
      cutoffMode: "exclusive" as const,
      outcome: selected.outcome,
      decisionAt: selected.decisionAt,
      authorId: binding.subject.author?.id ?? null,
      sourceEventIds: selected.ids,
      proofDigest: receipt.digest,
    };
  });
}

const repositoryFields = "databaseId nameWithOwner isPrivate";
const parentFields =
  "__typename ... on PullRequest { id databaseId number url repository { " + repositoryFields + " } }";
const subjectFields =
  "id databaseId number url createdAt updatedAt state closedAt mergedAt " +
  "author { __typename ... on User { id databaseId } ... on Bot { id databaseId } }";
const types = "CLOSED_EVENT,REOPENED_EVENT,MERGED_EVENT";
const fragments =
  "... on ClosedEvent { id createdAt closable { " +
  parentFields +
  " } } " +
  "... on ReopenedEvent { id createdAt closable { " +
  parentFields +
  " } } " +
  "... on MergedEvent { id createdAt pullRequest { " +
  parentFields +
  " } commit { oid } }";
const anchorQuery =
  "query PullRequestDecisionAnchor($owner:String!,$name:String!,$number:Int!) { " +
  "repository(owner:$owner,name:$name) { " +
  repositoryFields +
  " pullRequest(number:$number) { " +
  subjectFields +
  " timelineItems(first:1,itemTypes:[" +
  types +
  "]) { totalCount updatedAt } } } }";
const pageQuery =
  "query PullRequestDecisionHistory($owner:String!,$name:String!,$number:Int!,$after:String) { " +
  "repository(owner:$owner,name:$name) { " +
  repositoryFields +
  " pullRequest(number:$number) { " +
  subjectFields +
  " timelineItems(first:100,after:$after,itemTypes:[" +
  types +
  "]) { " +
  "totalCount updatedAt filteredCount pageCount pageInfo { hasNextPage endCursor } " +
  "edges { cursor node { __typename " +
  fragments +
  " } } } } } }";

function nativeRepository(value: unknown, binding: PullRequestDecisionBinding): void {
  if (
    !object(value) ||
    value.databaseId !== binding.repository.id ||
    value.nameWithOwner !== binding.repository.slug ||
    value.isPrivate !== false
  )
    fail("subject_unavailable");
}
function parent(value: unknown, binding: PullRequestDecisionBinding): void {
  if (
    !object(value) ||
    value.__typename !== "PullRequest" ||
    value.id !== binding.subject.id ||
    value.databaseId !== binding.subject.databaseId ||
    value.number !== binding.pullNumber ||
    value.url !== binding.subject.url
  )
    fail("subject_unavailable");
  nativeRepository(value.repository, binding);
}
function nativeSubject(
  data: unknown,
  binding: PullRequestDecisionBinding,
): { anchor: Anchor; connection: Record<string, unknown> } {
  if (!object(data)) fail("invalid_response");
  nativeRepository(data.repository, binding);
  const repo = data.repository as Record<string, unknown>;
  const item = repo.pullRequest;
  if (!object(item)) fail("subject_unavailable");
  parent({ ...item, __typename: "PullRequest", repository: repo }, binding);
  const nativeAuthor = item.author;
  let author: PullRequestDecisionBinding["subject"]["author"] = null;
  if (nativeAuthor !== null) {
    if (!object(nativeAuthor)) fail("subject_unavailable");
    author = {
      id: nativeAuthor.id as string,
      databaseId: nativeAuthor.databaseId as number,
      kind: nativeAuthor.__typename as "User" | "Bot",
    };
  }
  if (!equal(author, binding.subject.author) || item.createdAt !== binding.subject.createdAt)
    fail("subject_unavailable");
  if (!object(item.timelineItems)) fail("invalid_response");
  const connection = item.timelineItems;
  const parsed = pullRequestDecisionHistoryPayloadSchema.shape.capture.shape.before.safeParse({
    state: item.state,
    updatedAt: item.updatedAt,
    closedAt: item.closedAt,
    mergedAt: item.mergedAt,
    timelineUpdatedAt: connection.updatedAt,
    totalCount: connection.totalCount,
  });
  if (!parsed.success) fail("invalid_response");
  return { anchor: parsed.data, connection };
}
function nativeEvent(value: unknown, binding: PullRequestDecisionBinding): PullRequestDecisionEvent {
  if (!object(value)) fail("history_incomplete");
  let kind: PullRequestDecisionEvent["kind"];
  switch (value.__typename) {
    case "ClosedEvent":
      kind = "closed";
      parent(value.closable, binding);
      break;
    case "ReopenedEvent":
      kind = "reopened";
      parent(value.closable, binding);
      break;
    case "MergedEvent":
      kind = "merged";
      parent(value.pullRequest, binding);
      break;
    default:
      return fail("invalid_response");
  }
  const minimized = {
    id: value.id,
    subjectId: binding.subject.id,
    createdAt: value.createdAt,
    kind,
    ...(kind === "merged"
      ? { commitOid: value.commit === null ? null : object(value.commit) ? value.commit.oid : undefined }
      : {}),
  };
  const parsed = pullRequestDecisionHistoryPayloadSchema.shape.history.element.safeParse(minimized);
  if (!parsed.success) fail("invalid_response");
  return parsed.data;
}

/** Capture the complete API-visible decision sequence; no cached scan or live metric publication. */
export async function capturePullRequestDecisionHistory(
  options: PullRequestDecisionHistoryOptions,
): Promise<Captured | PullRequestDecisionUnavailable> {
  try {
    if (nativeTypes.isProxy(options) || !object(options)) fail("invalid_request");
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const allowed = [
      "client",
      "source",
      "repository",
      "pullNumber",
      "expectedSubject",
      "semanticRevision",
      "scanId",
      "asOf",
      "now",
      "assertAuthorized",
      "maxPages",
    ];
    if (
      Reflect.ownKeys(options).some((key) => typeof key !== "string" || !allowed.includes(key)) ||
      Object.values(descriptors).some((entry) => !("value" in entry) || !entry.enumerable)
    )
      fail("invalid_request");
    const get = (key: string): unknown => descriptors[key]?.value;
    const bindingResult = pullRequestDecisionBindingSchema.safeParse(
      dataSnapshot({
        repository: get("repository"),
        pullNumber: get("pullNumber"),
        subject: get("expectedSubject"),
        source: get("source"),
        semanticRevision: get("semanticRevision"),
      }),
    );
    const generationResult = pullRequestDecisionGenerationSchema.safeParse(
      dataSnapshot({
        scanId: get("scanId"),
        asOf: get("asOf"),
        cutoffMode: "exclusive",
      }),
    );
    if (!bindingResult.success || !generationResult.success) fail("invalid_request");
    const binding = bindingResult.data;
    const generation = generationResult.data;
    const now = get("now");
    const authority = get("assertAuthorized");
    const maxPages = get("maxPages") ?? pullRequestDecisionHistoryLimits.pages;
    const client = get("client") as GithubReadClient;
    if (
      typeof now !== "function" ||
      typeof authority !== "function" ||
      !client ||
      typeof client.forRepository !== "function" ||
      !Number.isSafeInteger(maxPages) ||
      Number(maxPages) < 1 ||
      Number(maxPages) > pullRequestDecisionHistoryLimits.pages
    )
      fail("invalid_request");
    const authorize = (): void => {
      try {
        const value: unknown = authority();
        if (value === undefined) return;
        drainUnexpectedPromise(value);
      } catch (error) {
        drainUnexpectedPromise(error);
      }
      throw new GithubClientError({ kind: "unsafe_request" }, binding.source);
    };
    authorize();
    const scoped = client.forRepository(binding.repository.id);
    const graphql = scoped.graphql.bind(scoped);
    const clock = (): string => {
      authorize();
      let value: unknown;
      try {
        value = now();
        drainUnexpectedPromise(value);
      } catch (error) {
        drainUnexpectedPromise(error);
        fail("clock_inconsistent");
      } finally {
        // Current authorization wins even when the selected clock throws.
        authorize();
      }
      const parsed = pullRequestDecisionInstantSchema.safeParse(value);
      if (!parsed.success) fail("clock_inconsistent");
      return parsed.data;
    };
    const startedAt = clock();
    const [owner, name] = binding.repository.slug.split("/");
    const variables = { owner, name, number: binding.pullNumber };
    const query = async (document: string, cursor?: string | null): Promise<unknown> => {
      authorize();
      const response = await graphql(
        binding.source,
        document,
        { ...variables, ...(cursor === undefined ? {} : { after: cursor }) },
        authorize,
      );
      authorize();
      return response;
    };
    const before = nativeSubject(await query(anchorQuery), binding).anchor;
    const history: PullRequestDecisionEvent[] = [];
    const pages: PullRequestDecisionHistory["pagination"]["pages"] = [];
    const cursors = new Set<string>();
    const eventIds = new Set<string>();
    let after: string | null = null;
    let terminal = false;
    for (let index = 0; index < Number(maxPages); index++) {
      const page = nativeSubject(await query(pageQuery, after), binding);
      if (!equal(page.anchor, before)) fail("history_changed");
      const connection = page.connection;
      if (
        !Array.isArray(connection.edges) ||
        connection.edges.length > 100 ||
        connection.pageCount !== connection.edges.length ||
        connection.filteredCount !== before.totalCount - history.length ||
        !object(connection.pageInfo)
      )
        fail("history_incomplete");
      const info = connection.pageInfo;
      let lastCursor: string | null = null;
      for (const edge of connection.edges) {
        if (
          !object(edge) ||
          typeof edge.cursor !== "string" ||
          edge.cursor.length < 1 ||
          edge.cursor.length > 1024 ||
          cursors.has(edge.cursor)
        )
          fail("history_incomplete");
        cursors.add(edge.cursor);
        lastCursor = edge.cursor;
        const event = nativeEvent(edge.node, binding);
        if (eventIds.has(event.id)) fail("history_inconsistent");
        eventIds.add(event.id);
        history.push(event);
      }
      if (history.length > before.totalCount || history.length > pullRequestDecisionHistoryLimits.events)
        fail("history_incomplete");
      if (
        info.endCursor !== lastCursor ||
        info.hasNextPage !== history.length < before.totalCount ||
        (connection.edges.length === 0 && before.totalCount !== 0)
      )
        fail("history_incomplete");
      pages.push({
        after,
        endCursor: lastCursor,
        hasNextPage: info.hasNextPage as boolean,
        count: connection.edges.length,
        filteredCount: connection.filteredCount as number,
      });
      if (Buffer.byteLength(JSON.stringify(history)) > pullRequestDecisionHistoryLimits.bytes) fail("budget_exceeded");
      if (info.hasNextPage === false) {
        terminal = true;
        break;
      }
      after = lastCursor;
    }
    if (!terminal) fail("budget_exceeded");
    const finalAnchor = nativeSubject(await query(anchorQuery), binding).anchor;
    const completedAt = clock();
    const payloadResult = pullRequestDecisionHistoryPayloadSchema.safeParse({
      schemaVersion: pullRequestDecisionHistoryVersion,
      binding,
      generation,
      capture: { startedAt, completedAt, before, after: finalAnchor },
      history,
      pagination: { totalCount: before.totalCount, consumedCount: history.length, terminal: true, pages },
    });
    if (!payloadResult.success) fail("invalid_response");
    const payload = payloadResult.data;
    validatePayload(payload);
    const receipt = { ...payload, digest: digest(payload) };
    if (Buffer.byteLength(JSON.stringify(receipt)) > pullRequestDecisionHistoryLimits.bytes) fail("budget_exceeded");
    authorize();
    return { status: "captured", receipt };
  } catch (error) {
    if (error instanceof Unavailable) return { status: "unavailable", reason: error.reason };
    throw error;
  }
}
