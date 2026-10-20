import { z } from "zod";

/** Private source/calculation identity. This is not a public API field or grant. */
export const relationshipPairNormalizationVersion = "relationship-pair-units/v1";

const identity = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value));
const repositoryId = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(16)
  .refine((value) => Number.isSafeInteger(Number(value)));

export const relationshipEndpointSchema = z
  .object({
    repositoryId,
    artifactId: identity,
    kind: z.enum(["issue", "pull_request"]),
  })
  .strict();

export const relationshipPairSchema = z
  .object({
    version: z.literal(relationshipPairNormalizationVersion),
    kind: z.enum(["reference", "closing"]),
    action: z.enum(["reference", "connect", "disconnect"]),
    eventId: identity,
    from: relationshipEndpointSchema,
    to: relationshipEndpointSchema,
  })
  .strict()
  .superRefine((pair, context) => {
    if (
      pair.kind === "reference"
        ? pair.action !== "reference"
        : pair.action === "reference" || pair.from.kind === pair.to.kind
    )
      context.addIssue({ code: "custom", message: "Relationship action and endpoint kinds must match its unit" });
    if (
      pair.from.artifactId === pair.to.artifactId &&
      (pair.from.kind !== pair.to.kind || pair.from.repositoryId !== pair.to.repositoryId)
    )
      context.addIssue({ code: "custom", message: "One source object cannot have conflicting endpoint bindings" });
  });

export type RelationshipEndpoint = z.infer<typeof relationshipEndpointSchema>;
export type RelationshipPair = z.infer<typeof relationshipPairSchema>;

/** Actor, event, clock and the endpoint view never multiply this source unit. */
export function relationshipPairKey(input: RelationshipPair): string {
  const pair = relationshipPairSchema.parse(input);
  const endpoints =
    pair.kind === "closing" && pair.from.kind !== "pull_request" ? [pair.to, pair.from] : [pair.from, pair.to];
  return JSON.stringify([
    pair.version,
    pair.kind,
    ...endpoints.map((endpoint) => [endpoint.repositoryId, endpoint.kind, endpoint.artifactId]),
  ]);
}
