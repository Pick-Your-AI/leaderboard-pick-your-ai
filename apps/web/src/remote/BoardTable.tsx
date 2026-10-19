import React, { useId, useMemo, useState } from "react";
import { uiHref, type Board, type Selection } from "./client.ts";
import { proofHref } from "./proof.ts";
import { RankMovementValue } from "./RankComparison.tsx";
import { RankingPresentation } from "./RankingPresentation.tsx";
import { PhysicalContext, isPhysicalContextMetric } from "./PhysicalContext.tsx";
import {
  boardColumnOrder,
  boardContributorName,
  boardPageOrders,
  orderBoardPage,
  type BoardPageOrder,
} from "./board-page-order.ts";

export function BoardTable({
  board,
  selected,
  path,
  renderValue,
}: {
  board: Board;
  selected: Selection;
  path: string;
  renderValue: (row: Board["rows"][number]) => React.ReactNode;
}) {
  const [order, setOrder] = useState<BoardPageOrder>("api");
  const tableId = useId(),
    helpId = useId();
  const rows = useMemo(() => orderBoardPage(board.rows, order), [board.rows, order]);
  const physical = isPhysicalContextMetric(board.metric.id);
  return (
    <>
      <RankingPresentation board={board} />
      <div className="remote-filters">
        <label>
          Sort current page
          <select
            value={order}
            aria-controls={tableId}
            aria-describedby={helpId}
            onChange={(event) => {
              const next = boardPageOrders.find((option) => option.value === event.currentTarget.value);
              if (next) setOrder(next.value);
            }}
          >
            {boardPageOrders.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p id={helpId}>
        Sorting changes only these {board.rows.length} loaded rows, not the complete board. API ranks, values and
        evidence stay unchanged. Rank and value sorts keep missing entries last; ties retain their original order.
        Downloads and the next cursor page use the original API order. Tied ranks may continue on another page. A new
        page or selection resets this control.
      </p>
      <p role="status" className="small">
        Current page order: {boardPageOrders.find((option) => option.value === order)!.label}.
      </p>
      <div className="table-region" role="region" aria-label="Published contributions" tabIndex={0}>
        <table id={tableId} className="board-table" role="table">
          <caption>
            {board.metric.name} · {board.metric.definition.unit} · {board.totalRows} published rows; this page has{" "}
            {board.rows.length}
          </caption>
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader" aria-sort={boardColumnOrder(order, "rank")}>
                Rank
              </th>
              {board.comparison && (
                <th scope="col" role="columnheader">
                  Rank movement
                </th>
              )}
              <th scope="col" role="columnheader" aria-sort={boardColumnOrder(order, "contributor")}>
                Contributor
              </th>
              <th scope="col" role="columnheader" aria-sort={boardColumnOrder(order, "value")}>
                Value and state
              </th>
              <th scope="col" role="columnheader">
                {physical ? "Evidence and change size" : "Evidence"}
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {rows.map((row) => (
              <tr key={row.actorId} role="row">
                <td role="cell" data-label="Rank">
                  {row.rank === null ? "Unranked" : row.rank}
                </td>
                {board.comparison && (
                  <td role="cell" data-label="Rank movement">
                    <RankMovementValue value={row.movement} />
                  </td>
                )}
                <th role="rowheader" scope="row">
                  <a data-api-nav href={uiHref(`/contributors/${encodeURIComponent(row.actorId)}`, selected)}>
                    {boardContributorName(row)}
                  </a>
                </th>
                <td role="cell" data-label="Value">
                  {renderValue(row)}
                </td>
                <td role="cell" data-label={physical ? "Evidence and change size" : "Evidence"}>
                  {row.evidenceIds.length
                    ? row.evidenceIds.map((id) => (
                        <p key={id}>
                          <a data-api-proof href={proofHref(path, selected, id)}>
                            {id}
                          </a>
                        </p>
                      ))
                    : "No evidence IDs supplied"}
                  {physical && <PhysicalContext context={row.physicalContext} metricId={board.metric.id} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
