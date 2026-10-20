import { GithubClientError } from "../../../packages/github/dist/client.js";
import { isPromise } from "node:util/types";
import { createHash } from "node:crypto";
import { readTypedIssueHistory, typedHistoryRevision } from "../../../packages/github/dist/timeline-history.js";
import {
  readProjectCurationHistory,
  projectCurationHistoryRevision,
} from "../../../packages/github/dist/project-curation-history.js";
import { readIssueFieldHistory, issueFieldHistoryRevision } from "../../../packages/github/dist/issue-field-history.js";
import { assertPublicProjects } from "../../../packages/github/dist/project-snapshots.js";
import { githubRestSnapshotRevision, isGithubRestSnapshotFamily } from "../../../packages/github/dist/rest-snapshot.js";
import {
  readPublicSubjectProjectSnapshot,
  projectSubjectSnapshotRevision,
} from "../../../packages/github/dist/project-context.js";
import {
  githubReviewRevision,
  githubDiscussionRevision,
  githubSnapshotRevision,
  githubTimelineRevision,
} from "../../../packages/github/dist/normalizers.js";
import { parseReconciliationRunId } from "./reconciliation-plan.mjs";
import { readGithubCommentIdentity } from "../../../packages/github/dist/comment-identity.js";
import {
  readGithubContentEditParents,
  githubContentEditRevision,
} from "../../../packages/github/dist/content-edit-history.js";
import { readGithubCommentEditInventory } from "../../../packages/github/dist/comment-edit-inventory.js";
import { githubCommentEditRevision } from "../../../packages/github/dist/comment-edit-history.js";
import { minimizeDiscussionFeedback, discussionFeedbackRevision } from "@pick-your-ai/github";
import { discussionFeedbackContentVersion, discussionFeedbackLimits } from "@pick-your-ai/contracts";
import { captureDecisionObservation, decisionHistoryRepositories } from "./pull-request-decision-history.mjs";

/** Conservative scope-loss codes emitted by the trusted Project adapters. */
export function isProjectSourceScopeFailure(error, family) {
  if (
    ["project_current", "project_history", "project_curation_history"].includes(family) &&
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
      "project_curation_scope_unverified",
      "project_curation_subject_identity_unverified",
      "project_curation_event_unavailable",
    ].includes(error.message)
  );
}

/** Native issue-field scope loss is independent of Project history and transient transport failures. */
export function isIssueFieldSourceScopeFailure(error, family) {
  if (family !== "issue_field_history") return false;
  if (
    error instanceof GithubClientError &&
    ["authentication_required", "permission_denied", "not_found_or_hidden"].includes(error.outcome.kind)
  )
    return true;
  return (
    error instanceof Error &&
    [
      "issue_field_public_scope_unverified",
      "issue_field_subject_identity_unverified",
      "issue_field_event_unavailable",
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
const at = (value) => {
  // Match the GitHub normalizer's UTC/millisecond profile before conversion.
  // Date parsing alone rolls invalid dates forward and drops finer precision.
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19)
    ? date.toISOString()
    : null;
};

// These APIs expose an actual updated/event-time lower bound. Parent updated
// order, commit author dates and current Project positions are not change feeds.
export const githubRecentSourceFamilies = Object.freeze(["issues", "comments", "project_history", "relationships"]);
const sourceWindow = (request) => {
  if (request.since == null) return null;
  const since = at(request.since),
    until = at(request.until);
  if (since === null || until === null || since >= until) throw new Error("invalid_source_window");
  if (!githubRecentSourceFamilies.includes(request.family)) throw new Error("source_recent_window_unsupported");
  // REST `since` is strictly after the supplied second. Read one extra whole
  // second, then apply the exact inclusive boundary to the returned observations.
  const apiSince = new Date(Math.floor(Date.parse(since) / 1000) * 1000 - 1000).toISOString().replace(".000Z", "Z");
  if (at(apiSince) === null) throw new Error("invalid_source_window");
  return { since, until, apiSince };
};
const recentRoute = (route, window) => {
  const [path, query] = route.split("?");
  const parameters = new URLSearchParams(query);
  parameters.set("since", window.apiSince);
  parameters.set("sort", "updated");
  parameters.set("direction", "asc");
  return path + "?" + parameters.toString();
};
const sourceSubjectId = (value) =>
  value?.node_id ?? value?.sha ?? (Number.isSafeInteger(value?.id) ? String(value.id) : null);

/** Read-only REST source with complete, bounded review fanout. */
export function createGithubCollectionSource({
  client: readClient,
  sourceId,
  repositories,
  isSynthetic = false,
  maxPages = 100,
  onUnavailable,
  assertAuthorized = () => {},
  useRestSnapshotRevisions = () => false,
  includePullRequestReviewComments = () => false,
  includeContentEditMetadata = () => false,
  includeCommentEditMetadata = () => false,
  discussionFeedback = null,
  pullRequestDecisionRepositoryIds,
  decisionHistoryNow = () => new Date().toISOString(),
}) {
  if (
    !readClient?.scanRest ||
    !readClient?.rest ||
    typeof readClient.forRepository !== "function" ||
    typeof sourceId !== "string" ||
    !sourceId ||
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 1000 ||
    typeof useRestSnapshotRevisions !== "function" ||
    typeof includePullRequestReviewComments !== "function" ||
    typeof includeContentEditMetadata !== "function" ||
    typeof includeCommentEditMetadata !== "function" ||
    typeof decisionHistoryNow !== "function"
  )
    throw new Error("invalid_github_collection_source");
  if (
    discussionFeedback !== null &&
    (!discussionFeedback.authority?.current || !discussionFeedback.store?.begin || !discussionFeedback.store?.complete)
  )
    throw new Error("invalid_discussion_feedback_source");
  const approved = new Map(repositories.map((repository) => [repository.id, repository]));
  const decisionRepositories = decisionHistoryRepositories(pullRequestDecisionRepositoryIds, repositories);
  async function probeRepository(repository) {
    const scope = approved.get(repository.id);
    if (!scope || scope.slug !== repository.slug || scope.installationId !== repository.installationId)
      throw new Error("repository_not_authorized");
    const client = readClient.forRepository(scope.id);
    let value;
    if (scope.families.includes("project_curation_history")) {
      const [owner, name] = scope.slug.split("/");
      // REST probes can persist their full ETag response before a caller projects
      // it. Curation needs only the repository identity and current visibility.
      const data = await client.graphql(
        sourceId,
        "query ProjectCurationRepository($owner:String!, $name:String!) {" +
          " repository(owner:$owner, name:$name) { databaseId nameWithOwner isPrivate } }",
        { owner, name },
        assertAuthorized,
      );
      value = {
        id: data?.repository?.databaseId,
        full_name: data?.repository?.nameWithOwner,
        private: data?.repository?.isPrivate,
      };
    } else value = await client.rest(sourceId, `/repos/${scope.slug}`, assertAuthorized);
    if (
      value?.id !== repository.id ||
      typeof value.private !== "boolean" ||
      typeof value.full_name !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.full_name) ||
      value.full_name.toLowerCase() !== scope.slug.toLowerCase()
    )
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
    async readPage(request, issueFieldWindow) {
      const repository = approved.get(request.repositoryId),
        route = routes[request.family];
      if (
        !repository ||
        !repository.families.includes(request.family) ||
        (!route &&
          ![
            "reviews",
            "discussions",
            "project_current",
            "project_history",
            "project_curation_history",
            "relationships",
            "issue_field_history",
            "content_edits",
          ].includes(request.family))
      )
        throw new Error("source_family_adapter_unavailable");
      if (
        request.family === "content_edits" &&
        (!["audit", "backfill"].includes(request.mode) ||
          request.since !== null ||
          at(request.until) === null ||
          at(request.until) !== request.until)
      )
        throw new Error("source_content_edit_window_unsupported");
      if (
        request.family === "project_curation_history" &&
        (!["audit", "backfill", "reconcile"].includes(request.mode) ||
          request.since !== null ||
          at(request.until) === null ||
          at(request.until) !== request.until)
      )
        throw new Error("source_project_curation_window_unsupported");
      const planned = parseReconciliationRunId(request.runId);
      const window = request.family === "issue_field_history" ? null : sourceWindow(request);
      if (
        planned &&
        (at(request.until) === null ||
          at(request.until) !== request.until ||
          (request.mode === "audit"
            ? request.since !== null
            : request.mode === "reconcile"
              ? !window || window.since !== request.since
              : true))
      )
        throw new Error("reconciliation_source_plan_invalid");
      let expandedContentEdits = false;
      if (request.family === "content_edits") {
        assertAuthorized();
        const admitted = includeContentEditMetadata(Object.freeze({ ...request }));
        if (isPromise(admitted))
          void Promise.prototype.then.call(
            admitted,
            () => {},
            () => {},
          );
        assertAuthorized();
        if (typeof admitted !== "boolean") throw new Error("invalid_content_edit_inventory_policy");
        if (!admitted) throw new Error("source_content_edit_inventory_unavailable");
        expandedContentEdits = includeCommentEditMetadata(Object.freeze({ ...request }));
        if (isPromise(expandedContentEdits))
          void Promise.prototype.then.call(
            expandedContentEdits,
            () => {},
            () => {},
          );
        assertAuthorized();
        if (typeof expandedContentEdits !== "boolean") throw new Error("invalid_comment_edit_inventory_policy");
      }
      const expandedComments =
        request.family === "comments" ? includePullRequestReviewComments({ runId: request.runId }) : false;
      if (typeof expandedComments !== "boolean") throw new Error("invalid_comments_inventory_policy");
      const client = readClient.forRepository(repository.id);
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
      const curationCursor =
        request.family === "project_curation_history" && request.cursor !== null
          ? /^([a-f0-9]{64}):(0|[1-9]\d{0,4})$/.exec(request.cursor)
          : null;
      if (
        request.cursor !== null &&
        (request.family === "project_curation_history"
          ? curationCursor === null
          : !/^(0|[1-9]\d{0,4})$/.test(request.cursor))
      )
        throw new Error("invalid_source_cursor");
      const offset = request.cursor === null ? 0 : Number(curationCursor ? curationCursor[2] : request.cursor);
      let restSnapshots = Boolean(planned) || expandedComments;
      if (!restSnapshots && isGithubRestSnapshotFamily(request.family)) {
        assertAuthorized();
        restSnapshots = await useRestSnapshotRevisions({ repositoryId: repository.id, family: request.family });
        assertAuthorized();
        if (typeof restSnapshots !== "boolean") throw new Error("invalid_rest_snapshot_policy");
      }
      if (["project_current", "project_history", "project_curation_history"].includes(request.family))
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
          ...(request.family === "project_curation_history" ? { refresh: true } : {}),
          maxPages,
          assertAuthorized,
          select(body) {
            assertAuthorized();
            if (!Array.isArray(body)) throw new Error("source_array_required");
            return filter(body);
          },
        });
      let values;
      let projectSubjectCount = null;
      if (request.family === "content_edits") {
        const inventory = await (expandedContentEdits ? readGithubCommentEditInventory : readGithubContentEditParents)({
          client,
          source: sourceId,
          repository: { id: repository.id, slug: repository.slug },
          scanId: request.runId,
          maxPages,
          assertAuthorized,
        });
        values = inventory.snapshots;
      } else if (request.family === "issue_field_history") {
        if (!client.scanGraphql) throw new Error("issue_field_source_unavailable");
        const inventorySubjects = (items, limit) => {
          if (!Array.isArray(items) || items.length > limit)
            throw new GithubClientError({ kind: "invalid_response" }, sourceId);
          const seenNumbers = new Set();
          const seenIds = new Set();
          return items.map((subject) => {
            if (
              subject === null ||
              typeof subject !== "object" ||
              Array.isArray(subject) ||
              Object.keys(subject).sort().join(",") !== "id,number,url" ||
              !Number.isSafeInteger(subject.number) ||
              subject.number < 1 ||
              typeof subject.id !== "string" ||
              !/^[A-Za-z0-9_=.:\-]{1,128}$/.test(subject.id) ||
              typeof subject.url !== "string" ||
              !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[1-9]\d*$/.test(subject.url)
            )
              throw new GithubClientError({ kind: "invalid_response" }, sourceId);
            if (seenNumbers.has(subject.number) || seenIds.has(subject.id))
              throw new Error("issue_field_duplicate_subject");
            if (subject.url !== "https://github.com/" + repository.slug + "/issues/" + subject.number)
              throw new Error("issue_field_subject_identity_unverified");
            seenNumbers.add(subject.number);
            seenIds.add(subject.id);
            return { id: subject.id, number: subject.number, url: subject.url };
          });
        };
        const [owner, name] = repository.slug.split("/");
        // REST issue inventories include content in both HTTP and scan caches.
        // This issue-only query acquires and checkpoints just bound identities.
        const subjects = await client.scanGraphql({
          source: sourceId,
          key: `pipeline:${repository.id}:${request.runId}:issue-field-history:issue-inventory-metadata-v1`,
          query: `query IssueFieldInventory($owner:String!, $name:String!, $first:Int!, $after:String) {
            repository(owner:$owner, name:$name) {
              databaseId isPrivate
              issues(first:$first, after:$after, states:[OPEN,CLOSED], orderBy:{field:CREATED_AT,direction:ASC}) {
                nodes { id number url }
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
            if (repo === null) throw new Error("issue_field_subject_identity_unverified");
            if (
              !repo ||
              typeof repo !== "object" ||
              Array.isArray(repo) ||
              !Number.isSafeInteger(repo.databaseId) ||
              repo.databaseId < 1 ||
              typeof repo.isPrivate !== "boolean"
            )
              throw new GithubClientError({ kind: "invalid_response" }, sourceId);
            if (repo.databaseId !== repository.id || repo.isPrivate !== false)
              throw new Error("issue_field_subject_identity_unverified");
            return { nodes: inventorySubjects(repo.issues?.nodes, 100), pageInfo: repo.issues.pageInfo };
          },
        });
        if (subjects.length > 10000) throw new Error("source_dataset_budget_exceeded");
        values = [];
        // Completed or resumed checkpoints must satisfy the same whole-inventory
        // identity checks before any event values are read.
        for (const subject of inventorySubjects(subjects, 10000)) {
          const records = await readIssueFieldHistory({
            client,
            source: sourceId,
            repository,
            number: subject.number,
            subjectId: subject.id,
            scanId: request.runId,
            maxPages,
            assertAuthorized,
          });
          values.push(
            ...records.map((record) => ({
              node_id: record.event.id,
              history_subject_id: record.subject.id,
              issue_field_id: record.issueField.id,
              html_url: record.subject.url,
              source_revision: issueFieldHistoryRevision(record),
              created_at: record.event.createdAt,
              actor: record.event.actor,
            })),
          );
          if (values.length > 10000) throw new Error("source_dataset_budget_exceeded");
        }
        // Preserve every fresh privacy/membership check before selecting the
        // native events admitted by CollectionStore's inclusive scan window.
        values = values.filter((value) => {
          const occurredAt = at(value.created_at);
          if (occurredAt === null) throw new Error("issue_field_event_invalid_response");
          return (
            occurredAt <= issueFieldWindow.until &&
            (issueFieldWindow.since === null || occurredAt >= issueFieldWindow.since)
          );
        });
      } else if (["project_history", "relationships"].includes(request.family)) {
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
            // Match collection identity validation before admitting history:
            // Project identity loss must reach the durable publication gate.
            !/^[A-Za-z0-9_=.:\-]{1,128}$/.test(subject.node_id) ||
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
            ...(window ? { since: window.apiSince } : {}),
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
      } else if (request.family === "project_curation_history") {
        const [owner, name] = repository.slug.split("/");
        const subjects = [];
        // Select metadata at the transport boundary. A REST inventory would
        // cache complete issue bodies before scanRest applies its selector.
        for (const [field, kind, states] of [
          ["issues", "issue", "OPEN,CLOSED"],
          ["pullRequests", "pull_request", "OPEN,CLOSED,MERGED"],
        ]) {
          const inventory = await client.scanGraphql({
            source: sourceId,
            key: `pipeline:${repository.id}:${request.runId}:project-curation:${kind}-subjects-metadata-v1`,
            query:
              "query ProjectCurationInventory($owner:String!, $name:String!, $first:Int!, $after:String) {" +
              " repository(owner:$owner, name:$name) { databaseId isPrivate " +
              field +
              "(first:$first, after:$after, states:[" +
              states +
              "], orderBy:{field:CREATED_AT,direction:ASC}) {" +
              " nodes { id number url } pageInfo { hasNextPage endCursor } } } }",
            variables: { owner, name },
            first: 100,
            maxPages,
            refresh: true,
            assertAuthorized,
            select(data) {
              assertAuthorized();
              const nativeRepository = data?.repository;
              if (
                nativeRepository === null ||
                typeof nativeRepository !== "object" ||
                Array.isArray(nativeRepository) ||
                nativeRepository.databaseId !== repository.id ||
                nativeRepository.isPrivate !== false
              )
                throw new Error("project_curation_scope_unverified");
              const connection = nativeRepository[field];
              if (
                connection === null ||
                typeof connection !== "object" ||
                Array.isArray(connection) ||
                !Array.isArray(connection.nodes) ||
                connection.nodes.length > 100
              )
                throw new Error("project_curation_subject_identity_unverified");
              return {
                nodes: connection.nodes.map((subject) => {
                  if (
                    subject === null ||
                    typeof subject !== "object" ||
                    Array.isArray(subject) ||
                    typeof subject.id !== "string" ||
                    !/^[A-Za-z0-9_=.:-]{1,128}$/.test(subject.id) ||
                    !Number.isSafeInteger(subject.number) ||
                    subject.number < 1 ||
                    subject.url !==
                      "https://github.com/" +
                        repository.slug +
                        "/" +
                        (kind === "pull_request" ? "pull/" : "issues/") +
                        subject.number
                  )
                    throw new Error("project_curation_subject_identity_unverified");
                  return {
                    node_id: subject.id,
                    number: subject.number,
                    html_url: subject.url,
                    pull_request: kind === "pull_request",
                  };
                }),
                pageInfo: connection.pageInfo,
              };
            },
          });
          if (!Array.isArray(inventory) || subjects.length + inventory.length > 10000)
            throw new Error("source_dataset_budget_exceeded");
          subjects.push(...inventory);
        }
        if (subjects.length > 10000) throw new Error("source_dataset_budget_exceeded");
        const seenNumbers = new Set();
        const seenSubjects = new Set();
        const seenEvents = new Set();
        values = [];
        for (const subject of subjects) {
          if (
            subject === null ||
            typeof subject !== "object" ||
            Array.isArray(subject) ||
            !Number.isSafeInteger(subject.number) ||
            subject.number < 1 ||
            typeof subject.node_id !== "string" ||
            !/^[A-Za-z0-9_=.:\-]{1,128}$/.test(subject.node_id) ||
            typeof subject.pull_request !== "boolean" ||
            subject.html_url !==
              "https://github.com/" +
                repository.slug +
                "/" +
                (subject.pull_request ? "pull/" : "issues/") +
                subject.number ||
            seenNumbers.has(subject.number) ||
            seenSubjects.has(subject.node_id)
          )
            throw new Error("project_curation_subject_identity_unverified");
          seenNumbers.add(subject.number);
          seenSubjects.add(subject.node_id);
          const records = await readProjectCurationHistory({
            client,
            source: sourceId,
            repository,
            number: subject.number,
            subjectType: subject.pull_request ? "pull_request" : "issue",
            subjectId: subject.node_id,
            scanId: request.runId,
            maxPages,
            assertAuthorized,
          });
          for (const record of records) {
            if (seenEvents.has(record.event.id)) throw new Error("project_curation_event_identity_ambiguous");
            seenEvents.add(record.event.id);
            if (seenEvents.size > 10000) throw new Error("source_dataset_budget_exceeded");
            // A full audit is an observation, not proof of complete history.
            // Its retained events still obey the fixed source-time cutoff.
            if (record.event.createdAt > request.until) continue;
            values.push({
              node_id: record.event.id,
              history_subject_id: record.subject.id,
              project_curation_project_id: record.event.project.id,
              curation_action: record.event.__typename,
              curation_automated: record.event.wasAutomated,
              html_url: record.subject.url,
              source_revision: projectCurationHistoryRevision(record),
              created_at: record.event.createdAt,
              actor: record.event.actor,
            });
          }
        }
      } else if (request.family === "project_current") {
        const allowedProjectIds = repository.allowedProjectIds ?? [];
        if (!Array.isArray(allowedProjectIds) || !allowedProjectIds.length)
          throw new Error("approved_project_scope_required");
        if (!client.scanGraphql) throw new Error("project_source_unavailable");
        const subjects = await scan("project-subjects", routes.issues);
        if (subjects.length > 10000) throw new Error("source_dataset_budget_exceeded");
        if (offset > subjects.length) throw new Error("invalid_source_cursor");
        projectSubjectCount = subjects.length;
        values = [];
        const subjectIds = new Set();
        for (const subject of subjects) {
          if (typeof subject.node_id !== "string" || subjectIds.has(subject.node_id))
            throw new Error("project_subject_identity_unverified");
          subjectIds.add(subject.node_id);
        }
        // Keep the complete subject inventory/count, but hydrate each subject
        // only on its output page. Repeated output pages must not rescan all items.
        for (const subject of subjects.slice(offset, offset + request.limit)) {
          const snapshot = await readPublicSubjectProjectSnapshot({
            client,
            source: sourceId,
            repository,
            subjectId: subject.node_id,
            sourceUrl: subject.html_url,
            allowedProjectIds,
            scanId: request.runId,
            maxPages,
            assertAuthorized,
          });
          // A subject with no current membership is still a complete observation.
          // One native issue/PR produces one row regardless of its Project count.
          values.push({
            node_id: snapshot.subjectId,
            project_subject_id: snapshot.subjectId,
            html_url: snapshot.sourceUrl,
            source_revision: projectSubjectSnapshotRevision(snapshot),
          });
        }
      } else if (request.family === "discussions") {
        if (!client.scanGraphql) throw new Error("discussions_source_unavailable");
        const [owner, name] = repository.slug.split("/");
        const feedback = discussionFeedback?.authority.current(repository.id) ?? null;
        if (feedback) {
          const authorizeFeedback = () => {
            assertAuthorized();
            if (discussionFeedback.authority.current(repository.id)?.authorityHash !== feedback.authorityHash)
              throw new Error("discussion_feedback_authority_changed");
          };
          authorizeFeedback();
          const start = await discussionFeedback.store.begin(request, feedback);
          authorizeFeedback();
          let observations = start.completed;
          if (!observations) {
            const descriptors = await client.scanGraphql({
              source: sourceId,
              key: `pipeline:${repository.id}:${request.runId}:${discussionFeedbackContentVersion}`,
              first: discussionFeedbackLimits.pageSize,
              query: `query($owner:String!, $name:String!, $first:Int!, $after:String) {
                repository(owner:$owner, name:$name) {
                  databaseId isPrivate hasDiscussionsEnabled
                  discussions(first:$first, after:$after, orderBy:{field:CREATED_AT,direction:ASC}) {
                    nodes { id url title body updatedAt createdAt lastEditedAt answerChosenAt
                      author { __typename login ... on User { id databaseId } ... on Bot { id databaseId } }
                      answerChosenBy { __typename login ... on User { id databaseId } ... on Bot { id databaseId } }
                      answer { id isAnswer body createdAt updatedAt lastEditedAt deletedAt isMinimized
                        author { __typename login ... on User { id databaseId } ... on Bot { id databaseId } }
                      }
                    }
                    pageInfo { hasNextPage endCursor }
                  }
                }
              }`,
              variables: { owner, name },
              maxPages,
              assertAuthorized: authorizeFeedback,
              select(data) {
                authorizeFeedback();
                const repo = data?.repository;
                if (
                  repo?.databaseId !== repository.id ||
                  repo.isPrivate !== false ||
                  repo.hasDiscussionsEnabled !== true
                )
                  throw new Error("discussion_feedback_public_scope_unverified");
                if (
                  !Array.isArray(repo.discussions?.nodes) ||
                  repo.discussions.nodes.length > discussionFeedbackLimits.pageSize
                )
                  throw new Error("discussion_feedback_page_unverified");
                // select runs before GithubReadClient writes its first checkpoint.
                const nodes = repo.discussions.nodes.map((node) =>
                  minimizeDiscussionFeedback(node, repository, githubDiscussionRevision(node)),
                );
                authorizeFeedback();
                return { nodes, pageInfo: repo.discussions.pageInfo };
              },
            });
            authorizeFeedback();
            observations = await discussionFeedback.store.complete(start, descriptors);
          }
          authorizeFeedback();
          values = observations.map((metadata) => ({ discussion_feedback: metadata }));
        } else {
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
                  answer { id isAnswer createdAt author { __typename ... on User { id databaseId } ... on Bot { id databaseId } } }
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
        }
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
      } else if (expandedComments) {
        const conversations = await scan("comments", window ? recentRoute(route, window) : route);
        if (conversations.length > 10000) throw new Error("source_dataset_budget_exceeded");
        for (const value of conversations)
          if (
            typeof value?.html_url === "string" &&
            value.html_url.includes("/pull/") &&
            readGithubCommentIdentity(repository.slug, value)?.kind !== "pull_request_conversation_comment"
          )
            throw new Error("source_comment_identity_unverified");
        const inlineRoute = "pulls/comments?per_page=100";
        const inline = await scan(
          "comments:pull-request-review/v1",
          window ? recentRoute(inlineRoute, window) : inlineRoute,
        );
        for (const value of inline)
          if (readGithubCommentIdentity(repository.slug, value)?.kind !== "pull_request_review_comment")
            throw new Error("source_comment_identity_unverified");
        values = [...conversations, ...inline];
      } else {
        values = await scan(request.family, window ? recentRoute(route, window) : route, (body) =>
          request.family === "issues" ? body.filter((item) => !item.pull_request) : body,
        );
      }
      if (isGithubRestSnapshotFamily(request.family)) {
        const seen = new Set();
        for (const value of values) {
          const subjectId = sourceSubjectId(value);
          if (typeof subjectId !== "string") throw new Error("source_identity_or_revision_unverified");
          // Reordered provider pages can repeat an object at another revision
          // while omitting a different object. Revisions are not inventory IDs.
          if (seen.has(subjectId)) throw new Error("source_inventory_identity_ambiguous");
          seen.add(subjectId);
        }
      }
      if (request.family === "timelines")
        values = values.map((value) => ({
          ...value,
          node_id: Number.isSafeInteger(value.id) && value.id > 0 ? String(value.id) : null,
          html_url: value.issue?.html_url,
        }));
      if (window) {
        const history = ["project_history", "relationships"].includes(request.family);
        values = values.filter((value) => {
          const timestamp = at(history ? value.created_at : value.updated_at);
          if (timestamp === null) throw new Error("source_window_timestamp_unverified");
          // Current objects have no historical as-of representation. Retain an
          // observation newer than the event cutoff; never turn it into a past
          // transition or silently drop it as proof of complete source coverage.
          return timestamp >= window.since && (!history || timestamp <= window.until);
        });
      }
      assertAuthorized();
      if (values.length > 10000) throw new Error("source_dataset_budget_exceeded");
      let curationDigest = null;
      if (request.family === "project_curation_history") {
        // Native pages are refreshed, so an output offset must also bind the
        // complete minimized observation. A new/removed/changed operation
        // requires a fresh full run rather than shifting the saved page.
        values.sort((left, right) => (left.node_id < right.node_id ? -1 : left.node_id > right.node_id ? 1 : 0));
        curationDigest = createHash("sha256")
          .update(
            JSON.stringify([
              "project-curation-output/v1",
              repository.id,
              request.runId,
              request.until,
              values.map((value) => [
                value.history_subject_id,
                value.project_curation_project_id,
                value.node_id,
                value.curation_action,
                value.source_revision,
                value.actor,
                value.created_at,
                value.curation_automated,
              ]),
            ]),
          )
          .digest("hex");
        if (curationCursor && curationCursor[1] !== curationDigest)
          throw new Error("source_project_curation_cursor_changed");
      }
      const expectedCount = projectSubjectCount ?? values.length;
      if (offset > expectedCount) throw new Error("invalid_source_cursor");
      const selected = projectSubjectCount === null ? values.slice(offset, offset + request.limit) : values;
      const facts = selected.map((value) => {
        if (request.family === "discussions" && value.discussion_feedback !== undefined)
          return {
            subjectId: value.discussion_feedback.descriptor.discussionId,
            sourceRevision: discussionFeedbackRevision(value.discussion_feedback),
            sourceUrl: value.discussion_feedback.descriptor.threadUrl,
            evidence: "current_state",
            actorId: null,
            occurredAt: null,
            state: "present",
            discussionFeedback: value.discussion_feedback,
          };
        if (request.family === "content_edits")
          return {
            subjectId: (value.version === "github-comment-edit-metadata/v1" ? value.target : value.parent).id,
            sourceRevision:
              value.version === "github-comment-edit-metadata/v1"
                ? githubCommentEditRevision(value, request.runId)
                : githubContentEditRevision(value, request.runId),
            sourceUrl: (value.version === "github-comment-edit-metadata/v1" ? value.target : value.parent).url,
            evidence: "current_state",
            actorId: null,
            occurredAt: null,
            state: "present",
            contentEditMetadata: value,
          };
        const subjectId = sourceSubjectId(value);
        const nativeRevision =
          value.sha ?? at(value.updated_at) ?? at(value.submitted_at) ?? at(value.published_at) ?? at(value.created_at);
        const revision = [
          "project_history",
          "project_curation_history",
          "relationships",
          "issue_field_history",
        ].includes(request.family)
          ? value.source_revision
          : request.family === "timelines"
            ? githubTimelineRevision(value)
            : request.family === "reviews"
              ? githubSnapshotRevision(githubReviewRevision(value), request.runId)
              : ["discussions", "project_current"].includes(request.family)
                ? githubSnapshotRevision(value.source_revision, request.runId)
                : restSnapshots && isGithubRestSnapshotFamily(request.family) && nativeRevision
                  ? githubRestSnapshotRevision(request.family, value, request.runId)
                  : nativeRevision;
        if (
          typeof subjectId !== "string" ||
          !revision ||
          typeof value.html_url !== "string" ||
          !value.html_url.startsWith(`https://github.com/${repository.slug}/`)
        )
          throw new Error("source_identity_or_revision_unverified");
        return {
          subjectId,
          ...(["project_history", "project_curation_history", "issue_field_history"].includes(request.family)
            ? { historySubjectId: value.history_subject_id }
            : {}),
          ...(request.family === "project_curation_history"
            ? { projectCurationProjectId: value.project_curation_project_id }
            : {}),
          ...(request.family === "issue_field_history" ? { issueFieldId: value.issue_field_id } : {}),
          ...(request.family === "project_current" ? { projectSubjectId: value.project_subject_id } : {}),
          sourceRevision: revision,
          sourceUrl: value.html_url,
          evidence: [
            "timelines",
            "project_history",
            "project_curation_history",
            "relationships",
            "issue_field_history",
          ].includes(request.family)
            ? "observed_transition"
            : "current_state",
          actorId:
            [
              "timelines",
              "project_history",
              "project_curation_history",
              "relationships",
              "issue_field_history",
            ].includes(request.family) &&
            Number.isSafeInteger(value.actor?.databaseId ?? value.actor?.id) &&
            (value.actor?.databaseId ?? value.actor?.id) > 0
              ? String(value.actor.databaseId ?? value.actor.id)
              : null,
          occurredAt: [
            "timelines",
            "project_history",
            "project_curation_history",
            "relationships",
            "issue_field_history",
          ].includes(request.family)
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
      if (request.family === "pull_requests" && decisionRepositories.includes(repository.id)) {
        let bytes = 0;
        // The complete REST inventory has already selected this outer page.
        // Only its PRs receive one fresh native decision-history observation.
        for (let index = 0; index < facts.length; index++) {
          assertAuthorized();
          facts[index].pullRequestDecisionHistory = await captureDecisionObservation({
            client: readClient,
            source: sourceId,
            repository,
            request,
            fact: facts[index],
            payload: selected[index],
            now: decisionHistoryNow,
            assertAuthorized,
          });
          assertAuthorized();
          bytes += Buffer.byteLength(JSON.stringify(facts[index]));
          if (bytes > 8_000_000) throw new Error("decision_history_page_budget_exceeded");
        }
      }
      const next = offset + facts.length;
      return {
        repositoryId: repository.id,
        visibility: "public",
        isSynthetic,
        facts,
        nextCursor:
          next < expectedCount ? (curationDigest === null ? String(next) : curationDigest + ":" + next) : null,
        // Native field visibility can omit events. Content parent counts do not
        // establish how many historical edits GitHub has retained or redacted.
        expectedCount: ["issue_field_history", "project_curation_history", "content_edits"].includes(request.family)
          ? null
          : expectedCount,
      };
    },
  };
  return {
    probeRepository,
    async readPage(request) {
      // A caller may reuse its request while a source read is awaiting I/O.
      // Keep this invocation's scope, paging and checkpoint identity together.
      const captured = {
        repositoryId: request.repositoryId,
        runId: request.runId,
        family: request.family,
        cursor: request.cursor,
        limit: request.limit,
        mode: request.mode,
        since: request.since,
        until: request.until,
      };
      let issueFieldWindow = null;
      if (captured.family === "issue_field_history") {
        const since = captured.since;
        const from = since === null ? null : at(since);
        const until = at(captured.until);
        if (until === null || (since !== null && from === null) || (from !== null && from >= until))
          throw new Error("invalid_issue_field_window");
        // Reserved plans still validate the original canonical fields. Native
        // direct reads compare normalized instants without rewriting that proof.
        issueFieldWindow = { since: from, until };
      }
      try {
        return await adapter.readPage(captured, issueFieldWindow);
      } catch (error) {
        const repository = approved.get(captured.repositoryId);
        if (repository && isProjectSourceScopeFailure(error, captured.family))
          await onUnavailable?.(repository, "project_scope_unavailable");
        if (repository && isIssueFieldSourceScopeFailure(error, captured.family))
          await onUnavailable?.(repository, "issue_field_scope_unavailable");
        throw error;
      }
    },
  };
}
