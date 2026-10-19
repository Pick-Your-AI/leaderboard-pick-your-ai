import React from "react";
import type { Board } from "./client.ts";

export function RankingPresentation({ board }: { board: Board }) {
  const receipt = board.rankingPresentation;
  if (!receipt)
    return (
      <p className="small" aria-label="Ranking presentation policy">
        This retained snapshot has no recorded cohort display policy. Its legacy ranks do not establish the current
        five-contributor convention; comparable movement is unavailable.
      </p>
    );
  return (
    <section aria-label="Ranking presentation policy" className="small">
      <p>
        {receipt.state === "ranked"
          ? "This cohort qualifies for displayed ranks."
          : receipt.state === "small_cohort"
            ? "Small cohort: values and evidence remain visible without ranks or rank movement."
            : "This metric's approved policy does not enable ranking."}
      </p>
      <p>
        {receipt.comparableContributors} comparable contributors and {receipt.unrankableContributors} unrankable
        contributors among {receipt.totalContributors} currently public rows, counted before pagination. Policy{" "}
        {receipt.version} requires at least {receipt.minimumComparableContributors} comparable contributors. Existing
        approved numeric values, including zero and partial results, keep their source-coverage labels. Missing values
        do not become zero. This is a display convention, not a privacy or statistical assurance.
      </p>
    </section>
  );
}
