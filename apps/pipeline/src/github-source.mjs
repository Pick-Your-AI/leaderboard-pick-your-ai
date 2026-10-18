import { GithubClientError } from "../../../packages/github/dist/client.js";
import { readTypedIssueHistory, typedHistoryRevision } from "../../../packages/github/dist/timeline-history.js";
import {
  assertPublicProjects,
  readPublicProjectSnapshot,
  projectSnapshotRevision,
} from "../../../packages/github/dist/project-snapshots.js";
import {
  githubReviewRevision,
  githubDiscussionRevision,
  githubSnapshotRevision,
  githubTimelineRevision,
} from "../../../packages/github/dist/normalizers.js";

/** Conservative scope-loss codes emitted by the trusted Project adapters. */
export function isProjectSourceScopeFailure(error, family) {
  if (
    ["project_current", "project_history"].includes(family) &&
    error instanceof GithubClientError &&
    ["authentication_required", "permission_denied", "not_found_or_hidden"].includes(error.outcome.kind)
  )
    return true;
  return (
    error instanceof Error &&
    [
      "project_not_authorized",
      "project_public_scope_unverified",
      "project_public_subject_unverified",
      "project_history_scope_unverified",
      "project_subject_identity_unverified",
    ].includes(error.message)
  );
}

const routes = {
  issues: "issues?state=all&sort=created&direction=asc&per_page=100",
  pull_requests: "pulls?state=all&sort=created&direction=asc&per_page=100",
  comments: "issues/comments?per_page=100",
  commits: "commits?per_page=100",
  releases: "releases?per_page=100",
  timelines: "issues/events?per_page=100",
};
const at = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** Read-only REST source with complete, bounded review fanout. */
export function createGithubCollectionSource({
  client,
  sourceId,
  repositories,
  isSynthetic = false,
  maxPages = 100,
  onUnavailable,
  assertAuthorized = () => {},
}) {
  if (
    !client?.scanRest ||
    !client?.rest ||
    typeof sourceId !== "string" ||
    !sourceId ||
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 1000
  )
    throw new Error("invalid_github_collection_source");
  const approved = new Map(repositories.map((repository) => [repository.id, repository]));
  async function probeRepository(repository) {
    const scope = approved.get(repository.id);
    if (!scope || scope.slug !== repository.slug || scope.installationId !== repository.installationId)
      throw new Error("repository_not_authorized");
    const value = await client.rest(sourceId, `/repos/${scope.slug}`, assertAuthorized);
    if (value?.id !== repository.id || typeof value.private !== "boolean")
      throw new Error("repository_identity_unverified");
    return {
      repositoryId: value.id,
      installationId: scope.installationId,
      visibility: value.private === false ? "public" : "private",
      checkedAt: new Date().toISOString(),
      isSynthetic,
    };
  }
  const adapter = {
    probeRepository,
    async readPage(request) {
      const repository = approved.get(request.repositoryId),
        route = routes[request.family];
      if (
        !repository ||
        !repository.families.includes(request.family) ||
        (!route &&
          !["reviews", "discussions", "project_current", "project_history", "relationships"].includes(request.family))
      )
        throw new Error("source_family_adapter_unavailable");
      assertAuthorized();
      let verification;
      try {
        verification = await probeRepository(repository);
      } catch {
        await onUnavailable?.(repository, "visibility_probe_unavailable");
        throw new Error("repository_probe_unavailable");
      }
      assertAuthorized();
      if (verification.visibility !== "public") {
        await onUnavailable?.(repository, "visibility_or_scope_not_public");
        throw new Error("public_repository_required");
      }
      if (request.cursor !== null && !/^(0|[1-9]\d{0,4})$/.test(request.cursor))
        throw new Error("invalid_source_cursor");
      if (["project_current", "project_history"].includes(request.family))
        await assertPublicProjects({
          client,
          source: sourceId,
          allowedProjectIds: repository.allowedProjectIds ?? [],
          assertAuthorized,
        });
      const scan = (key, path, filter = (body) => body) =>
        client.scanRest({
          source: sourceId,
          key: `pipeline:${repository.id}:${request.runId}:${key}`,
          url: `/repos/${repository.slug}/${path}`,
          maxPages,
          assertAuthorized,
          select(body) {
            assertAuthorized();
            if (!Array.isArray(body)) throw new Error("source_array_required");
            return filter(body);
          },
        });
      let values;
      if (["project_history", "relationships"].includes(request.family)) {
        if (
          request.family === "project_history" &&
          (!Array.isArray(repository.allowedProjectIds) || !repository.allowedProjectIds.length)
        )
          throw new Error("approved_project_scope_required");
        // Old Project checkpoints contain filtered issue-only inventories; do not reuse them for PR coverage.
        const subjects = await scan(
          request.family === "project_history" ? "project_history:issue-and-pr-subjects" : "relationships:subjects",
          routes.issues,
          (items) => (request.family === "project_history" ? items : items.filter((item) => !item.pull_request)),
        );
        if (subjects.length > 10000) throw new Error("source_dataset_budget_exceeded");
        values = [];
        const seen = new Set();
        const seenIds = new Set();
        for (const subject of subjects) {
          if (
            subject === null ||
            typeof subject !== "object" ||
            Array.isArray(subject) ||
            !Number.isSafeInteger(subject.number) ||
            subject.number < 1 ||
            seen.has(subject.number) ||
            typeof subject.node_id !== "string" ||
            !subject.node_id.trim() ||
            seenIds.has(subject.node_id)
          )
            throw new Error(
              request.family === "project_history"
                ? "project_subject_identity_unverified"
                : "history_subject_unverified",
            );
          seen.add(subject.number);
          seenIds.add(subject.node_id);
          const records = await readTypedIssueHistory({
            client,
            source: sourceId,
            repository,
            number: subject.number,
            subjectType: subject.pull_request ? "pull_request" : "issue",
            subjectId: subject.node_id,
            family: request.family,
            scanId: request.runId,
            maxPages,
            assertAuthorized,
          });
          values.push(
            ...records.map((record) => ({
              node_id: record.event.id,
              ...(request.family === "project_history" ? { history_subject_id: record.subject.id } : {}),
              html_url: record.subject.url,
              source_revision: typedHistoryRevision(record),
              created_at: record.event.createdAt,
              actor: record.event.actor,
            })),
          );
          if (values.length > 10000) throw new Error("source_dataset_budget_exceeded");
        }
      } else if (request.family === "project_current") {
        const allowedProjectIds = repository.allowedProjectIds ?? [];
        if (!Array.isArray(allowedProjectIds) || !allowedProjectIds.length)
          throw new Error("approved_project_scope_required");
        if (!client.scanGraphql) throw new Error("project_source_unavailable");
        const subjects = await scan("project-subjects", routes.issues);
        if (subjects.length > 10000) throw new Error("source_dataset_budget_exceeded");
        values = [];
        for (const subject of subjects) {
          if (typeof subject.node_id !== "string") throw new Error("project_subject_identity_unverified");
          const items = await client.scanGraphql({
            source: sourceId,
            key: `pipeline:${repository.id}:${request.runId}:project-items:${subject.node_id}`,
            query: `query($id:ID!, $first:Int!, $after:String) {
              node(id:$id) {
                ... on Issue { id repository { databaseId isPrivate } projectItems(first:$first,after:$after) { nodes { id project { id public } } pageInfo { hasNextPage endCursor } } }
                ... on PullRequest { id repository { databaseId isPrivate } projectItems(first:$first,after:$after) { nodes { id project { id public } } pageInfo { hasNextPage endCursor } } }
              }
            }`,
            variables: { id: subject.node_id },
            maxPages,
            assertAuthorized,
            select(data) {
              assertAuthorized();
              if (
                data?.node?.id !== subject.node_id ||
                data.node.repository?.databaseId !== repository.id ||
                data.node.repository?.isPrivate !== false ||
                !Array.isArray(data.node.projectItems?.nodes)
              )
                throw new Error("project_subject_identity_unverified");
              if (
                data.node.projectItems.nodes.some(
                  (item) => allowedProjectIds.includes(item?.project?.id) && item?.project?.public !== true,
                )
              )
                throw new Error("project_public_scope_unverified");
              return {
                ...data.node.projectItems,
                nodes: data.node.projectItems.nodes.filter((item) => allowedProjectIds.includes(item?.project?.id)),
              };
            },
          });
          if (items.length + values.length > 10000) throw new Error("source_dataset_budget_exceeded");
          for (const item of items) {
            const snapshot = await readPublicProjectSnapshot({
              client,
              source: sourceId,
              repository,
              itemId: item.id,
              allowedProjectIds,
              scanId: request.runId,
              maxPages,
              assertAuthorized,
            });
            values.push({
              node_id: snapshot.id,
              html_url: snapshot.sourceUrl,
              source_revision: projectSnapshotRevision(snapshot),
            });
          }
        }
      } else if (request.family === "discussions") {
        if (!client.scanGraphql) throw new Error("discussions_source_unavailable");
        const [owner, name] = repository.slug.split("/");
        values = await client.scanGraphql({
          source: sourceId,
          key: `pipeline:${repository.id}:${request.runId}:discussions`,
          query: `query($owner:String!, $name:String!, $first:Int!, $after:String) {
            repository(owner:$owner, name:$name) {
              databaseId isPrivate hasDiscussionsEnabled
              discussions(first:$first, after:$after, orderBy:{field:CREATED_AT,direction:ASC}) {
                nodes { id url updatedAt createdAt answerChosenAt
                  author { __typename login ... on User { id databaseId } ... on Bot { id databaseId } }
                  answerChosenBy { __typename ... on User { id databaseId } ... on Bot { id databaseId } }
                  answer { id isAnswer author { __typename ... on User { id databaseId } ... on Bot { id databaseId } } }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }`,
          variables: { owner, name },
          maxPages,
          assertAuthorized,
          select(data) {
            assertAuthorized();
            const repo = data?.repository;
            if (repo?.databaseId !== repository.id || repo.isPrivate !== false)
              throw new Error("repository_identity_unverified");
            if (repo.hasDiscussionsEnabled !== true) throw new Error("discussions_source_unavailable");
            if (!Array.isArray(repo.discussions?.nodes)) throw new Error("source_array_required");
            return { nodes: repo.discussions.nodes, pageInfo: repo.discussions.pageInfo };
          },
        });
        values = values.map((value) => ({
          source_revision: githubDiscussionRevision(value),
          node_id: value.id,
          html_url: value.url,
          updated_at: value.updatedAt,
          created_at: value.createdAt,
        }));
      } else if (request.family === "reviews") {
        const pulls = await scan("review-pulls", routes.pull_requests);
        if (pulls.length > 10000) throw new Error("source_dataset_budget_exceeded");
        values = [];
        const seen = new Set();
        for (const pull of pulls) {
          assertAuthorized();
          if (!Number.isSafeInteger(pull.number) || pull.number < 1 || seen.has(pull.number))
            throw new Error("source_pull_identity_unverified");
          seen.add(pull.number);
          const reviews = await scan(`reviews:${pull.number}`, `pulls/${pull.number}/reviews?per_page=100`);
          values.push(...reviews);
          if (values.length > 10000) throw new Error("source_dataset_budget_exceeded");
        }
      } else {
        values = await scan(request.family, route, (body) =>
          request.family === "issues" ? body.filter((item) => !item.pull_request) : body,
        );
      }
      if (request.family === "timelines")
        values = values.map((value) => ({
          ...value,
          node_id: Number.isSafeInteger(value.id) && value.id > 0 ? String(value.id) : null,
          html_url: value.issue?.html_url,
        }));
      assertAuthorized();
      if (values.length > 10000) throw new Error("source_dataset_budget_exceeded");
      const offset = request.cursor === null ? 0 : Number(request.cursor);
      if (offset > values.length) throw new Error("invalid_source_cursor");
      const facts = values.slice(offset, offset + request.limit).map((value) => {
        const subjectId = value.node_id ?? value.sha ?? (Number.isSafeInteger(value.id) ? String(value.id) : null);
        const revision = ["project_history", "relationships"].includes(request.family)
          ? value.source_revision
          : request.family === "timelines"
            ? githubTimelineRevision(value)
            : request.family === "reviews"
              ? githubSnapshotRevision(githubReviewRevision(value), request.runId)
              : ["discussions", "project_current"].includes(request.family)
                ? githubSnapshotRevision(value.source_revision, request.runId)
                : (value.sha ??
                  at(value.updated_at) ??
                  at(value.submitted_at) ??
                  at(value.published_at) ??
                  at(value.created_at));
        if (
          typeof subjectId !== "string" ||
          !revision ||
          typeof value.html_url !== "string" ||
          !value.html_url.startsWith(`https://github.com/${repository.slug}/`)
        )
          throw new Error("source_identity_or_revision_unverified");
        return {
          subjectId,
          ...(request.family === "project_history" ? { historySubjectId: value.history_subject_id } : {}),
          sourceRevision: revision,
          sourceUrl: value.html_url,
          evidence: ["timelines", "project_history", "relationships"].includes(request.family)
            ? "observed_transition"
            : "current_state",
          actorId:
            ["timelines", "project_history", "relationships"].includes(request.family) &&
            Number.isSafeInteger(value.actor?.databaseId ?? value.actor?.id) &&
            (value.actor?.databaseId ?? value.actor?.id) > 0
              ? String(value.actor.databaseId ?? value.actor.id)
              : null,
          occurredAt: ["timelines", "project_history", "relationships"].includes(request.family)
            ? at(value.created_at)
            : null,
          state: value.merged_at
            ? "merged"
            : value.state === "closed"
              ? "closed"
              : value.state === "open"
                ? "open"
                : "present",
        };
      });
      const next = offset + facts.length;
      return {
        repositoryId: repository.id,
        visibility: "public",
        isSynthetic,
        facts,
        nextCursor: next < values.length ? String(next) : null,
        expectedCount: values.length,
      };
    },
  };
  return {
    probeRepository,
    async readPage(request) {
      try {
        return await adapter.readPage(request);
      } catch (error) {
        const repository = approved.get(request.repositoryId);
        if (repository && isProjectSourceScopeFailure(error, request.family))
          await onUnavailable?.(repository, "project_scope_unavailable");
        throw error;
      }
    },
  };
}
