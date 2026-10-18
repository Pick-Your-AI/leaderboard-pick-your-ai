export interface ReplayWindow {
  repositoryId: number;
  receivedSince: string;
  receivedUntil: string;
  limit: number;
  policyVersion: string;
}
export interface WindowPreview {
  window: ReplayWindow;
  sourceGeneration: string;
  authorityRevision: string;
  revision: string;
  deliveries: Array<{ deliveryId: string; attempts: number | null; reason: string; revision: string }>;
  meaning: string;
}
export interface WindowReceipt {
  id: string;
  window: ReplayWindow;
  sourceGeneration: string;
  status: "queued";
  receipts: Array<{ id: string; deliveryId: string; beforeRevision: string; queuedRevision: string }>;
  beforeRevision: string;
  queuedRevision: string;
  resultingPublicationRevision: null;
}
const revision = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const sameWindow = (a: ReplayWindow | undefined, b: ReplayWindow) =>
  a?.repositoryId === b.repositoryId &&
  a.receivedSince === b.receivedSince &&
  a.receivedUntil === b.receivedUntil &&
  a.limit === b.limit &&
  a.policyVersion === b.policyVersion;

/** Interpret an explicitly labeled UTC input without using the browser's local time zone. */
export function replayWindowInput(
  repositoryId: number,
  policyVersion: string,
  receivedSince: string,
  receivedUntil: string,
  limit: number,
): ReplayWindow {
  const utc = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value)) throw Error("Invalid UTC window.");
    const full = value.length === 16 ? `${value}:00` : value;
    const canonical = full.includes(".") ? `${full}${"0".repeat(23 - full.length)}Z` : `${full}.000Z`;
    if (!Number.isFinite(Date.parse(canonical)) || new Date(canonical).toISOString() !== canonical)
      throw Error("Invalid UTC window.");
    return canonical;
  };
  const since = utc(receivedSince),
    until = utc(receivedUntil);
  if (
    !Number.isSafeInteger(repositoryId) ||
    repositoryId < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    Date.parse(until) <= Date.parse(since) ||
    Date.parse(until) - Date.parse(since) > 31 * 86400_000
  )
    throw Error("Choose a UTC window of at most 31 days and a limit from 1 to 50.");
  return { repositoryId, policyVersion, receivedSince: since, receivedUntil: until, limit };
}

/** Do not show a preview or report queued success for another scope, authority, or selection. */
export function checkedWindowPreview(
  value: WindowPreview,
  expected: ReplayWindow,
  sourceGeneration: string,
  authorityRevision: string,
): WindowPreview {
  if (
    !value ||
    !sameWindow(value.window, expected) ||
    value.sourceGeneration !== sourceGeneration ||
    value.authorityRevision !== authorityRevision ||
    !revision(value.revision) ||
    typeof value.meaning !== "string" ||
    !Array.isArray(value.deliveries) ||
    value.deliveries.length > expected.limit ||
    value.deliveries.some(
      (row) =>
        !row ||
        !uuid(row.deliveryId) ||
        !revision(row.revision) ||
        !(row.attempts === null || (Number.isSafeInteger(row.attempts) && row.attempts >= 0)) ||
        !["source_unavailable", "normalization_failed", "unsupported_payload", "unknown"].includes(row.reason),
    ) ||
    new Set(value.deliveries.map((row) => row.deliveryId)).size !== value.deliveries.length
  )
    throw Error("Window preview changed or is invalid.");
  return value;
}

export function checkedWindowReceipt(value: WindowReceipt, preview: WindowPreview): WindowReceipt {
  if (
    !value ||
    !sameWindow(value.window, preview.window) ||
    value.sourceGeneration !== preview.sourceGeneration ||
    value.status !== "queued" ||
    !uuid(value.id) ||
    value.beforeRevision !== preview.revision ||
    !revision(value.queuedRevision) ||
    value.resultingPublicationRevision !== null ||
    !Array.isArray(value.receipts) ||
    !value.receipts.length ||
    value.receipts.length !== preview.deliveries.length ||
    value.receipts.some(
      (row, index) =>
        !row ||
        !uuid(row.id) ||
        row.deliveryId !== preview.deliveries[index]!.deliveryId ||
        row.beforeRevision !== preview.deliveries[index]!.revision ||
        !revision(row.queuedRevision),
    ) ||
    new Set(value.receipts.map((row) => row.id)).size !== value.receipts.length
  )
    throw Error("Window replay receipt changed or is invalid.");
  return value;
}
