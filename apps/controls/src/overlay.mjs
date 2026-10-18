// Read-only, fail-closed overlay over the pipeline's independently approved
// baseline. It grants no new source permission or collection scope.
export function configurationOverlay(state) {
  const current = state.configuration || { revision: 0, active: null };
  const active = current.active;
  return {
    revision: current.revision,
    version: active?.version ?? null,
    digest: active?.digest ?? null,
    approvalReceipt: active?.approval.id ?? null,
    allowedRepositoryIds: active ? active.document.repositories.map((r) => r.id) : null,
    allowedRepositories: active ? structuredClone(active.document.repositories) : null,
    allowedProjectIds: active ? active.document.projects.map((project) => project.id) : null,
    disabledMetricIds: active ? active.document.metrics.filter((m) => !m.enabled).map((m) => m.id) : [],
    disabledMetrics: active
      ? active.document.metrics
          .filter((m) => !m.enabled)
          .map(({ id, reason, policyVersion, policyLink }) => ({ id, reason, policyVersion, policyLink }))
      : [],
  };
}
