import { z } from "zod";
import type { Actor } from "./v1/schemas.js";

export const publicProfilePresentationVersion = "public-profile-presentation/v1" as const;

/** Preserve the existing public URL admission and canonicalization rule.
 * This checks shape only; a link is not source verification or permission.
 */
export function safePublicGithubUrl(value: string | null | undefined): string | null {
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.origin === "https://github.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      (!url.hash ||
        /^#(?:issuecomment-\d+|pullrequestreview-\d+|discussion_r\d+|r\d+|discussioncomment-\d+)$/.test(url.hash)) &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./~-]+)?$/.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Optional current account text, separate from immutable identity and evidence. */
export const publicProfilePresentationSchema = z
  .object({
    schemaVersion: z.literal(publicProfilePresentationVersion),
    actorId: z
      .string()
      .regex(/^[1-9][0-9]{0,19}$/)
      .refine((value) => value.trim() === value),
    bio: z
      .string()
      .max(500)
      .refine((value) => !/[<>\u0000-\u001f\u007f]/.test(value)),
    highlights: z
      .array(
        z
          .string()
          .max(2048)
          .refine((value) => safePublicGithubUrl(value) === value),
      )
      .max(6),
  })
  .strict();

export type PublicProfilePresentation = z.infer<typeof publicProfilePresentationSchema>;

/** A login, node-only identity or coincidentally matching route is insufficient. */
export function publicProfilePresentationMatches(
  value: PublicProfilePresentation,
  actorId: string,
  actor: Actor,
): boolean {
  const databaseId = actor.githubDatabaseId;
  return (
    actor.identityState === "resolved" &&
    typeof databaseId === "number" &&
    Number.isSafeInteger(databaseId) &&
    databaseId > 0 &&
    String(databaseId) === actorId &&
    value.actorId === actorId
  );
}
