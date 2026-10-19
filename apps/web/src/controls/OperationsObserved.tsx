import React from "react";
import type { OperatorHealthResponse, OperatorReplayResultResponse } from "./operations-observed.ts";

const value = (item: string | number | null) => item ?? "Unknown";
const seconds = (item: number | null) =>
  item === null ? "Unknown" : `${item.toLocaleString("en", { maximumFractionDigits: 3 })} seconds`;

function Fields({ rows }: { rows: Array<[string, string | number | null]> }) {
  return (
    <dl className="definition-list">
      {rows.map(([label, item]) => (
        <React.Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value(item)}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function Publications({ publications }: { publications: OperatorReplayResultResponse["publications"] }) {
  return (
    <ul aria-label="Verified publication revisions">
      {publications.map((publication) => (
        <li key={publication.scopeKey}>
          <p>Scope {publication.scopeKey}</p>
          <p>
            Revision {publication.revision} · snapshot <code>{publication.snapshotId}</code>
          </p>
        </li>
      ))}
    </ul>
  );
}

const collectorReasons: Record<string, string> = {
  no_current_attempt: "No usable collection attempt is retained for this source generation.",
  source_read_failed: "The last collector read failed. This does not diagnose a physical network connection.",
  source_schema_drift: "The last collection encountered an unsupported source shape.",
  source_commit_failed: "The last collection could not retain its result.",
  collection_failed: "The last collection failed.",
  attempt_overdue: "The latest attempt is older than the configured freshness budget.",
  partial_collection: "A recent collection attempt is incomplete.",
  completion_time_unknown: "The completion or reconciliation time is unknown.",
  reconciliation_gap: "A recent completed window leaves a gap after the retained reconciliation watermark.",
  reconciliation_overdue: "The last complete reconciliation is older than the configured freshness budget.",
  completed_empty_window: "A fresh complete source window reported zero items and expected zero items.",
  source_count_unknown: "The complete source count is unknown or does not match the retained item count.",
  completed_observed_window: "A fresh complete source window retained its expected items.",
};

export function OperatorHealthView({ health }: { health: OperatorHealthResponse }) {
  return (
    <section className="operator-observation" aria-label="Operator health observations">
      <h3>Operator health observations</h3>
      <p>
        Observed at {health.asOf}. Freshness budget: {health.freshnessBudgetSeconds} seconds. Refresh explicitly to read
        later progress.
      </p>
      <p role="status">Collector state: {health.collector.state}.</p>
      <p>An empty inbox alone cannot establish a quiet source. Unknown values remain unknown.</p>
      {health.collector.families.map((family) => (
        <section key={family.family} aria-label={`Collector ${family.family}`}>
          <h4>
            {family.family}: {family.state}
          </h4>
          <p>{collectorReasons[family.reason]}</p>
          <Fields
            rows={[
              ["Last attempt (UTC)", family.lastAttemptAt],
              ["Last complete success (UTC)", family.lastSuccessAt],
              ["Reconciled through (UTC)", family.reconciledThrough],
              ["Latest attempt items", family.items],
              ["Latest attempt expected items", family.expectedItems],
            ]}
          />
        </section>
      ))}
      <h4>Retained intake</h4>
      <p>
        Counts cover retained delivery envelopes in this repository. Expired payloads do not establish complete delivery
        history.
      </p>
      <Fields
        rows={[
          ["Retained envelopes", health.intake.retained],
          ["Pending intake", health.intake.pending],
          ["Leased intake", health.intake.leased],
          ["Quarantined intake", health.intake.quarantined],
          ["Oldest unfinished intake (UTC)", health.intake.oldestPendingAt],
          ["Intake queue age", seconds(health.intake.queueAgeSeconds)],
          ["Latest received delivery (UTC)", health.intake.latestReceivedAt],
          ["Latest delivery source time (UTC)", health.intake.latestSourceAt],
          ["Source-to-intake lag", seconds(health.intake.lagSeconds)],
        ]}
      />
      <h4>Publication progress</h4>
      <p>
        Publication state: {health.publication.state}. Only a verified publication supplies its revisions and completion
        delay.
      </p>
      <Fields
        rows={[
          ["Pending publication", health.publication.pending],
          ["Leased publication", health.publication.leased],
          ["Quarantined publication", health.publication.quarantined],
          ["Oldest unfinished publication (UTC)", health.publication.oldestPendingAt],
          ["Publication queue age", seconds(health.publication.queueAgeSeconds)],
          ["Verified completion (UTC)", health.publication.completedAt],
          ["Received-to-publication delay", seconds(health.publication.delaySeconds)],
          ["Publication policy", health.publication.policyVersion],
        ]}
      />
      {health.publication.state === "verified" && <Publications publications={health.publication.publications} />}
      <h4>Source quota observations</h4>
      <p>
        These are retained response observations for the authorized source pool. They are not an exact global remaining
        balance or a collector heartbeat. Reading them makes no source request.
      </p>
      {health.quota.state === "unavailable" ? (
        <p>Quota observations are unavailable.</p>
      ) : (
        <>
          <details>
            <summary>Quota observation scope</summary>
            <p>{health.quota.scopeKey}</p>
          </details>
          {health.quota.resources.map((resource) => (
            <section key={resource.resource} aria-label={`Quota ${resource.resource}`}>
              <h5>
                {resource.resource}: {resource.state}
              </h5>
              {resource.observation ? (
                <Fields
                  rows={[
                    ["Response observed (UTC)", resource.observation.observedAt],
                    ["HTTP response status", resource.observation.responseStatus],
                    ["Observed limit", resource.observation.limit],
                    ["Observed remaining", resource.observation.remaining],
                    ["Observed used", resource.observation.used],
                    ["Reported reset (UTC)", resource.observation.resetAt],
                    ["Reported retry delay", seconds(resource.observation.retryAfterSeconds)],
                  ]}
                />
              ) : (
                <p>No usable response observation is available for this resource.</p>
              )}
            </section>
          ))}
        </>
      )}
    </section>
  );
}

const replayReasons: Record<OperatorReplayResultResponse["reason"], string> = {
  legacy_unbound: "This older audit has no retained binding to a processing lease. Its publication result is unknown.",
  awaiting_intake: "The audited replay is queued and has not completed intake.",
  intake_in_progress: "An intake worker holds the replay. Completion is not confirmed.",
  intake_failed: "The replay intake is quarantined. Inspect diagnostics before deciding on another audited replay.",
  later_replay_queued: "A later replay superseded this queued attempt. Inspect that replay's receipt.",
  no_new_publication_notice:
    "Intake completed without creating a new publication notice. An earlier notice is not attributed to this replay.",
  awaiting_publication: "Intake completed and its publication notice is waiting for a publisher.",
  publication_in_progress: "A publisher holds this replay's notice. Publication is not confirmed.",
  publication_failed: "The publication notice is quarantined. Publication is not confirmed.",
  source_generation_changed: "The source generation changed. This result cannot expose old publication references.",
  result_binding_unavailable: "The retained processing binding or its timestamps cannot establish this result.",
  publication_verification_unavailable:
    "The recorded publication cannot be verified against current source and private publication authority.",
  verified_publication:
    "The actual publication ledger, snapshot contents and current source and private authority verify these revisions. Identical contents may retain an existing revision.",
};

export function OperatorReplayResultView({ result }: { result: OperatorReplayResultResponse }) {
  return (
    <section className="operator-observation" aria-label="Verified replay result">
      <h4>Replay result: {result.status}</h4>
      <p role="status">{replayReasons[result.reason]}</p>
      <p>
        Receipt {result.receiptId} · delivery {result.deliveryId}. Refresh explicitly to read later progress.
      </p>
      <Fields
        rows={[
          ["Queued (UTC)", result.queuedAt],
          ["Processed (UTC)", result.processedAt],
          ["Queued-to-processing delay", seconds(result.processingDelaySeconds)],
          ["Verified publication completion (UTC)", result.publicationCompletedAt],
          ["Queued-to-publication delay", seconds(result.publicationDelaySeconds)],
          ["Queued replay policy", result.replayPolicyVersion],
          ["Verified publication policy", result.publicationPolicyVersion],
        ]}
      />
      {result.status === "published" && <Publications publications={result.publications} />}
    </section>
  );
}
