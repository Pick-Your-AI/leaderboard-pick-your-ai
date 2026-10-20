import { z } from "zod";

export const githubPullRequestMergeTargetVersion = "github-pr-merge-target/v1" as const;
export const pullRequestMergeTargetVersion = "pr-merge-target/v1" as const;
export const pullRequestMergeTargetMetricIds = ["pr_merged", "maintainer_merges", "pr_coauthored"] as const;

export function supportsPullRequestMergeTarget(metricId: string): boolean {
  return (pullRequestMergeTargetMetricIds as readonly string[]).includes(metricId);
}

/** A literal short branch name, bounded to 255 UTF-8 bytes; never a current-ref lookup or an unknown sentinel. */
export function isPullRequestMergeTargetBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    !/[\uD800-\uDFFF]/u.test(value) &&
    new TextEncoder().encode(value).length <= 255 &&
    value !== "@" &&
    value !== "HEAD" &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !/[\x00-\x20\x7f-\x9f~^:?*\[\\]/.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.includes("//") &&
    value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

const branch = z.string().refine(isPullRequestMergeTargetBranch, "Invalid pull-request merge-target branch");
const nodeId = z.string().regex(/^[A-Za-z0-9_+=/\-]{1,256}$/);
const databaseId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const repositoryId = z
  .string()
  .regex(/^[1-9]\d{0,15}$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const instant = z
  .string()
  .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  .refine((value) => {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
  }, "Expected a normalized UTC instant");
const sourceRevision = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim() && !/[\x00-\x1f\x7f-\x9f]/.test(value));
const slug = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/)
  .refine((value) => ![".", ".."].includes(value.split("/")[1]!));

export const githubPullRequestMergeTargetUnknownReasons = [
  "merge_event_missing",
  "merge_event_ambiguous",
  "merge_event_branch_missing",
  "merge_event_unverified",
  "merge_event_time_mismatch",
  "merge_event_commit_mismatch",
  "merge_event_incomplete",
] as const;

const captureFields = {
  schemaVersion: z.literal(githubPullRequestMergeTargetVersion),
  repository: z.object({ id: databaseId, slug }).strict(),
  pullRequest: z.object({ id: nodeId, number: databaseId, url: z.string().max(512) }).strict(),
  sourceRevision,
  observedAt: instant,
  mergedAt: instant,
  status: z.enum(["known", "unknown"]),
  event: z
    .object({ id: nodeId, createdAt: instant, mergeRefName: branch.nullable(), commitOid: commit.nullable() })
    .strict()
    .nullable(),
  reason: z.enum(githubPullRequestMergeTargetUnknownReasons).nullable(),
};

type CaptureFields = z.infer<z.ZodObject<typeof captureFields>>;
function checkCapture(capture: CaptureFields, context: z.RefinementCtx): void {
  const problem = (message: string) => context.addIssue({ code: "custom", message });
  if (capture.pullRequest.url !== `https://github.com/${capture.repository.slug}/pull/${capture.pullRequest.number}`)
    problem("Merge-target proof must name the exact public GitHub pull request");
  if (capture.mergedAt > capture.observedAt || (capture.event && capture.event.createdAt > capture.observedAt))
    problem("Merge-target proof cannot precede its source event");
  if (capture.status === "known") {
    if (
      capture.reason !== null ||
      !capture.event ||
      capture.event.mergeRefName === null ||
      capture.event.commitOid === null ||
      capture.event.createdAt !== capture.mergedAt
    )
      problem("Known merge-target proof requires a matching historical merged event and branch name");
  } else if (capture.reason === null) problem("Unknown merge-target proof requires an explicit reason");
}

const captureInputSchema = z.object(captureFields).strict().superRefine(checkCapture);
const captureSchema = z
  .object({ ...captureFields, proofHash: hash })
  .strict()
  .superRefine(checkCapture);
const factSchema = z
  .object({
    schemaVersion: z.literal(pullRequestMergeTargetVersion),
    repositoryId,
    pullRequestId: nodeId,
    eventId: nodeId,
    mergedAt: instant,
    branch,
    proofHash: hash,
  })
  .strict();

export type GithubPullRequestMergeTargetCaptureInput = z.infer<typeof captureInputSchema>;
export type GithubPullRequestMergeTargetCapture = z.infer<typeof captureSchema>;
export type PrMergeTarget = z.infer<typeof factSchema>;

/** Structural admission only. Source authority and digest verification are separate. */
export function validateGithubPullRequestMergeTargetCaptureInput(
  input: unknown,
): GithubPullRequestMergeTargetCaptureInput {
  return captureInputSchema.parse(input);
}

/** Structural admission only; callers accepting retained bytes must also verify the digest. */
export function validateGithubPullRequestMergeTargetCapture(input: unknown): GithubPullRequestMergeTargetCapture {
  return captureSchema.parse(input);
}

/** The normalizer binds this private projection to its verified source capture. */
export function validatePullRequestMergeTarget(input: unknown): PrMergeTarget {
  return factSchema.parse(input);
}

// The strict capture schema contains only records and scalar values, with no arrays.
function canonicalJson(value: unknown): string {
  if (value !== null && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(fields[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Version-prefixed, sorted-key JSON of the strict input; proofHash is not part of its own digest. */
export function encodeGithubPullRequestMergeTargetCapture(input: unknown): Uint8Array<ArrayBuffer> {
  const capture = validateGithubPullRequestMergeTargetCaptureInput(input);
  return new TextEncoder().encode(`${githubPullRequestMergeTargetVersion}\n${canonicalJson(capture)}`);
}

export async function githubPullRequestMergeTargetHash(input: unknown): Promise<string> {
  // Validate and detach before yielding so mutation cannot change the hashed source.
  const bytes = encodeGithubPullRequestMergeTargetCapture(input);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("SHA-256 requires Web Crypto SubtleCrypto.");
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyGithubPullRequestMergeTargetCapture(
  input: unknown,
): Promise<GithubPullRequestMergeTargetCapture> {
  const capture = validateGithubPullRequestMergeTargetCapture(input);
  const { proofHash, ...body } = capture;
  if ((await githubPullRequestMergeTargetHash(body)) !== proofHash)
    throw new Error("Invalid pull-request merge-target proof hash");
  return capture;
}
