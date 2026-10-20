import { z } from "zod";
import { publicArtifactIdSchema } from "./artifact-identity.js";
import { achievementProofSchema } from "./v1/achievements.js";
import { compareSourceInstants } from "./v1/source-time.js";
import { sourceEventSchema } from "./v1/schemas.js";

export const workstreamHelpVersion = "reviewed-cross-workstream-help/v1";
export const workstreamHelpStatementVersion = "cross-workstream-help-statement/v1";
export const workstreamHelpMeaning =
  "Explicitly reviewed help between two named workstreams, supported by an accepted authored merge in this selection. This is not a complete collaboration history, a first-ever claim or a ranking.";
export const workstreamHelpLimits = Object.freeze({ records: 1000, statementBytes: 8192, responseBytes: 1_500_000 });
export const workstreamHelpMetricIds = Object.freeze(["maintenance", "automation", "documentation", "tests"] as const);
const identifier = z.string().min(1).max(200).refine(
  (value) => value !== "." && value !== ".." && !/[^A-Za-z0-9_.:-]/.test(value),
);
const hash = z.string().regex(/^[a-f0-9]{64}$/).refine((value) => value.length === 64);
const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).refine((value) => !/[^a-f0-9]/.test(value));
const time = sourceEventSchema.shape.occurredAt.unwrap();
const workstream = z.object({
  id: identifier,
  label: z.string().min(1).max(200).refine(
    (value) => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value),
  ),
}).strict();

function githubPath(value: string): string[] | null {
  try {
    if (value.length > 2048 || /[%\\?#\u0000-\u0020\u007f]/.test(value)) return null;
    const url = new URL(value);
    const parts = url.pathname.slice(1).split("/");
    return url.origin === "https://github.com" && !url.username && !url.password && !url.port &&
      !url.search && !url.hash && url.href === value &&
      parts.every((part) => /^[A-Za-z0-9_.~-]+$/.test(part) && part !== "." && part !== "..")
      ? parts : null;
  } catch { return null; }
}
const pullUrl = z.string().max(2048).refine((value) => {
  const parts = githubPath(value);
  return parts?.length === 4 && parts[2] === "pull" && /^[1-9][0-9]*$/.test(parts[3]!);
});
const blobUrl = z.string().max(2048).refine((value) => {
  const parts = githubPath(value);
  return parts !== null && parts.length >= 5 && parts[2] === "blob" && revision.safeParse(parts[3]).success;
});

/** The canonical public statement is factual evidence only after protected host review.
 * Current Project membership, metric categories and caller-provided approval flags cannot supply it.
 */
export const workstreamHelpStatementSchema = z.object({
  schemaVersion: z.literal(workstreamHelpStatementVersion),
  organization: identifier,
  definitionVersion: identifier,
  from: workstream,
  to: workstream,
  actorId: identifier,
  repositoryId: identifier,
  artifactId: publicArtifactIdSchema,
  sourceUrl: pullUrl,
  sourceRevision: identifier,
  occurredAt: time,
  role: z.literal("author"),
  helpKind: z.literal("authored_merged_change"),
}).strict().superRefine((value, ctx) => {
  if (value.from.id === value.to.id)
    ctx.addIssue({ code: "custom", message: "Cross-workstream help requires two distinct workstream identities" });
});
export type WorkstreamHelpStatement = z.infer<typeof workstreamHelpStatementSchema>;

/** Exact UTF-8 file representation. Canonical encoding also rejects duplicate JSON keys on intake. */
export function encodeWorkstreamHelpStatement(value: unknown): string {
  return JSON.stringify(workstreamHelpStatementSchema.parse(value)) + "\n";
}
export function parseWorkstreamHelpStatement(text: string): WorkstreamHelpStatement {
  if (typeof text !== "string" || text.length > workstreamHelpLimits.statementBytes ||
      new TextEncoder().encode(text).length > workstreamHelpLimits.statementBytes)
    throw new TypeError("invalid_workstream_help_statement");
  const value = workstreamHelpStatementSchema.parse(JSON.parse(text));
  if (encodeWorkstreamHelpStatement(value) !== text) throw new TypeError("invalid_workstream_help_statement");
  return value;
}

/** Protected configuration only. Structural validity is not source or reviewer authorization. */
export const reviewedWorkstreamHelpBindingSchema = z.object({
  ruleVersion: z.literal(workstreamHelpVersion),
  organization: identifier,
  definitionVersion: identifier,
  workstreams: z.array(workstream).min(2).max(32).refine(
    (values) => new Set(values.map((entry) => entry.id)).size === values.length,
  ),
  records: z.array(z.object({
    requestId: identifier,
    requestVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    decisionId: identifier,
    factId: identifier,
    sourceAcceptance: z.object({
      requestId: identifier,
      requestVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      decisionId: identifier,
    }).strict(),
    validUntil: time,
    statement: z.object({
      revision,
      url: blobUrl,
      sha256: hash,
      content: z.string().max(workstreamHelpLimits.statementBytes),
    }).strict(),
  }).strict()).max(workstreamHelpLimits.records).refine(
    (values) => new Set(values.map((entry) => entry.requestId)).size === values.length,
  ),
}).strict();
export type ReviewedWorkstreamHelpBinding = z.infer<typeof reviewedWorkstreamHelpBindingSchema>;

/** Minimized output of the protected materializer, never a public submission format. */
export const publicWorkstreamHelpSchema = z.object({
  ruleVersion: z.literal(workstreamHelpVersion),
  contributionId: identifier,
  acceptedAt: time,
  reviewedAt: time,
  statement: workstreamHelpStatementSchema,
  statementRevision: revision,
  statementUrl: blobUrl,
  statementHash: hash,
}).strict().superRefine((value, ctx) => {
  const source = githubPath(value.statement.sourceUrl);
  const statement = githubPath(value.statementUrl);
  if (source === null || statement === null || source[0] !== statement[0] || source[1] !== statement[1] ||
      statement[3] !== value.statementRevision ||
      compareSourceInstants(value.statement.occurredAt, value.acceptedAt) > 0 ||
      compareSourceInstants(value.acceptedAt, value.reviewedAt) > 0)
    ctx.addIssue({ code: "custom", message: "Help statement must bind the exact public source revision and clock" });
});
export type PublicWorkstreamHelp = z.infer<typeof publicWorkstreamHelpSchema>;
export function workstreamHelpUnit(value: PublicWorkstreamHelp): string {
  const source = value.statement;
  return JSON.stringify([workstreamHelpVersion, source.organization, source.actorId, source.repositoryId,
    source.artifactId]);
}
export function workstreamHelpEvidenceKey(value: PublicWorkstreamHelp): string {
  return JSON.stringify([value.statement, value.statementRevision, value.statementUrl, value.statementHash]);
}

export const workstreamHelpRecognitionSchema = z.object({
  label: z.literal("Reviewed cross-workstream help"),
  help: publicWorkstreamHelpSchema,
  proof: achievementProofSchema,
}).strict().superRefine(({ help, proof }, ctx) => {
  const source = help.statement;
  if (help.contributionId !== proof.contributionId || source.actorId !== proof.actorId ||
      source.artifactId !== proof.artifactId || source.repositoryId !== proof.repositoryId ||
      source.sourceUrl !== proof.sourceUrl || source.occurredAt !== proof.occurredAt ||
      proof.artifactKind !== "pull_request" || proof.roles.length !== 1 || proof.roles[0] !== "author" ||
      proof.metricIds.length !== 1 || !workstreamHelpMetricIds.some((id) => id === proof.metricIds[0]))
    ctx.addIssue({ code: "custom", message: "Help recognition requires its exact accepted authored-merge proof" });
});
export type WorkstreamHelpRecognition = z.infer<typeof workstreamHelpRecognitionSchema>;

export const workstreamHelpPageSchema = z.object({
  ruleVersion: z.literal(workstreamHelpVersion),
  category: identifier.nullable(),
  meaning: z.literal(workstreamHelpMeaning),
  recognitions: z.array(workstreamHelpRecognitionSchema).max(100),
  totalRecognitions: z.number().int().min(0).max(workstreamHelpLimits.records),
  pageSize: z.number().int().min(1).max(100),
  nextCursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    .refine((value) => !/[^A-Za-z0-9_.-]/.test(value)).nullable(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.recognitions.map((entry) => workstreamHelpUnit(entry.help))).size !== value.recognitions.length ||
      value.recognitions.length > value.pageSize || value.recognitions.length > value.totalRecognitions ||
      (value.nextCursor !== null && (value.recognitions.length === 0 ||
        value.recognitions.length >= value.totalRecognitions)))
    ctx.addIssue({ code: "custom", message: "Invalid bounded workstream-help page" });
});
