import {
  githubPullRequestMergeTargetHash,
  validateGithubPullRequestMergeTargetCapture,
  validateGithubPullRequestMergeTargetCaptureInput,
  type GithubPullRequestMergeTargetCapture,
  type GithubPullRequestMergeTargetCaptureInput,
} from "@pick-your-ai/contracts";
import type { GithubReadClient } from "./client.js";

export {
  githubPullRequestMergeTargetHash,
  validateGithubPullRequestMergeTargetCapture,
  validateGithubPullRequestMergeTargetCaptureInput,
  verifyGithubPullRequestMergeTargetCapture,
} from "@pick-your-ai/contracts";
export type { GithubPullRequestMergeTargetCapture } from "@pick-your-ai/contracts";

/** Independent of current REST base.ref and of default-branch delivery authority. */
export const pullRequestMergeTargetNormalizationVersion = "pr-merge-target-normalization/v1";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const nodeId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_+=/\-]{1,256}$/.test(value);
const oid = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const text = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
export function pullRequestMergeTargetSourceInstant(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ||
    value.startsWith("0000-")
  )
    return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19)
    ? date.toISOString()
    : null;
}
const instant = pullRequestMergeTargetSourceInstant;

type CaptureBody = GithubPullRequestMergeTargetCaptureInput;
type Event = NonNullable<CaptureBody["event"]>;
type Reason = Exclude<CaptureBody["reason"], null>;

export interface PullRequestMergeTargetOptions {
  client: GithubReadClient;
  source: string;
  repository: { id: number; slug: string };
  pullRequest: { id: string; number: number; url: string };
  sourceRevision: string;
  mergedAt: string;
  observedAt: string;
  /** Native selected PR merge SHA when it exists; null never invents a commit. */
  expectedCommitOid?: string | null;
  scanId: string;
  assertAuthorized: () => void;
  maxPages?: number;
}

/**
 * Retains a minimized, repository-bound native merge event. It is a protected
 * collector product, not a cryptographic attestation or a current access grant.
 * The caller owns its actual observation clock and frozen-input lifecycle.
 */
export async function readPullRequestMergeTarget(
  options: PullRequestMergeTargetOptions,
): Promise<GithubPullRequestMergeTargetCapture> {
  // Copy all request values before token preparation, pagination or callbacks.
  const repository = { id: options.repository.id, slug: options.repository.slug };
  const pullRequest = {
    id: options.pullRequest.id,
    number: options.pullRequest.number,
    url: options.pullRequest.url,
  };
  const { source, sourceRevision, mergedAt, observedAt, scanId, assertAuthorized } = options;
  const expectedCommitOid = options.expectedCommitOid ?? null;
  const maxPages = options.maxPages ?? 10;
  if (
    !positive(repository.id) ||
    !/^[A-Za-z0-9-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository.slug) ||
    [".", ".."].includes(repository.slug.split("/")[1]!) ||
    !nodeId(pullRequest.id) ||
    !positive(pullRequest.number) ||
    pullRequest.url !== `https://github.com/${repository.slug}/pull/${pullRequest.number}` ||
    !text(source, 256) ||
    !text(sourceRevision, 512) ||
    !text(scanId, 512) ||
    instant(mergedAt) !== mergedAt ||
    instant(observedAt) !== observedAt ||
    Date.parse(observedAt) < Date.parse(mergedAt) ||
    (expectedCommitOid !== null && !oid(expectedCommitOid)) ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 100 ||
    typeof assertAuthorized !== "function"
  )
    throw new Error("invalid_pull_request_merge_target_request");
  const client = options.client.forRepository(repository.id);
  const base = {
    schemaVersion: "github-pr-merge-target/v1" as const,
    repository,
    pullRequest,
    sourceRevision,
    mergedAt,
    observedAt,
  };
  const unknown = (reason: Reason, event: Event | null = null): CaptureBody =>
    validateGithubPullRequestMergeTargetCaptureInput({ ...base, status: "unknown", event, reason });
  const finish = async (body: CaptureBody) => {
    const detached = validateGithubPullRequestMergeTargetCaptureInput(body);
    const proofHash = await githubPullRequestMergeTargetHash(detached);
    assertAuthorized();
    return validateGithubPullRequestMergeTargetCapture({ ...detached, proofHash });
  };
  const matchesRepository = (value: unknown) =>
    object(value) &&
    value.databaseId === repository.id &&
    value.isPrivate === false &&
    value.nameWithOwner === repository.slug;
  const matchesPullRequest = (value: unknown) =>
    object(value) &&
    value.id === pullRequest.id &&
    value.number === pullRequest.number &&
    value.url === pullRequest.url &&
    matchesRepository(value.repository);
  function eventBody(raw: unknown, parentCommitOid: string | null): CaptureBody {
    if (
      !object(raw) ||
      raw.__typename !== "MergedEvent" ||
      !nodeId(raw.id) ||
      !matchesPullRequest(raw.pullRequest) ||
      instant(raw.createdAt) === null ||
      !(raw.commit === null || (object(raw.commit) && oid(raw.commit.oid)))
    )
      return unknown("merge_event_unverified");
    const event = {
      id: raw.id,
      createdAt: instant(raw.createdAt)!,
      mergeRefName: typeof raw.mergeRefName === "string" ? raw.mergeRefName : null,
      commitOid: object(raw.commit) ? (raw.commit.oid as string) : null,
    };
    const reason =
      raw.mergeRefName === null || raw.mergeRefName === undefined
        ? "merge_event_branch_missing"
        : typeof raw.mergeRefName !== "string"
          ? "merge_event_unverified"
          : event.createdAt !== mergedAt
            ? "merge_event_time_mismatch"
            : event.commitOid === null || parentCommitOid === null
              ? "merge_event_unverified"
              : [expectedCommitOid, parentCommitOid].some((value) => value !== null && value !== event.commitOid)
                ? "merge_event_commit_mismatch"
                : null;
    try {
      return validateGithubPullRequestMergeTargetCaptureInput({
        ...base,
        status: reason === null ? "known" : "unknown",
        event,
        reason,
      });
    } catch {
      // Malformed provider values are not retained as arbitrary source text.
      return unknown("merge_event_unverified");
    }
  }
  assertAuthorized();
  const [owner, name] = repository.slug.split("/");
  let records: CaptureBody[];
  try {
    records = await client.scanGraphql<CaptureBody>({
      source,
      key: JSON.stringify([
        pullRequestMergeTargetNormalizationVersion,
        repository,
        pullRequest,
        sourceRevision,
        mergedAt,
        expectedCommitOid,
        observedAt,
        scanId,
      ]),
      query: `query PullRequestMergeTarget($owner:String!, $name:String!, $number:Int!, $first:Int!, $after:String) {
        repository(owner:$owner, name:$name) { databaseId isPrivate nameWithOwner
          pullRequest(number:$number) { id number url merged mergedAt mergeCommit { oid }
            timelineItems(first:$first, after:$after, itemTypes:[MERGED_EVENT]) {
              nodes { __typename ... on MergedEvent { id createdAt mergeRefName commit { oid }
                pullRequest { id number url repository { databaseId isPrivate nameWithOwner } }
              } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      variables: { owner, name, number: pullRequest.number },
      first: 100,
      maxPages,
      assertAuthorized,
      select(data) {
        const repo = object(data) ? data.repository : null;
        const item = object(repo) ? repo.pullRequest : null;
        if (
          !matchesRepository(repo) ||
          !object(item) ||
          item.id !== pullRequest.id ||
          item.number !== pullRequest.number ||
          item.url !== pullRequest.url ||
          item.merged !== true ||
          instant(item.mergedAt) !== mergedAt ||
          !(item.mergeCommit === null || (object(item.mergeCommit) && oid(item.mergeCommit.oid))) ||
          !object(item.timelineItems) ||
          !Array.isArray(item.timelineItems.nodes) ||
          item.timelineItems.nodes.length > 100 ||
          !object(item.timelineItems.pageInfo)
        )
          throw new Error("pull_request_merge_target_source_unverified");
        const parentCommitOid = object(item.mergeCommit) ? (item.mergeCommit.oid as string) : null;
        if (expectedCommitOid !== null && parentCommitOid !== null && expectedCommitOid !== parentCommitOid)
          throw new Error("pull_request_merge_target_selected_commit_changed");
        return {
          nodes: Array.from(item.timelineItems.nodes, (event) => eventBody(event, parentCommitOid)),
          pageInfo: item.timelineItems.pageInfo as { hasNextPage: boolean; endCursor: string | null },
        };
      },
    });
  } catch (error) {
    assertAuthorized();
    if (
      error instanceof Error &&
      [
        "Source pagination exceeded maxPages; checkpoint retained",
        "Source pagination repeated a page; checkpoint retained",
      ].includes(error.message)
    )
      return finish(unknown("merge_event_incomplete"));
    // Authentication, permission, quota, transport and durable-storage failures
    // keep their existing host failure semantics; they are never empty evidence.
    throw error;
  }
  assertAuthorized();
  // Completed checkpoints bypass select. Revalidate every retained binding.
  const retained = Array.from(records, (value) => {
    const record = validateGithubPullRequestMergeTargetCaptureInput(value);
    if (
      record.repository.id !== repository.id ||
      record.repository.slug !== repository.slug ||
      record.pullRequest.id !== pullRequest.id ||
      record.pullRequest.number !== pullRequest.number ||
      record.pullRequest.url !== pullRequest.url ||
      record.sourceRevision !== sourceRevision ||
      record.observedAt !== observedAt ||
      record.mergedAt !== mergedAt ||
      (record.status === "known" && expectedCommitOid !== null && record.event?.commitOid !== expectedCommitOid)
    )
      throw new Error("pull_request_merge_target_checkpoint_binding_mismatch");
    return record;
  });
  if (retained.length === 0) return finish(unknown("merge_event_missing"));
  if (retained.length > 1) return finish(unknown("merge_event_ambiguous"));
  return finish(retained[0]!);
}
