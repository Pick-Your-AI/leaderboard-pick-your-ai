import { z } from "zod";
import { publicArtifactIdSchema } from "./artifact-identity.js";
import type { Artifact, Contribution } from "./v1/schemas.js";

export const publicProjectContextVersion = "public-project-context/v1" as const;
export const publicProjectLimit = 100;
const projectId = z
  .string()
  .regex(/^[A-Za-z0-9_=.:\-]{1,128}$/)
  .refine((value) => value === value.trim());
const ids = z
  .array(projectId)
  .max(publicProjectLimit)
  .refine((value) => JSON.stringify(value) === JSON.stringify([...new Set(value)].sort()));

/** A minimized display projection; its schema and binding are not source authorization. */
export const publicProjectContextSchema = z
  .object({
    schemaVersion: z.literal(publicProjectContextVersion),
    binding: z
      .object({
        repositoryId: publicArtifactIdSchema,
        artifactId: publicArtifactIdSchema,
        contributionId: publicArtifactIdSchema,
      })
      .strict(),
    basis: z.enum(["event", "current"]),
    state: z.enum(["known", "unknown"]),
    projects: ids,
    projectScope: ids,
    observedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const valid =
      value.state === "known"
        ? value.observedAt !== null &&
          value.projectScope.length > 0 &&
          value.projects.every((id) => value.projectScope.includes(id))
        : value.observedAt === null && value.projects.length === 0 && value.projectScope.length === 0;
    if (!valid)
      context.addIssue({ code: "custom", message: "Project knowledge requires its verified scope and clock" });
  });

export type PublicProjectContext = z.infer<typeof publicProjectContextSchema>;

/** Compare exact parsed public identities, not a URL-derived native subject. */
export function publicProjectContextMatches(
  value: PublicProjectContext,
  artifact: Artifact,
  contribution: Contribution,
  basis: "event" | "current",
): boolean {
  return (
    value.basis === basis &&
    value.binding.repositoryId === artifact.repositoryId &&
    value.binding.artifactId === artifact.stableId &&
    value.binding.contributionId === contribution.contributionId &&
    contribution.artifactId === artifact.stableId
  );
}
