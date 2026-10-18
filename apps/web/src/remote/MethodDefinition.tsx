import React from "react";
import type { MetricDefinition } from "@pick-your-ai/contracts";

const labels: Record<string, string> = {
  kind: "Denominator type",
  definition: "Population and denominator",
  zero_behavior: "Zero-denominator behavior",
  facets: "Definition facets",
  permission_rule: "Source permission limits",
  deduplication: "Duplicate and repeated activity",
  clock_selection: "Date selection and acceptance",
  source_acceptance_cases: "Counting examples and source checks",
};
const label = (key: string) =>
  Object.hasOwn(labels, key)
    ? labels[key]
    : /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key)
      ? key.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase())
      : key;
const overflow = "Additional detail exceeds the display limit; this is not a complete definition display.";

/** Preserve supplied nested definition fields without interpreting them as measurements. */
function detail(value: unknown, budget: { remaining: number }, depth = 0): React.ReactNode {
  if (budget.remaining-- <= 0 || depth > 8) return <span>{overflow}</span>;
  if (value === null || value === undefined) return "Not supplied";
  if (typeof value === "string") return value || "Empty text supplied";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    if (!value.length) return "No entries supplied";
    const children: React.ReactNode[] = [];
    for (const [index, entry] of value.entries()) {
      if (budget.remaining <= 0) {
        children.push(<li key="limit">{overflow}</li>);
        break;
      }
      children.push(<li key={index}>{detail(entry, budget, depth + 1)}</li>);
    }
    return <ul>{children}</ul>;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return "No fields supplied";
    const children: React.ReactNode[] = [];
    for (const [key, entry] of entries) {
      if (budget.remaining <= 0) {
        children.push(
          <React.Fragment key="limit">
            <dt>Display limit</dt>
            <dd>{overflow}</dd>
          </React.Fragment>,
        );
        break;
      }
      children.push(
        <React.Fragment key={`field:${key}`}>
          <dt>{label(key)}</dt>
          <dd>{detail(entry, budget, depth + 1)}</dd>
        </React.Fragment>,
      );
    }
    return <dl>{children}</dl>;
  }
  return "Unsupported definition value";
}

export function MethodDefinition({ metric }: { metric: MetricDefinition }) {
  const definition = metric.definition;
  const displayed = new Set([
    "unit",
    "aggregation",
    "numerator",
    "denominator",
    "denominator_filter_rule",
    "display_policy",
    "release_eligibility",
    "source_coverage_class",
    "event_clock",
    "subjective_qualification",
    "launch_gate",
  ]);
  const fields: [string, unknown][] = [
    ["Definition", metric.counting_rule],
    ["Unit", definition.unit],
    ["Aggregation", definition.aggregation],
    ["Numerator", definition.numerator],
    ["Denominator and population", definition.denominator],
    ["Denominator scope", definition.denominator_filter_rule],
    ["Attributed to", metric.attribution],
    ["Source definition", metric.source],
    ["Event clock", metric.event_clock],
    ["Definition event clock", definition.event_clock],
    ["Coverage class", metric.coverage_class],
    ["Definition source coverage", definition.source_coverage_class],
    ["Display", metric.display],
    ["Definition display policy", definition.display_policy],
    ["Release eligibility", definition.release_eligibility],
    ["Quality interpretation", definition.subjective_qualification],
    ["Publication requirements", definition.launch_gate],
    ...Object.entries(definition)
      .filter(([key]) => !displayed.has(key))
      .map(([key, value]): [string, unknown] => [label(key), value]),
    ["Shared policy rule names", metric.shared_rules],
  ];
  const budget = { remaining: 512 };
  const visible: React.ReactNode[] = [];
  for (const [index, [name, value]] of fields.entries()) {
    if (budget.remaining <= 0) {
      visible.push(
        <React.Fragment key="limit">
          <dt>Display limit</dt>
          <dd>{overflow}</dd>
        </React.Fragment>,
      );
      break;
    }
    visible.push(
      <React.Fragment key={index}>
        <dt>{name}</dt>
        <dd>{detail(value, budget)}</dd>
      </React.Fragment>,
    );
  }
  return <dl className="receipt">{visible}</dl>;
}
