import { createHash, randomUUID } from "node:crypto";
import { ControlError, exactKeys, requireThat, text } from "./store.mjs";
import { projectSpotlights } from "./editorial.mjs";

export const ROTATION_VERSION = "editorial-dimensions/v1";
export const ROTATION_LIMITS = Object.freeze({ retained: 256, accepted: 32, history: 8, events: 64, bytes: 262144 });
const own = (value, key) => Object.hasOwn(value, key);
const integer = (value) => Number.isSafeInteger(value) && value > 0;
const id = (value) => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);

function declarations(value) {
  requireThat(Array.isArray(value.workstreams) && value.workstreams.length <= 4, 400, "At most four editorial labels");
  const workstreams = value.workstreams.map((label) => {
    const result = text(label, 100);
    requireThat(!/[\u0000-\u001f\u007f]/.test(result), 400, "Editorial labels cannot contain controls");
    requireThat(!/[\uD800-\uDFFF]/u.test(result), 400, "Editorial labels must be well-formed Unicode");
    return result;
  });
  requireThat(new Set(workstreams).size === workstreams.length, 400, "Duplicate editorial labels");
  requireThat(typeof value.behindScenes === "boolean", 400, "Explicit behind-the-scenes choice required");
  let newcomerPeriod = null;
  if (value.newcomerPeriod !== null) {
    exactKeys(value.newcomerPeriod, ["start", "end"]);
    const { start, end } = value.newcomerPeriod;
    for (const stamp of [start, end]) {
      requireThat(
        typeof stamp === "string" &&
          /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(stamp) &&
          Number.isFinite(Date.parse(stamp)) &&
          new Date(stamp).toISOString() === stamp,
        400,
        "Use the supported whole-second UTC timestamp ending .000Z",
      );
    }
    requireThat(
      start < end && Date.parse(end) - Date.parse(start) <= 366 * 86400000,
      400,
      "A finite supported period of at most 366 days is required",
    );
    newcomerPeriod = { start, end };
  }
  requireThat(workstreams.length || value.behindScenes || newcomerPeriod, 400, "Choose an editorial dimension");
  return { workstreams, behindScenes: value.behindScenes, newcomerPeriod };
}

/** Integrity identity of the exact consented proposal; never an authorization token. */
export function rotationDigest(record) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        ROTATION_VERSION,
        record.id,
        record.owner,
        record.nominationVersion,
        record.claimId,
        record.claimVersion,
        record.revision,
        record.workstreams,
        record.behindScenes,
        record.newcomerPeriod,
      ]),
    )
    .digest("hex");
}

function retained(state) {
  const records = state.spotlightRotations ?? {};
  requireThat(records && typeof records === "object" && !Array.isArray(records), 503, "Invalid editorial state");
  requireThat(Object.keys(records).length <= ROTATION_LIMITS.retained, 503, "Editorial state exceeds capacity");
  for (const [key, record] of Object.entries(records)) {
    try {
      requireThat(record && record.id === key && id(key) && integer(record.version) && integer(record.revision));
      requireThat(integer(record.claimVersion) && integer(record.nominationVersion));
      requireThat(typeof record.owner === "string" && typeof record.claimId === "string");
      requireThat(["pending", "accepted", "rejected", "withdrawn"].includes(record.status));
      requireThat(Array.isArray(record.history) && record.history.length <= ROTATION_LIMITS.events + 1);
      const normalized = declarations(record);
      requireThat(
        JSON.stringify(normalized) ===
          JSON.stringify({
            workstreams: record.workstreams,
            behindScenes: record.behindScenes,
            newcomerPeriod: record.newcomerPeriod,
          }),
      );
      requireThat(record.digest === rotationDigest(record));
      if (record.status === "accepted") {
        const decision = record.history.at(-1);
        requireThat(
          decision?.action === "accepted" &&
            decision.version === record.version &&
            decision.digest === record.digest &&
            decision.actor !== record.owner &&
            decision.conflict === false,
        );
        requireThat(text(record.publicExplanation, 1000) === record.publicExplanation);
        requireThat(decision.publicExplanation === record.publicExplanation);
      }
    } catch {
      throw new ControlError(503, "Invalid retained editorial declaration; no partial projection is served");
    }
  }
  return records;
}

function currentNomination(state, nominationId, eligibleClaim) {
  const nomination = state.spotlights?.[nominationId];
  requireThat(nomination && integer(nomination.version), 404, "Nomination unavailable");
  const item = projectSpotlights(state, eligibleClaim).spotlights.find((entry) => entry.id === nominationId);
  requireThat(item, 409, "Current accepted, consented and source-eligible spotlight required");
  return { nomination, item, claim: state.requests[nomination.claimId] };
}

function append(state, record, actor, action, at, extra = {}) {
  const event = {
    id: randomUUID(),
    spotlightRotation: record.id,
    actor,
    action,
    at,
    version: record.version,
    revision: record.revision,
    digest: record.digest,
    ...extra,
  };
  record.history.push(event);
  state.audit.push(structuredClone(event));
}

export function proposeRotation(state, session, input, now, eligibleClaim = () => false) {
  exactKeys(input, ["nominationId", "version", "workstreams", "behindScenes", "newcomerPeriod", "consent"]);
  requireThat(input.consent === true, 400, "Separate explicit dimension consent required");
  requireThat(id(input.nominationId));
  const records = retained(state);
  const previous = records[input.nominationId];
  requireThat(input.version === (previous?.version ?? null), 409, "Editorial declaration changed");
  requireThat(
    !previous || previous.history.length < ROTATION_LIMITS.events,
    409,
    "Amendment capacity reached; withdrawal remains available",
  );
  requireThat(
    previous || Object.keys(records).length < ROTATION_LIMITS.retained,
    503,
    "Editorial record capacity reached",
  );
  const { nomination } = currentNomination(state, input.nominationId, eligibleClaim);
  requireThat(nomination.owner === session.actorId, 403, "Owner required");
  const fields = declarations(input);
  requireThat(
    fields.newcomerPeriod === null || Date.parse(fields.newcomerPeriod.end) <= now,
    400,
    "The assessment period must already have ended",
  );
  const record = {
    id: nomination.id,
    owner: nomination.owner,
    nominationVersion: nomination.version,
    claimId: nomination.claimId,
    claimVersion: nomination.claimVersion,
    version: (previous?.version ?? 0) + 1,
    revision: (previous?.revision ?? 0) + 1,
    ...fields,
    status: "pending",
    publicExplanation: null,
    history: previous ? structuredClone(previous.history) : [],
  };
  record.digest = rotationDigest(record);
  append(state, record, session.actorId, "proposed", now, {
    nominationVersion: record.nominationVersion,
    claimId: record.claimId,
    claimVersion: record.claimVersion,
    ...structuredClone(fields),
  });
  (state.spotlightRotations ||= {})[record.id] = record;
  return structuredClone(record);
}

export function decideRotation(state, session, nominationId, input, now, eligibleClaim = () => false) {
  exactKeys(input, ["version", "action", "reason", "publicExplanation", "conflict"]);
  const record = state.spotlightRotations?.[nominationId];
  requireThat(record && own(state.spotlightRotations, nominationId), 404, "Declaration unavailable");
  requireThat(input.version === record.version, 409, "Editorial declaration changed");
  requireThat(["accept", "reject", "withdraw"].includes(input.action));
  const reason = text(input.reason, 1000);
  // Withdrawal must not depend on a still-valid source, claim, nomination or
  // remaining amendment capacity. It retires only this separate consent.
  if (input.action === "withdraw") {
    requireThat(record.owner === session.actorId, 403, "Owner required");
    requireThat(record.status !== "withdrawn", 409, "Already withdrawn");
    record.status = "withdrawn";
    record.publicExplanation = null;
    record.version++;
    append(state, record, session.actorId, "withdrawn", now, { reason });
    return structuredClone(record);
  }
  retained(state);
  requireThat(
    record.history.length < ROTATION_LIMITS.events,
    409,
    "Review capacity reached; withdrawal remains available",
  );
  requireThat(session.roles.includes("reviewer"), 403, "Reviewer required");
  requireThat(record.status === "pending", 409, "Current pending proposal required");
  const { nomination, claim } = currentNomination(state, nominationId, eligibleClaim);
  requireThat(
    nomination.version === record.nominationVersion && claim.version === record.claimVersion,
    409,
    "Nomination or evidence changed",
  );
  requireThat(
    session.actorId !== record.owner && !own(claim.collaborators, session.actorId) && input.conflict === false,
    403,
    "Independent review required",
  );
  const explanation = input.action === "accept" ? text(input.publicExplanation, 1000) : null;
  if (input.action === "accept") {
    const current = projectRotation(state, eligibleClaim).candidates;
    requireThat(current.length < ROTATION_LIMITS.accepted, 409, "Accepted editorial capacity reached");
    requireThat(
      record.newcomerPeriod === null ||
        current.filter((entry) => entry.newcomerPeriod !== null).length < ROTATION_LIMITS.history,
      409,
      "History assessment capacity reached",
    );
  }
  record.status = input.action === "accept" ? "accepted" : "rejected";
  record.publicExplanation = explanation;
  record.version++;
  append(state, record, session.actorId, record.status, now, {
    reason,
    conflict: false,
    publicExplanation: explanation,
  });
  return structuredClone(record);
}

export function rotationQueue(state, session, eligibleClaim = () => false) {
  const records = retained(state);
  let contexts = new Map();
  try {
    contexts = new Map(projectSpotlights(state, eligibleClaim).spotlights.map((item) => [item.id, item]));
  } catch {
    // Missing current source context must not prevent an owner withdrawing consent.
  }
  const result = {
    schemaVersion: ROTATION_VERSION,
    records: Object.values(records)
      .filter((entry) => entry.owner === session.actorId || session.roles.includes("reviewer"))
      .map(({ history, ...entry }) => {
        const nomination = state.spotlights?.[entry.id];
        const item = contexts.get(entry.id);
        const matching =
          item &&
          nomination?.version === entry.nominationVersion &&
          nomination.claimId === entry.claimId &&
          nomination.claimVersion === entry.claimVersion &&
          nomination.owner === entry.owner &&
          item.claimId === entry.claimId &&
          item.actorId === entry.owner;
        return {
          ...entry,
          historyCount: history.length,
          lastEvent: history.at(-1) ?? null,
          currentContext: matching
            ? {
                state: "current",
                sourceUrl: item.sourceUrl,
                category: item.category,
                selectionExplanation: item.selectionExplanation,
                selectedAt: item.selectedAt,
              }
            : { state: "unavailable" },
        };
      }),
  };
  requireThat(Buffer.byteLength(JSON.stringify(result)) <= 2_000_000, 503, "Editorial queue exceeds capacity");
  return result;
}

/** Only the unchanged v1 projector establishes current nomination eligibility. */
export function projectRotation(state, eligibleClaim = () => false) {
  const records = retained(state);
  const candidates = [];
  for (const item of projectSpotlights(state, eligibleClaim).spotlights) {
    const record = records[item.id];
    const nomination = state.spotlights[item.id];
    if (
      !record ||
      record.status !== "accepted" ||
      nomination.version !== record.nominationVersion ||
      nomination.claimId !== record.claimId ||
      nomination.claimVersion !== record.claimVersion ||
      nomination.owner !== record.owner
    )
      continue;
    candidates.push({
      ...item,
      nominationVersion: record.nominationVersion,
      claimVersion: record.claimVersion,
      classificationVersion: record.version,
      classificationRevision: record.revision,
      classificationDigest: record.digest,
      workstreams: [...record.workstreams],
      behindScenes: record.behindScenes,
      newcomerPeriod: record.newcomerPeriod && { ...record.newcomerPeriod },
      classificationExplanation: record.publicExplanation,
    });
  }
  requireThat(
    candidates.length <= ROTATION_LIMITS.accepted &&
      candidates.filter((entry) => entry.newcomerPeriod !== null).length <= ROTATION_LIMITS.history,
    503,
    "Editorial projection exceeds capacity; no prefix is served",
  );
  const result = { schemaVersion: ROTATION_VERSION, ordering: "reviewed-editorial-dimensions/v1", candidates };
  requireThat(
    Buffer.byteLength(JSON.stringify(result)) <= ROTATION_LIMITS.bytes,
    503,
    "Editorial response exceeds capacity",
  );
  return result;
}
