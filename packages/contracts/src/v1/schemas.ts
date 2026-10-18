import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const id = nonEmpty;
const isoDateTime = z.string().datetime({ offset: true });

export const actorKindSchema = z.enum([
  "user",
  "service_account",
  "bot",
  "github_app",
  "organization",
  "system",
  "unknown",
]);
/** Private reviewed classification evidence; not part of the public Actor projection. */
export const serviceAccountClassificationSchema = z
  .object({
    schemaVersion: z.literal("leaderboard-service-account/v1"),
    classificationId: id,
    githubDatabaseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    githubNodeId: id.optional(),
    source: z.enum(["reviewed_source", "reviewed_configuration"]),
    evidenceIds: z.array(id).min(1),
    reviewerActorId: id,
    reviewedAt: isoDateTime,
  })
  .strict()
  .refine(
    (classification) =>
      classification.reviewerActorId !== String(classification.githubDatabaseId) &&
      classification.reviewerActorId !== classification.githubNodeId,
    { message: "Service-account classification requires an independent reviewer.", path: ["reviewerActorId"] },
  );

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

export const metricSelectionSchema = z
  .object({
    state: z.enum(["observed", "qualified", "reviewed"]),
    date_basis: z.enum(["occurredAt", "acceptedAt"]),
  })
  .strict();

export const metricUiEntrySchema = z
  .object({
    metric_id: id,
    department: id,
    synonyms: z.array(nonEmpty).min(1),
    maturity: z.enum(["definition_only", "synthetic_verified", "deferred"]),
    source_class: z.enum(["reconstructible", "since_installation", "evidence_reviewed", "conditional", "unsupported"]),
    supported_states: z.array(metricSelectionSchema.shape.state),
    supported_date_bases: z.array(metricSelectionSchema.shape.date_basis),
    supported_combinations: z.array(metricSelectionSchema),
    default_combination: metricSelectionSchema.nullable(),
    lead_view: z
      .object({ overview: z.boolean(), wall: z.boolean(), order: z.number().int().nonnegative().nullable() })
      .strict(),
    verification_cases: z.array(nonEmpty),
    limitations: z.array(nonEmpty).min(1),
  })
  .strict();

export const metricUiMetadataSchema = z
  .object({
    decision_state: z.literal("candidate"),
    version: z.literal("leaderboard-ui/v1"),
    public_enabled: z.literal(false),
    note: nonEmpty,
    departments: z.array(z.object({ id, label: nonEmpty, order: z.number().int().nonnegative() }).strict()).min(1),
    metrics: z.array(metricUiEntrySchema).length(98),
  })
  .strict();

export const metricGroupingPolicySchema = z
  .object({
    version: z.literal("triage-raw-state/v1"),
    metric_id: z.literal("items_triaged"),
    state: z.literal("observed"),
    date_basis: z.literal("occurredAt"),
    group_by: z.literal("actor_artifact_state_interval"),
    grouping_seconds: z.literal(3600),
    interval_origin: z.literal("1970-01-01T00:00:00Z"),
    raw_state_rule: z.literal("exact_source_value"),
    repeated_state_rule: z.literal("one_actor_artifact_raw_state_per_interval"),
    missing_state_or_time: z.literal("exclude_unknown"),
    semantic_classifier: z.literal("none"),
    public_enabled: z.literal(false),
  })
  .strict();

export const metricRegistrySchema = z
  .object({
    contract_version: z.literal("leaderboard-metrics/v1"),
    policy_version: id,
    source_plan: id,
    metrics: z.array(metricDefinitionSchema).length(98),
    // Retain read compatibility with the earlier unresolved candidate. It has
    // no selectable capability, and consumers must explicitly handle it.
    ui_metadata: z.union([
      metricUiMetadataSchema,
      z
        .object({
          decision_state: z.literal("unresolved"),
          fields: z.array(id),
          note: nonEmpty,
        })
        .strict(),
    ]),
    grouping_policies: z.array(metricGroupingPolicySchema).optional(),
  })
  .strict()
  .superRefine((registry, ctx) => {
    const problem = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    const ids = registry.metrics.map((metric) => metric.id);
    if (new Set(ids).size !== ids.length) problem("Metric IDs must be unique within a registry version.", ["metrics"]);
    if (
      registry.grouping_policies &&
      new Set(registry.grouping_policies.map((p) => p.metric_id)).size !== registry.grouping_policies.length
    )
      problem("Grouping policies must be unique per metric.", ["grouping_policies"]);
    const ui = registry.ui_metadata;
    if (ui.decision_state === "unresolved") return;
    const departments = ui.departments.map((d) => d.id);
    if (
      new Set(departments).size !== departments.length ||
      new Set(ui.departments.map((d) => d.order)).size !== departments.length
    )
      problem("Department IDs and ordering must be unique.", ["ui_metadata", "departments"]);
    const mapped = ui.metrics.map((m) => m.metric_id);
    if (new Set(mapped).size !== ids.length || mapped.some((id) => !ids.includes(id)))
      problem("UI metadata must map every definition exactly once.", ["ui_metadata", "metrics"]);
    const leadOrders = ui.metrics.filter((m) => m.lead_view.order !== null).map((m) => m.lead_view.order);
    if (new Set(leadOrders).size !== leadOrders.length)
      problem("Lead ordering must be unique.", ["ui_metadata", "metrics"]);
    const leadDepartments = ui.metrics.filter((m) => m.lead_view.overview).map((m) => m.department);
    if (new Set(leadDepartments).size !== leadDepartments.length)
      problem("A department has at most one overview lead.", ["ui_metadata", "metrics"]);
    for (const [index, entry] of ui.metrics.entries()) {
      const path = ["ui_metadata", "metrics", index];
      const metric = registry.metrics.find((m) => m.id === entry.metric_id);
      if (!departments.includes(entry.department)) problem("Unknown department.", [...path, "department"]);
      const combinations = entry.supported_combinations.map((c) => `${c.state}:${c.date_basis}`);
      const selectable = combinations.length > 0;
      const states = [...new Set(entry.supported_combinations.map((c) => c.state))].sort();
      const dates = [...new Set(entry.supported_combinations.map((c) => c.date_basis))].sort();
      if (
        new Set(combinations).size !== combinations.length ||
        JSON.stringify([...entry.supported_states].sort()) !== JSON.stringify(states) ||
        JSON.stringify([...entry.supported_date_bases].sort()) !== JSON.stringify(dates)
      )
        problem("Supported state/date lists must exactly project unique combinations.", path);
      if (
        (entry.default_combination !== null) !== selectable ||
        (entry.default_combination &&
          !combinations.includes(`${entry.default_combination.state}:${entry.default_combination.date_basis}`))
      )
        problem("A default must be an explicitly supported combination; unavailable metrics have no default.", path);
      if (
        (entry.maturity === "synthetic_verified") !== selectable ||
        (combinations.length && !entry.verification_cases.length)
      )
        problem(
          "Selectable candidates require verification cases; definition-only and deferred metrics cannot select a view.",
          path,
        );
      const lead = entry.lead_view;
      if (
        (lead.overview || lead.wall) !== (lead.order !== null) ||
        ((lead.overview || lead.wall) && (!combinations.length || metric?.display !== "leaderboard"))
      )
        problem("Lead and wall choices require a supported ranked definition and explicit order.", path);
      if (
        (entry.source_class === "unsupported" ||
          metric?.coverage_class === "disabled_currently" ||
          metric?.definition.release_eligibility === "deferred advanced") &&
        combinations.length
      )
        problem("Unsupported or deferred metrics cannot expose measured selections.", path);
      if (entry.metric_id === "items_triaged" && selectable) {
        const grouping = registry.grouping_policies?.find((policy) => policy.metric_id === entry.metric_id);
        if (!grouping) problem("Triage selections require an explicit versioned grouping policy.", path);
        else if (
          entry.supported_combinations.some(
            (pair) => pair.state !== grouping.state || pair.date_basis !== grouping.date_basis,
          )
        )
          problem("Every triage selection must match its versioned grouping policy state and date basis.", path);
      }
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

/** Separate, bounded policy-unit counts; never added to a ranked value. */
export const pendingCountSchema = z
  .object({
    schemaVersion: z.literal("leaderboard-pending/v1"),
    state: z.enum(["measured", "partial", "unknown"]),
    valueClass: z.enum(["observed", "qualified", "reviewed"]),
    count: z.number().int().min(0).max(10000).nullable(),
    evidenceIds: z.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/)).max(10000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.evidenceIds).size !== value.evidenceIds.length ||
      (value.state === "unknown"
        ? value.count !== null || value.evidenceIds.length !== 0
        : value.count !== value.evidenceIds.length || (value.state === "partial" && value.count === 0))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pending counts require exact distinct evidence; unknown is not zero.",
      });
    }
  });
export type PendingCount = z.infer<typeof pendingCountSchema>;
export type ServiceAccountClassification = z.infer<typeof serviceAccountClassificationSchema>;
export type MetricSelection = z.infer<typeof metricSelectionSchema>;
export type MetricUiEntry = z.infer<typeof metricUiEntrySchema>;
export type MetricUiMetadata = z.infer<typeof metricUiMetadataSchema>;
