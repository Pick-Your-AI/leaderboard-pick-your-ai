/**
 * SYNTHETIC PROTOTYPE FIXTURE. Nothing in this file describes a real person,
 * repository, contribution or ranking. Logins use the reserved "synthetic-"
 * prefix and every source link points at the reserved synthetic.example
 * domain. It exists so that the LB-13.04 journeys and required states can be
 * evaluated before the read API exists, and it must never be published as
 * contributor evidence.
 */
import type { Coverage } from "@pick-your-ai/contracts";
import type {
  ContributionRecord,
  EvidenceState,
  FixtureMetric,
  LineBreakdown,
  Person,
  ProgramProject,
  RepoCoverage,
  Repository,
  SnapshotMeta,
} from "./model.ts";

export const SYNTHETIC_DATASET_ID = "synthetic-prototype-2026-10-17";

export const repositories: Repository[] = [
  { id: "syn-repo-research", name: "synthetic/research" },
  { id: "syn-repo-website", name: "synthetic/website" },
  { id: "syn-repo-leaderboard", name: "synthetic/leaderboard" },
];

export const projects: ProgramProject[] = [
  {
    id: "syn-proj-research",
    name: "Synthetic research program",
    repoIds: ["syn-repo-research"],
    note: "One repository; workstreams are not inferred from labels.",
  },
  {
    id: "syn-proj-web",
    name: "Synthetic web program",
    repoIds: ["syn-repo-website", "syn-repo-leaderboard"],
    note: "Shares the website repository with no other program in this fixture. Contributions counted in both programs count once in organization totals.",
  },
];

function user(
  id: number,
  login: string,
  displayName: string,
  note: string,
  publicState: Person["publicState"] = "visible",
): Person {
  return {
    actorId: `syn-actor-${id}`,
    login,
    displayName,
    actor: {
      schemaVersion: "leaderboard/v1",
      identityState: publicState === "deleted" ? "deleted" : "resolved",
      ...(publicState === "deleted" ? {} : { githubNodeId: `SYN_U_${id}` }),
      login,
      displayName,
      kind: "user",
      executionMode: "unknown",
    },
    publicState,
    fixtureNote: note,
  };
}

export const people: Person[] = [
  user(1, "synthetic-aster", "Aster (synthetic)", "Code author and reviewer; ties with Dahlia on PRs reviewed."),
  user(2, "synthetic-birch", "Birch (synthetic)", "Triage-heavy profile with one corrected label application."),
  user(3, "synthetic-cedar", "Cedar (synthetic)", "Research decision records; no code activity."),
  user(4, "synthetic-dahlia", "Dahlia (synthetic)", "Reviewer and documentation author."),
  user(5, "synthetic-elm", "Elm (synthetic)", "Code author with large changes, including excluded lockfile lines."),
  user(6, "synthetic-fern", "Fern (synthetic)", "Research and issue reporting; one finding pending review."),
  user(
    7,
    "synthetic-gale",
    "Gale (synthetic)",
    "Newcomer whose only work is observed or pending; never ranked but listed in the directory.",
  ),
  user(
    8,
    "synthetic-hazel",
    "Hazel (synthetic)",
    "Suppressed at their request; must not appear on any public surface.",
    "suppressed",
  ),
  user(9, "synthetic-iris", "Iris (synthetic)", "Deleted account; past contributions keep a neutral label.", "deleted"),
  {
    actorId: "syn-actor-bot-1",
    login: "synthetic-ci-bot",
    displayName: "synthetic-ci-bot",
    actor: {
      schemaVersion: "leaderboard/v1",
      identityState: "resolved",
      githubNodeId: "SYN_B_1",
      login: "synthetic-ci-bot",
      kind: "bot",
      executionMode: "automated",
    },
    publicState: "visible",
    fixtureNote: "Automation account; appears only in the automation area.",
  },
];

const repoName = (repoId: string) => repositories.find((repo) => repo.id === repoId)?.name ?? repoId;

const lines = (
  source: number,
  docs = 0,
  tests = 0,
  generated = 0,
  vendor = 0,
  lockfile = 0,
  other = 0,
): LineBreakdown => ({
  source,
  docs,
  tests,
  generated,
  vendor,
  lockfile,
  other,
});

interface RecordSpec {
  n: number;
  title: string;
  repo: string;
  metrics: string[];
  actor: number | "bot" | null;
  role: ContributionRecord["role"];
  evidence: EvidenceState;
  at: string;
  path: string;
  accepted?: string;
  rule?: string;
  lines?: LineBreakdown;
  exclusion?: string;
  visibility?: "public" | "unavailable";
  corrections?: ContributionRecord["corrections"];
  adapter?: ContributionRecord["adapter"];
  observedLag?: number;
  note?: string;
}

const projectFor = (repoId: string) =>
  projects.filter((project) => project.repoIds.includes(repoId)).map((project) => project.id);

function record(spec: RecordSpec): ContributionRecord {
  const visibility = spec.visibility ?? "public";
  const observed = new Date(Date.parse(spec.at) + (spec.observedLag ?? 4) * 60_000).toISOString();
  return {
    id: `syn-c-${String(spec.n).padStart(3, "0")}`,
    title: spec.title,
    repoId: spec.repo,
    projectIds: projectFor(spec.repo),
    metricIds: spec.metrics,
    actorId: spec.actor === null ? null : spec.actor === "bot" ? "syn-actor-bot-1" : `syn-actor-${spec.actor}`,
    role: spec.role,
    evidence: spec.evidence,
    occurredAt: spec.at,
    observedAt: observed,
    acceptedAt: spec.accepted ?? null,
    acceptanceRule: spec.rule ?? null,
    visibility,
    sourceUrl: visibility === "public" ? `https://synthetic.example/${repoName(spec.repo)}/${spec.path}` : null,
    adapter: spec.adapter ?? "github_rest",
    exclusionReason: spec.exclusion ?? null,
    corrections: spec.corrections ?? [],
    lines: spec.lines ?? null,
    fixtureNote: spec.note ?? "Synthetic fixture row for prototype evaluation.",
  };
}

const R = "syn-repo-research";
const W = "syn-repo-website";
const L = "syn-repo-leaderboard";
const MERGED = "Merged into the default branch";
const REVIEWED = "Accepted by a second reviewer under the decision-record policy";

export const contributions: ContributionRecord[] = [
  // Code delivery and lines.
  record({
    n: 1,
    title: "Add contributor directory skeleton",
    repo: L,
    metrics: ["pr_merged", "pr_lines_changed"],
    actor: 1,
    role: "author",
    evidence: "qualified",
    at: "2026-10-03T14:10:00Z",
    accepted: "2026-10-04T09:00:00Z",
    rule: MERGED,
    path: "pull/4",
    lines: lines(420, 40, 120),
  }),
  record({
    n: 2,
    title: "Fix board period serialization",
    repo: L,
    metrics: ["pr_merged", "pr_lines_changed"],
    actor: 1,
    role: "author",
    evidence: "qualified",
    at: "2026-10-09T10:00:00Z",
    accepted: "2026-10-09T16:30:00Z",
    rule: MERGED,
    path: "pull/9",
    lines: lines(36, 0, 48),
  }),
  record({
    n: 3,
    title: "Website footer contrast fix",
    repo: W,
    metrics: ["pr_merged", "pr_lines_changed"],
    actor: 1,
    role: "author",
    evidence: "qualified",
    at: "2026-09-25T08:00:00Z",
    accepted: "2026-09-25T12:00:00Z",
    rule: MERGED,
    path: "pull/41",
    lines: lines(12),
  }),
  record({
    n: 4,
    title: "Upgrade bundler and regenerate lockfile",
    repo: W,
    metrics: ["pr_merged", "pr_lines_changed"],
    actor: 5,
    role: "author",
    evidence: "qualified",
    at: "2026-10-06T11:00:00Z",
    accepted: "2026-10-07T10:00:00Z",
    rule: MERGED,
    path: "pull/44",
    lines: lines(64, 0, 0, 0, 0, 2900),
    note: "Lockfile lines are excluded from the LOC board by policy; the merge still counts on PRs merged.",
  }),
  record({
    n: 5,
    title: "Vendor icon set",
    repo: W,
    metrics: ["pr_merged", "pr_lines_changed"],
    actor: 5,
    role: "author",
    evidence: "qualified",
    at: "2026-10-12T15:00:00Z",
    accepted: "2026-10-13T09:00:00Z",
    rule: MERGED,
    path: "pull/47",
    lines: lines(20, 0, 0, 0, 1800),
  }),
  record({
    n: 6,
    title: "Refactor scope parser",
    repo: L,
    metrics: ["pr_merged", "pr_lines_changed"],
    actor: 5,
    role: "author",
    evidence: "qualified",
    at: "2026-07-20T09:00:00Z",
    accepted: "2026-07-21T09:00:00Z",
    rule: MERGED,
    path: "pull/2",
    lines: lines(210, 0, 90),
    note: "Older than 90 days before the cutoff; only appears in all-time and calendar-year scopes.",
  }),
  record({
    n: 7,
    title: "Draft: live wall pause control",
    repo: L,
    metrics: ["pr_merged"],
    actor: 7,
    role: "author",
    evidence: "provisional",
    at: "2026-10-15T18:00:00Z",
    path: "pull/12",
    note: "Open PR from a newcomer. Pending: not merged, so it is not on the ranked value.",
  }),
  record({
    n: 8,
    title: "Dependency update (automated)",
    repo: W,
    metrics: ["pr_merged", "pr_lines_changed"],
    actor: "bot",
    role: "automation",
    evidence: "qualified",
    at: "2026-10-10T03:00:00Z",
    accepted: "2026-10-10T08:00:00Z",
    rule: MERGED,
    path: "pull/46",
    lines: lines(4, 0, 0, 0, 0, 380),
  }),
  record({
    n: 9,
    title: "Add evidence drawer focus return",
    repo: L,
    metrics: ["pr_merged", "pr_lines_changed"],
    actor: 4,
    role: "author",
    evidence: "qualified",
    at: "2026-10-17T12:05:00Z",
    accepted: "2026-10-17T12:08:00Z",
    rule: MERGED,
    path: "pull/14",
    lines: lines(88, 10, 40),
    observedLag: 1,
    note: "Observed after snapshot r42; appears from r43.",
  }),

  // Reviews.
  record({
    n: 10,
    title: "Review: contributor directory skeleton",
    repo: L,
    metrics: ["prs_reviewed"],
    actor: 4,
    role: "reviewer",
    evidence: "observed",
    at: "2026-10-03T18:00:00Z",
    path: "pull/4#review-1",
  }),
  record({
    n: 11,
    title: "Review: board period serialization",
    repo: L,
    metrics: ["prs_reviewed"],
    actor: 4,
    role: "reviewer",
    evidence: "observed",
    at: "2026-10-09T12:00:00Z",
    path: "pull/9#review-1",
  }),
  record({
    n: 12,
    title: "Review: lockfile upgrade",
    repo: W,
    metrics: ["prs_reviewed"],
    actor: 1,
    role: "reviewer",
    evidence: "observed",
    at: "2026-10-06T16:00:00Z",
    path: "pull/44#review-1",
  }),
  record({
    n: 13,
    title: "Review: vendor icon set",
    repo: W,
    metrics: ["prs_reviewed"],
    actor: 1,
    role: "reviewer",
    evidence: "observed",
    at: "2026-10-12T17:00:00Z",
    path: "pull/47#review-1",
  }),
  record({
    n: 14,
    title: "Review: website footer contrast",
    repo: W,
    metrics: ["prs_reviewed"],
    actor: 5,
    role: "reviewer",
    evidence: "observed",
    at: "2026-09-25T10:00:00Z",
    path: "pull/41#review-1",
  }),
  record({
    n: 15,
    title: "Review: decision record DR-syn-3",
    repo: R,
    metrics: ["prs_reviewed"],
    actor: 6,
    role: "reviewer",
    evidence: "observed",
    at: "2026-10-01T09:00:00Z",
    path: "pull/88#review-1",
  }),
  record({
    n: 16,
    title: "Review: evidence drawer focus return",
    repo: L,
    metrics: ["prs_reviewed"],
    actor: 1,
    role: "reviewer",
    evidence: "observed",
    at: "2026-10-17T12:07:00Z",
    path: "pull/14#review-1",
    observedLag: 1,
    note: "Observed after snapshot r42; appears from r43 and breaks the Aster/Dahlia tie.",
  }),

  // Triage.
  record({
    n: 20,
    title: "Applied label: accessibility",
    repo: W,
    metrics: ["labels_applied"],
    actor: 2,
    role: "triager",
    evidence: "observed",
    at: "2026-10-02T08:00:00Z",
    path: "issues/30#label",
  }),
  record({
    n: 21,
    title: "Applied label: question",
    repo: R,
    metrics: ["labels_applied"],
    actor: 2,
    role: "triager",
    evidence: "observed",
    at: "2026-10-05T08:00:00Z",
    path: "issues/52#label",
  }),
  record({
    n: 22,
    title: "Applied label: documentation",
    repo: R,
    metrics: ["labels_applied"],
    actor: 2,
    role: "triager",
    evidence: "observed",
    at: "2026-10-08T08:00:00Z",
    path: "issues/57#label",
  }),
  record({
    n: 23,
    title: "Applied label: security",
    repo: L,
    metrics: ["labels_applied"],
    actor: 2,
    role: "triager",
    evidence: "observed",
    at: "2026-10-11T08:00:00Z",
    path: "issues/39#label",
  }),
  record({
    n: 24,
    title: "Applied label: security (duplicate event)",
    repo: L,
    metrics: ["labels_applied"],
    actor: 2,
    role: "triager",
    evidence: "excluded",
    at: "2026-10-11T08:00:30Z",
    path: "issues/39#label-2",
    exclusion: "Duplicate of syn-c-023: same label, item and day.",
    corrections: [
      {
        correctionId: "syn-cr-1",
        at: "2026-10-12T10:00:00Z",
        summary:
          "Excluded as a duplicate label application after correction review syn-cr-1. The value fell from 5 to 4.",
      },
    ],
    note: "Corrected result: originally counted, then excluded after a public correction.",
  }),
  record({
    n: 25,
    title: "Applied label: enhancement",
    repo: W,
    metrics: ["labels_applied"],
    actor: 6,
    role: "triager",
    evidence: "observed",
    at: "2026-10-14T08:00:00Z",
    path: "issues/33#label",
  }),
  record({
    n: 26,
    title: "Applied label: good first issue",
    repo: L,
    metrics: ["labels_applied"],
    actor: "bot",
    role: "automation",
    evidence: "observed",
    at: "2026-10-14T09:00:00Z",
    path: "issues/40#label",
    note: "Applied by automation; shown only when the actor scope includes automation.",
  }),
  record({
    n: 27,
    title: "Applied label: bug",
    repo: W,
    metrics: ["labels_applied"],
    actor: 7,
    role: "triager",
    evidence: "provisional",
    at: "2026-10-16T08:00:00Z",
    path: "issues/35#label",
    note: "Pending deduplication against the scheduled source read.",
  }),
  record({
    n: 28,
    title: "Applied label: research",
    repo: R,
    metrics: ["labels_applied"],
    actor: 2,
    role: "triager",
    evidence: "observed",
    at: "2026-10-16T09:00:00Z",
    path: "issues/61#label",
  }),

  // Issues.
  record({
    n: 30,
    title: "Reported: period picker loses custom range",
    repo: L,
    metrics: ["issues_opened"],
    actor: 6,
    role: "reporter",
    evidence: "observed",
    at: "2026-10-04T13:00:00Z",
    path: "issues/8",
  }),
  record({
    n: 31,
    title: "Reported: drawer traps focus on Safari",
    repo: L,
    metrics: ["issues_opened"],
    actor: 7,
    role: "reporter",
    evidence: "observed",
    at: "2026-10-15T13:00:00Z",
    path: "issues/11",
    note: "A newcomer's first observed contribution.",
  }),
  record({
    n: 32,
    title: "Reported: stale banner never clears",
    repo: W,
    metrics: ["issues_opened"],
    actor: 9,
    role: "reporter",
    evidence: "observed",
    at: "2026-09-29T13:00:00Z",
    path: "issues/38",
    visibility: "unavailable",
    note: "The account was deleted and the issue is no longer public. The count stays; the source link does not.",
  }),
  record({
    n: 33,
    title: "Reported: mobile filter sheet overlaps header",
    repo: W,
    metrics: ["issues_opened"],
    actor: 1,
    role: "reporter",
    evidence: "observed",
    at: "2026-10-07T13:00:00Z",
    path: "issues/39",
  }),

  // Research.
  record({
    n: 40,
    title: "Decision record: GPU memory bandwidth source",
    repo: R,
    metrics: ["decision_records"],
    actor: 3,
    role: "author",
    evidence: "reviewed",
    at: "2026-09-30T10:00:00Z",
    accepted: "2026-10-02T10:00:00Z",
    rule: REVIEWED,
    adapter: "reviewed_receipt",
    path: "pull/88",
  }),
  record({
    n: 41,
    title: "Decision record: price snapshot cadence",
    repo: R,
    metrics: ["decision_records"],
    actor: 3,
    role: "author",
    evidence: "reviewed",
    at: "2026-10-08T10:00:00Z",
    accepted: "2026-10-10T10:00:00Z",
    rule: REVIEWED,
    adapter: "reviewed_receipt",
    path: "pull/91",
  }),
  record({
    n: 42,
    title: "Decision record: quantization naming",
    repo: R,
    metrics: ["decision_records"],
    actor: 6,
    role: "author",
    evidence: "reviewed",
    at: "2026-10-05T10:00:00Z",
    accepted: "2026-10-09T10:00:00Z",
    rule: REVIEWED,
    adapter: "reviewed_receipt",
    path: "pull/90",
  }),
  record({
    n: 43,
    title: "Decision record: benchmark rights review",
    repo: R,
    metrics: ["decision_records"],
    actor: 6,
    role: "author",
    evidence: "provisional",
    at: "2026-10-15T10:00:00Z",
    adapter: "reviewed_receipt",
    path: "pull/94",
    note: "Awaiting the second reviewer: pending, not ranked.",
  }),

  // Documentation.
  record({
    n: 50,
    title: "Docs: methodology glossary",
    repo: L,
    metrics: ["documentation"],
    actor: 4,
    role: "author",
    evidence: "qualified",
    at: "2026-10-05T09:00:00Z",
    accepted: "2026-10-05T15:00:00Z",
    rule: MERGED,
    path: "pull/6",
    lines: lines(0, 140),
  }),
  record({
    n: 51,
    title: "Docs: contributor guide screenshots",
    repo: W,
    metrics: ["documentation"],
    actor: 4,
    role: "author",
    evidence: "qualified",
    at: "2026-10-13T09:00:00Z",
    accepted: "2026-10-13T15:00:00Z",
    rule: MERGED,
    path: "pull/48",
    lines: lines(0, 60),
  }),
  record({
    n: 52,
    title: "Docs: research workflow walkthrough",
    repo: R,
    metrics: ["documentation"],
    actor: 8,
    role: "author",
    evidence: "qualified",
    at: "2026-10-06T09:00:00Z",
    accepted: "2026-10-06T15:00:00Z",
    rule: MERGED,
    path: "pull/89",
    lines: lines(0, 220),
    note: "Suppressed contributor: excluded from every public payload.",
  }),
];

/** Metrics that have prototype fixture data. All others render "not measured in this prototype". */
export const fixtureMetrics: Record<string, FixtureMetric> = {
  pr_merged: {
    rankStates: ["qualified"],
    valueKind: "count",
    explanation: "Each fixture row is one synthetic merged PR. Open PRs are pending.",
  },
  pr_lines_changed: {
    rankStates: ["qualified"],
    valueKind: "lines",
    explanation:
      "Sum of synthetic additions plus deletions in source, docs, tests and other. Generated, vendor and lockfile lines are excluded.",
  },
  prs_reviewed: {
    rankStates: ["observed"],
    valueKind: "count",
    explanation: "Each fixture row is one synthetic reviewer-PR participation.",
  },
  labels_applied: {
    rankStates: ["observed"],
    valueKind: "count",
    explanation: "Each fixture row is one synthetic, deduplicated label application.",
  },
  issues_opened: {
    rankStates: ["observed"],
    valueKind: "count",
    explanation: "Each fixture row is one synthetic issue.",
  },
  decision_records: {
    rankStates: ["reviewed"],
    valueKind: "count",
    explanation: "Each fixture row is one synthetic decision-record version accepted after review.",
  },
  documentation: {
    rankStates: ["qualified"],
    valueKind: "count",
    explanation: "Each fixture row is one synthetic merged documentation-category PR participation.",
  },
};

export const snapshots: SnapshotMeta[] = [
  {
    id: "syn-r41",
    revision: 41,
    cutoff: "2026-10-16T12:00:00Z",
    generatedAt: "2026-10-16T12:03:00Z",
    status: "published",
    freshness: "Fresh",
    collectorConnected: true,
    reconciliation: "Reconciled",
    servesSnapshotId: "syn-r41",
    note: "Previous day's snapshot; pinned links keep it unchanged.",
  },
  {
    id: "syn-r42",
    revision: 42,
    cutoff: "2026-10-17T12:00:00Z",
    generatedAt: "2026-10-17T12:02:00Z",
    status: "published",
    freshness: "Fresh",
    collectorConnected: true,
    reconciliation: "Reconciled",
    servesSnapshotId: "syn-r42",
    note: "Latest snapshot when a page first loads.",
  },
  {
    id: "syn-r43",
    revision: 43,
    cutoff: "2026-10-17T12:15:00Z",
    generatedAt: "2026-10-17T12:16:00Z",
    status: "published",
    freshness: "Fresh",
    collectorConnected: true,
    reconciliation: "Reconciling",
    servesSnapshotId: "syn-r43",
    note: "Published shortly after load to show held updates.",
  },
  {
    id: "syn-r40-stale",
    revision: 40,
    cutoff: "2026-10-13T06:00:00Z",
    generatedAt: "2026-10-13T06:04:00Z",
    status: "published",
    freshness: "Stale",
    collectorConnected: false,
    reconciliation: "Not reconciled",
    servesSnapshotId: "syn-r40-stale",
    note: "Stale snapshot with a disconnected collector.",
  },
  {
    id: "syn-r44-rebuilding",
    revision: 44,
    cutoff: "2026-10-17T12:30:00Z",
    generatedAt: "2026-10-17T12:31:00Z",
    status: "rebuilding",
    freshness: "Reconciling",
    collectorConnected: true,
    reconciliation: "Reconciling",
    servesSnapshotId: "syn-r42",
    note: "Rebuilding after a policy change; r42 data is served meanwhile.",
  },
  {
    id: "syn-r45-failed",
    revision: 45,
    cutoff: "2026-10-17T12:45:00Z",
    generatedAt: "2026-10-17T12:46:00Z",
    status: "failed",
    freshness: "Error",
    collectorConnected: true,
    reconciliation: "Not reconciled",
    servesSnapshotId: "syn-r45-failed",
    note: "A snapshot whose read fails, to show the failure state.",
  },
];

export const initialLatestSnapshotId = "syn-r42";
export const deferredLatestSnapshotId = "syn-r43";

function cov(
  state: Coverage["state"],
  source: Coverage["source"],
  scopeId: string,
  knownStart: string | null,
  extra: Partial<Pick<Coverage, "missingPages" | "permissionsMissing" | "sourceErrors" | "lastSuccessfulSync">> = {},
): Coverage {
  return {
    schemaVersion: "leaderboard/v1",
    state,
    source,
    scopeId,
    windowStart: knownStart,
    windowEnd: "2026-10-17T12:00:00Z",
    knownStart,
    lastSuccessfulSync: extra.lastSuccessfulSync ?? "2026-10-17T11:58:00Z",
    sourceWatermark: "2026-10-17T11:55:00Z",
    missingPages: extra.missingPages ?? 0,
    permissionsMissing: extra.permissionsMissing ?? [],
    sourceErrors: extra.sourceErrors ?? [],
  };
}

export const coverage: RepoCoverage[] = [
  {
    repoId: R,
    coverage: [
      cov("complete", "github_rest", R, "2026-01-01T00:00:00Z"),
      cov("complete", "reviewed_receipt", R, "2026-06-01T00:00:00Z"),
      cov("partial", "github_graphql", R, "2026-08-01T00:00:00Z", {
        sourceErrors: ["Project field history before 2026-08-01 is not retained by the source."],
      }),
    ],
  },
  {
    repoId: W,
    coverage: [
      cov("partial", "github_rest", W, "2026-03-01T00:00:00Z", {
        missingPages: 2,
        sourceErrors: ["2 timeline pages failed; a retry is scheduled."],
      }),
      cov("unknown", "reviewed_receipt", W, null),
      cov("unknown", "github_graphql", W, null),
    ],
  },
  {
    repoId: L,
    coverage: [
      cov("complete", "github_rest", L, "2026-07-01T00:00:00Z"),
      cov("unknown", "reviewed_receipt", L, null),
      cov("unavailable", "github_graphql", L, null, {
        permissionsMissing: ["Projects (read)"],
        lastSuccessfulSync: null,
      }),
    ],
  },
];
