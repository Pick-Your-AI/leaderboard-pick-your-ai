import React from "react";
import type { MetricDefinition, PublicParticipation } from "@pick-your-ai/contracts";
import { uiHref, type Selection } from "./client.ts";

export function ContributorParticipation({
  value,
  selected,
  metrics,
}: {
  value: PublicParticipation | null;
  selected: Selection;
  metrics: MetricDefinition[];
}) {
  return (
    <section aria-labelledby="participation-title">
      <h3 id="participation-title">Participation in this snapshot</h3>
      <p>
        Calendar weeks start on Monday in UTC. These are descriptive counts of public qualifying evidence for each
        measure. Pending work, acceptance ratios and review-wait statistics are separate; these counts do not change
        ranks.
      </p>
      <p>
        Newcomer status is unknown: reviewed organization-wide history is unavailable. The earliest dated evidence below
        is limited to this snapshot and selection; it is not a joining date or proof that no earlier work exists.
      </p>
      {!value ? (
        <p>Participation data is unavailable for this publication.</p>
      ) : (
        <>
          <p>
            {value.denominatorWeeks === null
              ? "All-time selection has no calendar-week denominator."
              : `${value.denominatorWeeks} calendar weeks intersect the selected start-inclusive, end-exclusive window.`}
          </p>
          {value.metrics.length === 0 ? (
            <p>
              No qualifying participation summary is available for this selection. This does not establish zero
              activity.
            </p>
          ) : (
            <ul>
              {value.metrics.map((entry) => (
                <li key={entry.metricId}>
                  <h4>{metrics.find((metric) => metric.id === entry.metricId)?.name ?? entry.metricId}</h4>
                  <p>
                    {entry.activeWeeks === null
                      ? "Active weeks unknown"
                      : `${entry.activeWeeks} active calendar ${entry.activeWeeks === 1 ? "week" : "weeks"}`}
                    {entry.activeWeeks !== null && value.denominatorWeeks !== null
                      ? ` out of ${value.denominatorWeeks}`
                      : ""}
                    {`; ${entry.state === "measured" ? "complete selected coverage" : entry.state === "partial" ? "partial evidence coverage" : "insufficient dated evidence"}.`}
                  </p>
                  <p>
                    {entry.datedEvidenceCount} dated evidence records; {entry.unknownDateEvidenceCount} with unknown
                    metric dates.
                  </p>
                  {entry.earliestDatedEvidence && (
                    <p>
                      Earliest dated qualifying evidence in this selection:{" "}
                      <a
                        data-api-nav
                        href={uiHref(
                          `/contributions/${encodeURIComponent(entry.earliestDatedEvidence.contributionId)}`,
                          selected,
                          { cursor: null },
                        )}
                      >
                        <time dateTime={entry.earliestDatedEvidence.effectiveAt}>
                          {entry.earliestDatedEvidence.effectiveAt}
                        </time>
                      </a>
                      . Observed{" "}
                      {entry.earliestDatedEvidence.observedAt === null ? (
                        "time unknown"
                      ) : (
                        <time dateTime={entry.earliestDatedEvidence.observedAt}>
                          {entry.earliestDatedEvidence.observedAt}
                        </time>
                      )}
                      .
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
