import type { MetricRegistry } from "@pick-your-ai/contracts";

type GroupingPolicy = NonNullable<MetricRegistry["grouping_policies"]>[number];

export function describeMetricGrouping(grouping: GroupingPolicy): { label: string; detail: string } {
  switch (grouping.version) {
    case "triage-raw-state/v1":
      return {
        label: "Raw triage grouping",
        detail:
          `${grouping.version}; exact raw source state per actor/artifact in ${grouping.grouping_seconds}-second ` +
          `UTC buckets anchored at ${grouping.interval_origin}. Repeated identical state in one bucket counts once. ` +
          "Missing state/time remains unknown. No semantic classifier.",
      };
    case "triage-definition-day/v1":
      return {
        label: "Definition-day grouping",
        detail:
          `${grouping.version}; one actor and stable definition per UTC calendar day within its repository and ` +
          "definition kind. Creation, edits and reversals share the same daily unit. Observed changes use the " +
          "proven source day. Independently qualified receipts can use a separately selected source or acceptance " +
          "day; acceptance never supplies a missing raw event time. Missing identity or the selected clock stays " +
          "unknown. Grouping does not establish correctness or enable a view.",
      };
    case "public-stewardship-day/v1":
      return {
        label: "Public stewardship item-day grouping",
        detail:
          `${grouping.version}; one actor and stable item per UTC calendar day within its repository. Pin, unpin, ` +
          "lock and unlock facets and repeated toggles share one daily unit. Observed changes use the proven " +
          "source day. Independently qualified same-metric receipts retain separate source or acceptance day " +
          "lenses; acceptance never supplies a missing raw event time. Missing identity or the selected clock " +
          "stays unknown. Totals remain descriptive and are never ranked. Grouping does not establish justified " +
          "moderation or enable publication.",
      };
    case "project-field-day/v1":
      return {
        label: "Project item-day grouping",
        detail:
          `${grouping.version}; one observed actor and stable Project item per UTC calendar day within its ` +
          "repository. Different field facets, repeated changes and reversals share one item day. Only the proven " +
          "source event time chooses the day; collection or acceptance time cannot replace it. Missing item, " +
          "actor or source time stays unknown. Grouping does not establish useful work or enable publication.",
      };
  }
}
