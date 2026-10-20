import { createHash } from "node:crypto";
import { compareSourceInstants, sourceEventSchema } from "@pick-your-ai/contracts";

const fail = () => {
  // Protected source details, Project identities and receipt IDs remain private.
  throw new Error("project_configuration_evidence_unverified");
};
const require = (condition) => {
  if (!condition) fail();
};
const object = (value, keys) => {
  require(value && typeof value === "object" && !Array.isArray(value));
  require([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  require(
    Reflect.ownKeys(value).length === keys.length &&
      keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable;
      }),
  );
  return value;
};
const array = (value, minimum, maximum) => {
  require(Array.isArray(value) && value.length >= minimum && value.length <= maximum);
  require(Object.getPrototypeOf(value) === Array.prototype && Reflect.ownKeys(value).length === value.length + 1);
  // structuredClone preserves holes; Array callbacks skip them. Every declared
  // element must therefore be an own data value before any iteration or hash.
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    require(descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable);
  }
  return value;
};
const id = (value) => {
  require(typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value));
  return value;
};
const digest = (value) => {
  require(typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
  return value;
};
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const instant = (value) => {
  require(typeof value === "string" && sourceEventSchema.shape.occurredAt.safeParse(value).success);
  return value;
};
const notAfter = (left, right) => require(compareSourceInstants(instant(left), instant(right)) <= 0);
const text = (value, maximum = 200, empty = false) => {
  require(typeof value === "string" && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value));
  require(empty || value.trim().length > 0);
  return value;
};
const choice = (value, allowed) => {
  require(allowed.includes(value));
  return value;
};
const url = (value) => {
  require(typeof value === "string" && value.length <= 2048);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail();
  }
  require(
    parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      !parsed.port &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.href === value &&
      !/%|\\/.test(parsed.pathname),
  );
  const parts = parsed.pathname.split("/").slice(1);
  require(parts.every((part) => part.length > 0 && part !== "." && part !== ".."));
  return parts;
};
const pinnedUrl = (value, revision, blobOnly = false) => {
  require(typeof revision === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision));
  const parts = url(value);
  require(
    parts.length >= 4 &&
      parts.slice(0, 2).every((part) => /^[A-Za-z0-9_.-]+$/.test(part)) &&
      parts[3] === revision &&
      ((parts[2] === "blob" && parts.length > 4) || (!blobOnly && parts[2] === "commit" && parts.length === 4)),
  );
  return { repository: parts.slice(0, 2).join("/"), path: parts.slice(4).join("/") };
};
const pin = (value) => {
  const result = object(value, ["revision", "sourceRevisionUrl", "contentHash"]);
  const location = pinnedUrl(result.sourceRevisionUrl, result.revision, true);
  digest(result.contentHash);
  return {
    ...location,
    revision: result.revision,
    sourceRevisionUrl: result.sourceRevisionUrl,
    contentHash: result.contentHash,
  };
};
const orderedIds = (value) => {
  array(value, 0, 16);
  value.forEach(id);
  require(new Set(value).size === value.length);
  return [...value];
};
const sortFields = (value) => {
  array(value, 0, 16);
  const fields = value.map((entry) => {
    object(entry, ["fieldId", "direction"]);
    return { fieldId: id(entry.fieldId), direction: choice(entry.direction, ["asc", "desc"]) };
  });
  require(new Set(fields.map((entry) => entry.fieldId)).size === fields.length);
  return fields;
};
const workflowState = (value) => {
  object(value, ["enabled", "configurationHash"]);
  require(typeof value.enabled === "boolean");
  return { enabled: value.enabled, configurationHash: digest(value.configurationHash) };
};

// Facets describe reviewed configuration state, never item effects or inferred
// activity. Canonical key order prevents receipt field ordering minting units.
function facet(value) {
  require(value && typeof value === "object");
  let identity, before, after, operation;
  switch (value.kind) {
    case "field":
    case "option":
    case "view": {
      const identityKeys =
        value.kind === "option" ? ["fieldId", "optionId"] : [value.kind === "field" ? "fieldId" : "viewId"];
      object(value, ["kind", ...identityKeys, "operation", "before", "after"]);
      identity = identityKeys.map((key) => id(value[key]));
      operation = choice(value.operation, ["add", "rename"]);
      before = operation === "add" ? (require(value.before === null), null) : text(value.before);
      after = text(value.after);
      break;
    }
    case "filter":
    case "group":
    case "sort":
    case "layout":
      object(value, ["kind", "viewId", "before", "after"]);
      identity = [id(value.viewId)];
      if (value.kind === "filter") {
        before = text(value.before, 1000, true);
        after = text(value.after, 1000, true);
      } else if (value.kind === "group") {
        before = orderedIds(value.before);
        after = orderedIds(value.after);
      } else if (value.kind === "sort") {
        before = sortFields(value.before);
        after = sortFields(value.after);
      } else {
        before = choice(value.before, ["table", "board", "roadmap"]);
        after = choice(value.after, ["table", "board", "roadmap"]);
      }
      break;
    case "workflow":
      object(value, ["kind", "workflowId", "operation", "before", "after"]);
      identity = [id(value.workflowId)];
      operation = choice(value.operation, ["enable", "disable", "configure"]);
      before = workflowState(value.before);
      after = workflowState(value.after);
      if (operation === "configure")
        require(before.enabled === after.enabled && before.configurationHash !== after.configurationHash);
      else
        require(
          before.enabled === (operation === "disable") &&
            after.enabled === (operation === "enable") &&
            before.configurationHash === after.configurationHash,
        );
      break;
    default:
      fail();
  }
  require(JSON.stringify(before) !== JSON.stringify(after));
  return {
    key: JSON.stringify([value.kind, ...identity]),
    kind: value.kind,
    value: [value.kind, ...identity, operation ?? null, before, after],
  };
}

/**
 * Consume a protected, current host attestation for the existing Project metric.
 * This checks its exact source/claim/actor/proof binding; it does not fetch the
 * Project, discover an editor, authenticate a reviewer or certify proof contents.
 */
export function qualifyProjectConfiguration({ input, request, decision, binding, candidate, acceptedAt, cutoff }) {
  const domain = object(binding.domainEvidence, ["version", "projects", "records"]);
  require(domain.version === "project-configuration-evidence/v1");
  array(domain.projects, 1, 32);
  const projects = domain.projects.map((entry) => {
    object(entry, ["id", "url"]);
    const parts = url(entry.url);
    require(
      parts.length === 4 &&
        ["orgs", "users"].includes(parts[0]) &&
        /^[A-Za-z0-9-]+$/.test(parts[1]) &&
        parts[2] === "projects" &&
        /^[1-9][0-9]*$/.test(parts[3]),
    );
    return { id: id(entry.id), url: entry.url };
  });
  require(
    new Set(projects.map((entry) => entry.id)).size === projects.length &&
      new Set(projects.map((entry) => entry.url)).size === projects.length,
  );
  array(domain.records, 0, 1000);
  const matching = domain.records.filter((record) => record?.requestId === request.id);
  require(matching.length === 1);
  const record = object(matching[0], [
    "requestId",
    "requestVersion",
    "decisionId",
    "factId",
    "sourceRevision",
    "sourceRevisionUrl",
    "validUntil",
    "synthetic",
    "publicSafe",
    "details",
  ]);
  require(
    id(record.requestId) === request.id &&
      Number.isSafeInteger(record.requestVersion) &&
      record.requestVersion > 0 &&
      record.requestVersion === request.version &&
      decision.version === request.version &&
      id(record.decisionId) === decision.id &&
      id(record.factId) === candidate.id &&
      record.synthetic === false &&
      record.publicSafe === true,
  );
  notAfter(acceptedAt, cutoff);
  notAfter(cutoff, record.validUntil);
  require(input.isSynthetic !== true && !(input.syntheticFactIds ?? []).includes(candidate.id));
  // The first adapter supports explicitly attributed merged-PR authors only.
  // A current Project creator, an automated item event or a self-asserted fact
  // is not evidence that this contributor configured the Project.
  require(
    binding.metricId === "project_configuration" &&
      binding.sourceMetricId === "pr_merged" &&
      candidate.metricId === "pr_merged" &&
      candidate.role === "author" &&
      candidate.state === "observed" &&
      candidate.actorId === request.owner &&
      candidate.repoId === binding.repositoryId &&
      typeof candidate.rawState === "string" &&
      candidate.rawState.startsWith("target:"),
  );
  const actors = input.actors.filter((actor) => actor.id === candidate.actorId);
  require(
    actors.length === 1 &&
      actors[0].kind === "user" &&
      actors[0].publicState === "visible" &&
      actors[0].executionMode !== "automated",
  );
  const evidence = input.evidence.filter((entry) => entry.contribution.contributionId === candidate.id);
  require(evidence.length === 1);
  const target = evidence[0];
  require(
    target.artifact.kind === "pull_request" &&
      target.artifact.visibility === "public" &&
      target.artifact.stableId === candidate.artifactId &&
      target.contribution.artifactId === candidate.artifactId &&
      target.artifact.repositoryId === binding.repositoryId &&
      target.artifact.publicUrl === request.locator &&
      target.contribution.actorId === request.owner &&
      target.contribution.roles.length === 1 &&
      target.contribution.roles[0] === candidate.role &&
      target.contribution.metricIds.length === 1 &&
      target.contribution.metricIds[0] === candidate.metricId &&
      target.sourceRevision === record.sourceRevision &&
      target.sourceRevisionUrl === record.sourceRevisionUrl &&
      target.occurredAt === candidate.occurredAt,
  );
  notAfter(candidate.occurredAt, acceptedAt);
  notAfter(candidate.observedAt, cutoff);
  const sourceLocation = pinnedUrl(record.sourceRevisionUrl, record.sourceRevision);
  const locator = url(request.locator);
  require(
    locator.length === 4 &&
      locator[2] === "pull" &&
      /^[1-9][0-9]*$/.test(locator[3]) &&
      locator.slice(0, 2).join("/") === sourceLocation.repository,
  );
  const detail = object(record.details, ["projectId", "changeSetId", "before", "after", "contributor", "facets"]);
  require(projects.some((project) => project.id === id(detail.projectId)));
  id(detail.changeSetId);
  const before = pin(detail.before),
    after = pin(detail.after);
  require(
    before.repository === sourceLocation.repository &&
      after.repository === sourceLocation.repository &&
      before.path === after.path &&
      before.revision !== after.revision &&
      before.contentHash !== after.contentHash &&
      after.revision === record.sourceRevision,
  );
  const contributor = object(detail.contributor, ["actorId", "role", "attribution"]);
  require(id(contributor.actorId) === request.owner);
  choice(contributor.role, ["author", "coauthor", "editor"]);
  // A reviewed source role cannot silently replace the role to which the owner
  // consented in the exact current claim. Unknown remains an intake option, but
  // it does not establish the explicit role required by this metric.
  require(request.intake?.roles?.submitter === contributor.role);
  const attribution = pin(contributor.attribution);
  require(attribution.repository === sourceLocation.repository && attribution.revision === record.sourceRevision);
  array(detail.facets, 1, 32);
  const facets = detail.facets
    .map(facet)
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  require(new Set(facets.map((entry) => entry.key)).size === facets.length);
  const pins = [before, after, attribution].map((entry) => [entry.sourceRevisionUrl, entry.contentHash]);
  const pinnedHashes = new Map();
  for (const [url, contentHash] of pins) {
    require(!pinnedHashes.has(url) || pinnedHashes.get(url) === contentHash);
    pinnedHashes.set(url, contentHash);
  }
  const changesetId =
    "project-configuration:" +
    hash(["project-configuration-evidence/v1", binding.repositoryId, detail.projectId, detail.changeSetId]);
  return {
    changesetId,
    occurredAt: acceptedAt,
    dateBasis: "acceptedAt",
    // Compare immutable change-set state across receipts before deduplication.
    // Attribution may differ by contributor; it cannot alter shared state.
    projectConfiguration: { signature: hash([before, after, facets.map((entry) => entry.value)]), pins },
    publicReasonCodes: [
      "independent_recognition_receipt",
      "domain_metric:project_configuration",
      "domain_clock:accepted_at",
      "reviewed_configuration_not_automated_item_effects",
      `configuration_role:${contributor.role}`,
      ...[...new Set(facets.map((entry) => entry.kind))].sort().map((kind) => `configuration_facet:${kind}`),
    ],
  };
}

// An invalid later alias must fail even when the canonical unit was seen earlier.
export function verifyProjectConfigurationConsistency(domain, changesets, artifactHashes) {
  if (!domain?.projectConfiguration) return;
  const { signature, pins } = domain.projectConfiguration;
  require(!changesets.has(domain.changesetId) || changesets.get(domain.changesetId) === signature);
  for (const [url, contentHash] of pins) {
    require(!artifactHashes.has(url) || artifactHashes.get(url) === contentHash);
    artifactHashes.set(url, contentHash);
  }
  changesets.set(domain.changesetId, signature);
}
