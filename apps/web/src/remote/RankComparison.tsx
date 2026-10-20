import { useState } from "react";
import { selection, uiHref, type RankComparison, type RankMovement, type Selection } from "./client.ts";

const reasons: Record<string, string> = {
  comparison_unavailable: "The baseline is missing, expired, revoked or unavailable.",
  current_authority_changed: "Publication permissions changed.",
  mixed_computation_versions: "The computation versions differ.",
  ranking_presentation_policy_unknown: "At least one snapshot has no recorded cohort display policy.",
  ranking_presentation_policy_changed: "The snapshots' cohort display policies differ.",
  ranking_presentation_cohort_unavailable: "Both snapshots need at least five currently comparable contributors.",
  insufficient_evidence_history: "The retained evidence history is insufficient.",
  history_or_visible_cohort_changed: "The retained history or visible contributor cohort changed.",
  filtered_cohort_unavailable: "Movement is unavailable for a filtered contributor cohort.",
  different_metric: "The metric definitions differ.",
  mixed_policy_versions: "The policy or definition versions differ.",
  different_scope_or_window: "The periods or source scopes are incompatible.",
  insufficient_history: "Source coverage does not establish complete comparable history.",
  backfill_or_reconciliation: "Historical backfill or reconciliation changed.",
  reversed_snapshots: "The baseline’s retained cutoff is later than the displayed snapshot’s cutoff.",
  late_history: "Earlier evidence arrived after the baseline was published.",
  corrected_or_removed_evidence: "Evidence was corrected or removed.",
  unranked_metric: "A comparable ranked result is unavailable.",
};

export function RankMovementValue({ value }: { value: RankMovement | undefined }) {
  if (!value) return <>Comparison unavailable</>;
  if (value.state === "new_entrant") return <>New entrant; no previous rank</>;
  if (value.state === "unavailable")
    return (
      <>
        Unavailable:{" "}
        {Object.hasOwn(reasons, value.reason)
          ? reasons[value.reason]
          : "The service cannot establish compatible history (" + value.reason + ")."}
      </>
    );
  if (value.delta === 0) return <>Rank unchanged</>;
  const count = Math.abs(value.delta);
  return (
    <>
      {value.delta > 0 ? "Up " : "Down "}
      {count}
      {count === 1 ? " rank" : " ranks"}
    </>
  );
}

export function RankComparisonControls({
  value,
  selected,
  path,
  navigate,
}: {
  value: RankComparison | undefined;
  selected: Selection;
  path: string;
  navigate: (href: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="section" aria-label="Rank comparison">
      <h3>Rank comparison</h3>
      {value?.snapshotId && value.scope ? (
        <p>
          Baseline snapshot {value.snapshotId}. Generated {value.generatedAt}. Window{" "}
          {value.scope.start ?? "unbounded start"} → {value.scope.end ?? "unbounded end"}.
        </p>
      ) : value ? (
        <p>The requested baseline is unavailable under current publication controls.</p>
      ) : (
        <p>Select a baseline to compare ranks.</p>
      )}
      <details open={Boolean(selected.compare)}>
        <summary>Compare with a published snapshot</summary>
        <p>
          Enter an exact published snapshot ID. Leave both baseline date fields blank to reuse this board’s exact
          window. The service checks period, policy, coverage and evidence compatibility.
        </p>
        <form
          className="remote-filters"
          aria-label="Baseline selection"
          onSubmit={(event) => {
            event.preventDefault();
            const input = new FormData(event.currentTarget);
            const next = {
              ...selected,
              compare: String(input.get("compare") ?? "").trim() || null,
              compareStart: String(input.get("compareStart") ?? "").trim() || null,
              compareEnd: String(input.get("compareEnd") ?? "").trim() || null,
              cursor: null,
              proof: null,
            };
            try {
              const href = uiHref(path, next);
              selection(href.slice(href.indexOf("?") + 1), { comparison: true });
              setError(null);
              navigate(href);
            } catch {
              setError(
                "Use a valid snapshot ID and either leave both dates blank or enter a UTC interval of at most 366 days.",
              );
            }
          }}
        >
          <label>
            Baseline snapshot ID
            <input name="compare" maxLength={200} defaultValue={selected.compare ?? ""} />
          </label>
          <label>
            Baseline start (UTC)
            <input
              name="compareStart"
              placeholder="2026-09-17T00:00:00.000Z"
              defaultValue={selected.compareStart ?? ""}
            />
          </label>
          <label>
            Baseline end (UTC)
            <input name="compareEnd" placeholder="2026-10-17T00:00:00.000Z" defaultValue={selected.compareEnd ?? ""} />
          </label>
          <button className="button" type="submit">
            Compare ranks
          </button>
          {selected.compare && (
            <button
              className="button button-ghost"
              type="button"
              onClick={() =>
                navigate(
                  uiHref(path, { ...selected, compare: null, compareStart: null, compareEnd: null, cursor: null }),
                )
              }
            >
              Clear rank comparison
            </button>
          )}
        </form>
        {error && <p role="alert">{error}</p>}
      </details>
    </section>
  );
}
