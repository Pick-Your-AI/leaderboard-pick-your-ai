import React from "react";
import { RankCell } from "../components/BoardTable.tsx";
import { CountLink } from "../components/CountLink.tsx";
import { PageHeader } from "../components/Layout.tsx";
import { PersonName, publicPersonLabel, ReceiptRow } from "../components/Receipt.tsx";
import { ReferenceScope, ScopeBar } from "../components/ScopeBar.tsx";
import {
  CoverageLabel,
  EmptyState,
  ErrorState,
  FreshnessIndicator,
  Loading,
  SnapshotNotices,
  StateLabel,
} from "../components/status.tsx";
import {
  displayPolicyLabels,
  families,
  familyLabel,
  getMetric,
  leadMetrics,
  metricsInFamily,
  searchMetrics,
} from "../data/registry.ts";
import {
  buildBoard,
  combinedCoverageState,
  contributorProofSelector,
  coverageFor,
  listActivity,
  listContributors,
} from "../data/source.ts";
import { fixtureMetrics } from "../data/synthetic.ts";
import { formatDate, formatNumber } from "../lib/format.ts";
import { useLatestSnapshotId, useRead, useScope } from "../lib/hooks.ts";
import { Link, useRouter } from "../lib/router.tsx";
import { inWindow, serializeScope } from "../lib/scope.ts";

const exampleBoards: Record<string, string> = Object.fromEntries(
  leadMetrics("overview").map((metric) => [metric.family, metric.id]),
);

export function OverviewPage() {
  const { scope, hrefWith } = useScope();
  const latest = useLatestSnapshotId();
  const scopeKey = serializeScope(scope);
  const state = useRead(() => {
    const boards = Object.fromEntries(
      Object.entries(exampleBoards).map(([family, metricId]) => [family, buildBoard(metricId, scope, latest)!]),
    );
    const directory = listContributors(scope, latest);
    const activity = listActivity(scope, latest);
    // First observed anywhere in known history, not just in the selected repositories.
    const history = listContributors(
      { ...scope, period: "all", from: null, to: null, repos: [], projects: [] },
      latest,
    ).entries;
    const newcomers = history.filter(
      (entry) =>
        inWindow(entry.firstObservedAt, directory.window) &&
        directory.entries.some((candidate) => candidate.person.actorId === entry.person.actorId),
    );
    return { boards, directory, activity, newcomers };
  }, [scopeKey, latest]);

  return (
    <>
      <PageHeader eyebrow="PickYour.AI organization" title="Contributions, with evidence">
        <p>
          Many kinds of work, each on its own board with its own unit and source proof. There is no overall score. Every
          family below has equal weight.
        </p>
      </PageHeader>
      <ScopeBar timeWindow={state.status === "ready" ? state.data.directory.window : null} />
      {state.status === "loading" && <Loading label="overview" />}
      {state.status === "error" && <ErrorState error={state.error} />}
      {state.status === "ready" && (
        <>
          <div className="board-meta">
            <FreshnessIndicator view={state.data.directory.snapshot} />
          </div>
          <SnapshotNotices view={state.data.directory.snapshot} />
          <section aria-labelledby="families-heading" className="section">
            <h2 id="families-heading">Contribution families</h2>
            <p className="muted">
              Departments and lead measures come from the versioned registry. These navigation defaults do not assign
              organizational ownership or certify source coverage.
            </p>
            <ul className="family-grid">
              {families.map((family) => {
                const metricId = exampleBoards[family.id];
                const board = metricId ? state.data.boards[family.id] : undefined;
                const total = metricsInFamily(family.id).length;
                return (
                  <li key={family.id} className="family-block">
                    <h3>
                      <Link to={hrefWith("/leaderboards", { family: family.id })}>{family.label}</Link>
                    </h3>
                    <p className="muted">{total} defined measures</p>
                    {board ? (
                      <>
                        <p>
                          Example: <Link to={hrefWith(`/leaderboards/${board.metric.id}`)}>{board.metric.name}</Link>{" "}
                          <span className="tag">Registry default</span>
                        </p>
                        {board.rows.length ? (
                          <ol className="mini-board" aria-label={`Top of ${board.metric.name}`}>
                            {board.rows.slice(0, 3).map((row) => (
                              <li key={row.person.actorId}>
                                <span className="rank">
                                  <RankCell row={row} />
                                </span>
                                <PersonName person={row.person} />
                                <span className="numeric">
                                  <CountLink
                                    to={hrefWith(
                                      `/leaderboards/${board.metric.id}`,
                                      {
                                        proof: contributorProofSelector(row.person, [
                                          ...row.ranked,
                                          ...row.pendingRecords,
                                        ]),
                                        ui: "prototype",
                                      },
                                      { ...board.scope, snapshot: board.snapshot.served.id },
                                    )}
                                    label={`${formatNumber(row.value)} ${board.metric.definition.unit}, ${publicPersonLabel(row.person)}, ${board.metric.name}`}
                                  >
                                    {formatNumber(row.value)}{" "}
                                    <span className="unit">{board.metric.definition.unit}</span>
                                  </CountLink>
                                </span>
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <p className="muted">No ranked activity in this scope.</p>
                        )}
                        <CoverageLabel state={board.coverageState} />
                      </>
                    ) : (
                      <p>
                        <StateLabel state="not_measured" /> No measure in this family has prototype data yet.{" "}
                        <Link to={hrefWith("/leaderboards", { family: family.id })}>Browse its definitions</Link>.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-labelledby="first-heading" className="section">
            <h2 id="first-heading">First observed contributions</h2>
            <p className="muted">
              People whose first observed contribution falls in this window, alphabetically and unranked. "First
              observed" is bounded by each source's known history.
            </p>
            {state.data.newcomers.length ? (
              <ul className="people-list">
                {state.data.newcomers.map((entry) => (
                  <li key={entry.person.actorId}>
                    <PersonName person={entry.person} /> · first observed {formatDate(entry.firstObservedAt)}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No first contributions in this window">Try a longer period.</EmptyState>
            )}
            <p>
              <Link to={hrefWith("/contributors")}>All contributors ({state.data.directory.entries.length})</Link>
            </p>
          </section>

          <section aria-labelledby="activity-heading" className="section">
            <h2 id="activity-heading">Recent activity</h2>
            <ul className="receipt-list">
              {state.data.activity.records.slice(0, 5).map((record) => (
                <ReceiptRow key={record.id} record={record} />
              ))}
            </ul>
            <p>
              <Link to={hrefWith("/activity")}>All activity</Link>
            </p>
          </section>

          <section aria-labelledby="coverage-heading" className="section">
            <h2 id="coverage-heading">Source coverage</h2>
            <p>
              Repository activity:{" "}
              <CoverageLabel state={combinedCoverageState(coverageFor(scope.repos, ["github_rest"]))} /> · Reviewed
              receipts: <CoverageLabel state={combinedCoverageState(coverageFor(scope.repos, ["reviewed_receipt"]))} />{" "}
              · Project history:{" "}
              <CoverageLabel state={combinedCoverageState(coverageFor(scope.repos, ["github_graphql"]))} />
            </p>
            <p>
              <Link to={hrefWith("/coverage")}>Coverage details</Link>
            </p>
          </section>
        </>
      )}
    </>
  );
}

export function LeaderboardsPage() {
  const { scope, params, hrefWith } = useScope();
  const { pathname, navigate } = useRouter();
  const query = params.q ?? "";
  const family = params.family && families.some((entry) => entry.id === params.family) ? params.family : null;
  const results = searchMetrics(query, family);
  const setParam = (key: string, value: string | null) =>
    navigate(`${pathname}${serializeScope(scope, { ...params, [key]: value })}`, { replace: key === "q" });

  return (
    <>
      <PageHeader eyebrow="Metric catalog" title={family ? `${familyLabel(family)} measures` : "Leaderboards"}>
        <p>
          Every defined measure from the metric registry, including ones that are not measured yet. Search by name, unit
          or rule.
        </p>
      </PageHeader>
      <ReferenceScope />
      {params.family && !family && (
        <div className="notice notice-warn" role="alert">
          <p className="notice-title">Unknown family "{params.family}". Showing all families.</p>
        </div>
      )}
      <form className="catalog-controls" role="search" onSubmit={(event) => event.preventDefault()}>
        <label>
          <span>Search measures</span>
          <input type="search" value={query} onChange={(event) => setParam("q", event.target.value || null)} />
        </label>
        <fieldset className="chips">
          <legend>Family</legend>
          <button
            type="button"
            className="chip"
            aria-pressed={family === null}
            onClick={() => setParam("family", null)}
          >
            All
          </button>
          {families.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="chip"
              aria-pressed={family === entry.id}
              onClick={() => setParam("family", entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </fieldset>
      </form>
      <p role="status" className="muted">
        {results.length} of 98 measures
      </p>
      {results.length === 0 ? (
        <EmptyState title="No measures match">
          Nothing matches "{query}"{family ? ` in ${familyLabel(family)}` : ""}.{" "}
          <Link to={hrefWith("/leaderboards")}>Clear the search</Link>
        </EmptyState>
      ) : (
        <div className="table-region" role="region" aria-labelledby="catalog-caption" tabIndex={0}>
          <table className="data-table catalog-table">
            <caption id="catalog-caption">Measures, in registry order</caption>
            <thead>
              <tr>
                <th scope="col">Measure</th>
                <th scope="col">Family</th>
                <th scope="col">Unit</th>
                <th scope="col">Display</th>
                <th scope="col">Prototype data</th>
              </tr>
            </thead>
            <tbody>
              {results.map((metric) => (
                <tr key={metric.id}>
                  <th scope="row" data-label="Measure">
                    <Link to={hrefWith(`/leaderboards/${metric.id}`)}>{metric.name}</Link>
                  </th>
                  <td data-label="Family">{familyLabel(metric.family)}</td>
                  <td data-label="Unit">{metric.definition.unit}</td>
                  <td data-label="Display">{displayPolicyLabels[metric.display] ?? metric.display}</td>
                  <td data-label="Prototype data">
                    {fixtureMetrics[metric.id] ? "Synthetic fixture" : <StateLabel state="not_measured" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">
        Journeys: <Link to={hrefWith(`/leaderboards/${getMetric("pr_merged")!.id}`)}>PRs merged</Link> ·{" "}
        <Link to={hrefWith("/leaderboards/pr_lines_changed")}>Lines changed</Link> ·{" "}
        <Link to={hrefWith("/leaderboards/labels_applied")}>Triage</Link> ·{" "}
        <Link to={hrefWith("/leaderboards/decision_records")}>Research</Link> ·{" "}
        <Link to={hrefWith("/leaderboards/prs_reviewed")}>Review</Link>
      </p>
    </>
  );
}
