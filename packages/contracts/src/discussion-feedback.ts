/** Private, minimized source and review contracts. None of these records grants
 * source access, establishes helpfulness, or belongs in a public projection. */
export const discussionFeedbackContentVersion = "discussion-feedback-content/v1";
export const acceptedFeedbackThreadsVersion = "accepted-feedback-threads/v1";
export const discussionFeedbackLimits = Object.freeze({
  bodyBytes: 65536,
  titleBytes: 4096,
  pageSize: 10,
  threads: 10000,
});
export const discussionFeedbackFieldScope = Object.freeze([
  "Discussion.title",
  "Discussion.body",
  "Discussion.updatedAt",
  "Discussion.lastEditedAt",
  "Discussion.answer.body",
  "Discussion.answer.updatedAt",
  "Discussion.answer.lastEditedAt",
  "Discussion.answer.deletedAt",
  "Discussion.answer.isMinimized",
] as const);

export type FeedbackActor = null | {
  kind: "User" | "Bot";
  id: string;
  databaseId: number | null;
  login: string | null;
};
export interface DiscussionFeedbackDescriptor {
  version: typeof discussionFeedbackContentVersion;
  repositoryId: number;
  installationId: number;
  discussionId: string;
  threadUrl: string;
  nativeRevision: string;
  author: FeedbackActor;
  createdAt: string;
  updatedAt: string;
  lastEditedAt: string | null;
  titleDigest: string;
  bodyDigest: string;
  answerChosenAt: string | null;
  answerChosenBy: FeedbackActor;
  answer: null | {
    id: string;
    author: FeedbackActor;
    createdAt: string;
    updatedAt: string;
    lastEditedAt: string | null;
    deletedAt: null;
    isMinimized: false;
    isAnswer: true;
    bodyDigest: string;
  };
}
export interface DiscussionFeedbackObservation {
  version: typeof discussionFeedbackContentVersion;
  descriptor: DiscussionFeedbackDescriptor;
  fingerprint: string;
  authorityHash: string;
  coverageEpoch: string;
  generation: string;
  scanId: string;
}
export interface DiscussionFeedbackSource {
  metadata: DiscussionFeedbackObservation;
  sourceRevision: string;
  observedAt: string;
  selectedCurrentState: boolean;
}
export interface AcceptedFeedbackThread {
  schemaVersion: typeof acceptedFeedbackThreadsVersion;
  targetFactId: string;
  actorId: string;
  repositoryId: number;
  discussionId: string;
  threadUrl: string;
  sourceMetricId: "discussions_started" | "discussion_answers";
  sourceRevision: string;
  descriptorFingerprint: string;
  authorityHash: string;
  coverageEpoch: string;
  generation: string;
  observedAt: string;
}
export interface DiscussionFeedbackCapture {
  repositoryId: number;
  authorityHash: string;
  coverageHash: string;
}

function invalid(): never {
  throw new TypeError("invalid_discussion_feedback_contract");
}
/** Reject accessors, extra fields, symbols and custom prototypes before reading. */
export function discussionFeedbackFields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return invalid();
  const properties = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(properties).length !== names.length) return invalid();
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const property = properties[name];
    if (!property?.enumerable || !Object.hasOwn(property, "value")) return invalid();
    result[name] = property.value;
  }
  return result;
}
export function feedbackIdentifier(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[^A-Za-z0-9_=.:/-]/.test(value))
    return invalid();
  return value;
}
export function feedbackHash(value: unknown): string {
  if (typeof value !== "string" || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value)) return invalid();
  return value;
}
export function feedbackPositive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return invalid();
  return value;
}
export function feedbackTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return invalid();
  return value;
}
export function feedbackThreadUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\s\u0000-\u001f\u007f]/u.test(value) ||
    !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/discussions\/[1-9][0-9]*$/.test(value)
  )
    return invalid();
  return value;
}
function actor(value: unknown): FeedbackActor {
  if (value === null) return null;
  const entry = discussionFeedbackFields(value, ["kind", "id", "databaseId", "login"]);
  if (entry.kind !== "User" && entry.kind !== "Bot") return invalid();
  if (
    entry.login !== null &&
    (typeof entry.login !== "string" ||
      entry.login.length > 64 ||
      /[^A-Za-z0-9\[\]-]/.test(entry.login) ||
      !/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(entry.login))
  )
    return invalid();
  return {
    kind: entry.kind,
    login: entry.login as string | null,
    id: feedbackIdentifier(entry.id),
    databaseId: entry.databaseId === null ? null : feedbackPositive(entry.databaseId),
  };
}
const nullableTime = (value: unknown) => (value === null ? null : feedbackTimestamp(value));

/** Exact field order is part of the v1 fingerprint encoding. */
export function parseDiscussionFeedbackDescriptor(value: unknown): DiscussionFeedbackDescriptor {
  const entry = discussionFeedbackFields(value, [
    "version",
    "repositoryId",
    "installationId",
    "discussionId",
    "threadUrl",
    "nativeRevision",
    "author",
    "createdAt",
    "updatedAt",
    "lastEditedAt",
    "titleDigest",
    "bodyDigest",
    "answerChosenAt",
    "answerChosenBy",
    "answer",
  ]);
  if (entry.version !== discussionFeedbackContentVersion) return invalid();
  let answer: DiscussionFeedbackDescriptor["answer"] = null;
  if (entry.answer !== null) {
    const selected = discussionFeedbackFields(entry.answer, [
      "id",
      "author",
      "createdAt",
      "updatedAt",
      "lastEditedAt",
      "deletedAt",
      "isMinimized",
      "isAnswer",
      "bodyDigest",
    ]);
    if (selected.deletedAt !== null || selected.isMinimized !== false || selected.isAnswer !== true) return invalid();
    answer = {
      id: feedbackIdentifier(selected.id),
      author: actor(selected.author),
      createdAt: feedbackTimestamp(selected.createdAt),
      updatedAt: feedbackTimestamp(selected.updatedAt),
      lastEditedAt: nullableTime(selected.lastEditedAt),
      deletedAt: null,
      isMinimized: false,
      isAnswer: true,
      bodyDigest: feedbackHash(selected.bodyDigest),
    };
  }
  const result: DiscussionFeedbackDescriptor = {
    version: discussionFeedbackContentVersion,
    repositoryId: feedbackPositive(entry.repositoryId),
    installationId: feedbackPositive(entry.installationId),
    discussionId: feedbackIdentifier(entry.discussionId),
    threadUrl: feedbackThreadUrl(entry.threadUrl),
    nativeRevision: feedbackHash(entry.nativeRevision),
    author: actor(entry.author),
    createdAt: feedbackTimestamp(entry.createdAt),
    updatedAt: feedbackTimestamp(entry.updatedAt),
    lastEditedAt: nullableTime(entry.lastEditedAt),
    titleDigest: feedbackHash(entry.titleDigest),
    bodyDigest: feedbackHash(entry.bodyDigest),
    answerChosenAt: nullableTime(entry.answerChosenAt),
    answerChosenBy: actor(entry.answerChosenBy),
    answer,
  };
  if (
    result.createdAt > result.updatedAt ||
    (result.lastEditedAt !== null && (result.lastEditedAt < result.createdAt || result.lastEditedAt > result.updatedAt))
  )
    return invalid();
  if (answer === null) {
    if (result.answerChosenAt !== null || result.answerChosenBy !== null) return invalid();
  } else if (
    result.answerChosenAt === null ||
    answer.createdAt < result.createdAt ||
    answer.createdAt > result.answerChosenAt ||
    answer.createdAt > answer.updatedAt ||
    (answer.lastEditedAt !== null && (answer.lastEditedAt < answer.createdAt || answer.lastEditedAt > answer.updatedAt))
  )
    return invalid();
  return result;
}
export function encodeDiscussionFeedbackDescriptor(value: unknown): string {
  return JSON.stringify(parseDiscussionFeedbackDescriptor(value));
}
export function parseDiscussionFeedbackObservation(value: unknown): DiscussionFeedbackObservation {
  const entry = discussionFeedbackFields(value, [
    "version",
    "descriptor",
    "fingerprint",
    "authorityHash",
    "coverageEpoch",
    "generation",
    "scanId",
  ]);
  if (entry.version !== discussionFeedbackContentVersion) return invalid();
  return {
    version: discussionFeedbackContentVersion,
    descriptor: parseDiscussionFeedbackDescriptor(entry.descriptor),
    fingerprint: feedbackHash(entry.fingerprint),
    authorityHash: feedbackHash(entry.authorityHash),
    coverageEpoch: feedbackHash(entry.coverageEpoch),
    generation: feedbackHash(entry.generation),
    scanId: feedbackIdentifier(entry.scanId),
  };
}
export function parseDiscussionFeedbackSource(value: unknown): DiscussionFeedbackSource {
  const entry = discussionFeedbackFields(value, ["metadata", "sourceRevision", "observedAt", "selectedCurrentState"]);
  if (
    typeof entry.selectedCurrentState !== "boolean" ||
    typeof entry.sourceRevision !== "string" ||
    entry.sourceRevision.length !== 102 ||
    !/^gdf1:[a-f0-9]{64}\.[a-f0-9]{32}$/.test(entry.sourceRevision)
  )
    return invalid();
  const metadata = parseDiscussionFeedbackObservation(entry.metadata),
    observedAt = feedbackTimestamp(entry.observedAt);
  const descriptor = metadata.descriptor;
  // A claimed original observation cannot precede any of the content or native
  // answer-selection clocks it is said to have observed. This also guards saved
  // current proof and direct receipt consumers, not just the normalizer path.
  const clocks = [
    descriptor.createdAt,
    descriptor.updatedAt,
    descriptor.lastEditedAt,
    descriptor.answerChosenAt,
    descriptor.answer?.createdAt ?? null,
    descriptor.answer?.updatedAt ?? null,
    descriptor.answer?.lastEditedAt ?? null,
  ];
  if (clocks.some((clock) => clock !== null && clock > observedAt)) return invalid();
  return {
    metadata,
    sourceRevision: entry.sourceRevision,
    observedAt,
    selectedCurrentState: entry.selectedCurrentState,
  };
}
export function parseAcceptedFeedbackThread(value: unknown): AcceptedFeedbackThread {
  const entry = discussionFeedbackFields(value, [
    "schemaVersion",
    "targetFactId",
    "actorId",
    "repositoryId",
    "discussionId",
    "threadUrl",
    "sourceMetricId",
    "sourceRevision",
    "descriptorFingerprint",
    "authorityHash",
    "coverageEpoch",
    "generation",
    "observedAt",
  ]);
  if (
    entry.schemaVersion !== acceptedFeedbackThreadsVersion ||
    !["discussions_started", "discussion_answers"].includes(entry.sourceMetricId as string) ||
    typeof entry.actorId !== "string" ||
    !/^[1-9][0-9]{0,15}$/.test(entry.actorId) ||
    !Number.isSafeInteger(Number(entry.actorId)) ||
    /[^0-9]/.test(entry.actorId) ||
    typeof entry.sourceRevision !== "string" ||
    entry.sourceRevision.length !== 102 ||
    !/^gdf1:[a-f0-9]{64}\.[a-f0-9]{32}$/.test(entry.sourceRevision)
  )
    return invalid();
  return {
    schemaVersion: acceptedFeedbackThreadsVersion,
    targetFactId: feedbackIdentifier(entry.targetFactId),
    actorId: entry.actorId,
    repositoryId: feedbackPositive(entry.repositoryId),
    discussionId: feedbackIdentifier(entry.discussionId),
    threadUrl: feedbackThreadUrl(entry.threadUrl),
    sourceMetricId: entry.sourceMetricId as AcceptedFeedbackThread["sourceMetricId"],
    sourceRevision: entry.sourceRevision,
    descriptorFingerprint: feedbackHash(entry.descriptorFingerprint),
    authorityHash: feedbackHash(entry.authorityHash),
    coverageEpoch: feedbackHash(entry.coverageEpoch),
    generation: feedbackHash(entry.generation),
    observedAt: feedbackTimestamp(entry.observedAt),
  };
}

/** The accepted record is a flat, bounded JSON object. Decode keys before
 * checking uniqueness: JSON.parse alone would silently accept repeated keys,
 * including escaped aliases such as "actorId" and "\u0061ctorId". */
export function parseAcceptedFeedbackThreadText(text: unknown): AcceptedFeedbackThread {
  if (typeof text !== "string" || text.length > 2000) return invalid();
  let offset = 0;
  const whitespace = () => {
    while (offset < text.length && /[ \t\r\n]/.test(text[offset]!)) offset++;
  };
  const stringToken = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const numberToken = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const token = (expression: RegExp): unknown => {
    expression.lastIndex = offset;
    const match = expression.exec(text);
    if (!match) return invalid();
    offset += match[0].length;
    return JSON.parse(match[0]);
  };
  whitespace();
  if (text[offset++] !== "{") return invalid();
  whitespace();
  const record: Record<string, unknown> = Object.create(null);
  const seen = new Set<string>();
  if (text[offset] !== "}")
    for (;;) {
      const key = token(stringToken) as string;
      if (seen.has(key)) return invalid();
      seen.add(key);
      whitespace();
      if (text[offset++] !== ":") return invalid();
      whitespace();
      record[key] = token(text[offset] === '"' ? stringToken : numberToken);
      whitespace();
      if (text[offset] === "}") break;
      if (text[offset++] !== ",") return invalid();
      whitespace();
    }
  if (text[offset++] !== "}") return invalid();
  whitespace();
  if (offset !== text.length) return invalid();
  return parseAcceptedFeedbackThread(record);
}
export function parseDiscussionFeedbackCapture(value: unknown): DiscussionFeedbackCapture[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 100 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return invalid();
  const result: DiscussionFeedbackCapture[] = [];
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property?.enumerable || !Object.hasOwn(property, "value")) return invalid();
    const entry = discussionFeedbackFields(property.value, ["repositoryId", "authorityHash", "coverageHash"]);
    const repositoryId = feedbackPositive(entry.repositoryId);
    if (index > 0 && repositoryId <= result[index - 1]!.repositoryId) return invalid();
    result.push({
      repositoryId,
      authorityHash: feedbackHash(entry.authorityHash),
      coverageHash: feedbackHash(entry.coverageHash),
    });
  }
  return result;
}
