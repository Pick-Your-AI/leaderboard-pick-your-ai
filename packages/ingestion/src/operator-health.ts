import type { DispatchPublication } from "./outbox.js";
import type { SqlSession } from "./store.js";

export interface OperatorReadScope {
  repositoryId: number;
  installationId: string;
  generation: string;
}
export interface OperatorReadAuthority {
  repositoryId: number;
  sourceGeneration: string;
  policyVersion: string;
  authorityRevision: string;
}
/** HTTP consumers serialize and send inside this callback, while source locks
 * remain held. beforeSend must run after serialization and all async reauth. */
export type OperatorReadObserver<T> = (data: T, beforeSend: () => void) => Promise<void>;
export interface OperatorHealth {
  asOf: string;
  freshnessBudgetSeconds: number;
  collector: {
    state: "unknown" | "quiet" | "progress" | "collecting" | "disconnected" | "degraded" | "overdue";
    families: Array<{
      family: string;
      state: OperatorHealth["collector"]["state"];
      reason: string;
      lastAttemptAt: string | null;
      lastSuccessAt: string | null;
      reconciledThrough: string | null;
      items: number | null;
      expectedItems: number | null;
    }>;
  };
  intake: {
    retained: number | null;
    pending: number | null;
    leased: number | null;
    quarantined: number | null;
    oldestPendingAt: string | null;
    queueAgeSeconds: number | null;
    latestReceivedAt: string | null;
    latestSourceAt: string | null;
    lagSeconds: number | null;
  };
  publication: {
    pending: number | null;
    leased: number | null;
    quarantined: number | null;
    oldestPendingAt: string | null;
    queueAgeSeconds: number | null;
    state: "unknown" | "unavailable" | "verified";
    completedAt: string | null;
    delaySeconds: number | null;
    policyVersion: string | null;
    publications: DispatchPublication[];
  };
  quota: {
    state: "available" | "unavailable";
    scopeKey: string | null;
    resources: Array<{
      resource: "core" | "search" | "code_search" | "graphql" | "unknown";
      state: "observed" | "unknown" | "unavailable";
      observation: {
        observedAt: string;
        responseStatus: number;
        limit: number | null;
        remaining: number | null;
        used: number | null;
        resetAt: string | null;
        retryAfterSeconds: number | null;
      } | null;
    }>;
  };
}
export type ReadOperatorHealth = (
  tx: SqlSession,
  scope: OperatorReadScope,
) => Promise<{ health: OperatorHealth; confirmCurrent: () => boolean }>;
