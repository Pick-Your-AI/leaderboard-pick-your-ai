import { control, type Session } from "./client.ts";

type ObjectValue = Record<string, unknown>;
export interface FrozenPolicyInput {
  inputId: string;
  inputHash: string;
  scopeHash: string;
  baselineHash: string;
  cutoff: string;
  expiresAt: string;
  snapshot: { snapshotId: string; revision: number };
  policies: Array<{ metricId: string; version: string; policyHash: string }>;
}
export interface PolicyChange {
  actorId: string;
  beforeValue: number | null;
  afterValue: number | null;
  beforeRank: number | null;
  afterRank: number | null;
  included: string[];
  excluded: string[];
  causes: {
    changedPolicyFields: string[];
    included: Array<{ factId: string; reasons: string[]; revision: number | null }>;
    excluded: Array<{ factId: string; reasons: string[]; revision: number | null }>;
    value: string | null;
    rank: string | null;
  };
}
export interface PolicyPreview {
  comparisonId: string;
  inputId: string;
  resultHash: string;
  responseHash: string;
  redactionsApplied: boolean;
  beforePolicy: ObjectValue;
  candidatePolicy: ObjectValue;
  before: { policyVersion: string; coverage: unknown; rows: unknown[] };
  after: { policyVersion: string; coverage: unknown; rows: unknown[] };
  changes: PolicyChange[];
}
const object = (v: unknown): v is ObjectValue => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const date = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 10_000 && v.every(text);
const numberOrNull = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v));
const rank = (v: unknown) => v === null || (Number.isSafeInteger(v) && Number(v) > 0);
const fail = () => new Error("Invalid private policy comparison response. Reload retained inputs.");

export function checkedPolicyInputs(value: unknown, now = Date.now()): FrozenPolicyInput[] {
  if (!object(value) || value.status !== "candidate_preview" || !Array.isArray(value.inputs) || value.inputs.length > 8)
    throw fail();
  const ids = new Set<string>();
  return value.inputs.map((entry) => {
    if (
      !object(entry) ||
      entry.schemaVersion !== "private-policy-preview/v1" ||
      !hash(entry.inputId) ||
      ids.has(entry.inputId) ||
      !hash(entry.inputHash) ||
      !hash(entry.scopeHash) ||
      !hash(entry.baselineHash) ||
      !date(entry.cutoff) ||
      !date(entry.expiresAt) ||
      Date.parse(entry.expiresAt) <= now ||
      !object(entry.snapshot) ||
      !text(entry.snapshot.snapshotId) ||
      !rank(entry.snapshot.revision) ||
      entry.snapshot.revision === null ||
      !Array.isArray(entry.policies) ||
      entry.policies.length > 98 ||
      !entry.policies.every((p) => object(p) && text(p.metricId) && text(p.version) && hash(p.policyHash)) ||
      new Set(entry.policies.map((p) => p.metricId)).size !== entry.policies.length
    )
      throw fail();
    ids.add(entry.inputId);
    return entry as unknown as FrozenPolicyInput;
  });
}

export function readCandidatePolicy(json: string, input: FrozenPolicyInput): ObjectValue {
  if (new TextEncoder().encode(json).length > 8192) throw new Error("Candidate policy must fit within 8 KiB.");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Enter a complete candidate policy as valid JSON.");
  }
  if (
    !object(value) ||
    !text(value.metricId) ||
    !text(value.version) ||
    !input.policies.some((p) => p.metricId === value.metricId)
  )
    throw new Error("Choose a metric present in the selected frozen input and supply a policy version.");
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function causes(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 10_000 &&
    value.every(
      (c) =>
        object(c) &&
        text(c.factId) &&
        strings(c.reasons) &&
        (c.revision === null || (Number.isSafeInteger(c.revision) && Number(c.revision) >= 0)),
    )
  );
}
export function checkedPolicyPreview(value: unknown, input: FrozenPolicyInput, candidate?: ObjectValue): PolicyPreview {
  if (
    Date.parse(input.expiresAt) <= Date.now() ||
    !object(value) ||
    value.schemaVersion !== "private-policy-preview/v1" ||
    value.status !== "candidate_preview" ||
    value.publicEnabled !== false ||
    value.activationSupported !== false ||
    value.approvalRequired !== true ||
    value.releaseNotesRequired !== true ||
    !hash(value.comparisonId) ||
    value.inputId !== input.inputId ||
    value.inputHash !== input.inputHash ||
    value.scopeHash !== input.scopeHash ||
    value.cutoff !== input.cutoff ||
    !object(value.snapshot) ||
    value.snapshot.snapshotId !== input.snapshot.snapshotId ||
    value.snapshot.revision !== input.snapshot.revision ||
    !hash(value.resultHash) ||
    !hash(value.responseHash) ||
    typeof value.redactionsApplied !== "boolean" ||
    !object(value.beforePolicy) ||
    !object(value.candidatePolicy) ||
    !text(value.candidatePolicy.metricId) ||
    !text(value.candidatePolicy.version) ||
    (candidate && canonical(candidate) !== canonical(value.candidatePolicy)) ||
    !input.policies.some(
      (p) =>
        p.metricId === (value.beforePolicy as ObjectValue).metricId &&
        p.metricId === (value.candidatePolicy as ObjectValue).metricId &&
        p.version === (value.beforePolicy as ObjectValue).version &&
        p.policyHash === value.beforePolicyHash,
    ) ||
    !object(value.before) ||
    !object(value.after) ||
    value.before.policyVersion !== value.beforePolicy.version ||
    value.after.policyVersion !== value.candidatePolicy.version ||
    !Array.isArray(value.before.rows) ||
    value.before.rows.length > 2000 ||
    !Array.isArray(value.after.rows) ||
    value.after.rows.length > 2000 ||
    !Array.isArray(value.changes) ||
    value.changes.length > 2000 ||
    !value.changes.every(
      (c) =>
        object(c) &&
        text(c.actorId) &&
        numberOrNull(c.beforeValue) &&
        numberOrNull(c.afterValue) &&
        rank(c.beforeRank) &&
        rank(c.afterRank) &&
        strings(c.included) &&
        strings(c.excluded) &&
        object(c.causes) &&
        strings(c.causes.changedPolicyFields) &&
        causes(c.causes.included) &&
        causes(c.causes.excluded) &&
        (c.causes.value === null || text(c.causes.value)) &&
        (c.causes.rank === null || text(c.causes.rank)) &&
        (!value.redactionsApplied || (c.beforeRank === null && c.afterRank === null)),
    )
  )
    throw fail();
  return value as unknown as PolicyPreview;
}
export async function policyInputs(): Promise<FrozenPolicyInput[]> {
  return checkedPolicyInputs(await control("/controls/policy-comparisons/inputs"));
}
export async function comparePolicy(
  input: FrozenPolicyInput,
  candidate: ObjectValue,
  session: Session,
): Promise<PolicyPreview> {
  return checkedPolicyPreview(
    await control("/controls/policy-comparisons", session, { inputId: input.inputId, candidatePolicy: candidate }),
    input,
    candidate,
  );
}
export async function rereadPolicy(input: FrozenPolicyInput, comparisonId: string): Promise<PolicyPreview> {
  if (!hash(comparisonId)) throw new Error("Enter a saved comparison ID of 64 lowercase hexadecimal characters.");
  const result = checkedPolicyPreview(await control(`/controls/policy-comparisons/${comparisonId}`), input);
  if (result.comparisonId !== comparisonId) throw fail();
  return result;
}
