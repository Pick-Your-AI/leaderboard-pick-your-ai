import { z } from "zod";
import { artifactKindSchema, contributionRoleSchema, sourceEventSchema } from "./schemas.js";
import { publicArtifactIdSchema } from "../artifact-identity.js";

export const achievementMilestoneVersion = "accepted-evidence/v2";
export const achievementScopeMeaning =
  "Earliest available accepted evidence in this snapshot and scope; not a claim of first-ever activity.";
export const coContributionMeaning =
  "Recorded accepted work on the same public artifact, limited to this snapshot and selection. This is not a complete collaborator history or a ranking.";
const identifier = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value !== "." && value !== ".." && !/[^A-Za-z0-9_.:-]/.test(value));
const text = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const time = sourceEventSchema.shape.occurredAt.unwrap();
const publicUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      if (/[\\\u0000-\u0020\u007f]/.test(value)) return false;
      const url = new URL(value);
      return (
        url.origin === "https://github.com" &&
        !url.username &&
        !url.password &&
        !url.search &&
        /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./~-]+)?$/.test(url.pathname) &&
        (!url.hash ||
          /^#(?:issuecomment-\d+|pullrequestreview-\d+|discussion_r\d+|r\d+|discussioncomment-\d+)$/.test(url.hash))
      );
    } catch {
      return false;
    }
  });
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const roles = z
  .array(contributionRoleSchema)
  .min(1)
  .max(9)
  .refine((values) => unique(values) && !values.includes("unknown") && !values.includes("automation"));

/** A minimized original public proof. Parsing does not authenticate source acceptance. */
export const achievementProofSchema = z
  .object({
    contributionId: identifier,
    canonicalEventId: identifier,
    actorId: identifier,
    artifactId: publicArtifactIdSchema,
    artifactKind: artifactKindSchema,
    repositoryId: identifier.nullable(),
    sourceUrl: publicUrl,
    roles,
    metricIds: z.array(identifier).min(1).max(98).refine(unique),
    occurredAt: time,
    activityState: z.literal("accepted"),
    qualification: z.literal("eligible"),
  })
  .strict();
export type AchievementProof = z.infer<typeof achievementProofSchema>;

export const achievementMilestoneSchema = z
  .object({
    id: z.string().min(1).max(230),
    label: z.enum([
      "First accepted contribution in available scope",
      "First accepted review in available scope",
      "First accepted contribution in category",
    ]),
    categoryId: identifier.nullable(),
    ruleVersion: z.literal(achievementMilestoneVersion),
    dateBasis: z.literal("proven_source_occurrence_in_selected_scope"),
    scopeMeaning: z.literal(achievementScopeMeaning),
    occurredAt: time,
    evidenceIds: z.tuple([identifier]),
    artifactIds: z.tuple([publicArtifactIdSchema]),
    sourceUrls: z.tuple([publicUrl]),
    sharedCredit: z.boolean(),
    proof: achievementProofSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const isCategory = value.categoryId !== null;
    const expectedId = isCategory ? "first-category-in-scope:" + value.categoryId : value.id;
    const expectedLabel = isCategory
      ? "First accepted contribution in category"
      : value.id === "first-review-in-scope"
        ? "First accepted review in available scope"
        : "First accepted contribution in available scope";
    if (
      (!isCategory && !["first-accepted-in-scope", "first-review-in-scope"].includes(value.id)) ||
      value.id !== expectedId ||
      value.label !== expectedLabel ||
      (isCategory && !value.proof.metricIds.includes(value.categoryId!)) ||
      (value.id === "first-review-in-scope" && !value.proof.roles.includes("reviewer")) ||
      value.occurredAt !== value.proof.occurredAt ||
      value.evidenceIds[0] !== value.proof.contributionId ||
      value.artifactIds[0] !== value.proof.artifactId ||
      value.sourceUrls[0] !== value.proof.sourceUrl ||
      value.sharedCredit !== value.proof.roles.includes("coauthor")
    )
      ctx.addIssue({ code: "custom", message: "Milestone must bind its exact qualifying proof and rule" });
  });
export type AchievementMilestone = z.infer<typeof achievementMilestoneSchema>;

export const coContributionSchema = z
  .object({
    relationship: z.enum(["shared_authorship", "author_review_pair"]),
    peer: z.object({ actorId: identifier, login: text.nullable(), displayName: text.nullable() }).strict(),
    subject: achievementProofSchema,
    peerProof: achievementProofSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const a = value.subject,
      b = value.peerProof;
    const author = (proof: AchievementProof) => proof.roles.some((role) => role === "author" || role === "coauthor");
    const validRoles =
      value.relationship === "shared_authorship"
        ? author(a) && author(b)
        : (author(a) && b.roles.includes("reviewer")) || (a.roles.includes("reviewer") && author(b));
    if (
      !validRoles ||
      a.actorId === b.actorId ||
      b.actorId !== value.peer.actorId ||
      a.artifactId !== b.artifactId ||
      a.artifactKind !== b.artifactKind ||
      a.repositoryId !== b.repositoryId ||
      a.sourceUrl !== b.sourceUrl ||
      a.artifactKind === "unknown" ||
      a.contributionId === b.contributionId
    )
      ctx.addIssue({
        code: "custom",
        message: "Co-contribution requires distinct accepted participants on one exact artifact",
      });
  });
export type CoContribution = z.infer<typeof coContributionSchema>;

/** The endpoint adds its existing exact snapshot/scope metadata outside this closed extension. */
export const achievementMilestonesPageSchema = z
  .object({
    ruleVersion: z.literal(achievementMilestoneVersion),
    category: identifier.nullable(),
    achievements: z.array(achievementMilestoneSchema).max(100),
    coContributionMeaning: z.literal(coContributionMeaning),
    coContributions: z.array(coContributionSchema).max(100),
    totalCoContributions: z.number().int().min(0).max(20000),
    pageSize: z.number().int().min(1).max(100),
    nextCursor: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
      .refine((value) => !/[^A-Za-z0-9_.-]/.test(value))
      .nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      !unique(value.achievements.map((award) => award.id)) ||
      !unique(value.coContributions.map((pair) => JSON.stringify([pair.subject.artifactId, pair.peer.actorId]))) ||
      value.coContributions.length > value.pageSize ||
      value.coContributions.length > value.totalCoContributions ||
      (value.nextCursor !== null &&
        (value.coContributions.length === 0 || value.coContributions.length >= value.totalCoContributions))
    )
      ctx.addIssue({ code: "custom", message: "Invalid bounded milestone/co-contribution page" });
  });
