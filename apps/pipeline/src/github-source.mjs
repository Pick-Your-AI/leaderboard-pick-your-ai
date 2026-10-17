const routes = {
  issues: 'issues?state=all&sort=created&direction=asc&per_page=100',
  pull_requests: 'pulls?state=all&sort=created&direction=asc&per_page=100',
  comments: 'issues/comments?per_page=100',
  commits: 'commits?per_page=100',
  releases: 'releases?per_page=100',
};
const at = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** Actual read-only REST source. Rich event/history families need their own reviewed adapters. */
export function createGithubCollectionSource({ client, sourceId, repositories, isSynthetic = false, maxPages = 100, onUnavailable }) {
  if (!client?.scanRest || !client?.rest || typeof sourceId !== 'string' || !sourceId || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new Error('invalid_github_collection_source');
  const approved = new Map(repositories.map(repository => [repository.id, repository]));
  async function probeRepository(repository) {
    const scope = approved.get(repository.id);
    if (!scope || scope.slug !== repository.slug || scope.installationId !== repository.installationId) throw new Error('repository_not_authorized');
    const value = await client.rest(sourceId, `/repos/${scope.slug}`);
    if (value?.id !== repository.id || typeof value.private !== 'boolean') throw new Error('repository_identity_unverified');
    return { repositoryId: value.id, installationId: scope.installationId,
      visibility: value.private === false ? 'public' : 'private', checkedAt: new Date().toISOString(), isSynthetic };
  }
  return {
    probeRepository,
    async readPage(request) {
      const repository = approved.get(request.repositoryId), route = routes[request.family];
      if (!repository || !repository.families.includes(request.family) || !route) throw new Error('source_family_adapter_unavailable');
      let verification;
      try { verification = await probeRepository(repository); } catch {
        await onUnavailable?.(repository,'visibility_probe_unavailable'); throw new Error('repository_probe_unavailable');
      }
      if (verification.visibility !== 'public') { await onUnavailable?.(repository,'visibility_or_scope_not_public'); throw new Error('public_repository_required'); }
      if (request.cursor !== null && !/^(0|[1-9]\d{0,4})$/.test(request.cursor)) throw new Error('invalid_source_cursor');
      const values = await client.scanRest({ source: sourceId, key: `pipeline:${request.runId}:${request.family}`,
        url: `/repos/${repository.slug}/${route}`, maxPages,
        select(body) {
          if (!Array.isArray(body)) throw new Error('source_array_required');
          return request.family === 'issues' ? body.filter(item => !item.pull_request) : body;
        } });
      if (values.length > 10000) throw new Error('source_dataset_budget_exceeded');
      const offset = request.cursor === null ? 0 : Number(request.cursor);
      if (offset > values.length) throw new Error('invalid_source_cursor');
      const facts = values.slice(offset, offset + request.limit).map(value => {
        const subjectId = value.node_id ?? value.sha ?? (Number.isSafeInteger(value.id) ? String(value.id) : null);
        const revision = value.sha ?? at(value.updated_at) ?? at(value.published_at) ?? at(value.created_at);
        if (typeof subjectId !== 'string' || !revision || typeof value.html_url !== 'string' || !value.html_url.startsWith(`https://github.com/${repository.slug}/`)) throw new Error('source_identity_or_revision_unverified');
        return { subjectId, sourceRevision: revision, sourceUrl: value.html_url,
          evidence: 'current_state', actorId: null, occurredAt: null,
          state: value.merged_at ? 'merged' : value.state === 'closed' ? 'closed' : value.state === 'open' ? 'open' : 'present' };
      });
      const next = offset + facts.length;
      return { repositoryId: repository.id, visibility: 'public', isSynthetic, facts,
        nextCursor: next < values.length ? String(next) : null, expectedCount: values.length };
    },
  };
}
