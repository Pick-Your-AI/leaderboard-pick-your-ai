/** Every listed participant must consent before this optional claim can be public. */
export function hasRequiredParticipantConsent(request) {
  const collaborators = request?.collaborators;
  return (
    request?.kind === "evidence" &&
    collaborators !== null &&
    typeof collaborators === "object" &&
    !Array.isArray(collaborators) &&
    Object.values(collaborators).every((consent) => consent === "accepted")
  );
}

/** A legacy acceptance cannot authorize consent supplied after that review. */
export function hasReviewedParticipantConsent(request) {
  if (!hasRequiredParticipantConsent(request)) return false;
  if (Object.keys(request.collaborators).length === 0) return true;
  const accepted = Array.isArray(request.history)
    ? request.history.findLast((event) => event?.action === "accepted")
    : undefined;
  return Number.isSafeInteger(request.version) && request.version > 0 && accepted?.version === request.version;
}
