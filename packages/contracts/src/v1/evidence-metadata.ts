import { z } from "zod";

const time = z.string().datetime({ offset: true });
const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
// These are credited facts, never arbitrary webhook envelope actions or prose.
export const publicEvidenceActionSchema = z.enum([
  "artifact_created",
  "pull_request_ready",
  "pull_request_merged",
  "pull_request_closed_unmerged",
  "issue_closed",
  "comment_created",
  "review_submitted",
  "review_feedback_created",
  "review_dismissed",
  "default_branch_integrated",
  "release_published",
  "review_thread_resolved",
  "title_or_body_edited",
  "issue_field_changed",
  "project_item_field_changed",
  "project_status_changed",
  "project_progress_published",
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
  "milestoned",
  "demilestoned",
  "issue_typed",
  "issue_untyped",
  "label_created",
  "label_edited",
  "label_deleted",
  "label_archived",
  "label_unarchived",
  "milestone_created",
  "milestone_edited",
  "milestone_closed",
  "milestone_reopened",
  "milestone_deleted",
  "pinned",
  "unpinned",
  "locked",
  "unlocked",
  "relationship_changed",
  "issue_transferred",
  "revert_observed",
  "recognition_accepted",
  "unknown",
]);
const publicUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.origin === "https://github.com" &&
        !url.username &&
        !url.password &&
        !url.search &&
        (!url.hash ||
          /^#(?:issuecomment-\d+|pullrequestreview-\d+|discussion_r\d+|r\d+|discussioncomment-\d+)$/.test(url.hash)) &&
        /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./~-]+)?$/.test(url.pathname)
      );
    } catch {
      return false;
    }
  }, "A minimized public GitHub record URL is required");
const historyRecord = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("source_revision"), revision: identifier, occurredAt: time.nullable(), publicUrl })
    .strict(),
  z.object({ kind: z.literal("correction"), occurredAt: time.nullable(), publicUrl }).strict(),
]);
export const publicEvidenceHistorySchema = z.discriminatedUnion("coverage", [
  z.object({ coverage: z.literal("not_supplied"), records: z.array(historyRecord).max(0) }).strict(),
  // v1 deliberately cannot certify a complete history or that no corrections occurred.
  z.object({ coverage: z.literal("partial"), records: z.array(historyRecord).min(1).max(20) }).strict(),
]);
export const publicEvidenceMetadataSchema = z
  .object({
    schemaVersion: z.literal("leaderboard-evidence/v1"),
    artifactTitle: z
      .object({
        value: z
          .string()
          .min(1)
          .max(200)
          .refine((value) => value.trim() === value && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value)),
        basis: z.literal("as_collected"),
        collectedAt: time,
      })
      .strict()
      .nullable(),
    sourceAction: publicEvidenceActionSchema,
    sourceOccurredAt: time.nullable(),
    observedAt: time,
    activityState: z.enum(["observed", "pending", "accepted", "unknown"]),
    acceptedAt: time.nullable(),
    history: publicEvidenceHistorySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(value)).length > 8192)
      ctx.addIssue({ code: "custom", message: "Public evidence metadata exceeds its 8 KiB byte budget" });
    if (
      value.acceptedAt !== null &&
      (value.activityState !== "accepted" || value.sourceAction !== "recognition_accepted")
    )
      ctx.addIssue({ code: "custom", message: "Acceptance time requires an independently accepted recognition fact" });
    if (value.sourceAction === "recognition_accepted" && value.acceptedAt === null)
      ctx.addIssue({ code: "custom", message: "Recognition acceptance requires its actual receipt clock" });
  });
export type PublicEvidenceMetadata = z.infer<typeof publicEvidenceMetadataSchema>;
export type PublicEvidenceHistory = z.infer<typeof publicEvidenceHistorySchema>;
export type PublicEvidenceAction = z.infer<typeof publicEvidenceActionSchema>;
