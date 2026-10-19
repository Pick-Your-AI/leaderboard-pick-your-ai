/** Private reviewer input; only an authenticated acceptance audit grants target authority. */
export function parseReleaseReviewTarget(value) {
  const fields = ["targetFactId", "releaseId", "pullRequestNumber", "proofHash", "policyVersion"];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== fields.length ||
    !fields.every((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    }) ||
    typeof value.targetFactId !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,200}$/.test(value.targetFactId) ||
    !Number.isSafeInteger(value.releaseId) ||
    value.releaseId < 1 ||
    !Number.isSafeInteger(value.pullRequestNumber) ||
    value.pullRequestNumber < 1 ||
    typeof value.proofHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.proofHash) ||
    typeof value.policyVersion !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,200}$/.test(value.policyVersion)
  )
    throw new Error("Invalid release review target");
  return {
    targetFactId: value.targetFactId,
    releaseId: value.releaseId,
    pullRequestNumber: value.pullRequestNumber,
    proofHash: value.proofHash,
    policyVersion: value.policyVersion,
  };
}

/** Bind the exact private request reviewed; later configuration cannot reinterpret it. */
export function releaseReviewRequest(request) {
  return {
    owner: request.owner,
    locator: request.locator,
    category: request.category,
    scope: request.scope,
  };
}
