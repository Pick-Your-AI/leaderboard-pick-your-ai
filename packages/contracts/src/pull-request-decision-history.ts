import { z } from "zod";
import { compareSourceInstants } from "./v1/source-time.js";

export const pullRequestDecisionHistoryVersion = "github-pr-decision-history/v1" as const;
export const pullRequestDecisionHistoryLimits = Object.freeze({ pages: 100, events: 10_000, bytes: 2_000_000 });
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().min(0).max(pullRequestDecisionHistoryLimits.events);
const id = z.string().regex(/^[A-Za-z0-9_=.:_-]{1,128}$/);
const token = z.string().regex(/^[A-Za-z0-9_=.:/-]{1,512}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** This native profile admits UTC instants without rounding their fractional precision. */
export const pullRequestDecisionInstantSchema = z
  .string()
  .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/)
  .refine((value) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
  });
const time = pullRequestDecisionInstantSchema;
const author = z
  .object({ id, databaseId: positive, kind: z.enum(["User", "Bot"]) })
  .strict()
  .nullable();
const repository = z
  .object({
    id: positive,
    slug: z
      .string()
      .max(201)
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .refine((value) => value.split("/").every((part) => part !== "." && part !== "..")),
  })
  .strict();
const subject = z.object({ id, databaseId: positive, url: z.string().max(512), createdAt: time, author }).strict();
export const pullRequestDecisionBindingSchema = z
  .object({ repository, pullNumber: positive, subject, source: token, semanticRevision: token })
  .strict()
  .superRefine((value, ctx) => {
    if (value.subject.url !== "https://github.com/" + value.repository.slug + "/pull/" + value.pullNumber)
      ctx.addIssue({ code: "custom", message: "PR URL must match the selected repository and number" });
  });
export const pullRequestDecisionGenerationSchema = z
  .object({ scanId: token, asOf: time, cutoffMode: z.literal("exclusive") })
  .strict();
const anchor = z
  .object({
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    updatedAt: time,
    closedAt: time.nullable(),
    mergedAt: time.nullable(),
    timelineUpdatedAt: time,
    totalCount: count,
  })
  .strict();
const eventBase = { id, subjectId: id, createdAt: time };
const event = z.discriminatedUnion("kind", [
  z.object({ ...eventBase, kind: z.literal("closed") }).strict(),
  z.object({ ...eventBase, kind: z.literal("reopened") }).strict(),
  z
    .object({
      ...eventBase,
      kind: z.literal("merged"),
      commitOid: z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .nullable(),
    })
    .strict(),
]);
const page = z
  .object({
    after: z.string().min(1).max(1024).nullable(),
    endCursor: z.string().min(1).max(1024).nullable(),
    hasNextPage: z.boolean(),
    count,
    filteredCount: count,
  })
  .strict();
export const pullRequestDecisionHistoryPayloadSchema = z
  .object({
    schemaVersion: z.literal(pullRequestDecisionHistoryVersion),
    binding: pullRequestDecisionBindingSchema,
    generation: pullRequestDecisionGenerationSchema,
    capture: z.object({ startedAt: time, completedAt: time, before: anchor, after: anchor }).strict(),
    history: z.array(event).max(pullRequestDecisionHistoryLimits.events),
    pagination: z
      .object({
        totalCount: count,
        consumedCount: count,
        terminal: z.literal(true),
        pages: z.array(page).min(1).max(pullRequestDecisionHistoryLimits.pages),
      })
      .strict(),
  })
  .strict();
export const pullRequestDecisionHistorySchema = pullRequestDecisionHistoryPayloadSchema
  .extend({ digest: hash })
  .strict();
export type PullRequestDecisionBinding = z.infer<typeof pullRequestDecisionBindingSchema>;
export type PullRequestDecisionGeneration = z.infer<typeof pullRequestDecisionGenerationSchema>;
export type PullRequestDecisionHistory = z.infer<typeof pullRequestDecisionHistorySchema>;
export type PullRequestDecisionHistoryPayload = z.infer<typeof pullRequestDecisionHistoryPayloadSchema>;
export type PullRequestDecisionEvent = PullRequestDecisionHistory["history"][number];

export const pullRequestDecisionUnavailableReasons = [
  "invalid_request",
  "subject_unavailable",
  "invalid_response",
  "history_changed",
  "history_incomplete",
  "history_ambiguous",
  "history_inconsistent",
  "budget_exceeded",
  "clock_inconsistent",
  "invalid_receipt",
  "binding_mismatch",
  "digest_mismatch",
] as const;
export type PullRequestDecisionUnavailableReason = (typeof pullRequestDecisionUnavailableReasons)[number];
export interface PullRequestDecisionUnavailable {
  status: "unavailable";
  reason: PullRequestDecisionUnavailableReason;
}

/** Structural chronology checks are not authentication or complete-history authority. */
export function pullRequestDecisionClocksValid(value: PullRequestDecisionHistoryPayload): boolean {
  const { startedAt, completedAt, before, after } = value.capture;
  const creation = value.binding.subject.createdAt;
  return (
    compareSourceInstants(startedAt, completedAt) <= 0 &&
    compareSourceInstants(value.generation.asOf, completedAt) <= 0 &&
    [before, after].every(
      (entry) =>
        compareSourceInstants(creation, entry.updatedAt) <= 0 &&
        compareSourceInstants(entry.updatedAt, completedAt) <= 0 &&
        compareSourceInstants(creation, entry.timelineUpdatedAt) <= 0 &&
        compareSourceInstants(entry.timelineUpdatedAt, completedAt) <= 0 &&
        [entry.closedAt, entry.mergedAt].every(
          (instant) =>
            instant === null ||
            (compareSourceInstants(creation, instant) <= 0 && compareSourceInstants(instant, completedAt) <= 0),
        ),
    ) &&
    value.history.every(
      (entry) =>
        compareSourceInstants(creation, entry.createdAt) <= 0 &&
        compareSourceInstants(entry.createdAt, before.timelineUpdatedAt) <= 0 &&
        compareSourceInstants(entry.createdAt, completedAt) <= 0,
    )
  );
}
