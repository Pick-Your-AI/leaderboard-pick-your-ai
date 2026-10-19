import { createHash } from "node:crypto";

/** Private collection DTO, structurally equivalent to the GitHub reader's v1 metadata. */
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

export interface ContentEditMetadata {
  version: "github-content-edit-metadata/v1";
  parent: { kind: "issue" | "pull_request"; id: string; number: number; url: string };
  includesCreatedEdit: boolean;
  history:
    | { availability: "available"; retainedTotalCount: number; records: NativeContentEdit[] }
    | { availability: "unavailable"; retainedTotalCount: null; records: null };
}

function invalid(): never {
  throw new TypeError("invalid_content_edit_metadata");
}

/** Copy only closed data properties; no accessor or repository text is evaluated. */
function fields(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== expected.length) return invalid();
  const result: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid();
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\s\u0000-\u001f\u007f]/u.test(value))
    return invalid();
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) return invalid();
  return date.toISOString();
}

function actor(value: unknown): ContentEditActor {
  if (value === null) return null;
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getOwnPropertyDescriptor(value, "kind")?.value === "unknown"
  ) {
    const entry = fields(value, ["kind", "typename"]);
    if (
      typeof entry.typename !== "string" ||
      !/^[_A-Za-z][_0-9A-Za-z]{0,127}$/.test(entry.typename) ||
      entry.typename === "User" ||
      entry.typename === "Bot"
    )
      return invalid();
    return { kind: "unknown", typename: entry.typename };
  }
  const entry = fields(value, ["kind", "id", "databaseId"]);
  if (entry.kind !== "User" && entry.kind !== "Bot") return invalid();
  return {
    kind: entry.kind,
    id: identifier(entry.id),
    databaseId: entry.databaseId === null ? null : integer(entry.databaseId, 1),
  };
}

function record(value: unknown): NativeContentEdit {
  const entry = fields(value, ["id", "createdAt", "editedAt", "updatedAt", "editor", "deletedAt", "deletedBy"]);
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

function records(value: unknown): NativeContentEdit[] {
  if (!Array.isArray(value) || value.length > 100 || Reflect.ownKeys(value).length !== value.length + 1)
    return invalid();
  const result: NativeContentEdit[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return invalid();
    const entry = record(descriptor.value);
    if (seen.has(entry.id)) return invalid();
    seen.add(entry.id);
    result.push(entry);
  }
  return result.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** Keep the reader's exact canonical field order, nullable values and native-ID sorting for hashing. */
export function parseContentEditMetadata(value: unknown): ContentEditMetadata {
  const entry = fields(value, ["version", "parent", "includesCreatedEdit", "history"]);
  if (entry.version !== "github-content-edit-metadata/v1" || typeof entry.includesCreatedEdit !== "boolean")
    return invalid();
  const parent = fields(entry.parent, ["kind", "id", "number", "url"]);
  if (parent.kind !== "issue" && parent.kind !== "pull_request") return invalid();
  const number = integer(parent.number, 1);
  const route = parent.kind === "issue" ? "issues" : "pull";
  const match =
    typeof parent.url === "string"
      ? /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(issues|pull)\/([1-9][0-9]*)$/.exec(parent.url)
      : null;
  if (!match || match[0] !== parent.url || match[2] !== route || match[3] !== String(number)) return invalid();
  const selectedParent: ContentEditMetadata["parent"] = {
    kind: parent.kind,
    id: identifier(parent.id),
    number,
    url: parent.url as string,
  };
  const history = fields(entry.history, ["availability", "retainedTotalCount", "records"]);
  if (history.availability === "unavailable") {
    if (history.retainedTotalCount !== null || history.records !== null) return invalid();
    return {
      version: "github-content-edit-metadata/v1",
      parent: selectedParent,
      includesCreatedEdit: entry.includesCreatedEdit,
      history: { availability: "unavailable", retainedTotalCount: null, records: null },
    };
  }
  if (history.availability !== "available") return invalid();
  const count = integer(history.retainedTotalCount, 0, 100);
  const selectedRecords = records(history.records);
  if (selectedRecords.length !== count) return invalid();
  return {
    version: "github-content-edit-metadata/v1",
    parent: selectedParent,
    includesCreatedEdit: entry.includesCreatedEdit,
    history: { availability: "available", retainedTotalCount: count, records: selectedRecords },
  };
}

/** This reserved format is optional for legacy facts, and mandatory once its metadata or marker is present. */
export function collectionContentEditMetadata(value: unknown, family: string): ContentEditMetadata | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const revision = Object.getOwnPropertyDescriptor(value, "sourceRevision")?.value;
  if (!("contentEditMetadata" in value) && !(typeof revision === "string" && revision.startsWith("gh-content-edit-")))
    return undefined;
  const fact = fields(value, [
    "subjectId",
    "sourceRevision",
    "sourceUrl",
    "evidence",
    "actorId",
    "occurredAt",
    "state",
    "contentEditMetadata",
  ]);
  if (
    family !== "content_edits" ||
    fact.evidence !== "current_state" ||
    fact.actorId !== null ||
    fact.occurredAt !== null ||
    fact.state !== "present"
  )
    return invalid();
  const metadata = parseContentEditMetadata(fact.contentEditMetadata);
  if (metadata.parent.id !== fact.subjectId || metadata.parent.url !== fact.sourceUrl) return invalid();
  const match =
    typeof fact.sourceRevision === "string"
      ? /^gh-content-edit-v1:([a-f0-9]{64})\.([a-f0-9]{32})$/.exec(fact.sourceRevision)
      : null;
  if (
    !match ||
    match[0] !== fact.sourceRevision ||
    match[1] !== createHash("sha256").update(JSON.stringify(metadata)).digest("hex")
  )
    return invalid();
  return metadata;
}
