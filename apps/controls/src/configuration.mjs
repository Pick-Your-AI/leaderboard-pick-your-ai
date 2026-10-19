import { createHash, randomUUID } from "node:crypto";
import { ControlError, exactKeys, locator, requireThat, text } from "./store.mjs";
export { configurationOverlay } from "./overlay.mjs";

export function stableJSON(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJSON).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stableJSON(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const configurationDigest = (value) => createHash("sha256").update(stableJSON(value)).digest("hex");
const configurationState = (state) => state.configuration || { revision: 0, active: null, proposals: {}, history: [] };
const own = (state) => (state.configuration ||= configurationState(state));
const identifier = (value) => {
  requireThat(typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(value));
  return value;
};
const sourceId = (value) => {
  requireThat(typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value)));
  return value;
};
function unique(values, key) {
  requireThat(new Set(values.map((v) => v[key])).size === values.length, 400, "Duplicate configuration identity");
  return values.sort((a, b) => a[key].localeCompare(b[key]));
}

export function normalizeConfiguration(value) {
  exactKeys(value, ["repositories", "projects", "metrics"]);
  requireThat(
    Array.isArray(value.repositories) &&
      value.repositories.length <= 100 &&
      Array.isArray(value.projects) &&
      value.projects.length <= 100 &&
      Array.isArray(value.metrics) &&
      value.metrics.length <= 98,
  );
  const repositories = unique(
    value.repositories.map((repo) => {
      exactKeys(repo, ["id", "installationId", "slug", "capabilities"]);
      requireThat(typeof repo.slug === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.slug));
      requireThat(Array.isArray(repo.capabilities) && repo.capabilities.length > 0 && repo.capabilities.length <= 50);
      const capabilities = repo.capabilities.map(identifier).sort();
      requireThat(new Set(capabilities).size === capabilities.length);
      return { id: sourceId(repo.id), installationId: sourceId(repo.installationId), slug: repo.slug, capabilities };
    }),
    "id",
  );
  const projects = unique(
    value.projects.map((project) => {
      exactKeys(project, ["id", "fields"]);
      requireThat(typeof project.id === "string" && /^PVT_[A-Za-z0-9_-]{5,200}$/.test(project.id));
      requireThat(Array.isArray(project.fields) && project.fields.length <= 50);
      const fields = unique(
        project.fields.map((field) => {
          exactKeys(field, ["key", "id", "type"]);
          requireThat(typeof field.id === "string" && /^PVT(?:F|SSF|IF)_[A-Za-z0-9_-]{5,200}$/.test(field.id));
          return { key: identifier(field.key), id: field.id, type: identifier(field.type) };
        }),
        "key",
      );
      requireThat(new Set(fields.map((f) => f.id)).size === fields.length);
      return { id: project.id, fields };
    }),
    "id",
  );
  const metrics = unique(
    value.metrics.map((metric) => {
      exactKeys(metric, ["id", "enabled", "reason", "policyVersion", "policyLink"]);
      requireThat(typeof metric.enabled === "boolean");
      return {
        id: identifier(metric.id),
        enabled: metric.enabled,
        reason: metric.enabled
          ? metric.reason === undefined || metric.reason === ""
            ? ""
            : text(metric.reason, 500)
          : text(metric.reason, 500),
        policyVersion: text(metric.policyVersion, 100),
        policyLink: locator(metric.policyLink),
      };
    }),
    "id",
  );
  return { repositories, projects, metrics };
}

function restrictionOnly(before, after) {
  if (
    !before ||
    stableJSON(before.repositories) !== stableJSON(after.repositories) ||
    stableJSON(before.projects) !== stableJSON(after.projects)
  )
    return false;
  if (before.metrics.length !== after.metrics.length) return false;
  return after.metrics.every((metric) => {
    const previous = before.metrics.find((m) => m.id === metric.id);
    return (
      previous &&
      metric.policyVersion === previous.policyVersion &&
      metric.policyLink === previous.policyLink &&
      (!metric.enabled || previous.enabled)
    );
  });
}
const coverage = (document) => ({
  repositoryIds: document?.repositories.map((r) => r.id) ?? [],
  projectFieldIds: document?.projects.flatMap((p) => p.fields.map((f) => `${p.id}:${f.id}:${f.type}`)) ?? [],
  enabledMetricIds: document?.metrics.filter((m) => m.enabled).map((m) => m.id) ?? [],
});
const testedMeaning = (report) => ({
  restrictiveOverlay: report.restrictiveOverlay ?? false,
  inheritedActivationDigest: report.inheritedActivationDigest ?? null,
  repositories:
    report.repositories?.map((r) => ({
      id: r.id,
      installationId: r.installationId,
      capabilities: r.capabilities.map(({ id, permission, schemaVersion }) => ({ id, permission, schemaVersion })),
    })) ?? [],
  projects: report.projects?.map(({ id, fields }) => ({ id, fields })) ?? [],
  metrics: report.metrics?.map(({ id, policyVersion, policyLink }) => ({ id, policyVersion, policyLink })) ?? [],
});

// The source verifier is privileged server code. This validator binds its actual
// source/permission/schema test receipts to every requested stable identity.
function validateSourceReport(report, proposal, now, policyVersions) {
  requireThat(
    report && report.digest === proposal.digest && report.baseRevision === proposal.baseRevision,
    409,
    "Source receipt configuration mismatch",
  );
  requireThat(
    Number.isSafeInteger(report.verifiedAt) &&
      report.verifiedAt <= now &&
      report.verifiedAt >= now - 600_000 &&
      Number.isSafeInteger(report.validUntil) &&
      report.validUntil > now &&
      report.validUntil <= report.verifiedAt + 600_000,
    409,
    "Source receipt expired",
  );
  const receiptId = text(report.receiptId, 200);
  requireThat(
    Array.isArray(report.repositories) && Array.isArray(report.projects) && Array.isArray(report.metrics),
    409,
    "Incomplete source receipt",
  );
  const repositories = proposal.document.repositories.map((repo) => {
    const observed = report.repositories.filter((r) => r.id === repo.id);
    requireThat(observed.length === 1, 409, "Repository source receipt missing");
    const row = observed[0];
    requireThat(
      row.approved === true &&
        row.public === true &&
        row.installationId === repo.installationId &&
        row.slug === repo.slug &&
        Array.isArray(row.capabilities),
      409,
      "Repository not approved or public",
    );
    const capabilities = repo.capabilities.map((id) => {
      const matches = row.capabilities.filter((c) => c.id === id);
      requireThat(matches.length === 1, 409, "Capability source receipt missing");
      const capability = matches[0];
      requireThat(
        capability.tested === true && capability.permissionVerified === true,
        409,
        "Untested source permission",
      );
      return {
        id,
        permission: text(capability.permission, 100),
        schemaVersion: text(capability.schemaVersion, 100),
        evidenceId: text(capability.evidenceId, 200),
      };
    });
    return { id: repo.id, installationId: repo.installationId, capabilities };
  });
  const projects = proposal.document.projects.map((project) => {
    const matches = report.projects.filter((p) => p.id === project.id);
    requireThat(matches.length === 1, 409, "Project source receipt missing");
    const observed = matches[0];
    requireThat(
      observed.approved === true &&
        observed.public === true &&
        observed.permissionVerified === true &&
        Array.isArray(observed.fields),
      409,
      "Project source permission unavailable",
    );
    for (const field of project.fields)
      requireThat(
        observed.fields.filter((f) => f.id === field.id && f.type === field.type).length === 1,
        409,
        "Project field schema mismatch",
      );
    return { id: project.id, fields: project.fields, evidenceId: text(observed.evidenceId, 200) };
  });
  const metrics = proposal.document.metrics.map((metric) => {
    if (metric.enabled) requireThat(policyVersions.has(metric.policyVersion), 409, "Metric policy is not approved");
    const matches = report.metrics.filter((m) => m.id === metric.id && m.policyVersion === metric.policyVersion);
    requireThat(
      matches.length === 1 &&
        matches[0].policyLink === metric.policyLink &&
        matches[0].policyApproved === true &&
        (!metric.enabled || matches[0].sourceTested === true),
      409,
      "Metric source/policy receipt missing",
    );
    return {
      id: metric.id,
      policyVersion: metric.policyVersion,
      policyLink: metric.policyLink,
      evidenceId: text(matches[0].evidenceId, 200),
    };
  });
  return {
    receiptId,
    verifiedAt: report.verifiedAt,
    validUntil: report.validUntil,
    digest: proposal.digest,
    baseRevision: proposal.baseRevision,
    repositories,
    projects,
    metrics,
  };
}

export function createConfigurationManager({
  store,
  sourceVerifier,
  approvedPolicyVersions,
  knownMetricIds,
  now,
  rolesForActor,
  configurationAuthorityCurrent,
}) {
  const policyVersions = new Set(approvedPolicyVersions);
  const metricIds = new Set(knownMetricIds);
  function drainUnexpectedPromise(value) {
    try {
      if (value && typeof value.then === "function") void Promise.resolve(value).catch(() => undefined);
    } catch {
      // Provider details are private, including errors from a then getter.
    }
  }
  function requireCurrentAuthority(binding) {
    try {
      const value = configurationAuthorityCurrent?.(binding);
      if (value === true) return;
      drainUnexpectedPromise(value);
    } catch (error) {
      drainUnexpectedPromise(error);
    }
    throw new ControlError(409, "Configuration authority changed or unavailable");
  }
  async function verify(proposal, config, phase) {
    if (restrictionOnly(config.active?.document, proposal.document))
      return {
        receiptId: config.active.source.receiptId,
        digest: proposal.digest,
        baseRevision: proposal.baseRevision,
        verifiedAt: now(),
        validUntil: now() + 600_000,
        restrictiveOverlay: true,
        inheritedActivationDigest: config.active.digest,
      };
    requireThat(typeof sourceVerifier === "function", 409, "Source verification is not configured");
    const report = await sourceVerifier({
      document: structuredClone(proposal.document),
      digest: proposal.digest,
      baseRevision: proposal.baseRevision,
      phase,
    });
    return validateSourceReport(report, proposal, now(), policyVersions);
  }
  function proposalFor(state, id, version) {
    const config = own(state);
    const proposal = config.proposals[id];
    requireThat(proposal, 404, "Not found");
    requireThat(
      proposal.versionNumber === version && proposal.baseRevision === config.revision,
      409,
      "Configuration changed; propose or preview again",
    );
    return { config, proposal };
  }
  function audit(config, proposal, actor, action, details = {}) {
    const event = {
      id: randomUUID(),
      proposalId: proposal.id,
      actor,
      action,
      at: now(),
      digest: proposal.digest,
      baseRevision: proposal.baseRevision,
      ...details,
    };
    proposal.history.push(event);
    config.history.push(event);
    proposal.versionNumber++;
    return event;
  }
  return async function handle({ path, method, input, session, refreshSession }) {
    requireThat(session.roles.includes("operator"), 403, "Operator role required");
    const prefix = "/controls/configuration";
    if (path === prefix && method === "GET") return { status: 200, data: configurationState(store.read()) };
    if ((path === prefix + "/proposals" || path === prefix + "/rollback") && method === "POST") {
      exactKeys(
        input,
        path.endsWith("rollback")
          ? ["baseRevision", "version", "targetDigest"]
          : ["baseRevision", "version", "document"],
      );
      const version = identifier(input.version);
      const result = store.transaction((state) => {
        const config = own(state);
        requireThat(
          Number.isSafeInteger(input.baseRevision) && input.baseRevision === config.revision,
          409,
          "Configuration revision changed",
        );
        requireThat(
          !Object.values(config.proposals).some((p) => p.version === version),
          409,
          "Configuration version already exists",
        );
        let document;
        if (path.endsWith("rollback")) {
          const previous = Object.values(config.proposals).find(
            (p) => p.digest === input.targetDigest && p.status === "activated",
          );
          requireThat(previous, 404, "Activated rollback target unavailable");
          document = previous.document;
        } else document = normalizeConfiguration(input.document);
        requireThat(
          document.metrics.length === metricIds.size && document.metrics.every((m) => metricIds.has(m.id)),
          409,
          "Configuration must explicitly include every known metric definition",
        );
        const proposal = {
          id: randomUUID(),
          version,
          document,
          digest: configurationDigest(document),
          baseRevision: config.revision,
          owner: session.actorId,
          status: "proposed",
          versionNumber: 0,
          history: [],
          rollbackOf: input.targetDigest ?? null,
        };
        config.proposals[proposal.id] = proposal;
        audit(config, proposal, session.actorId, "proposed");
        return structuredClone(proposal);
      });
      return { status: 201, data: result };
    }
    const match = /^\/controls\/configuration\/proposals\/([a-f0-9-]{36})(?:\/(preview|approve|activate))?$/.exec(path);
    requireThat(match, 404, "Not found");
    const [, id, action] = match;
    if (method === "GET" && !action) {
      const proposal = configurationState(store.read()).proposals[id];
      requireThat(proposal, 404, "Not found");
      return { status: 200, data: proposal };
    }
    requireThat(method === "POST" && action, 405, "Method not allowed");
    const before = store.read();
    const { config, proposal } = proposalFor(before, id, input.version);
    requireThat(proposal.status !== "activated", 409, "Configuration already activated");
    let source;
    if (action === "preview" || action === "activate") {
      exactKeys(input, action === "preview" ? ["version"] : ["version", "approvalId"]);
      if (action === "activate")
        requireThat(
          proposal.status === "approved" && proposal.approval?.id === input.approvalId,
          409,
          "Independent approval required",
        );
      source = await verify(proposal, config, action);
      session = await refreshSession();
      requireThat(session.roles.includes("operator"), 403, "Operator role required");
    }
    if (action === "approve") {
      exactKeys(input, ["version", "previewDigest", "conflict"]);
      requireThat(
        proposal.owner !== session.actorId && input.conflict === false,
        403,
        "Independent operator approval required",
      );
      requireThat(
        proposal.status === "previewed" &&
          proposal.preview?.digest === input.previewDigest &&
          proposal.preview.source.validUntil > now(),
        409,
        "Current tested preview required",
      );
    }
    let confirmActivation;
    if (action === "activate") {
      const authority = await rolesForActor(proposal.approval.actor);
      requireThat(
        authority.roles.includes("operator") && authority.version === proposal.approval.roleVersion,
        409,
        "Configuration approval revoked",
      );
      session = await refreshSession();
      requireThat(session.roles.includes("operator"), 403, "Operator role required");
      requireThat(proposal.preview.source.validUntil > now(), 409, "Preview expired");
      requireThat(
        stableJSON(testedMeaning(source)) === stableJSON(testedMeaning(proposal.preview.source)),
        409,
        "Source schema or permission changed; preview again",
      );
      const binding = Object.freeze({
        actorId: session.actorId,
        roleVersion: session.roleVersion,
        approverId: proposal.approval.actor,
        approverRoleVersion: proposal.approval.roleVersion,
      });
      confirmActivation = () => {
        // Both role bindings must remain authoritative in this synchronous turn.
        // An asynchronous refresh or eventually consistent mirror cannot supply it.
        requireCurrentAuthority(binding);
        const active = store.read().sessions[session.sid];
        const currentSession =
          active &&
          active.actorId === session.actorId &&
          active.roleVersion === session.roleVersion &&
          active.csrf === session.csrf &&
          active.expires === session.expires &&
          stableJSON(active.roles) === stableJSON(session.roles) &&
          active.roles.includes("operator");
        const timestamp = now();
        requireThat(currentSession && active.expires > timestamp, 401, "Operator session revoked");
        requireThat(source.validUntil > timestamp, 409, "Source receipt expired");
        requireThat(proposal.preview.source.validUntil > timestamp, 409, "Preview expired");
      };
    }
    let activatedConfiguration;
    const result = store.transaction(
      (state) => {
        confirmActivation?.();
        const { config, proposal } = proposalFor(state, id, input.version);
        // Authority/session rechecks await external providers after verification.
        // The source receipt must still be current at the synchronous commit boundary.
        if (source) requireThat(source.validUntil > now(), 409, "Source receipt expired");
        if (action === "preview") {
          const preview = {
            configurationDigest: proposal.digest,
            baseRevision: proposal.baseRevision,
            source,
            before: coverage(config.active?.document),
            after: coverage(proposal.document),
          };
          preview.digest = configurationDigest(preview);
          proposal.preview = preview;
          proposal.approval = null;
          proposal.status = "previewed";
          audit(config, proposal, session.actorId, "previewed", { previewDigest: preview.digest });
        } else if (action === "approve") {
          requireThat(
            proposal.owner !== session.actorId &&
              proposal.status === "previewed" &&
              proposal.preview.digest === input.previewDigest,
            409,
            "Preview changed",
          );
          proposal.approval = {
            id: randomUUID(),
            actor: session.actorId,
            roleVersion: session.roleVersion,
            previewDigest: proposal.preview.digest,
            configurationDigest: proposal.digest,
            at: now(),
          };
          proposal.status = "approved";
          audit(config, proposal, session.actorId, "approved", { approvalId: proposal.approval.id });
        } else {
          requireThat(
            proposal.status === "approved" &&
              proposal.approval.id === input.approvalId &&
              proposal.approval.configurationDigest === proposal.digest &&
              proposal.approval.previewDigest === proposal.preview.digest,
            409,
            "Approval changed",
          );
          proposal.source = source;
          proposal.status = "activated";
          config.revision++;
          audit(config, proposal, session.actorId, "activated", {
            revision: config.revision,
            approvalId: proposal.approval.id,
          });
          config.active = structuredClone(proposal);
          activatedConfiguration = stableJSON(config);
        }
        return structuredClone(proposal);
      },
      {
        publish: action === "activate",
        ...(confirmActivation
          ? {
              beforeCommit: () => {
                requireThat(
                  stableJSON(configurationState(store.read())) === activatedConfiguration,
                  409,
                  "Configuration changed during publication",
                );
                confirmActivation();
              },
            }
          : {}),
      },
    );
    return { status: 200, data: result, ...(confirmActivation ? { beforeSend: confirmActivation } : {}) };
  };
}
