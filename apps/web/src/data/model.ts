/**
 * Prototype view model (LB-13.04). These shapes are what the public screens
 * need from the read API (LB-12.01/12.02); they are local to the web app until
 * that API contract is published. Every field maps onto the v1 leaderboard
 * contracts, and tests check that mapping with the contract schemas.
 */
import type { Actor, Coverage } from "@pick-your-ai/contracts";

export type EvidenceState =
  | "observed"
  | "provisional"
  | "qualified"
  | "reviewed"
  | "excluded"
  | "not_measured";

export type Freshness = "Fresh" | "Polling" | "Delayed" | "Reconciling" | "Stale" | "Error";

export interface Repository {
  id: string;
  name: string;
}

export interface ProgramProject {
  id: string;
  name: string;
  repoIds: string[];
  note: string;
}

export interface Person {
  actorId: string;
  login: string;
  displayName: string;
  actor: Actor;
  /** Suppressed people are omitted from every public surface. */
  publicState: "visible" | "suppressed" | "deleted";
  fixtureNote: string;
}

export interface LineBreakdown {
  source: number;
  docs: number;
  tests: number;
  generated: number;
  vendor: number;
  lockfile: number;
  other: number;
}

export const excludedLineCategories = ["generated", "vendor", "lockfile"] as const;

export interface CorrectionEntry {
  correctionId: string;
  at: string;
  summary: string;
}

export interface ContributionRecord {
  id: string;
  title: string;
  repoId: string;
  projectIds: string[];
  metricIds: string[];
  actorId: string | null;
  role: "author" | "coauthor" | "reviewer" | "merger" | "triager" | "reporter" | "resolver" | "automation";
  evidence: EvidenceState;
  /** The source activity time. */
  occurredAt: string;
  /** When ingestion first observed the activity. */
  observedAt: string;
  /** When a stated rule accepted the outcome, if one did. */
  acceptedAt: string | null;
  acceptanceRule: string | null;
  visibility: "public" | "unavailable";
  sourceUrl: string | null;
  adapter: "github_webhook" | "github_rest" | "github_graphql" | "reviewed_receipt";
  exclusionReason: string | null;
  corrections: CorrectionEntry[];
  lines: LineBreakdown | null;
  fixtureNote: string;
}

export interface SnapshotMeta {
  id: string;
  revision: number;
  cutoff: string;
  generatedAt: string;
  status: "published" | "rebuilding" | "failed";
  freshness: Freshness;
  collectorConnected: boolean;
  reconciliation: "Reconciled" | "Reconciling" | "Not reconciled";
  /** Snapshot whose data is served while this one rebuilds. */
  servesSnapshotId: string;
  note: string;
}

export interface RepoCoverage {
  repoId: string;
  coverage: Coverage[];
}

export interface FixtureMetric {
  /** Which evidence states form the ranked value. */
  rankStates: EvidenceState[];
  valueKind: "count" | "lines";
  explanation: string;
}
