import React from "react";
import { describeMetricGrouping } from "../lib/metric-grouping.ts";
import type { MetricDefinition, MetricRegistry } from "@pick-your-ai/contracts";
import { getMetricGroupingPolicy, getMetricUi, getRegistryDepartments } from "@pick-your-ai/metrics";
import { uiHref, type Selection } from "./client.ts";
import { discoverMetrics } from "./registry.ts";
import { MetricCategoryNavigation } from "./MetricCategoryNavigation.tsx";

const maturityLabels = {
  definition_only: "Definition only",
  synthetic_verified: "Synthetic verification only",
  deferred: "Deferred",
};

export function RegistryMetadata({ registry, metric }: { registry: MetricRegistry; metric: MetricDefinition }) {
  const ui = getMetricUi(metric.id, registry);
  const departments = getRegistryDepartments(registry);
  const grouping = getMetricGroupingPolicy(metric.id, registry);
  const groupingDescription = grouping ? describeMetricGrouping(grouping) : null;
  if (!ui || registry.ui_metadata.decision_state !== "candidate")
    return (
      <p>
        UI capability metadata is unavailable in this registry. No supported state/date combinations or navigation
        defaults are inferred.
      </p>
    );
  return (
    <>
      <dl className="receipt">
        <dt>UI metadata version</dt>
        <dd>{registry.ui_metadata.version}</dd>
        <dt>Department</dt>
        <dd>{departments.find((department) => department.id === ui.department)?.label ?? "Unknown"}</dd>
        <dt>Search synonyms</dt>
        <dd>{ui.synonyms.join(", ")}</dd>
        <dt>Implementation maturity</dt>
        <dd>{maturityLabels[ui.maturity]}</dd>
        <dt>Source design class</dt>
        <dd>{ui.source_class}; this does not certify current source availability or coverage.</dd>
        <dt>Candidate state/date combinations</dt>
        <dd>
          {ui.supported_combinations.length
            ? ui.supported_combinations.map((pair) => `${pair.state} / ${pair.date_basis}`).join(", ")
            : "No selectable candidate view registered; this is not a measured zero."}
        </dd>
        <dt>Candidate navigation defaults</dt>
        <dd>
          {ui.lead_view.overview ? "Overview lead" : "Catalog entry"}
          {ui.lead_view.wall ? "; wall choice" : ""}
        </dd>
        <dt>Implementation limitations</dt>
        <dd>{ui.limitations.join(" ")}</dd>
        {groupingDescription && (
          <>
            <dt>{groupingDescription.label}</dt>
            <dd>{groupingDescription.detail}</dd>
          </>
        )}
      </dl>
      <p>
        Candidate combinations describe tested implementations. This public API reads materialized snapshots and does
        not accept state/date-basis filters or substitute another combination. Registry metadata does not enable
        publication.
      </p>
    </>
  );
}

export function RegistryCatalog({
  registry,
  selected,
  path,
  navigate,
}: {
  registry: MetricRegistry;
  selected: Selection;
  path: string;
  navigate: (href: string) => void;
}) {
  const departments = getRegistryDepartments(registry);
  const metrics = discoverMetrics(registry, selected);
  return (
    <section aria-label="Metric discovery">
      <p>
        Definitions and navigation metadata are read from API registry {registry.contract_version}, definition policy{" "}
        {registry.policy_version}
        {registry.ui_metadata.decision_state === "candidate"
          ? `, UI metadata ${registry.ui_metadata.version}`
          : "; UI metadata unavailable"}
        . Board availability and current coverage are checked separately.
      </p>
      <MetricCategoryNavigation departments={departments} selected={selected} path={path} />
      <form
        className="remote-filters"
        role="search"
        aria-label="Search metric definitions"
        onSubmit={(event) => {
          event.preventDefault();
          const input = new FormData(event.currentTarget);
          navigate(
            uiHref(
              path,
              {
                ...selected,
                catalogQuery: String(input.get("q") ?? "").trim() || null,
                department: String(input.get("department") ?? "") || null,
              },
              { cursor: null },
            ),
          );
        }}
      >
        <label>
          Search definitions
          <input type="search" name="q" maxLength={120} defaultValue={selected.catalogQuery ?? ""} />
        </label>
        <label>
          Department
          <select name="department" defaultValue={selected.department ?? ""} disabled={!departments.length}>
            <option value="">All departments</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="button">
          Search measures
        </button>
      </form>
      <p role="status">
        {metrics.length} of {registry.metrics.length} defined measures
      </p>
      {!metrics.length && <p>No metric definitions match these filters. No alternative measure was substituted.</p>}
      <ul className="directory">
        {metrics.map((metric) => {
          const ui = getMetricUi(metric.id, registry);
          return (
            <li key={metric.id}>
              <h2>
                <a
                  data-api-nav
                  href={uiHref(`/leaderboards/${metric.id}`, selected, { metric: metric.id, cursor: null })}
                >
                  {metric.name}
                </a>
              </h2>
              <p>{metric.counting_rule}</p>
              <p>
                {ui
                  ? `${departments.find((department) => department.id === ui.department)?.label ?? "Unknown department"} · ${maturityLabels[ui.maturity]}`
                  : "UI capability metadata unavailable"}
                . Public measurement availability is checked when the board is opened.
              </p>
              <a data-api-nav href={uiHref(`/methodology/${metric.id}`, selected, { metric: metric.id, cursor: null })}>
                Method sheet
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
