/** Private reviewer input. This target becomes authority only after an authenticated acceptance audit. */
export function parseLocalizationReviewTarget(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "category,locale,policyVersion,sourceRevision,targetFactId" ||
    ![value.category, value.locale, value.policyVersion, value.sourceRevision, value.targetFactId].every(
      (item) => typeof item === "string",
    ) ||
    !/^[A-Za-z0-9_.:-]{1,200}$/.test(value.targetFactId) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.sourceRevision) ||
    !/^[A-Za-z0-9_.:-]{1,200}$/.test(value.policyVersion) ||
    !/^[a-z][a-z0-9_]{0,39}$/.test(value.category) ||
    value.locale.length > 64 ||
    !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value.locale)
  )
    throw new Error("Invalid localization review target");
  const locale = new Intl.Locale(value.locale);
  if (
    locale.baseName !== value.locale ||
    Intl.getCanonicalLocales(value.locale)[0] !== value.locale ||
    ["und", "mul", "zxx"].includes(value.locale.split("-")[0])
  )
    throw new Error("Invalid localization review target");
  return {
    targetFactId: value.targetFactId,
    sourceRevision: value.sourceRevision,
    locale: value.locale,
    category: value.category,
    policyVersion: value.policyVersion,
  };
}

/** Snapshot the request fields the reviewer sees; later configuration cannot reinterpret them. */
export function localizationReviewRequest(request) {
  return {
    owner: request.owner,
    locator: request.locator,
    category: request.category,
    scope: request.scope,
  };
}
