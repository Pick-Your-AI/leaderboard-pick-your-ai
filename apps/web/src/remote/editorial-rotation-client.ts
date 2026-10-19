import { metricRegistryV1 } from "@pick-your-ai/metrics";
import { compareSourceInstants } from "@pick-your-ai/contracts";
import { profile, portfolioParameters, publicLink, ReadFailure, request, selection, type Selection } from "./client.ts";
import {
  participationHistory,
  participationHistoryParameters,
  participationHistoryPath,
  type ContributorHistory,
} from "./participation-history-client.ts";
import { supportsEditorialScope } from "./recognition-client.ts";

export const editorialDimensionsVersion = "editorial-dimensions/v1";
export interface EditorialPeriod {
  start: string;
  end: string;
}
export interface EditorialCandidate {
  id: string;
  actorId: string;
  claimId: string;
  sourceUrl: string;
  category: string;
  selectionExplanation: string;
  selectedAt: string;
  ruleVersion: "reviewed-opt-in/v1";
  label: string;
  bio: string | null;
  nominationVersion: number;
  claimVersion: number;
  classificationVersion: number;
  classificationRevision: number;
  classificationDigest: string;
  workstreams: string[];
  behindScenes: boolean;
  newcomerPeriod: EditorialPeriod | null;
  classificationExplanation: string;
}
export type EditorialAssessment =
  | { state: "not_requested" }
  | { state: "unknown"; reason: string }
  | {
      state: "known";
      value: ContributorHistory & { history: Extract<ContributorHistory["history"], { state: "known" }> };
    };
export interface EditorialCard {
  candidate: EditorialCandidate;
  assessment: EditorialAssessment;
}
const fail = (): never => {
  throw new ReadFailure(502, "invalid_editorial_dimensions_response");
};
const exact = (value: unknown, keys: string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) return fail();
  return record;
};
const text = (value: unknown, maximum: number, lines = false): string => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    (lines ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)
  )
    return fail();
  return value;
};
const identity = (value: unknown): string => {
  const result = text(value, 200);
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(result) || result === "." || result === "..") return fail();
  return result;
};
const positive = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fail();
const timestamp = (value: unknown): string => {
  const result = text(value, 24);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result) ||
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString() !== result
  )
    return fail();
  return result;
};
export function editorialPeriod(value: unknown): EditorialPeriod | null {
  if (value === null) return null;
  const p = exact(value, ["start", "end"]);
  const start = timestamp(p.start),
    end = timestamp(p.end);
  if (
    start >= end ||
    !start.endsWith(".000Z") ||
    !end.endsWith(".000Z") ||
    Date.parse(end) - Date.parse(start) > 366 * 86400000
  )
    return fail();
  return { start, end };
}

/** New closed wire contract; neither historical v1 reader is changed. */
export function editorialCandidates(value: unknown): EditorialCandidate[] {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 262144) return fail();
  const response = exact(value, ["schemaVersion", "ordering", "candidates"]);
  if (
    response.schemaVersion !== editorialDimensionsVersion ||
    response.ordering !== "reviewed-editorial-dimensions/v1" ||
    !Array.isArray(response.candidates) ||
    response.candidates.length > 32
  )
    return fail();
  const candidates = response.candidates.map((raw): EditorialCandidate => {
    const r = exact(raw, [
      "id",
      "actorId",
      "claimId",
      "sourceUrl",
      "category",
      "selectionExplanation",
      "selectedAt",
      "ruleVersion",
      "label",
      "bio",
      "nominationVersion",
      "claimVersion",
      "classificationVersion",
      "classificationRevision",
      "classificationDigest",
      "workstreams",
      "behindScenes",
      "newcomerPeriod",
      "classificationExplanation",
    ]);
    const id = identity(r.id);
    if (
      !/^[a-f0-9-]{36}$/.test(id) ||
      r.ruleVersion !== "reviewed-opt-in/v1" ||
      r.label !== "Editorial selection — not a computed ranking" ||
      typeof r.behindScenes !== "boolean" ||
      !Array.isArray(r.workstreams) ||
      r.workstreams.length > 4 ||
      typeof r.classificationDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(r.classificationDigest)
    )
      return fail();
    const workstreams = r.workstreams.map((name) => text(name, 100));
    if (workstreams.some((name) => /[\uD800-\uDFFF]/u.test(name))) return fail();
    if (new Set(workstreams).size !== workstreams.length || workstreams.some((name) => name.trim() !== name))
      return fail();
    const sourceUrl = text(r.sourceUrl, 2048);
    if (publicLink(sourceUrl) !== sourceUrl || new URL(sourceUrl).hostname !== "github.com") return fail();
    const newcomerPeriod = editorialPeriod(r.newcomerPeriod);
    if (!workstreams.length && !r.behindScenes && newcomerPeriod === null) return fail();
    return {
      id,
      actorId: identity(r.actorId),
      claimId: identity(r.claimId),
      sourceUrl,
      category: text(r.category, 200),
      selectionExplanation: text(r.selectionExplanation, 1000, true),
      selectedAt: timestamp(r.selectedAt),
      ruleVersion: "reviewed-opt-in/v1",
      label: r.label,
      bio: r.bio === null || r.bio === "" ? null : text(r.bio, 500),
      nominationVersion: positive(r.nominationVersion),
      claimVersion: positive(r.claimVersion),
      classificationVersion: positive(r.classificationVersion),
      classificationRevision: positive(r.classificationRevision),
      classificationDigest: r.classificationDigest,
      workstreams,
      behindScenes: r.behindScenes,
      newcomerPeriod,
      classificationExplanation: text(r.classificationExplanation, 1000, true),
    };
  });
  if (
    new Set(candidates.map((c) => c.id)).size !== candidates.length ||
    candidates.filter((c) => c.newcomerPeriod).length > 8
  )
    return fail();
  return candidates;
}

export function editorialBinding(c: EditorialCandidate): string {
  return JSON.stringify([
    c.id,
    c.actorId,
    c.nominationVersion,
    c.claimId,
    c.claimVersion,
    c.classificationVersion,
    c.classificationRevision,
    c.classificationDigest,
    c.workstreams,
    c.behindScenes,
    c.newcomerPeriod,
  ]);
}
const bytes = new TextEncoder();
/** UTF-8 ordering has no host-locale dependency and preserves distinct spellings. */
export function editorialCompare(a: string, b: string): number {
  if (/[\uD800-\uDFFF]/u.test(a) || /[\uD800-\uDFFF]/u.test(b)) return fail();
  const x = bytes.encode(a),
    y = bytes.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
export function orderEditorialDimensions(cards: EditorialCard[]): EditorialCard[] {
  const names = [...new Set(cards.flatMap((card) => card.candidate.workstreams))].sort(editorialCompare);
  const lanes = names.map((name) => cards.filter((card) => card.candidate.workstreams.includes(name)));
  lanes.push(cards.filter((card) => card.candidate.behindScenes));
  lanes.push(
    cards.filter((card) => card.assessment.state === "known" && card.assessment.value.history.newcomer === true),
  );
  for (const lane of lanes)
    lane.sort(
      (a, b) =>
        compareSourceInstants(a.candidate.selectedAt, b.candidate.selectedAt) ||
        editorialCompare(a.candidate.id, b.candidate.id),
    );
  const emitted = new Set<string>(),
    result: EditorialCard[] = [];
  while (lanes.some((lane) => lane.length))
    for (const lane of lanes) {
      while (lane.length && emitted.has(lane[0]!.candidate.id)) lane.shift();
      const item = lane.shift();
      if (item) {
        emitted.add(item.candidate.id);
        result.push(item);
      }
    }
  return result;
}

type Read = (base: string, path: string, params: URLSearchParams, signal: AbortSignal) => Promise<unknown>;
async function cancellable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void task.catch(() => undefined);
    signal.throwIfAborted();
  }
  return new Promise((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    task.then(
      (value) => {
        cleanup();
        signal.aborted ? reject(signal.reason) : resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
async function deadline<T>(
  milliseconds: number,
  parent: AbortSignal,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new DOMException("Editorial read budget exhausted", "TimeoutError")),
    milliseconds,
  );
  const signal = AbortSignal.any([parent, timeout.signal]);
  try {
    return await cancellable(action(signal), signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Each history read uses an independently fetched, exactly scoped profile. */
export async function readEditorialAssessment(
  base: string,
  organization: string,
  candidate: EditorialCandidate,
  signal: AbortSignal,
  read: Read = request,
): Promise<EditorialAssessment> {
  if (candidate.newcomerPeriod === null) return { state: "not_requested" };
  const p = candidate.newcomerPeriod;
  const selected = selection(
    "?" + new URLSearchParams({ organization, start: p.start, end: p.end, actors: "all", limit: "1" }),
  );
  const parent = profile(
    await cancellable(
      read(base, `contributors/${encodeURIComponent(candidate.actorId)}`, portfolioParameters(selected), signal),
      signal,
    ),
    selected,
  );
  if (parent.actorId !== candidate.actorId) return fail();
  const pinned = { ...selected, snapshot: parent.snapshotId, cursor: null };
  const result = participationHistory(
    await cancellable(
      read(
        base,
        participationHistoryPath(candidate.actorId),
        participationHistoryParameters(selected, parent.snapshotId),
        signal,
      ),
      signal,
    ),
    pinned,
    candidate.actorId,
    parent,
    metricRegistryV1.metrics,
  );
  if (result.history.state !== "known") return { state: "unknown", reason: result.history.reason };
  if (result.history.newcomer === null)
    return { state: "unknown", reason: result.history.periodReason ?? "incomplete_period" };
  return {
    state: "known",
    value: result as ContributorHistory & { history: Extract<ContributorHistory["history"], { state: "known" }> },
  };
}

export interface EditorialDimensionsResult {
  cards: EditorialCard[];
  ordered: EditorialCard[];
}
/** A final projection replaces every earlier public byte, not just its identities. */
export async function readEditorialDimensions(
  controlsBase: string,
  publicBase: string,
  organization: string,
  selected: Selection,
  signal: AbortSignal,
  read: Read = request,
): Promise<EditorialDimensionsResult> {
  if (!supportsEditorialScope(selected, organization)) throw new ReadFailure(400, "editorial_scope_unavailable");
  const original = await deadline(8000, signal, async (s) =>
    editorialCandidates(await read(controlsBase, "spotlight-rotation", new URLSearchParams(), s)),
  );
  const assessed = new Map<string, { binding: string; assessment: EditorialAssessment }>();
  for (const candidate of original)
    assessed.set(candidate.id, {
      binding: editorialBinding(candidate),
      assessment: candidate.newcomerPeriod ? { state: "unknown", reason: "unassessed" } : { state: "not_requested" },
    });
  const candidates = original.filter((c) => c.newcomerPeriod !== null);
  let cursor = 0;
  try {
    await deadline(10000, signal, async (sourceSignal) => {
      const worker = async () => {
        while (cursor < candidates.length) {
          sourceSignal.throwIfAborted();
          const candidate = candidates[cursor++]!;
          let assessment: EditorialAssessment;
          try {
            assessment = await readEditorialAssessment(publicBase, organization, candidate, sourceSignal, read);
          } catch {
            sourceSignal.throwIfAborted();
            assessment = { state: "unknown", reason: "history_unavailable" };
          }
          sourceSignal.throwIfAborted();
          assessed.set(candidate.id, { binding: editorialBinding(candidate), assessment });
        }
      };
      await Promise.all([worker(), worker()]);
    });
  } catch {
    signal.throwIfAborted();
    // A partial timed-out batch does not retain even an earlier successful assessment.
    for (const candidate of candidates)
      assessed.set(candidate.id, {
        binding: editorialBinding(candidate),
        assessment: { state: "unknown", reason: "history_budget_exhausted" },
      });
  }
  const fresh = await deadline(8000, signal, async (s) =>
    editorialCandidates(await read(controlsBase, "spotlight-rotation", new URLSearchParams(), s)),
  );
  signal.throwIfAborted();
  const cards = fresh.map((candidate): EditorialCard => {
    const previous = assessed.get(candidate.id);
    return {
      candidate,
      assessment:
        candidate.newcomerPeriod === null
          ? { state: "not_requested" }
          : previous?.binding === editorialBinding(candidate)
            ? previous.assessment
            : { state: "unknown", reason: "changed_or_unassessed" },
    };
  });
  return { cards, ordered: orderEditorialDimensions(cards) };
}
