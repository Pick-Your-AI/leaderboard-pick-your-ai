import React from "react";
import type { MetricDefinition } from "@pick-your-ai/contracts";
import type { Board, BoardRow } from "../data/source.ts";
import { registry, releaseEligibilityLabels } from "../data/registry.ts";
import { formatNumber, plural } from "../lib/format.ts";
import { cutWithTies } from "../lib/ranking.ts";
import type { Density } from "../lib/scope.ts";
import { Link, ScopedLink } from "../lib/router.tsx";
import { CountLink } from "./CountLink.tsx";
import { PersonName, publicPersonLabel } from "./Receipt.tsx";

function ordinal(rank: number): string {
  const suffix =
    rank % 10 === 1 && rank % 100 !== 11
      ? "st"
      : rank % 10 === 2 && rank % 100 !== 12
        ? "nd"
        : rank % 10 === 3 && rank % 100 !== 13
          ? "rd"
          : "th";
  return `${rank}${suffix}`;
}

export function RankCell({ row }: { row: Pick<BoardRow, "rank" | "tied"> }) {
  return (
    <>
      <span aria-hidden="true">{row.tied ? `=${row.rank}` : row.rank}</span>
      <span className="visually-hidden">{row.tied ? `Tied ${ordinal(row.rank)}` : ordinal(row.rank)}</span>
    </>
  );
}

export type BoardSort = "rank" | "name";

export function BoardTable({
  board,
  density,
  sort,
  limit,
  sortHref,
  proofHref,
  countHref,
  moreHref,
}: {
  board: Board;
  density: Density;
  sort: BoardSort;
  limit: number;
  sortHref: (sort: BoardSort) => string;
  proofHref: (row: BoardRow) => string;
  countHref: (row: BoardRow) => string;
  moreHref: string;
}) {
  const unit = board.metric.definition.unit;
  const lines = board.fixture?.valueKind === "lines";
  const { shown, remaining } = cutWithTies(board.rows, limit);
  const rows = sort === "name" ? [...shown].sort((a, b) => a.person.login.localeCompare(b.person.login)) : shown;

  const sortHeader = (key: BoardSort, label: string) => (
    <th scope="col" role="columnheader" aria-sort={sort === key ? "ascending" : "none"}>
      <Link to={sortHref(key)} className="sort-link">
        {label}
        <span className="visually-hidden">{sort === key ? ", sorted" : ", select to sort"}</span>
        <span aria-hidden="true">{sort === key ? " ▲" : " ↕"}</span>
      </Link>
    </th>
  );

  return (
    <div className={`table-region density-${density}`} role="region" aria-labelledby="board-caption" tabIndex={0}>
      <table className="board-table" role="table">
        <caption id="board-caption">
          {board.metric.name}, ranked by {unit} ({board.fixture?.rankStates.join(" or ")} only). Pending work is shown
          separately and not ranked. Ties share a rank; order within a tie is alphabetical and has no effect.
        </caption>
        <thead role="rowgroup">
          <tr role="row">
            {sortHeader("rank", "Rank")}
            {sortHeader("name", "Contributor")}
            <th scope="col" role="columnheader" className="numeric">
              {lines ? "Eligible lines" : "Ranked value"}
            </th>
            <th scope="col" role="columnheader" className="numeric">
              Pending, not ranked
            </th>
            {lines && (
              <>
                <th scope="col" role="columnheader" className="numeric">
                  Source
                </th>
                <th scope="col" role="columnheader" className="numeric">
                  Docs
                </th>
                <th scope="col" role="columnheader" className="numeric">
                  Tests
                </th>
                <th scope="col" role="columnheader" className="numeric">
                  Excluded lines
                </th>
              </>
            )}
            <th scope="col" role="columnheader">
              Evidence
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((row) => (
            <tr key={row.person.actorId} role="row">
              <td role="cell" className="rank" data-label="Rank">
                <RankCell row={row} />
              </td>
              <th scope="row" role="rowheader" data-label="Contributor">
                <PersonName person={row.person} />
              </th>
              <td role="cell" className="numeric value" data-label={lines ? "Eligible lines" : "Ranked value"}>
                <CountLink
                  to={countHref(row)}
                  label={`${formatNumber(row.value)} ${unit}, ${publicPersonLabel(row.person)}, ${board.metric.name}`}
                >
                  {formatNumber(row.value)} <span className="unit">{unit}</span>
                </CountLink>
              </td>
              <td role="cell" className="numeric" data-label="Pending, not ranked">
                {row.pending > 0 ? (
                  <CountLink
                    to={countHref(row)}
                    label={`${plural(row.pending, "pending contribution")}, ${publicPersonLabel(row.person)}`}
                  >
                    {formatNumber(row.pending)}
                  </CountLink>
                ) : (
                  <span className="muted">None</span>
                )}
              </td>
              {lines && row.lines && (
                <>
                  <td role="cell" className="numeric" data-label="Source">
                    <CountLink
                      to={countHref(row)}
                      label={`${formatNumber(row.lines.source)} source lines, ${publicPersonLabel(row.person)}`}
                    >
                      {formatNumber(row.lines.source)}
                    </CountLink>
                  </td>
                  <td role="cell" className="numeric" data-label="Docs">
                    <CountLink
                      to={countHref(row)}
                      label={`${formatNumber(row.lines.docs)} docs lines, ${publicPersonLabel(row.person)}`}
                    >
                      {formatNumber(row.lines.docs)}
                    </CountLink>
                  </td>
                  <td role="cell" className="numeric" data-label="Tests">
                    <CountLink
                      to={countHref(row)}
                      label={`${formatNumber(row.lines.tests)} test lines, ${publicPersonLabel(row.person)}`}
                    >
                      {formatNumber(row.lines.tests)}
                    </CountLink>
                  </td>
                  <td role="cell" className="numeric" data-label="Excluded lines">
                    <CountLink
                      to={countHref(row)}
                      label={`${formatNumber(row.lines.generated + row.lines.vendor + row.lines.lockfile)} excluded lines, ${publicPersonLabel(row.person)}`}
                    >
                      {formatNumber(row.lines.generated + row.lines.vendor + row.lines.lockfile)}
                    </CountLink>
                  </td>
                </>
              )}
              <td role="cell" data-label="Evidence">
                <Link to={proofHref(row)} className="proof-link">
                  Proof
                  <span className="visually-hidden">
                    {" "}
                    for {publicPersonLabel(row.person)}:{" "}
                    {plural(row.ranked.length + row.pendingRecords.length, "contribution")}
                  </span>
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {remaining > 0 && (
        <p className="table-more">
          Showing {shown.length} of {board.rows.length} ranked contributors (ties at the boundary are never split).{" "}
          <Link to={moreHref}>Show the next page</Link>
        </p>
      )}
    </div>
  );
}

export function MethodDisclosure({ metric }: { metric: MetricDefinition }) {
  const definition = metric.definition;
  return (
    <details className="method">
      <summary>How this is counted</summary>
      <dl>
        <dt>Counts</dt>
        <dd>{metric.counting_rule}</dd>
        <dt>Unit</dt>
        <dd>{definition.unit}</dd>
        <dt>Attributed to</dt>
        <dd>{metric.attribution}</dd>
        <dt>Source</dt>
        <dd>{metric.source}</dd>
        <dt>Date basis</dt>
        <dd className="mono">{metric.event_clock}</dd>
        <dt>Denominator</dt>
        <dd>{definition.denominator.definition}</dd>
        <dt>Release</dt>
        <dd>{releaseEligibilityLabels[definition.release_eligibility] ?? definition.release_eligibility}</dd>
        <dt>Policy</dt>
        <dd className="mono">
          {registry.contract_version} · {registry.policy_version}
        </dd>
      </dl>
      <p>
        <ScopedLink to={`/methodology/${metric.id}`}>Full method sheet</ScopedLink>
      </p>
    </details>
  );
}
