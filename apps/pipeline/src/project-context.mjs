const fail = () => {
  throw new Error("invalid_normalized_project_context");
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) =>
  object(value) && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
const opaque = (value) => typeof value === "string" && /^[A-Za-z0-9_=.:\-]{1,128}$/.test(value);
const sortedIds = (value, limit) =>
  Array.isArray(value) &&
  value.length <= limit &&
  value.every(opaque) &&
  JSON.stringify(value) === JSON.stringify([...new Set(value)].sort());

/** Freeze host-approved stable-ID mappings before any collection or cache lookup. */
export function canonicalProjectWorkstreamMappings(config, validate) {
  const mappings = config.projectWorkstreamMappings ?? [];
  if (!Array.isArray(mappings) || mappings.length > 1000) throw new Error("invalid_project_workstream_mapping");
  const repositories = new Set();
  return mappings
    .map((mapping) => {
      if (
        !keys(mapping, ["repositoryId", "version", "projects"]) ||
        !Number.isSafeInteger(mapping.repositoryId) ||
        mapping.repositoryId < 1 ||
        repositories.has(mapping.repositoryId)
      )
        throw new Error("invalid_project_workstream_mapping");
      const repository = config.repositories.find((entry) => entry.id === mapping.repositoryId);
      if (!repository) throw new Error("invalid_project_workstream_mapping");
      repositories.add(mapping.repositoryId);
      return {
        repositoryId: mapping.repositoryId,
        ...validate({ version: mapping.version, projects: mapping.projects }, repository.allowedProjectIds ?? []),
      };
    })
    .sort((left, right) => left.repositoryId - right.repositoryId);
}

/** Project context stays in the private, hash-bound source normalization receipt. */
export function normalizedProjectContext(output, row, repository, mappings) {
  // A missing context can express uncertainty, but the marked observation must
  // remain free of action or actor credit in fresh and cached output alike.
  if (
    row.family === "project_current" &&
    row.document.projectSubjectId !== undefined &&
    ["facts", "actors", "evidence"].some((field) => !Array.isArray(output?.[field]) || output[field].length !== 0)
  )
    fail();
  const value = output.projectContext;
  if (value === undefined) return {};
  const mapping = mappings.find((entry) => entry.repositoryId === repository.id);
  const allowed = [...(repository.allowedProjectIds ?? [])].sort();
  const context = value?.context;
  const sourcePath = value?.sourceUrl?.slice?.("https://github.com/".length);
  const subject = typeof sourcePath === "string" ? sourcePath.split("/") : [];
  const workstreamScope = [
    ...new Set(
      (mapping?.projects ?? []).flatMap((project) =>
        project.fields.flatMap((field) => field.options.map((option) => option.workstreamId)),
      ),
    ),
  ].sort();
  const mappedWorkstreams = new Set(
    (mapping?.projects ?? [])
      .filter((project) => Array.isArray(context?.projects) && context.projects.includes(project.projectId))
      .flatMap((project) => project.fields.flatMap((field) => field.options.map((option) => option.workstreamId))),
  );
  if (
    !keys(value, [
      "schemaVersion",
      "repositoryId",
      "subjectId",
      "subjectKind",
      "sourceUrl",
      "sourceRevision",
      "observedAt",
      "mappingVersion",
      "context",
    ]) ||
    value.schemaVersion !== "github-current-project-context/v2" ||
    row.family !== "project_current" ||
    row.document.evidence !== "current_state" ||
    row.document.projectSubjectId !== row.subject_id ||
    value.repositoryId !== String(repository.id) ||
    value.repositoryId !== String(row.repository_id) ||
    !opaque(value.subjectId) ||
    value.subjectId !== row.subject_id ||
    value.sourceUrl !== row.document.sourceUrl ||
    !value.sourceUrl.startsWith("https://github.com/") ||
    subject.length !== 4 ||
    subject.slice(0, 2).join("/") !== repository.slug ||
    !/^[1-9]\d*$/.test(subject[3]) ||
    !["issues", "pull"].includes(subject[2]) ||
    value.subjectKind !== (subject[2] === "issues" ? "issue" : "pull_request") ||
    value.sourceRevision !== row.document.sourceRevision ||
    value.observedAt !== new Date(row.observed_at).toISOString() ||
    value.mappingVersion !== (mapping?.version ?? null) ||
    !keys(context, ["projects", "workstreams", "workstreamsKnown", "projectScope", "workstreamScope"]) ||
    !sortedIds(allowed, 100) ||
    !allowed.length ||
    !sortedIds(context.projects, 100) ||
    !sortedIds(context.workstreams, 10000) ||
    !sortedIds(context.workstreamScope, 10000) ||
    JSON.stringify(context.workstreamScope) !== JSON.stringify(workstreamScope) ||
    !sortedIds(context.projectScope, 100) ||
    JSON.stringify(context.projectScope) !== JSON.stringify(allowed) ||
    context.projects.some((id) => !allowed.includes(id)) ||
    context.workstreams.some((id) => !mappedWorkstreams.has(id)) ||
    typeof context.workstreamsKnown !== "boolean" ||
    (context.workstreamsKnown &&
      context.projects.some((id) => !mapping?.projects.some((project) => project.projectId === id)))
  )
    fail();
  return { projectContext: structuredClone(value) };
}

/** Overlay only exact repository/native-subject matches after action deduplication. */
export function applyCurrentProjectContexts(facts, documents) {
  const contexts = new Map();
  for (const document of documents) {
    const context = document.projectContext;
    if (!context) continue;
    const key = JSON.stringify([context.repositoryId, context.subjectId]);
    if (contexts.has(key)) throw new Error("ambiguous_current_project_context");
    contexts.set(key, context.context);
  }
  return facts.map((fact) => {
    const context = contexts.get(JSON.stringify([fact.repoId, fact.artifactId]));
    return context ? { ...fact, currentContext: structuredClone(context) } : fact;
  });
}
