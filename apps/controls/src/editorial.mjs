import { randomUUID } from "node:crypto";
import { exactKeys, requireThat, text } from "./store.mjs";

export const EDITORIAL_RULE_VERSION = "reviewed-opt-in/v1";

/** Selection is editorial, never an input to measured metric totals. */
export function nominateSpotlight(state, session, input, now) {
  exactKeys(input, ["claimId", "consent"]);
  requireThat(input.consent === true, 400, "Explicit spotlight consent required");
  const claim = state.requests[text(input.claimId, 200)];
  requireThat(claim?.kind === "evidence" && claim.owner === session.actorId, 404, "Not found");
  requireThat(claim.status === "accepted", 409, "Accepted evidence required");
  requireThat(!state.profiles[session.actorId]?.suppressed, 409, "Profile is suppressed");
  const nominations = (state.spotlights ||= {});
  requireThat(Object.keys(nominations).length < 10_000, 503, "Nomination capacity reached");
  requireThat(
    !Object.values(nominations).some(
      (entry) => entry.claimId === claim.id && entry.claimVersion === claim.version && entry.status !== "withdrawn",
    ),
    409,
    "Already nominated",
  );
  const entry = {
    id: randomUUID(),
    owner: session.actorId,
    claimId: claim.id,
    claimVersion: claim.version,
    status: "pending",
    version: 1,
    nominatedAt: now,
    history: [],
  };
  nominations[entry.id] = entry;
  return entry;
}

export function decideSpotlight(state, session, id, input, now) {
  exactKeys(input, ["version", "action", "reason", "publicExplanation", "conflict"]);
  const entry = state.spotlights?.[id];
  requireThat(entry, 404, "Not found");
  requireThat(input.version === entry.version, 409, "Stale nomination");
  requireThat(["accept", "reject", "withdraw"].includes(input.action));
  if (input.action === "withdraw") {
    requireThat(entry.owner === session.actorId, 403, "Owner required");
  } else {
    requireThat(session.roles.includes("reviewer"), 403, "Reviewer required");
    const claim = state.requests[entry.claimId];
    requireThat(claim?.status === "accepted" && claim.version === entry.claimVersion, 409, "Accepted evidence changed");
    requireThat(
      session.actorId !== entry.owner &&
        !Object.hasOwn(claim.collaborators, session.actorId) &&
        input.conflict === false,
      403,
      "Independent review required",
    );
    requireThat(entry.status === "pending", 409, "Already reviewed");
  }
  const publicExplanation = input.action === "accept" ? text(input.publicExplanation, 1000) : null;
  entry.status = { accept: "accepted", reject: "rejected", withdraw: "withdrawn" }[input.action];
  entry.version++;
  const event = {
    id: randomUUID(),
    actor: session.actorId,
    action: entry.status,
    reason: text(input.reason, 1000),
    publicExplanation,
    at: now,
    version: entry.version,
  };
  entry.history.push(event);
  state.audit.push({ ...event, spotlight: entry.id });
  return entry;
}

/** Re-evaluate current consent/evidence on every read, including persisted decisions. */
export function projectSpotlights(state, eligibleClaim = () => false) {
  const groups = new Map();
  for (const entry of Object.values(state.spotlights || {})) {
    const claim = state.requests[entry.claimId];
    const profile = state.profiles[entry.owner];
    if (
      entry.status !== "accepted" ||
      claim?.status !== "accepted" ||
      claim.version !== entry.claimVersion ||
      profile?.suppressed ||
      eligibleClaim({
        claimId: claim.id,
        actorId: claim.owner,
        locator: claim.locator,
        category: claim.category,
        policyVersion: claim.policyVersion,
      }) !== true
    )
      continue;
    const decision = entry.history.at(-1);
    const item = {
      id: entry.id,
      actorId: entry.owner,
      claimId: claim.id,
      sourceUrl: claim.locator,
      category: claim.category,
      selectionExplanation: decision.publicExplanation,
      selectedAt: new Date(decision.at).toISOString(),
      ruleVersion: EDITORIAL_RULE_VERSION,
      label: "Editorial selection — not a computed ranking",
      bio: profile?.public ? profile.bio : null,
    };
    const group = groups.get(claim.category) || [];
    group.push(item);
    groups.set(claim.category, group);
  }
  // Round-robin categories; oldest reviewed item first, stable identity breaks ties.
  const queues = [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => group.sort((a, b) => a.selectedAt.localeCompare(b.selectedAt) || a.id.localeCompare(b.id)));
  const result = [];
  while (queues.some((queue) => queue.length)) for (const queue of queues) if (queue.length) result.push(queue.shift());
  return {
    ruleVersion: EDITORIAL_RULE_VERSION,
    ordering: "round-robin-category-oldest-selection-first",
    spotlights: result,
  };
}
