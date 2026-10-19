import { createHash } from "node:crypto";
import type { GithubReadClient } from "./client.js";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_=.:\-]{1,128}$/.test(value);
const types = ["DATE", "MULTI_SELECT", "NUMBER", "SINGLE_SELECT", "TEXT"] as const;
type IssueFieldDataType = (typeof types)[number];
type FieldValue = string | string[] | null;
interface NativeFieldSide {
  value: string | null;
  options: string[] | null;
}
interface IssueFieldReference {
  subject: { id: string; url: string };
  event: { id: string; createdAt: string };
  issueField: { id: string; dataType: IssueFieldDataType };
}
export interface IssueFieldHistoryRecord extends IssueFieldReference {
  event: IssueFieldReference["event"] & { actor: Record<string, unknown> | null };
  native: { before: NativeFieldSide; after: NativeFieldSide };
  change: { before: FieldValue; after: FieldValue };
}
export interface IssueFieldHistoryOptions {
  client: GithubReadClient;
  source: string;
  repository: { id: number; slug: string };
  number: number;
  subjectId: string;
  scanId: string;
  maxPages?: number;
  /** Opaque host token, fresh for one normalization batch; never persisted. */
  issueFieldHistoryBatch?: object;
  assertAuthorized?: () => void;
}
type CapturedOptions = IssueFieldHistoryOptions & { clientScope: GithubReadClient };
const membershipBatches = new WeakMap<object, WeakMap<GithubReadClient, Map<string, Promise<IssueFieldReference[]>>>>();
const fieldSelection = "... on Node { id } ... on IssueFieldCommon { dataType visibility }";
const eventSelection = "id createdAt issueField { " + fieldSelection + " }";
const actorSelection = "actor { __typename login ... on User { id databaseId } ... on Bot { id databaseId } }";
const subjectSelection = "databaseId isPrivate issue(number:$number) { id url }";
function fail(code: string): never {
  throw new Error(code);
}
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}
function capture(options: IssueFieldHistoryOptions): CapturedOptions {
  if (
    !Number.isSafeInteger(options.repository.id) ||
    options.repository.id < 1 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository.slug) ||
    !Number.isSafeInteger(options.number) ||
    options.number < 1 ||
    !identity(options.subjectId) ||
    (options.issueFieldHistoryBatch !== undefined &&
      (options.issueFieldHistoryBatch === null ||
        typeof options.issueFieldHistoryBatch !== "object" ||
        Array.isArray(options.issueFieldHistoryBatch))) ||
    typeof options.scanId !== "string" ||
    !options.scanId ||
    options.scanId.length > 512 ||
    (options.maxPages !== undefined &&
      (!Number.isSafeInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 1000))
  )
    fail("issue_field_request_invalid");
  return {
    ...options,
    repository: { ...options.repository },
    clientScope: options.client,
    client: options.client.forRepository(options.repository.id),
  };
}
const subjectUrl = (options: IssueFieldHistoryOptions): string =>
  "https://github.com/" + options.repository.slug + "/issues/" + options.number;
const variables = (options: IssueFieldHistoryOptions): Record<string, unknown> => {
  const [owner, name] = options.repository.slug.split("/");
  return { owner, name, number: options.number };
};
async function query(
  options: IssueFieldHistoryOptions,
  document: string,
  values: Record<string, unknown>,
): Promise<unknown> {
  options.assertAuthorized?.();
  const data = await options.client.graphql(options.source, document, values, options.assertAuthorized);
  options.assertAuthorized?.();
  return data;
}
function subject(data: unknown, options: IssueFieldHistoryOptions): { id: string; url: string } {
  if (!object(data) || !Object.hasOwn(data, "repository")) fail("issue_field_scope_invalid_response");
  const repo = data.repository;
  if (repo === null) fail("issue_field_subject_identity_unverified");
  if (
    !object(repo) ||
    !Number.isSafeInteger(repo.databaseId) ||
    Number(repo.databaseId) < 1 ||
    typeof repo.isPrivate !== "boolean" ||
    !Object.hasOwn(repo, "issue")
  )
    fail("issue_field_scope_invalid_response");
  if (repo.databaseId !== options.repository.id || repo.isPrivate || repo.issue === null)
    fail("issue_field_subject_identity_unverified");
  if (
    !object(repo.issue) ||
    !identity(repo.issue.id) ||
    typeof repo.issue.url !== "string" ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9]\d*$/.test(repo.issue.url)
  )
    fail("issue_field_scope_invalid_response");
  if (repo.issue.id !== options.subjectId || repo.issue.url !== subjectUrl(options))
    fail("issue_field_subject_identity_unverified");
  return { id: repo.issue.id, url: repo.issue.url };
}
function field(value: unknown, previouslyCollected: boolean): IssueFieldReference["issueField"] | null {
  if (value === null && previouslyCollected) fail("issue_field_public_scope_unverified");
  if (!object(value) || !identity(value.id) || !types.includes(value.dataType as IssueFieldDataType))
    fail("issue_field_scope_invalid_response");
  if (value.visibility === "ORG_ONLY") {
    if (previouslyCollected) fail("issue_field_public_scope_unverified");
    return null;
  }
  if (value.visibility !== "ALL") fail("issue_field_scope_invalid_response");
  return { id: value.id, dataType: value.dataType as IssueFieldDataType };
}
function reference(
  event: unknown,
  issue: IssueFieldReference["subject"],
  previouslyCollected: boolean,
): IssueFieldReference | null {
  if (event === null && previouslyCollected) fail("issue_field_event_unavailable");
  if (
    !object(event) ||
    event.__typename !== "IssueFieldChangedEvent" ||
    !identity(event.id) ||
    !instant(event.createdAt)
  )
    fail("issue_field_event_invalid_response");
  const selected = field(event.issueField, previouslyCollected);
  return selected
    ? { subject: issue, event: { id: event.id, createdAt: event.createdAt }, issueField: selected }
    : null;
}
function retainedReference(value: unknown, options: IssueFieldHistoryOptions): IssueFieldReference {
  if (
    !exact(value, ["subject", "event", "issueField"]) ||
    !exact(value.subject, ["id", "url"]) ||
    !exact(value.event, ["id", "createdAt"]) ||
    !exact(value.issueField, ["id", "dataType"]) ||
    value.subject.id !== options.subjectId ||
    value.subject.url !== subjectUrl(options) ||
    !identity(value.event.id) ||
    !instant(value.event.createdAt) ||
    !identity(value.issueField.id) ||
    !types.includes(value.issueField.dataType as IssueFieldDataType)
  )
    fail("issue_field_checkpoint_invalid");
  return {
    subject: { id: options.subjectId, url: subjectUrl(options) },
    event: { id: value.event.id, createdAt: value.event.createdAt },
    issueField: { id: value.issueField.id, dataType: value.issueField.dataType as IssueFieldDataType },
  };
}
async function references(
  options: IssueFieldHistoryOptions,
  refresh = false,
): Promise<{ records: IssueFieldReference[]; fresh: boolean }> {
  // This uncached probe also protects a completed empty checkpoint.
  subject(
    await query(
      options,
      "query IssueFieldSubject($owner:String!,$name:String!,$number:Int!) { repository(owner:$owner,name:$name) { " +
        subjectSelection +
        " } }",
      variables(options),
    ),
    options,
  );
  let selectedPages = 0;
  let selectedRecords = 0;
  const rows = await options.client.scanGraphql<IssueFieldReference>({
    source: options.source,
    key: [
      "issue-field-history",
      "metadata-v1",
      options.repository.id,
      options.number,
      options.subjectId,
      options.scanId,
    ].join(":"),
    query:
      "query IssueFieldHistory($owner:String!,$name:String!,$number:Int!,$first:Int!,$after:String) { repository(owner:$owner,name:$name) { databaseId isPrivate issue(number:$number) { id url timelineItems(first:$first,after:$after,itemTypes:[ISSUE_FIELD_CHANGED_EVENT]) { nodes { __typename ... on IssueFieldChangedEvent { " +
      eventSelection +
      " } } pageInfo { hasNextPage endCursor } } } } }",
    variables: variables(options),
    maxPages: options.maxPages ?? 100,
    ...(refresh ? { refresh: true } : {}),
    ...(options.assertAuthorized ? { assertAuthorized: options.assertAuthorized } : {}),
    select(data) {
      options.assertAuthorized?.();
      const issue = subject(data, options);
      const repo = (data as Record<string, unknown>).repository as Record<string, unknown>;
      const item = repo.issue as Record<string, unknown>;
      if (
        !object(item.timelineItems) ||
        !Array.isArray(item.timelineItems.nodes) ||
        !object(item.timelineItems.pageInfo)
      )
        fail("issue_field_timeline_invalid_response");
      if (item.timelineItems.nodes.length > 100) fail("issue_field_history_budget_exceeded");
      const nodes: IssueFieldReference[] = [];
      for (const event of item.timelineItems.nodes) {
        const selected = reference(event, issue, false);
        // Explicit organization-only fields are outside this public-only reader.
        // Do not retain their event/field identity or any field content.
        if (selected) nodes.push(selected);
      }
      selectedPages++;
      selectedRecords += nodes.length;
      return {
        nodes,
        pageInfo: item.timelineItems.pageInfo as { hasNextPage: boolean; endCursor: string | null },
      };
    },
  });
  if (!Array.isArray(rows) || rows.length > 10000) fail("issue_field_history_budget_exceeded");
  const result: IssueFieldReference[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const retained = retainedReference(row, options);
    if (seen.has(retained.event.id)) fail("issue_field_duplicate_event");
    seen.add(retained.event.id);
    result.push(retained);
  }
  options.assertAuthorized?.();
  return { records: result, fresh: selectedPages > 0 && selectedRecords === result.length };
}
async function freshMembership(options: CapturedOptions): Promise<IssueFieldReference[]> {
  options.assertAuthorized?.();
  const token = options.issueFieldHistoryBatch;
  if (!token) return (await references(options, true)).records;
  let clients = membershipBatches.get(token);
  if (!clients) {
    clients = new WeakMap();
    membershipBatches.set(token, clients);
  }
  let issues = clients.get(options.clientScope);
  if (!issues) {
    issues = new Map();
    clients.set(options.clientScope, issues);
  }
  const key = JSON.stringify([
    options.source,
    options.repository.id,
    options.repository.slug,
    options.number,
    options.subjectId,
    options.maxPages ?? 100,
  ]);
  let pending = issues.get(key);
  if (!pending) {
    pending = references(options, true).then((result) => result.records);
    issues.set(key, pending);
  }
  try {
    const result = await pending;
    options.assertAuthorized?.();
    return result;
  } catch (error) {
    issues.delete(key);
    throw error;
  }
}
async function probe(
  options: IssueFieldHistoryOptions,
  eventId: string,
  issueFieldId: string,
): Promise<IssueFieldReference> {
  const data = await query(
    options,
    "query IssueFieldScope($owner:String!,$name:String!,$number:Int!,$eventId:ID!,$fieldId:ID!) { repository(owner:$owner,name:$name) { " +
      subjectSelection +
      " } field:node(id:$fieldId) { " +
      fieldSelection +
      " } event:node(id:$eventId) { __typename ... on Node { id } ... on IssueFieldChangedEvent { " +
      eventSelection +
      " } } }",
    { ...variables(options), eventId, fieldId: issueFieldId },
  );
  const issue = subject(data, options);
  if (!object(data) || !Object.hasOwn(data, "field") || !Object.hasOwn(data, "event"))
    fail("issue_field_scope_invalid_response");
  const currentField = field(data.field, true)!;
  if (currentField.id !== issueFieldId) fail("issue_field_public_scope_unverified");
  if (data.event === null) fail("issue_field_event_unavailable");
  if (!object(data.event) || typeof data.event.__typename !== "string" || !identity(data.event.id))
    fail("issue_field_event_invalid_response");
  if (data.event.__typename !== "IssueFieldChangedEvent" || data.event.id !== eventId)
    fail("issue_field_event_unavailable");
  const current = reference(data.event, issue, true)!;
  if (current.event.id !== eventId || current.issueField.id !== issueFieldId) fail("issue_field_event_unavailable");
  if (current.issueField.dataType !== currentField.dataType) fail("issue_field_scope_invalid_response");
  return current;
}
function sameReference(left: IssueFieldReference, right: IssueFieldReference): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function actor(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (!object(value) || typeof value.__typename !== "string") fail("issue_field_actor_invalid_response");
  return {
    __typename: value.__typename,
    id: identity(value.id) ? value.id : null,
    databaseId:
      typeof value.databaseId === "number" && Number.isSafeInteger(value.databaseId) && value.databaseId > 0
        ? value.databaseId
        : null,
    login: typeof value.login === "string" && value.login.length <= 200 ? value.login : null,
  };
}
function changes(
  detail: Record<string, unknown>,
  dataType: IssueFieldDataType,
): Pick<IssueFieldHistoryRecord, "native" | "change"> {
  const side = (valueName: string, optionsName: string): { native: NativeFieldSide; semantic: FieldValue } => {
    const value = detail[valueName];
    if (!Object.hasOwn(detail, valueName) || !(value === null || (typeof value === "string" && value.length <= 100000)))
      fail("issue_field_value_unverified");
    if (!Object.hasOwn(detail, optionsName)) fail("issue_field_value_unverified");
    const options = detail[optionsName];
    let names: string[] | null = null;
    if (options !== null) {
      if (!Array.isArray(options) || options.length > 1000) fail("issue_field_value_unverified");
      names = options.map((option) => {
        if (!object(option) || typeof option.name !== "string" || option.name.length > 10000)
          fail("issue_field_value_unverified");
        return option.name;
      });
      if (new Set(names).size !== names.length) fail("issue_field_option_identity_ambiguous");
    }
    const native: NativeFieldSide = { value, options: names };
    if (dataType === "MULTI_SELECT") {
      if (names === null && value !== null) fail("issue_field_value_unverified");
      return { native, semantic: names === null ? null : [...names].sort() };
    }
    if (dataType === "SINGLE_SELECT") {
      if (names === null) return { native, semantic: value };
      if (
        names.length > 1 ||
        (names.length === 0 && value !== null) ||
        (names.length === 1 && value !== null && value !== names[0])
      )
        fail("issue_field_value_unverified");
      return { native, semantic: names.length === 0 ? null : names[0]! };
    }
    if (names !== null) fail("issue_field_value_unverified");
    return { native, semantic: value };
  };
  const before = side("previousValue", "previousOptions");
  const after = side("newValue", "newOptions");
  return {
    native: { before: before.native, after: after.native },
    change: { before: before.semantic, after: after.semantic },
  };
}
async function hydrate(
  options: IssueFieldHistoryOptions,
  selected: IssueFieldReference,
): Promise<IssueFieldHistoryRecord> {
  if (!sameReference(selected, await probe(options, selected.event.id, selected.issueField.id)))
    fail("issue_field_event_unavailable");
  const data = await query(
    options,
    "query IssueFieldDetail($id:ID!) { node(id:$id) { __typename ... on Node { id } ... on IssueFieldChangedEvent { " +
      eventSelection +
      " " +
      actorSelection +
      " previousValue newValue previousOptions { name } newOptions { name } } } }",
    { id: selected.event.id },
  );
  if (!object(data) || !Object.hasOwn(data, "node")) fail("issue_field_event_invalid_response");
  if (data.node === null) fail("issue_field_event_unavailable");
  const current = reference(data.node, selected.subject, true)!;
  if (!sameReference(selected, current)) fail("issue_field_event_unavailable");
  const detail = data.node as Record<string, unknown>;
  if (!Object.hasOwn(detail, "actor")) fail("issue_field_actor_invalid_response");
  const result: IssueFieldHistoryRecord = {
    subject: { ...selected.subject },
    event: { ...selected.event, actor: actor(detail.actor) },
    issueField: { ...selected.issueField },
    ...changes(detail, selected.issueField.dataType),
  };
  // Values never enter a durable scan. Recheck visibility after this read window.
  if (!sameReference(selected, await probe(options, selected.event.id, selected.issueField.id)))
    fail("issue_field_event_unavailable");
  options.assertAuthorized?.();
  return result;
}
/** Public native issue-field events only. An empty visible history never certifies complete history. */
export async function readIssueFieldHistory(options: IssueFieldHistoryOptions): Promise<IssueFieldHistoryRecord[]> {
  const captured = capture(options);
  const selected = await references(captured);
  const metadata = selected.records;
  if (!selected.fresh) {
    // Previously collected field/event loss must not be hidden by an omitted or malformed timeline row.
    for (const item of metadata) await probe(captured, item.event.id, item.issueField.id);
    // A valid-shaped cached reference is not fresh proof that an event belongs to this issue.
    const current = new Map((await freshMembership(captured)).map((item) => [item.event.id, item]));
    for (const item of metadata) {
      const member = current.get(item.event.id);
      if (!member || !sameReference(item, member)) {
        await probe(captured, item.event.id, item.issueField.id);
        fail("issue_field_event_unavailable");
      }
    }
  }
  const records: IssueFieldHistoryRecord[] = [];
  for (const item of metadata) records.push(await hydrate(captured, item));
  captured.assertAuthorized?.();
  return records;
}
/** Revalidate a previously collected event even when refreshed timelines omit newly hidden fields. */
export async function readIssueFieldEvent(
  options: IssueFieldHistoryOptions & { eventId: string; issueFieldId: string },
): Promise<IssueFieldHistoryRecord> {
  const captured = capture(options);
  const eventId = options.eventId;
  const issueFieldId = options.issueFieldId;
  if (!identity(eventId) || !identity(issueFieldId)) fail("issue_field_request_invalid");
  const current = await probe(captured, eventId, issueFieldId);
  // Fresh membership is independent of any old completed normalization checkpoint.
  const metadata = await freshMembership(captured);
  const selected = metadata.find((item) => item.event.id === eventId);
  if (!selected || selected.issueField.id !== issueFieldId || !sameReference(current, selected))
    fail("issue_field_event_unavailable");
  return hydrate(captured, selected);
}
/** Hash a fixed, minimized native transition, including stable issue and field identities. */
export function issueFieldHistoryRevision(value: IssueFieldHistoryRecord): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "issue-field-history/v1",
        value.subject.id,
        value.subject.url,
        value.event.id,
        value.event.createdAt,
        value.event.actor,
        value.issueField.id,
        value.issueField.dataType,
        value.native.before,
        value.native.after,
        value.change.before,
        value.change.after,
      ]),
    )
    .digest("hex");
}
