import React, { useState } from "react";
import { compareSourceInstants, type Coverage } from "@pick-your-ai/contracts";

const pageSize = 20;
function Instant({ value }: { value: string | null }) {
  return value === null ? <>Unknown</> : <time dateTime={value}>{value}</time>;
}

function compareBoundaries(coverage: Coverage[], fields: ("windowStart" | "windowEnd" | "knownStart")[]) {
  let different = false;
  let unknown = false;
  for (const field of fields) {
    let first: string | null = null;
    for (const record of coverage) {
      const value = record[field];
      if (value === null) {
        unknown = true;
        continue;
      }
      const comparison = compareSourceInstants(value, first ?? value);
      if (!Number.isFinite(comparison)) {
        unknown = true;
        continue;
      }
      if (first === null) first = value;
      else if (comparison !== 0) different = true;
    }
  }
  if (different) return unknown ? "Different known dates; some dates remain unknown." : "Different known dates.";
  return unknown ? "Unknown; the available dates do not establish a matching baseline." : "Matching reported dates.";
}

/** Only the selected response's sanitized coverage is shown; no coverage is inferred. */
export function SnapshotCoverage({
  coverage,
  snapshotId,
  expanded = false,
  correctionHref,
}: {
  coverage: Coverage[];
  snapshotId: string;
  expanded?: boolean;
  correctionHref: string;
}) {
  const [requestedPage, setPage] = useState(0);
  const lastPage = Math.max(0, Math.ceil(coverage.length / pageSize) - 1);
  const page = Math.min(requestedPage, lastPage);
  const start = page * pageSize;
  const rows = coverage.slice(start, start + pageSize);
  return (
    <details className="method" open={expanded}>
      <summary>Snapshot source coverage</summary>
      <p>
        These source records belong to snapshot <strong>{snapshotId}</strong>. A current successful collection does not
        fill gaps in this snapshot's history. Window ends are exclusive.
      </p>
      <p>
        Coverage states describe the reported source scope. A completeness percentage is unavailable: the response does
        not supply a total expected source population. Zero known missing pages alone does not establish complete
        coverage or zero activity.
      </p>
      <dl>
        <dt>Observed since</dt>
        <dd>
          Unknown. These source records do not supply a first-observation date. The known history start below is a
          separate boundary.
        </dd>
        <dt>Imported or pre-organization history</dt>
        <dd>Unknown. These source records do not report import origin or when a repository joined the organization.</dd>
      </dl>
      {coverage.length > 1 && (
        <div role="note" aria-label="Reported history baselines">
          <dl>
            <dt>Reported source windows</dt>
            <dd>{compareBoundaries(coverage, ["windowStart", "windowEnd"])}</dd>
            <dt>Known history baselines</dt>
            <dd>{compareBoundaries(coverage, ["knownStart"])}</dd>
          </dl>
          <p>
            This comparison includes every supplied source record, across all pages. Matching dates alone do not
            establish complete coverage or a valid rank comparison.
          </p>
        </div>
      )}
      {coverage.length === 0 ? (
        <p>No source coverage records were supplied for this snapshot. Coverage is unknown.</p>
      ) : (
        <>
          <p role="status" aria-live="polite">
            Source records {start + 1}–{start + rows.length} of {coverage.length}.
          </p>
          <div className="table-region" role="region" aria-label="Snapshot source coverage records" tabIndex={0}>
            <table className="data-table" role="table">
              <caption>Reported source coverage for snapshot {snapshotId}</caption>
              <thead role="rowgroup">
                <tr role="row">
                  <th scope="col" role="columnheader">
                    Source and scope
                  </th>
                  <th scope="col" role="columnheader">
                    Coverage and history
                  </th>
                  <th scope="col" role="columnheader">
                    Reconciliation
                  </th>
                  <th scope="col" role="columnheader">
                    Known gaps
                  </th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {rows.map((record, index) => (
                  <tr key={`${record.source}:${record.scopeId}:${start + index}`} role="row">
                    <th scope="row" role="rowheader">
                      {record.source}
                      <p>Scope: {record.scopeId ?? "Unknown"}</p>
                    </th>
                    <td role="cell" data-label="Coverage and history">
                      <p>Reported state: {record.state}</p>
                      <p>
                        Window start: <Instant value={record.windowStart} />
                      </p>
                      <p>
                        Window end (exclusive): <Instant value={record.windowEnd} />
                      </p>
                      <p>
                        History known since: <Instant value={record.knownStart} />
                      </p>
                    </td>
                    <td role="cell" data-label="Reconciliation">
                      <p>
                        Last successful sync: <Instant value={record.lastSuccessfulSync} />
                      </p>
                      <p>
                        Reconciled through: <Instant value={record.sourceWatermark} />
                      </p>
                    </td>
                    <td role="cell" data-label="Known gaps">
                      <p>Known missing pages: {record.missingPages}</p>
                      <p>Missing permissions: {record.permissionsMissing.join("; ") || "None reported"}</p>
                      <p>Source errors: {record.sourceErrors.join("; ") || "None reported"}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {coverage.length > pageSize && (
            <nav aria-label="Source coverage record pages" className="inline-list">
              <button
                type="button"
                className="button button-ghost"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                Previous source records
              </button>
              <button
                type="button"
                className="button button-ghost"
                disabled={page === lastPage}
                onClick={() => setPage(page + 1)}
              >
                Next source records
              </button>
            </nav>
          )}
        </>
      )}
      <p>
        <a data-api-nav href={correctionHref}>
          Corrections and privacy for this selection
        </a>
      </p>
    </details>
  );
}
