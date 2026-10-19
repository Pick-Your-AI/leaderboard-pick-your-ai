// These records are private provider proof, never public payload lineage or
// recognition authority. Identity joins require the complete typed binding.
export const issueTransferVersion = "github-issue-transfer/v1";
export const issueCreationScopeVersion = "github-issue-creation-scope/v1";
export const issueTransferLimits = Object.freeze({ rawRecords: 20000, records: 10000, repositories: 100 });

const fail = () => {
  throw new Error("invalid_issue_transfer_binding");
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const issueArtifactId = (value) =>
  typeof value === "string" && value.length >= 1 && value.length <= 200 && !/[^A-Za-z0-9_=.:-]/.test(value);
const repositoryId = (value) =>
  typeof value === "string" &&
  /^[1-9][0-9]{0,15}$/.test(value) &&
  !/[^0-9]/.test(value) &&
  Number.isSafeInteger(Number(value));
const sourceText = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 2000 &&
  value.trim() === value &&
  !/[\p{Cc}\p{Cf}]/u.test(value);
const clock = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
};
export function issueEndpointUrl(value, slug = null) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (
      url.href !== value ||
      url.origin !== "https://github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname.includes("..")
    )
      return false;
    const path = url.pathname.split("/");
    return (
      path.length === 5 &&
      path[0] === "" &&
      /^[A-Za-z0-9-]+$/.test(path[1]) &&
      /^[A-Za-z0-9_.-]+$/.test(path[2]) &&
      path[3] === "issues" &&
      /^[1-9][0-9]*$/.test(path[4]) &&
      Number.isSafeInteger(Number(path[4])) &&
      (slug === null || `${path[1]}/${path[2]}` === slug)
    );
  } catch {
    return false;
  }
}
const transferFields = [
  "schemaVersion",
  "sourceArtifactId",
  "targetArtifactId",
  "sourceRepositoryId",
  "targetRepositoryId",
  "sourceUrl",
  "targetUrl",
  "observationId",
  "sourceRevision",
  "observedAt",
  "occurredAt",
  "eventId",
];
const creationFields = [
  "schemaVersion",
  "factId",
  "artifactId",
  "repositoryId",
  "observationId",
  "sourceRevision",
  "observedAt",
  "occurredAt",
  "eventId",
];
const exact = (value, fields) =>
  object(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
const recordKey = (entry, fields) => JSON.stringify(fields.map((field) => entry[field]));
function records(value, fields, validate) {
  if (!Array.isArray(value) || value.length > issueTransferLimits.rawRecords) fail();
  const unique = new Map();
  for (const entry of value) {
    if (!exact(entry, fields) || !validate(entry)) fail();
    unique.set(recordKey(entry, fields), Object.fromEntries(fields.map((field) => [field, entry[field]])));
    if (unique.size > issueTransferLimits.records) fail();
  }
  return [...unique].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}
export function validateIssueTransfers(value = []) {
  return records(
    value,
    transferFields,
    (entry) =>
      entry.schemaVersion === issueTransferVersion &&
      issueArtifactId(entry.sourceArtifactId) &&
      issueArtifactId(entry.targetArtifactId) &&
      repositoryId(entry.sourceRepositoryId) &&
      repositoryId(entry.targetRepositoryId) &&
      entry.sourceRepositoryId !== entry.targetRepositoryId &&
      issueEndpointUrl(entry.sourceUrl) &&
      issueEndpointUrl(entry.targetUrl) &&
      issueArtifactId(entry.observationId) &&
      sourceText(entry.sourceRevision) &&
      clock(entry.observedAt) &&
      (entry.occurredAt === null || (clock(entry.occurredAt) && entry.occurredAt <= entry.observedAt)) &&
      (entry.eventId === null || sourceText(entry.eventId)),
  );
}
export function validateIssueCreationScopes(value = []) {
  return records(
    value,
    creationFields,
    (entry) =>
      entry.schemaVersion === issueCreationScopeVersion &&
      issueArtifactId(entry.factId) &&
      issueArtifactId(entry.artifactId) &&
      repositoryId(entry.repositoryId) &&
      issueArtifactId(entry.observationId) &&
      sourceText(entry.sourceRevision) &&
      sourceText(entry.eventId) &&
      clock(entry.observedAt) &&
      clock(entry.occurredAt) &&
      entry.occurredAt <= entry.observedAt,
  );
}
function seeds(values, validator, limit) {
  if (!Array.isArray(values) || values.length > limit || !values.every(validator)) fail();
  return new Set(values);
}
function graph(records) {
  const adjacent = new Map();
  for (const entry of records) {
    for (const [left, right] of [
      [entry.sourceArtifactId, entry.targetArtifactId],
      [entry.targetArtifactId, entry.sourceArtifactId],
    ]) {
      if (!adjacent.has(left)) adjacent.set(left, new Set());
      adjacent.get(left).add(right);
    }
  }
  return adjacent;
}
function expand(adjacent, selected) {
  const queue = [...selected];
  for (let at = 0; at < queue.length; at++) {
    for (const next of adjacent.get(queue[at]) ?? []) {
      if (selected.has(next)) continue;
      selected.add(next);
      queue.push(next);
    }
  }
  return selected;
}

/** Exact selected-artifact/endpoint closure; a shared repository alone never
 * joins unrelated issues. Target repositories need no source-fact row. */
export function issueTransferClosure(value, { artifactIds = [], repositoryIds = [] } = {}) {
  const transfers = validateIssueTransfers(value);
  const selected = seeds(artifactIds, issueArtifactId, issueTransferLimits.rawRecords);
  const repositories = seeds(repositoryIds, repositoryId, issueTransferLimits.repositories);
  for (const entry of transfers) {
    if (repositories.has(entry.sourceRepositoryId)) selected.add(entry.sourceArtifactId);
    if (repositories.has(entry.targetRepositoryId)) selected.add(entry.targetArtifactId);
  }
  expand(graph(transfers), selected);
  const included = transfers.filter((entry) => selected.has(entry.sourceArtifactId));
  for (const entry of included) {
    repositories.add(entry.sourceRepositoryId);
    repositories.add(entry.targetRepositoryId);
  }
  if (repositories.size > issueTransferLimits.repositories) fail();
  return {
    artifactIds: [...selected].sort(),
    repositoryIds: [...repositories].sort((a, b) => Number(a) - Number(b)),
    transfers: included,
  };
}

/** A current unavailable endpoint withdraws its entire proven component,
 * including pinned aliases. Direct removals outside this graph stay literal. */
export function expandIssueTransferSuppressions(value, { artifactIds = [], unavailableRepositoryIds = [] } = {}) {
  const transfers = validateIssueTransfers(value);
  const selected = seeds(artifactIds, issueArtifactId, issueTransferLimits.rawRecords);
  const unavailable = seeds(unavailableRepositoryIds, repositoryId, issueTransferLimits.repositories);
  for (const entry of transfers) {
    if (unavailable.has(entry.sourceRepositoryId)) selected.add(entry.sourceArtifactId);
    if (unavailable.has(entry.targetRepositoryId)) selected.add(entry.targetArtifactId);
  }
  return [...expand(graph(transfers), selected)].sort();
}
