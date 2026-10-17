import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const id = nonEmpty;
const isoDateTime = z.string().datetime({ offset: true });

export const actorKindSchema = z.enum(["user", "bot", "github_app", "organization", "system", "unknown"]);
export const executionModeSchema = z.enum(["automated", "unknown"]);
export const actorIdentityStateSchema = z.enum(["resolved", "unresolved", "deleted", "suspended", "unavailable"]);

export const actorSchema = z
  .object({
    schemaVersion: z.literal("leaderboard/v1"),
    identityState: actorIdentityStateSchema,
    githubNodeId: id.optional(),
    githubDatabaseId: z.number().int().positive().optional(),
    login: nonEmpty.optional(),
    displayName: nonEmpty.optional(),
    kind: actorKindSchema,
    executionMode: executionModeSchema,
  })
  .strict()
  .superRefine((actor, ctx) => {
    if (actor.identityState === "resolved" && !actor.githubNodeId && actor.githubDatabaseId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Resolved actors require a stable GitHub node or database ID; login alone is not identity.",
        path: ["githubNodeId"],
      });
    }
  });

export const artifactKindSchema = z.enum([
  "repository",
  "issue",
  "pull_request",
  "commit",
  "release",
  "discussion",
  "project",
  "other",
  "unknown",
]);
export const visibilityStateSchema = z.enum(["public", "private", "unknown", "deleted", "unavailable"]);

export const artifactSchema = z
  .object({
    schemaVersion: z.literal("leaderboard/v1"),
    source: z.literal("github"),
    kind: artifactKindSchema,
    stableId: id.optional(),
    repositoryId: id.optional(),
    publicUrl: z.string().url().optional(),
    visibility: visibilityStateSchema,
  })
  .strict()
  .superRefine((artifact, ctx) => {
    if (artifact.visibility === "public" && (!artifact.stableId || !artifact.publicUrl)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A public artifact needs a stable source ID and public URL.",
        path: ["stableId"],
      });
    }
    if (artifact.visibility !== "public" && artifact.publicUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Non-public or unknown artifacts must not carry a public URL.",
        path: ["publicUrl"],
      });
    }
  });

export const contributionRoleSchema = z.enum([
  "author",
  "coauthor",
  "reviewer",
  "merger",
  "triager",
  "reporter",
  "resolver",
  "nominator",
  "automation",
  "unknown",
]);
export const sourceAdapterSchema = z.enum([
  "github_webhook",
  "github_rest",
  "github_graphql",
  "reviewed_receipt",
  "unknown",
]);
export const deduplicationStateSchema = z.enum(["unique", "duplicate", "ambiguous", "unknown"]);

export const sourceEventSchema = z
  .object({
    schemaVersion: z.literal("leaderboard/v1"),
    eventId: id,
    adapter: sourceAdapterSchema,
    action: nonEmpty,
    actor: actorSchema,
    role: contributionRoleSchema,
    subject: artifactSchema,
    occurredAt: isoDateTime.nullable(),
    observedAt: isoDateTime,
    sourceRevision: nonEmpty.optional(),
    dedupeKey: nonEmpty.optional(),
    deduplicationState: deduplicationStateSchema,
    observationIds: z.array(id).min(1),
  })
  .strict();

export const attributionStateSchema = z.enum(["verified", "ambiguous", "unknown", "unavailable"]);
export const attributionSchema = z
  .object({
    schemaVersion: z.literal("leaderboard/v1"),
    state: attributionStateSchema,
    actorId: id.nullable(),
    role: contributionRoleSchema,
    evidenceEventIds: z.array(id),
    method: z.enum([
      "stable_source_actor_id",
      "verified_account_link",
      "reviewed_receipt",
      "unresolved_source",
      "unknown",
    ]),
  })
  .strict()
  .superRefine((attribution, ctx) => {
    if (attribution.state === "verified" && (!attribution.actorId || attribution.evidenceEventIds.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Verified attribution requires an actor ID and evidence event.",
        path: ["actorId"],
      });
    }
    if (attribution.state !== "verified" && attribution.method === "stable_source_actor_id") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Stable source identity alone cannot certify a non-verified attribution state.",
        path: ["method"],
      });
    }
  });

export const identityCorrectionSchema = z
  .object({
    schemaVersion: z.literal("leaderboard/v1"),
    correctionId: id,
    kind: z.enum(["alias", "merge", "split"]),
    state: z.enum(["pending", "accepted", "rejected", "reversed"]),
    subjectActorIds: z.array(id).min(1),
    resultActorIds: z.array(id).min(1),
    evidenceEventIds: z.array(id),
    reviewerActorId: id.nullable(),
    reviewedAt: isoDateTime.nullable(),
    supersedesCorrectionId: id.nullable(),
  })
  .strict()
  .superRefine((correction, ctx) => {
    if (
      correction.state === "accepted" &&
      (!correction.reviewerActorId || !correction.reviewedAt || correction.evidenceEventIds.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Accepted identity corrections require a reviewer, review time and evidence.",
        path: ["reviewerActorId"],
      });
    }
    if (correction.kind === "merge" && correction.resultActorIds.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An identity merge must resolve to one stable actor ID.",
        path: ["resultActorIds"],
      });
    }
  });

export const artifactLineageSchema = z
  .object({
    schemaVersion: z.literal("leaderboard/v1"),
    lineageId: id,
    relation: z.enum(["same_change", "squash_of", "cherry_pick_of", "mirror_of", "imported_from", "unknown"]),
    sourceArtifactIds: z.array(id).min(1),
    targetArtifactId: id,
    state: z.enum(["verified", "pending", "ambiguous", "unknown", "unavailable"]),
    evidenceEventIds: z.array(id),
  })
  .strict()
  .superRefine((lineage, ctx) => {
    if (lineage.state === "verified" && lineage.evidenceEventIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Verified artifact lineage requires evidence.",
        path: ["evidenceEventIds"],
      });
    }
  });

export const coverageStateSchema = z.enum(["complete", "partial", "unknown", "unavailable"]);
export const coverageSchema = z
  .object({
    schemaVersion: z.literal("leaderboard/v1"),
    state: coverageStateSchema,
    source: sourceAdapterSchema,
    scopeId: id.nullable(),
    windowStart: isoDateTime.nullable(),
    windowEnd: isoDateTime.nullable(),
    knownStart: isoDateTime.nullable(),
    lastSuccessfulSync: isoDateTime.nullable(),
    sourceWatermark: isoDateTime.nullable(),
    missingPages: z.number().int().nonnegative(),
    permissionsMissing: z.array(nonEmpty),
    sourceErrors: z.array(nonEmpty),
  })
  .strict()
  .superRefine((coverage, ctx) => {
    if (
      coverage.windowStart &&
      coverage.windowEnd &&
      Date.parse(coverage.windowStart) >= Date.parse(coverage.windowEnd)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Coverage windows are half-open and require start < end.",
        path: ["windowEnd"],
      });
    }
    if (
      coverage.state === "complete" &&
      (coverage.missingPages > 0 || coverage.permissionsMissing.length > 0 || coverage.sourceErrors.length > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Coverage with known gaps cannot be marked complete.",
        path: ["state"],
      });
    }
  });

export const qualificationStateSchema = z.enum(["eligible", "ineligible", "pending", "unavailable", "unknown"]);
export const contributionSchema = z
  .object({
    schemaVersion: z.literal("leaderboard/v1"),
    contributionId: id,
    canonicalEventId: id,
    artifactId: id.nullable(),
    actorId: id.nullable(),
    roles: z.array(contributionRoleSchema).min(1),
    qualification: qualificationStateSchema,
    metricIds: z.array(id),
    reasonCodes: z.array(nonEmpty),
  })
  .strict();

export const metricValueStateSchema = z.enum(["measured", "zero", "partial", "unsupported", "unknown", "unavailable"]);
export const metricResultSchema = z
  .object({
    schemaVersion: z.literal("leaderboard/v1"),
    metricId: id,
    state: metricValueStateSchema,
    value: z.number().finite().nonnegative().optional(),
    coverage: coverageSchema,
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.state === "zero" && result.value !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A zero result must carry the numeric value 0.",
        path: ["value"],
      });
    }
    if (
      (result.state === "zero" || (result.state === "measured" && result.value === 0)) &&
      (result.coverage.state !== "complete" ||
        result.coverage.scopeId === null ||
        result.coverage.windowStart === null ||
        result.coverage.windowEnd === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Zero requires complete coverage with an explicit scope and time window.",
        path: ["coverage", "state"],
      });
    }
    if (["measured", "zero", "partial"].includes(result.state) !== (result.value !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only measured, zero, or partial results carry a numeric value.",
        path: ["value"],
      });
    }
  });

export const snapshotSchema = z
  .object({
    schemaVersion: z.literal("leaderboard/v1"),
    snapshotId: id,
    revision: z.number().int().nonnegative(),
    generatedAt: isoDateTime,
    metricDefinitionVersion: id,
    computationVersion: id,
    coverage: z.array(coverageSchema),
    results: z.array(metricResultSchema),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const ids = snapshot.results.map((result) => result.metricId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A snapshot may contain only one result per metric ID.",
        path: ["results"],
      });
    }
  });

export const metricDefinitionSchema = z
  .object({
    id,
    family: id,
    name: nonEmpty,
    attribution: nonEmpty,
    source: nonEmpty,
    counting_rule: nonEmpty,
    event_clock: nonEmpty,
    coverage_class: nonEmpty,
    display: nonEmpty,
    shared_rules: z.array(id),
    definition: z
      .object({
        unit: nonEmpty,
        aggregation: nonEmpty,
        numerator: nonEmpty,
        // A few planned ratio definitions carry candidate-specific explanatory
        // fields (for example zero_behavior); preserve them without normalizing.
        denominator: z.object({ kind: id, definition: nonEmpty }).passthrough(),
        denominator_filter_rule: nonEmpty,
        display_policy: nonEmpty,
        release_eligibility: nonEmpty,
        source_coverage_class: nonEmpty,
        event_clock: nonEmpty,
        subjective_qualification: nonEmpty,
        launch_gate: nonEmpty,
      })
      // Several families have explicit facets, dedupe, permission and source
      // acceptance fields. The parity check keeps these source meanings exact.
      .passthrough(),
    backlog_work_packages: z.array(id),
  })
  .strict();

export const metricRegistrySchema = z
  .object({
    contract_version: z.literal("leaderboard-metrics/v1"),
    policy_version: id,
    source_plan: id,
    metrics: z.array(metricDefinitionSchema).length(98),
    ui_metadata: z
      .object({
        decision_state: z.literal("unresolved"),
        fields: z.array(id),
        note: nonEmpty,
      })
      .strict(),
  })
  .strict()
  .superRefine((registry, ctx) => {
    const ids = registry.metrics.map((metric) => metric.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Metric IDs must be unique within a registry version.",
        path: ["metrics"],
      });
    }
  });

export const schemaVersion = "leaderboard/v1" as const;

export type Actor = z.infer<typeof actorSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type SourceEvent = z.infer<typeof sourceEventSchema>;
export type Attribution = z.infer<typeof attributionSchema>;
export type ArtifactLineage = z.infer<typeof artifactLineageSchema>;
export type IdentityCorrection = z.infer<typeof identityCorrectionSchema>;
export type Coverage = z.infer<typeof coverageSchema>;
export type Contribution = z.infer<typeof contributionSchema>;
export type MetricResult = z.infer<typeof metricResultSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type MetricDefinition = z.infer<typeof metricDefinitionSchema>;
export type MetricRegistry = z.infer<typeof metricRegistrySchema>;
