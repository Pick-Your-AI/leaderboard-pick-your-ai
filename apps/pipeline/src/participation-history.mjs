import { types } from "node:util";

const invalid = () => {
  throw new Error("participation_history_admission_invalid");
};
const check = (condition) => {
  if (!condition) invalid();
};
const identity = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) && ![".", ".."].includes(value);
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) =>
  check(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
  );

/** Host code is trusted authority, but returned JSON is still bounded before any
 * traversal, copying, schema validation or hashing. Never invoke supplied hooks. */
export function copyParticipationHistoryJSON(value) {
  let bytes = 0,
    nodes = 0;
  const seen = new Set();
  function visit(item, depth) {
    check(++nodes <= 250_000 && depth <= 32 && bytes <= 8_000_000);
    if (typeof item === "string") {
      check(item.length <= 8_000_000 - bytes);
      bytes += Buffer.byteLength(JSON.stringify(item));
    } else if (item === null || typeof item === "boolean") bytes += 5;
    else if (typeof item === "number" && Number.isFinite(item)) bytes += 32;
    else if (item && typeof item === "object") {
      check(!types.isProxy(item) && !seen.has(item));
      seen.add(item);
      if (Array.isArray(item)) {
        check(
          Object.getPrototypeOf(item) === Array.prototype && item.length <= 20_000 && item.length <= 250_000 - nodes,
        );
        const keys = Reflect.ownKeys(item);
        check(keys.length === item.length + 1 && keys.every((key) => typeof key === "string"));
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, index);
          check(descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable);
          visit(descriptor.value, depth + 1);
          bytes++;
        }
      } else {
        check([Object.prototype, null].includes(Object.getPrototypeOf(item)));
        const keys = Reflect.ownKeys(item);
        check(keys.length <= 250_000 - nodes && keys.every((key) => typeof key === "string"));
        for (const key of keys) {
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          check(Object.hasOwn(descriptor, "value") && descriptor.enumerable && key.length <= 8_000_000 - bytes);
          bytes += Buffer.byteLength(JSON.stringify(key)) + 2;
          visit(descriptor.value, depth + 1);
        }
      }
      seen.delete(item);
      bytes += 2;
    } else invalid();
    check(bytes <= 8_000_000);
  }
  visit(value, 0);
  return structuredClone(value);
}

/** Only an in-process protected host can install these callbacks. Config text,
 * approval receipt strings and HTTP parameters never create this capability. */
export function createParticipationHistoryAuthority(value) {
  if (value === undefined) return null;
  check(value && typeof value === "object" && !types.isProxy(value) && !Array.isArray(value));
  const keys = Reflect.ownKeys(value);
  check(keys.length === 2 && keys.includes("epoch") && keys.includes("resolve"));
  const descriptors = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(value, key)]));
  for (const key of ["epoch", "resolve"])
    check(Object.hasOwn(descriptors[key], "value") && typeof descriptors[key].value === "function");
  const epoch = descriptors.epoch.value,
    resolve = descriptors.resolve.value;
  const drain = (promise, seen = new WeakSet()) => {
    if (!types.isPromise(promise) || seen.has(promise)) return;
    seen.add(promise);
    try {
      void Promise.prototype.then.call(
        promise,
        () => undefined,
        (reason) => drain(reason, seen),
      );
    } catch {}
  };
  return {
    epoch(request) {
      try {
        const result = epoch(copyParticipationHistoryJSON(request));
        if (typeof result === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(result)) return result;
        drain(result);
      } catch (error) {
        drain(error);
      }
      return null;
    },
    async resolve(request, signal) {
      const result = resolve(copyParticipationHistoryJSON(request), signal);
      // Inspect direct values before Promise resolution can call a supplied
      // thenable. Native host promises settle under the host's own authority.
      return types.isPromise(result)
        ? copyParticipationHistoryJSON(await result)
        : copyParticipationHistoryJSON(result);
    },
  };
}

function inputIdentity(value, contracts) {
  exact(value, ["snapshotId", "revision", "sha256", "cutoff"]);
  check(
    identity(value.snapshotId) &&
      Number.isSafeInteger(value.revision) &&
      value.revision > 0 &&
      hash(value.sha256) &&
      contracts.sourceEventSchema.shape.observedAt.safeParse(value.cutoff).success,
  );
}

/** This validates the shape and exact source bindings of an independently
 * authenticated decision. It does not grant that decision or certify coverage. */
export function validateParticipationHistoryAdmission(value, request, config, contracts, digest, policyDigest) {
  if (value === null) return null;
  exact(value, [
    "schemaVersion",
    "selectedInput",
    "historyInput",
    "admission",
    "coverage",
    "proofSources",
    "unresolved",
  ]);
  check(value.schemaVersion === "pipeline-participation-history-admission/v1");
  inputIdentity(value.selectedInput, contracts);
  inputIdentity(value.historyInput, contracts);
  check(
    digest(value.selectedInput) === digest(request.selectedInput) &&
      value.historyInput.cutoff === value.selectedInput.cutoff,
  );
  const admission = value.admission;
  exact(admission, ["decisionId", "organization", "origin", "reviewedAt", "sourceInventory", "policies"]);
  check(
    identity(admission.decisionId) &&
      admission.organization === config.organization &&
      contracts.sourceEventSchema.shape.observedAt.safeParse(admission.reviewedAt).success,
  );
  const basis = contracts.participationHistoryBasisSchema.parse({
    scope: { organization: config.organization, repository: null, workstream: null, start: null, end: null },
    origin: admission.origin,
    cutoff: value.historyInput.cutoff,
    sourceInventory: admission.sourceInventory,
    policies: admission.policies,
  });
  check(contracts.compareSourceInstants(admission.reviewedAt, basis.cutoff) <= 0);
  // The host supplies the complete required inventory independently of observed
  // proofs/coverage. Configured repositories and policies cannot silently vanish.
  check(
    digest([...new Set(basis.sourceInventory.map((pair) => pair.repositoryId))].sort()) ===
      digest(config.repositories.map((repo) => String(repo.id)).sort()),
  );
  const policies = config.policies
    .map(({ policy, signature }) => ({
      metricId: policy.metricId,
      version: policy.version,
      signature: policyDigest(signature),
      roles: [...policy.roles].sort(),
      sources: [...policy.sources].sort(),
    }))
    .sort((a, b) => a.metricId.localeCompare(b.metricId));
  check(
    digest(
      basis.policies
        .map((entry) => ({ ...entry, roles: [...entry.roles].sort(), sources: [...entry.sources].sort() }))
        .sort((a, b) => a.metricId.localeCompare(b.metricId)),
    ) === digest(policies),
  );
  check(Array.isArray(value.coverage) && value.coverage.length === basis.sourceInventory.length);
  const pairs = new Set();
  for (const item of value.coverage) {
    const entry = contracts.coverageSchema.parse(item);
    const key = digest([entry.scopeId, entry.source]);
    check(
      !pairs.has(key) &&
        basis.sourceInventory.some((pair) => pair.repositoryId === entry.scopeId && pair.source === entry.source),
    );
    pairs.add(key);
    check(
      entry.state === "complete" &&
        entry.knownStart !== null &&
        contracts.compareSourceInstants(entry.knownStart, basis.origin) <= 0 &&
        entry.windowStart !== null &&
        contracts.compareSourceInstants(entry.windowStart, basis.origin) <= 0 &&
        entry.windowEnd !== null &&
        contracts.compareSourceInstants(entry.windowEnd, basis.cutoff) >= 0 &&
        entry.sourceWatermark !== null &&
        contracts.compareSourceInstants(entry.sourceWatermark, basis.cutoff) >= 0 &&
        entry.lastSuccessfulSync !== null &&
        contracts.compareSourceInstants(entry.lastSuccessfulSync, basis.cutoff) >= 0 &&
        entry.missingPages === 0 &&
        entry.permissionsMissing.length === 0 &&
        entry.sourceErrors.length === 0,
    );
  }
  check(
    Array.isArray(value.proofSources) &&
      value.proofSources.length <= 20_000 &&
      Array.isArray(value.unresolved) &&
      value.unresolved.length <= 20_000,
  );
  const proofs = new Set();
  for (const entry of value.proofSources) {
    exact(entry, ["contributionId", "repositoryId", "source"]);
    check(
      identity(entry.contributionId) &&
        identity(entry.repositoryId) &&
        !proofs.has(entry.contributionId) &&
        basis.sourceInventory.some((pair) => pair.repositoryId === entry.repositoryId && pair.source === entry.source),
    );
    proofs.add(entry.contributionId);
  }
  for (const entry of value.unresolved) {
    exact(entry, ["actorId", "reason"]);
    check(
      (entry.actorId === null || identity(entry.actorId)) &&
        ["unknown_actor", "unknown_time", "unknown_qualification", "withheld", "conflicting"].includes(entry.reason) &&
        (entry.reason !== "unknown_actor" || entry.actorId === null),
    );
  }
  return value;
}

/** Project only already confirmed, exact retained inputs. The host's separate
 * coverage assertion changes this private response, never stored publications. */
export function assembleParticipationHistory({
  current,
  selectedInput,
  history,
  retained,
  portfolioFacts,
  explanation,
  admission,
  contracts,
  digest,
}) {
  const portfolio = history.selected.portfolioEvidence;
  check(Array.isArray(portfolio));
  const sources = new Map(admission.proofSources.map((entry) => [entry.contributionId, entry]));
  check(
    sources.size === portfolio.length &&
      new Set(portfolio.map((entry) => entry.contribution.contributionId)).size === portfolio.length,
  );
  for (const entry of portfolio) {
    const binding = sources.get(entry.contribution.contributionId);
    check(binding && binding.repositoryId === entry.artifact.repositoryId);
    // Never invent an adapter from a policy's first source, URL or family.
    check(
      admission.admission.sourceInventory.some(
        (pair) => pair.repositoryId === binding.repositoryId && pair.source === binding.source,
      ),
    );
  }
  const unresolved = new Map(admission.unresolved.map((entry) => [digest(entry), entry]));
  const add = (actorId, reason) => {
    const entry = { actorId: reason === "unknown_actor" ? null : actorId, reason };
    unresolved.set(digest(entry), entry);
  };
  // Reuse the producer's canonical descriptive selector, which applies current
  // revisions, corrections and eligibility independently of rankedStates.
  // Ranking audit exclusions alone cannot prove that an accepted/pending proof
  // deliberately omitted from a stored portfolio was absent from the history.
  for (const fact of portfolioFacts) {
    if (["qualified", "reviewed", "pending"].includes(fact.state) && !sources.has(fact.id))
      add(fact.actorId, fact.state === "pending" ? "unknown_qualification" : "withheld");
  }
  const benign = new Set([
    "duplicate_observation",
    "repeated_policy_unit",
    "excluded_by_policy_or_correction",
    "role_filter",
    "actor_filter",
    "evidence_class_not_ranked",
    "pending_not_ranked",
    "observation_after_cutoff",
    "acceptance_after_cutoff",
  ]);
  const factsByMetricAndId = new Map();
  for (const fact of retained.facts) {
    const key = JSON.stringify([fact.metricId, fact.id]);
    const matches = factsByMetricAndId.get(key) ?? [];
    matches.push(fact);
    factsByMetricAndId.set(key, matches);
  }
  for (const metric of explanation.metrics)
    for (const entry of metric.audit) {
      // An acceptedAt ranking audit legitimately omits the acceptance clock for
      // a known, merely observed source fact. Its retained occurrence is known and
      // its explicit unaccepted state is not an uncertain earlier acceptance.
      if (
        entry.reason === "unknown_effective_time" &&
        metric.dateBasis === "acceptedAt" &&
        entry.factIds.length > 0 &&
        entry.factIds.every((id) => {
          const facts = factsByMetricAndId.get(JSON.stringify([metric.metricId, id])) ?? [];
          return (
            facts.length > 0 &&
            facts.every(
              (fact) =>
                fact.state === "observed" &&
                fact.acceptedAt === null &&
                contracts.sourceEventSchema.shape.observedAt.safeParse(fact.occurredAt).success &&
                contracts.compareSourceInstants(fact.occurredAt, fact.observedAt) <= 0 &&
                contracts.compareSourceInstants(fact.observedAt, retained.cutoff) <= 0,
            )
          );
        })
      )
        continue;
      if (entry.reason.startsWith("included_")) {
        if (entry.factIds.some((id) => !sources.has(id))) add(entry.actorId, "withheld");
      } else if (!benign.has(entry.reason)) {
        const reason =
          entry.reason === "unknown_actor"
            ? "unknown_actor"
            : /conflict|ambiguous/.test(entry.reason)
              ? "conflicting"
              : /time|outside_window/.test(entry.reason)
                ? "unknown_time"
                : /qualification|acceptance|unreviewed/.test(entry.reason)
                  ? "unknown_qualification"
                  : "withheld";
        add(entry.actorId, reason);
      }
    }
  // A ranked audit can use acceptance time and omit unknown source-occurrence
  // clocks. Inspect the complete frozen universe before any actor/privacy lens.
  const actors = new Map(retained.actors.map((actor) => [actor.id, actor]));
  for (const fact of retained.facts) {
    if (contracts.compareSourceInstants(fact.observedAt, retained.cutoff) > 0) continue;
    if (!actors.has(fact.actorId) || actors.get(fact.actorId).kind === "unknown") add(null, "unknown_actor");
    else if (fact.occurredAt === null) add(fact.actorId, "unknown_time");
    else if (fact.state === "unknown" || fact.role === "unknown") add(fact.actorId, "unknown_qualification");
  }
  check(unresolved.size <= 20_000);
  const publication = structuredClone(history);
  publication.selected.rows = [];
  publication.selected.evidence = [];
  publication.selected.pendingEvidence = [];
  publication.selected.diagnostics = [];
  publication.selected.snapshot.coverage = structuredClone(admission.coverage);
  return {
    current,
    selectedInput,
    history: {
      schemaVersion: "participation-history-provider/v1",
      selectedInput,
      admission: structuredClone(admission.admission),
      dataset: {
        id: retained.datasetId,
        sha256: admission.historyInput.sha256,
        backfillRevision: retained.backfillRevision,
        cutoff: retained.cutoff,
        sourceInventory: structuredClone(admission.admission.sourceInventory),
      },
      publication,
      proofSources: structuredClone(admission.proofSources),
      unresolved: [...unresolved.values()].sort((a, b) => digest(a).localeCompare(digest(b))),
    },
  };
}
