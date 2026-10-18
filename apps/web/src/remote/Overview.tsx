import React, { useState } from "react";
import type { MetricRegistry } from "@pick-your-ai/contracts";
import { getLeadMetrics, getMetricUi, getRegistryDepartments } from "@pick-your-ai/metrics";
import { uiHref, type Selection } from "./client.ts";

const departmentsPerPage = 12;

export function OverviewNavigation({ registry, selected }: { registry: MetricRegistry; selected: Selection }) {
  const departments = getRegistryDepartments(registry);
  const leads = getLeadMetrics("overview", registry);
  const [page, setPage] = useState(0);
  const lastPage = Math.max(0, Math.ceil(departments.length / departmentsPerPage) - 1);
  const currentPage = Math.min(page, lastPage);
  const start = currentPage * departmentsPerPage;
  // "All contributors" clears list-specific filters while retaining the actual
  // public scope, actor selection, display timezone and displayed health pin.
  const scope = { ...selected, search: null, category: null, catalogQuery: null, department: null, cursor: null };

  return (
    <section className="section" aria-labelledby="overview-departments-heading">
      <h2 id="overview-departments-heading">Explore contribution departments</h2>
      <p>
        Discover different kinds of work through separate measures. Each has its own meaning and unit; there is no
        combined contributor score.
      </p>
      <p>
        <a data-api-nav href={uiHref("/contributors", scope)}>
          All contributors in this scope
        </a>{" "}
        ·{" "}
        <a data-api-nav href={uiHref("/activity", scope)}>
          Public activity in this scope
        </a>{" "}
        ·{" "}
        <a data-api-nav href={uiHref("/leaderboards", scope)}>
          All metric definitions
        </a>
      </p>
      <p className="muted">
        Definitions describe what a measure counts, not how much work occurred. Opening a measure checks its public
        availability for this selection. Missing or unsupported data is not zero activity.
      </p>
      {departments.length ? (
        <>
          <ul className="family-grid">
            {departments.slice(start, start + departmentsPerPage).map((department) => {
              const definitions = registry.metrics.filter(
                (metric) => getMetricUi(metric.id, registry)?.department === department.id,
              );
              const lead = leads.find((metric) => getMetricUi(metric.id, registry)?.department === department.id);
              return (
                <li className="family-block" key={department.id}>
                  <h3>
                    <a data-api-nav href={uiHref("/leaderboards", { ...scope, department: department.id })}>
                      {department.label}
                    </a>
                  </h3>
                  {definitions.length ? (
                    <p className="muted">
                      {definitions.length} metric {definitions.length === 1 ? "definition" : "definitions"}
                    </p>
                  ) : (
                    <p>No metric definitions are supplied for this department. Activity is unknown.</p>
                  )}
                  {lead ? (
                    <p>
                      Example measure:{" "}
                      <a data-api-nav href={uiHref(`/leaderboards/${lead.id}`, scope, { metric: lead.id })}>
                        {lead.name}
                      </a>
                    </p>
                  ) : definitions.length ? (
                    <p>No overview example is selected for this department.</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {departments.length > departmentsPerPage && (
            <nav aria-label="Contribution department pages">
              <p role="status">
                Departments {start + 1}–{Math.min(start + departmentsPerPage, departments.length)} of{" "}
                {departments.length}
              </p>
              <button
                type="button"
                className="button"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous departments
              </button>{" "}
              <button
                type="button"
                className="button"
                disabled={currentPage === lastPage}
                onClick={() => setPage(currentPage + 1)}
              >
                Next departments
              </button>
            </nav>
          )}
        </>
      ) : (
        <p>Department navigation is unavailable in this registry.</p>
      )}
    </section>
  );
}
