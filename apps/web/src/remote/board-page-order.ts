import type { Board } from "./client.ts";

export const boardPageOrders = [
  { value: "api", label: "Original API order" },
  { value: "rank_ascending", label: "Rank: lowest first" },
  { value: "rank_descending", label: "Rank: highest first" },
  { value: "contributor_ascending", label: "Contributor: A to Z" },
  { value: "contributor_descending", label: "Contributor: Z to A" },
  { value: "value_ascending", label: "Published value: lowest first" },
  { value: "value_descending", label: "Published value: highest first" },
] as const;
export type BoardPageOrder = (typeof boardPageOrders)[number]["value"];
type Row = Board["rows"][number];
const labels = new Intl.Collator("en", { sensitivity: "base" });

export const boardContributorName = (row: Row) => row.actor.displayName ?? row.actor.login ?? row.actorId;

export function orderBoardPage(rows: readonly Row[], order: BoardPageOrder): Row[] {
  if (order === "api") return [...rows];
  const direction = order.endsWith("_descending") ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      let compared: number;
      if (order.startsWith("contributor_")) {
        compared = labels.compare(boardContributorName(a.row), boardContributorName(b.row)) * direction;
      } else {
        const av = order.startsWith("rank_") ? a.row.rank : a.row.result.value;
        const bv = order.startsWith("rank_") ? b.row.rank : b.row.result.value;
        // Missing values stay last in either direction. Zero remains a measured value.
        if (av == null) compared = bv == null ? 0 : 1;
        else if (bv == null) compared = -1;
        else compared = (av < bv ? -1 : av > bv ? 1 : 0) * direction;
      }
      // Equal display values retain the API's order; this never calculates new ranks.
      return compared || a.index - b.index;
    })
    .map(({ row }) => row);
}

export function boardColumnOrder(order: BoardPageOrder, column: "rank" | "contributor" | "value") {
  return order === `${column}_ascending` ? "ascending" : order === `${column}_descending` ? "descending" : "none";
}
