import { createHash } from "node:crypto";

export const webhookDispatchVersion = "issues-creation-dispatch.v1";
const hash = (value) => createHash("sha256").update(value).digest("hex");

/** A delivery only invalidates an already-approved source. It never supplies metric evidence. */
export function createWebhookDispatcher({
  outbox,
  config,
  dataMode,
  policyVersion,
  approved,
  configurationRevision,
  execute,
  confirm,
  assertAuthorized,
  now,
}) {
  const configurationHash = hash(JSON.stringify(config));
  const binding = () => ({
    configurationHash,
    configurationVersion: config.version,
    configurationRevision: configurationRevision(),
    normalizationVersion: webhookDispatchVersion,
    policyVersion,
    dataMode,
    cutoff: now(),
  });
  return async function dispatchOnce() {
    if (dataMode !== "synthetic" || !(await approved())) return "blocked";
    const requested = binding();
    const lease = await outbox.claim(requested);
    if (!lease) return "idle";
    try {
      for (const key of [
        "configurationHash",
        "configurationVersion",
        "configurationRevision",
        "normalizationVersion",
        "policyVersion",
        "dataMode",
      ])
        if (lease.operation[key] !== requested[key]) throw new Error("dispatch_configuration_changed");
      const observation = lease.observation;
      const repository = config.repositories.find(
        (repo) => repo.id === observation?.repositoryId && repo.installationId === observation?.installationId,
      );
      if (
        lease.normalizationVersion !== "delivery-observation/v1" ||
        observation?.version !== "github-delivery/v1" ||
        lease.eventKey !== `github:delivery:${observation.deliveryId}` ||
        observation.event !== "issues" ||
        observation.action !== "opened" ||
        typeof observation.subjectId !== "string" ||
        !/^[A-Za-z0-9_=-]{1,128}$/.test(observation.subjectId) ||
        !repository?.families.includes("issues") ||
        !config.policies.some(
          (item) => item.policy.metricId === "issues_opened" && item.policy.sources.includes("github_rest"),
        ) ||
        !config.scopes.some((scope) => scope.repository === null || scope.repository === String(repository.id)) ||
        typeof observation.sourceUrl !== "string" ||
        !observation.sourceUrl.startsWith(`https://github.com/${repository.slug}/issues/`) ||
        !/^[1-9]\d*$/.test(observation.sourceUrl.slice(`https://github.com/${repository.slug}/issues/`.length))
      )
        throw new Error("unsupported_dispatch_observation");
      const publications = await execute(lease);
      return (await outbox.complete(lease, publications, (tx) => confirm(tx, lease, publications), assertAuthorized))
        ? "processed"
        : "lease_lost";
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "dispatch_lease_lost") return "lease_lost";
      const unsupported = code === "unsupported_dispatch_observation";
      const configurationChanged = [
        "dispatch_configuration_changed",
        "active_configuration_changed",
        "active_configuration_revoked_source",
        "active_configuration_source_scope_unavailable",
        "active_configuration_repository_binding_changed",
        "active_configuration_revoked_capability",
        "active_configuration_revoked_project",
      ].includes(code);
      const reason = unsupported
        ? "unsupported_observation"
        : configurationChanged
          ? "configuration_changed"
          : /enrichment/.test(code)
            ? "enrichment_unavailable"
            : /source|repository|collection/.test(code)
              ? "source_unavailable"
              : "publication_unavailable";
      return outbox.fail(lease, reason, unsupported || configurationChanged);
    }
  };
}
