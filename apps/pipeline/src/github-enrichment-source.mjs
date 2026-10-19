import { githubReviewRevision, verifyGithubRestSnapshotRevision } from "@pick-your-ai/github";
import { compareSourceInstants } from "@pick-your-ai/contracts";

const abortedState = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;
const unavailable = () => {
  throw new Error("github_enrichment_unavailable");
};
const invalid = () => {
  throw new TypeError("invalid_github_enrichment_options");
};
const object = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const text = (value, maximum = 200) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  value.trim() === value &&
  !/[\x00-\x1f\x7f]/.test(value);
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const sha = (value) => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
const optionalNode = (value) => value === undefined || text(value);
const count = (value) => {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) unavailable();
  return value;
};
const instant = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)) unavailable();
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result) || result < 0 || new Date(result).toISOString().slice(0, 19) !== value.slice(0, 19))
    unavailable();
  return value;
};
const ignoreAsync = (value) => {
  if (value && typeof value.then === "function") void Promise.resolve(value).catch(() => undefined);
};
const copy = (value) => {
  if (!object(value)) unavailable();
  return structuredClone(value);
};
const exactKeys = (value, keys) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function factSnapshot(value, family) {
  const fact = copy(value);
  const required = ["subjectId", "sourceRevision", "sourceUrl", "evidence", "actorId", "occurredAt", "state"];
  const optional = ["historySubjectId", "projectSubjectId"];
  if (
    !required.every((key) => Object.hasOwn(fact, key)) ||
    Object.keys(fact).some((key) => !required.includes(key) && !optional.includes(key)) ||
    !text(fact.subjectId) ||
    !text(fact.sourceRevision) ||
    !text(fact.sourceUrl, 2048) ||
    fact.evidence !== "current_state" ||
    fact.actorId !== null ||
    fact.occurredAt !== null ||
    fact.state !== (family === "pull_requests" ? "merged" : "present") ||
    optional.some((key) => Object.hasOwn(fact, key) && !text(fact[key]))
  )
    unavailable();
  return Object.freeze(fact);
}

function target(scope, family, fact) {
  const publicRoot = `https://github.com/${scope.slug}`;
  const apiRoot = `/repos/${scope.slug}`;
  if (family === "commits") {
    if (!sha(fact.sourceRevision) || fact.sourceUrl !== `${publicRoot}/commit/${fact.sourceRevision}`) unavailable();
    return { endpoint: `${apiRoot}/commits/${fact.sourceRevision}` };
  }
  const prefix = `${publicRoot}/pull/`;
  if (!fact.sourceUrl.startsWith(prefix)) unavailable();
  const match = /^(\d+)(?:#pullrequestreview-(\d+))?$/.exec(fact.sourceUrl.slice(prefix.length));
  if (!match || !/^[1-9]\d*$/.test(match[1]) || !positive(Number(match[1]))) unavailable();
  const parentUrl = `${prefix}${match[1]}`;
  const parentEndpoint = `${apiRoot}/pulls/${match[1]}`;
  if (family === "pull_requests") {
    if (match[2] !== undefined || !/^gh-rest-v1:[a-f0-9]{64}\.[a-f0-9]{32}$/.test(fact.sourceRevision)) unavailable();
    return { endpoint: parentEndpoint, number: Number(match[1]), parentUrl };
  }
  if (!match[2] || !/^[1-9]\d*$/.test(match[2]) || !positive(Number(match[2]))) unavailable();
  return {
    endpoint: `${parentEndpoint}/reviews/${match[2]}`,
    parentEndpoint,
    parentUrl,
    parentApiUrl: `https://api.github.com${parentEndpoint}`,
    number: Number(match[1]),
    reviewId: Number(match[2]),
  };
}

function identity(payload, fact, family) {
  if (!optionalNode(payload.node_id) || payload.html_url !== fact.sourceUrl) unavailable();
  if (family !== "commits" && !positive(payload.id)) unavailable();
  const identities = [payload.node_id, family === "commits" ? payload.sha : String(payload.id)];
  if (!identities.includes(fact.subjectId)) unavailable();
}

function commitMetadata(payload, fact) {
  identity(payload, fact, "commits");
  if (payload.sha !== fact.sourceRevision) unavailable();
  const stats = payload.stats;
  if (stats !== undefined && stats !== null && !object(stats)) unavailable();
  const additions = count(stats?.additions);
  const deletions = count(stats?.deletions);
  const total = count(stats?.total);
  if (total !== null && additions !== null && deletions !== null && total !== additions + deletions) unavailable();
  // GET commit files are paginated. A returned array, even an empty one, does
  // not prove an aggregate file count through the body-only rest() interface.
  return { reviewState: null, additions, deletions, changedFiles: null };
}

function pullMetadata(payload, fact, selected, scope, observedAt) {
  identity(payload, fact, "pull_requests");
  if (
    payload.number !== selected.number ||
    payload.state !== "closed" ||
    payload.merged !== true ||
    payload.draft !== false ||
    compareSourceInstants(instant(payload.merged_at), new Date(observedAt).toISOString()) > 0 ||
    !sha(payload.merge_commit_sha) ||
    !object(payload.head) ||
    !sha(payload.head.sha) ||
    !object(payload.base) ||
    !sha(payload.base.sha) ||
    !object(payload.base.repo) ||
    payload.base.repo.id !== scope.id ||
    !verifyGithubRestSnapshotRevision("pull_requests", payload, fact.sourceRevision)
  )
    unavailable();
  return {
    reviewState: null,
    additions: count(payload.additions),
    deletions: count(payload.deletions),
    changedFiles: count(payload.changed_files),
  };
}

function reviewMetadata(payload, parent, fact, selected, observedAt) {
  identity(payload, fact, "reviews");
  if (
    !positive(parent.id) ||
    !optionalNode(parent.node_id) ||
    parent.number !== selected.number ||
    parent.html_url !== selected.parentUrl ||
    payload.id !== selected.reviewId ||
    (payload.pull_request_url !== undefined && payload.pull_request_url !== selected.parentApiUrl)
  )
    unavailable();
  if (payload._links !== undefined) {
    if (!object(payload._links)) unavailable();
    for (const [key, expected] of [
      ["html", fact.sourceUrl],
      ["pull_request", selected.parentApiUrl],
    ]) {
      const link = payload._links[key];
      if (link !== undefined && (!object(link) || link.href !== expected)) unavailable();
    }
  }
  if (
    !["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].includes(payload.state) ||
    compareSourceInstants(instant(payload.submitted_at), new Date(observedAt).toISOString()) > 0 ||
    !sha(payload.commit_id) ||
    !object(payload.user) ||
    !positive(payload.user.id) ||
    !["User", "Bot", "Organization"].includes(payload.user.type) ||
    !optionalNode(payload.user.node_id) ||
    (payload.body !== undefined && payload.body !== null && typeof payload.body !== "string")
  )
    unavailable();
  // Parity with normalizers' private matchesSnapshotRevision: a bare exact
  // fingerprint or its strict 32-hex observation suffix; never a guessed run ID.
  const fingerprint = githubReviewRevision(payload);
  if (
    fact.sourceRevision !== fingerprint &&
    !(/^[a-f0-9]{64}\.[a-f0-9]{32}$/.test(fact.sourceRevision) && fact.sourceRevision.slice(0, 64) === fingerprint)
  )
    unavailable();
  // This is one submitted review, not a cohort, current-head approval or credit.
  return { reviewState: payload.state.toLowerCase(), additions: null, deletions: null, changedFiles: null };
}

/** Explicit GitHub.com provider for the existing private EnrichmentSource contract. */
export function createGithubEnrichmentSource(options) {
  let configured, sourceId, policyVersion, readOutcome, now, scopes;
  try {
    if (!object(options)) invalid();
    ({ sourceId, policyVersion, readOutcome, now = Date.now } = options);
    configured = structuredClone(options.repositories);
    const client = options.client;
    const forRepository = client?.forRepository;
    if (
      !identifier(sourceId) ||
      !identifier(policyVersion) ||
      typeof readOutcome !== "function" ||
      typeof now !== "function" ||
      typeof forRepository !== "function" ||
      !Array.isArray(configured) ||
      !configured.length ||
      configured.length > 1200
    )
      invalid();
    scopes = new Map();
    const slugs = new Set();
    for (const value of configured) {
      if (
        !object(value) ||
        !exactKeys(value, ["id", "slug", "installationId"]) ||
        !positive(value.id) ||
        !positive(value.installationId) ||
        typeof value.slug !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value.slug) ||
        [".", ".."].includes(value.slug.split("/")[1]) ||
        scopes.has(value.id) ||
        slugs.has(value.slug.toLowerCase())
      )
        invalid();
      const view = forRepository.call(client, value.id);
      const rest = view?.rest;
      if (
        !view ||
        typeof view !== "object" ||
        Array.isArray(view) ||
        typeof view.then === "function" ||
        typeof rest !== "function"
      ) {
        ignoreAsync(view);
        invalid();
      }
      scopes.set(value.id, Object.freeze({ ...value, rest: rest.bind(view) }));
      slugs.add(value.slug.toLowerCase());
    }
  } catch {
    invalid();
  }

  return Object.freeze({
    async readMetadata(input) {
      let signal, abort;
      try {
        if (!object(input)) unavailable();
        const { repositoryId, family, fact: suppliedFact, assertAuthorized, signal: suppliedSignal } = input;
        signal = suppliedSignal;
        const scope = scopes.get(repositoryId);
        if (
          !scope ||
          !["commits", "pull_requests", "reviews"].includes(family) ||
          !(signal instanceof AbortSignal) ||
          typeof assertAuthorized !== "function"
        )
          unavailable();
        const fact = factSnapshot(suppliedFact, family);
        const selected = target(scope, family, fact);
        const isAborted = () => abortedState.call(signal);
        const fence = () => {
          if (isAborted()) unavailable();
          const result = assertAuthorized();
          if (result !== undefined) {
            ignoreAsync(result);
            unavailable();
          }
          if (isAborted()) unavailable();
        };
        let lastClock = 0;
        const clock = () => {
          const value = now();
          if (!positive(value) || value < lastClock) {
            ignoreAsync(value);
            unavailable();
          }
          lastClock = value;
          return value;
        };
        fence();
        clock();
        const aborted = new Promise((_, reject) => {
          abort = () => reject(new Error("github_enrichment_unavailable"));
          addListener.call(signal, "abort", abort, { once: true });
        });
        // A synchronous fence can abort before step installs its race. Observe
        // that rejection now; the original promise still rejects the race.
        void aborted.catch(() => undefined);
        const step = async (work) => {
          fence();
          const pending = Promise.resolve().then(() => {
            fence();
            return work();
          });
          const result = await Promise.race([pending, aborted]);
          fence();
          return result;
        };
        const read = async (endpoint) => copy(await step(() => scope.rest(sourceId, endpoint, fence)));
        const repository = await read(`/repos/${scope.slug}`);
        if (
          repository.id !== scope.id ||
          repository.private !== false ||
          repository.full_name !== scope.slug ||
          (repository.visibility !== undefined && repository.visibility !== "public") ||
          (repository.html_url !== undefined && repository.html_url !== `https://github.com/${scope.slug}`)
        )
          unavailable();
        const payload = await read(selected.endpoint);
        const parent = family === "reviews" ? await read(selected.parentEndpoint) : null;
        const observedAt = clock();
        const metadata =
          family === "commits"
            ? commitMetadata(payload, fact)
            : family === "pull_requests"
              ? pullMetadata(payload, fact, selected, scope, observedAt)
              : reviewMetadata(payload, parent, fact, selected, observedAt);
        const binding = Object.freeze({
          repositoryId,
          installationId: scope.installationId,
          sourceId,
          family,
          ...fact,
          policyVersion,
        });
        const record = copy(await step(() => readOutcome(Object.freeze({ binding, signal, assertAuthorized: fence }))));
        const keys = [
          "schemaVersion",
          ...Object.keys(binding),
          "recordId",
          "evidenceId",
          "acceptedOutcome",
          "recordedAt",
          "validUntil",
        ];
        if (
          !exactKeys(record, keys) ||
          record.schemaVersion !== "github-enrichment-outcome/v1" ||
          Object.keys(binding).some((key) => record[key] !== binding[key]) ||
          !identifier(record.recordId) ||
          !identifier(record.evidenceId) ||
          typeof record.acceptedOutcome !== "boolean" ||
          !positive(record.recordedAt) ||
          !positive(record.validUntil) ||
          record.validUntil <= record.recordedAt
        )
          unavailable();
        // Sample the decision time, then recheck authority after the last host
        // callback. These timestamps do not establish rights or approval.
        fence();
        const completedAt = clock();
        fence();
        if (isAborted() || record.recordedAt > completedAt || record.validUntil <= completedAt) unavailable();
        return { sourceRevision: fact.sourceRevision, acceptedOutcome: record.acceptedOutcome, ...metadata };
      } catch {
        unavailable();
      } finally {
        if (abort) removeListener.call(signal, "abort", abort);
      }
    },
  });
}
