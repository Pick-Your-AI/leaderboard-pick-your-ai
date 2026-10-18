import React from "react";
import { prototypeNavigation } from "../lib/prototype-url.ts";
import { PageHeader } from "../components/Layout.tsx";
import { ReferenceScope } from "../components/ScopeBar.tsx";
import { CoverageLabel, EmptyState, StateLabel, evidenceLabels } from "../components/status.tsx";
import type { EvidenceState } from "../data/model.ts";
import {
  displayPolicyLabels,
  families,
  getMetric,
  getMetricUi,
  getMetricGroupingPolicy,
  metricsInFamily,
  registry,
  releaseEligibilityLabels,
} from "../data/registry.ts";
import { coverage, projects, repositories, snapshots } from "../data/source.ts";
import { fixtureMetrics, SYNTHETIC_DATASET_ID } from "../data/synthetic.ts";
import { formatDate, formatDateTime } from "../lib/format.ts";
import { useScope } from "../lib/hooks.ts";
import { Link, ScopedLink } from "../lib/router.tsx";

export function MethodologyPage() {
  return (
    <>
      <PageHeader eyebrow="Methodology" title="How contributions are counted">
        <p>
          Each measure has its own unit, attribution rule, date basis and sources. Nothing is combined into a single
          score, and there are no streaks.
        </p>
      </PageHeader>
      <ReferenceScope />
      <section className="section" aria-labelledby="principles">
        <h2 id="principles">Principles</h2>
        <ul>
          <li>
            Observed activity, accepted outcomes and reviewed recognition are separate states and never share a ranked
            value.
          </li>
          <li>
            Unknown, unavailable and partial data are not zero. Zero is shown only when coverage is complete for the
            whole scope.
          </li>
          <li>Ties share a dense rank (1, =2, =2, 3). Order within a tie is alphabetical and carries no credit.</li>
          <li>
            User accounts and automation are separate. A user-account event does not prove manual work or the absence of
            AI assistance.
          </li>
          <li>Ingestion reads public sources only and never changes GitHub issues, labels or Projects.</li>
        </ul>
      </section>
      <section className="section" aria-labelledby="states">
        <h2 id="states">Evidence states</h2>
        <dl className="definition-list">
          {(Object.keys(evidenceLabels) as EvidenceState[]).map((state) => (
            <React.Fragment key={state}>
              <dt>
                <StateLabel state={state} />
              </dt>
              <dd>{evidenceLabels[state].description}</dd>
            </React.Fragment>
          ))}
        </dl>
      </section>
      <section className="section" aria-labelledby="index">
        <h2 id="index">Measure index</h2>
        <p className="muted">
          Registry {registry.contract_version}, policy {registry.policy_version}.{" "}
          <ScopedLink to="/methodology/changes">Policy changes</ScopedLink>
        </p>
        {families.map((family) => (
          <div key={family.id}>
            <h3>{family.label}</h3>
            <ul className="inline-list">
              {metricsInFamily(family.id).map((metric) => (
                <li key={metric.id}>
                  <ScopedLink to={`/methodology/${metric.id}`}>{metric.name}</ScopedLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </>
  );
}

export function MethodSheetPage({ metricId }: { metricId: string }) {
  const metric = getMetric(metricId);
  if (!metric) return <NotFoundPage />;
  const definition = metric.definition;
  const ui = getMetricUi(metric.id);
  const grouping = getMetricGroupingPolicy(metric.id);
  const extra = Object.entries(definition).filter(
    ([key]) =>
      ![
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
      ].includes(key),
  );
  return (
    <>
      <PageHeader eyebrow={`Method sheet · ${registry.policy_version}`} title={metric.name}>
        <p>
          <ScopedLink to={`/leaderboards/${metric.id}`}>Open the board</ScopedLink>
        </p>
      </PageHeader>
      <ReferenceScope />
      <dl className="receipt">
        <dt>UI metadata version</dt>
        <dd>
          {registry.ui_metadata.decision_state === "candidate"
            ? registry.ui_metadata.version
            : "Unresolved legacy metadata"}
        </dd>
        <dt>Department</dt>
        <dd>{families.find((department) => department.id === ui?.department)?.label ?? "Unassigned"}</dd>
        <dt>Search synonyms</dt>
        <dd>{ui?.synonyms.join(", ") ?? "None"}</dd>
        <dt>Implementation maturity</dt>
        <dd>{ui?.maturity ?? "definition_only"}</dd>
        <dt>Source capability class</dt>
        <dd>{ui?.source_class ?? "unknown"}; actual source coverage must be verified separately.</dd>
        <dt>Supported evidence and date pairs</dt>
        <dd>
          {ui?.supported_combinations.map((pair) => `${pair.state} / ${pair.date_basis}`).join(", ") ||
            "No selectable view; not measured"}
        </dd>
        <dt>Navigation default</dt>
        <dd>
          {ui?.lead_view.overview ? "Overview lead" : "Catalog entry"}
          {ui?.lead_view.wall ? "; wall choice" : ""}
        </dd>
        <dt>Implementation limitations</dt>
        <dd>{ui?.limitations.join(" ")}</dd>
        {grouping && (
          <>
            <dt>Raw triage grouping policy</dt>
            <dd>
              {grouping.version}: one actor, artifact and exact raw source state per {grouping.grouping_seconds}-second
              UTC interval anchored at {grouping.interval_origin}. Repeated state in that interval counts once. Missing
              state or time is excluded as unknown. No semantic classifier.
            </dd>
          </>
        )}
        <dt>What counts</dt>
        <dd>{metric.counting_rule}</dd>
        <dt>Unit</dt>
        <dd>{definition.unit}</dd>
        <dt>Aggregation</dt>
        <dd className="mono">{definition.aggregation}</dd>
        <dt>Numerator</dt>
        <dd>{definition.numerator}</dd>
        <dt>Denominator</dt>
        <dd>{definition.denominator.definition}</dd>
        <dt>Ratio scope rule</dt>
        <dd>{definition.denominator_filter_rule}</dd>
        <dt>Attributed to</dt>
        <dd>{metric.attribution}</dd>
        <dt>Source</dt>
        <dd>{metric.source}</dd>
        <dt>Date basis</dt>
        <dd className="mono">{metric.event_clock}</dd>
        <dt>Coverage class</dt>
        <dd className="mono">{metric.coverage_class}</dd>
        <dt>Display</dt>
        <dd>{displayPolicyLabels[metric.display] ?? metric.display}</dd>
        <dt>Release</dt>
        <dd>{releaseEligibilityLabels[definition.release_eligibility] ?? definition.release_eligibility}</dd>
        <dt>Quality judgement</dt>
        <dd>{definition.subjective_qualification}</dd>
        <dt>Launch gate</dt>
        <dd>{definition.launch_gate}</dd>
        <dt>Shared rules</dt>
        <dd>{metric.shared_rules.join(", ")}</dd>
        {extra.map(([key, value]) => (
          <React.Fragment key={key}>
            <dt className="mono">{key}</dt>
            <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
          </React.Fragment>
        ))}
        <dt>Work packages</dt>
        <dd className="mono">{metric.backlog_work_packages.join(", ")}</dd>
        <dt>Prototype data</dt>
        <dd>{fixtureMetrics[metric.id]?.explanation ?? "None. This measure is not measured in the prototype."}</dd>
      </dl>
    </>
  );
}

export function MethodologyChangesPage() {
  return (
    <>
      <PageHeader eyebrow="Methodology" title="Policy changes" />
      <ReferenceScope />
      <ol className="receipt-list">
        <li className="receipt-row">
          <div className="receipt-row-main">
            <span className="mono">{registry.policy_version}</span> Initial candidate registry of 98 measures
          </div>
          <div className="receipt-row-meta muted">
            No published policy change yet. Comparisons across policy versions will say when they are unavailable.
          </div>
        </li>
      </ol>
    </>
  );
}

const adapterNames = {
  github_rest: "Repository activity",
  reviewed_receipt: "Reviewed receipts",
  github_graphql: "Project history",
} as const;

export function CoveragePage() {
  const adapters = Object.keys(adapterNames) as (keyof typeof adapterNames)[];
  return (
    <>
      <PageHeader eyebrow="Source health" title="Coverage">
        <p>
          What each source covers, from when, and where the gaps are. No completeness percentage is shown, because the
          true total is unknowable.
        </p>
      </PageHeader>
      <ReferenceScope>
        Scope travels with contribution links. The coverage inventory below lists every repository and source.
      </ReferenceScope>
      <div className="table-region" role="region" aria-labelledby="coverage-caption" tabIndex={0}>
        <table className="data-table coverage-table">
          <caption id="coverage-caption">Coverage by repository and source</caption>
          <thead>
            <tr>
              <th scope="col">Repository</th>
              {adapters.map((adapter) => (
                <th key={adapter} scope="col">
                  {adapterNames[adapter]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {coverage.map((entry) => (
              <tr key={entry.repoId}>
                <th scope="row" className="mono" data-label="Repository">
                  {repositories.find((repo) => repo.id === entry.repoId)?.name}
                </th>
                {adapters.map((adapter) => {
                  const item = entry.coverage.find((candidate) => candidate.source === adapter);
                  return (
                    <td key={adapter} data-label={adapterNames[adapter]}>
                      {item ? (
                        <>
                          <CoverageLabel state={item.state} />
                          <div className="muted small">
                            {item.knownStart ? `From ${formatDate(item.knownStart)}` : "No known start"}
                            {item.lastSuccessfulSync && ` · synced ${formatDateTime(item.lastSuccessfulSync)}`}
                            {item.missingPages > 0 && ` · ${item.missingPages} missing pages`}
                            {item.permissionsMissing.length > 0 && ` · needs ${item.permissionsMissing.join(", ")}`}
                            {item.sourceErrors.map((error) => ` · ${error}`)}
                          </div>
                        </>
                      ) : (
                        <CoverageLabel state="unknown" />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="section" aria-labelledby="snapshots">
        <h2 id="snapshots">Published snapshots</h2>
        <ul className="receipt-list">
          {snapshots.map((snapshot) => (
            <li key={snapshot.id} className="receipt-row">
              <div className="receipt-row-main">
                <span className="mono">{snapshot.id}</span> {snapshot.status} · {snapshot.freshness}
              </div>
              <div className="receipt-row-meta muted">
                Cutoff {formatDateTime(snapshot.cutoff)} · {snapshot.note}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export function ProjectPage({ id }: { id: string }) {
  const { hrefWith } = useScope();
  const project = projects.find((candidate) => candidate.id === id);
  if (!project) return <NotFoundPage />;
  return (
    <>
      <PageHeader eyebrow="Program scope" title={project.name}>
        <p>{project.note}</p>
      </PageHeader>
      <ReferenceScope>
        Program details describe {project.name}. Board links select this program; other navigation carries the scope
        above.
      </ReferenceScope>
      <h2>Repositories</h2>
      <ul>
        {project.repoIds.map((repoId) => (
          <li key={repoId} className="mono">
            {repositories.find((repo) => repo.id === repoId)?.name}
          </li>
        ))}
      </ul>
      <p className="muted">
        Historical attribution: a contribution belongs to a program by its repository at the time it happened. Unknown
        membership is not inferred.
      </p>
      <h2>Boards in this scope</h2>
      <ul className="inline-list">
        {Object.keys(fixtureMetrics).map((metricId) => (
          <li key={metricId}>
            <Link to={hrefWith(`/leaderboards/${metricId}`, {}, { projects: [project.id] })}>
              {getMetric(metricId)?.name}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

const journeys: { title: string; steps: [string, string][] }[] = [
  {
    title: "Overview to metric to contributor to source",
    steps: [
      ["Overview", "/"],
      ["PRs merged board", "/leaderboards/pr_merged"],
      ["Evidence drawer for Aster", "/leaderboards/pr_merged?proof=synthetic-aster"],
      ["Aster's portfolio", "/contributors/synthetic-aster"],
      ["One contribution's proof", "/contributions/syn-c-001"],
    ],
  },
  {
    title: "Newcomer discovery",
    steps: [
      ["First observed contributions on the overview", "/"],
      ["Directory includes observed-only work", "/contributors"],
      ["Gale is listed but not ranked on PRs merged", "/leaderboards/pr_merged"],
    ],
  },
  {
    title: "Triage proof and corrections",
    steps: [
      ["Labels applied board", "/leaderboards/labels_applied"],
      ["Birch's evidence, with one exclusion", "/leaderboards/labels_applied?proof=synthetic-birch"],
      ["Corrected contribution", "/contributions/syn-c-024"],
      ["Corrections history", "/corrections"],
    ],
  },
  {
    title: "Lines of change in context",
    steps: [["Lines changed, with excluded lockfile and vendor lines", "/leaderboards/pr_lines_changed"]],
  },
  {
    title: "Live updates and the wall",
    steps: [
      ["Held update (publishes immediately with arrive=now)", "/leaderboards/prs_reviewed?arrive=now"],
      ["Wall configurator", "/live"],
      ["Cycling wall with pause", "/live?mode=cycle&boards=pr_merged,prs_reviewed,labels_applied"],
    ],
  },
];

const requiredStates: [string, string][] = [
  ["Loading", "/leaderboards/pr_merged"],
  ["Empty complete scope (true zero)", "/leaderboards/issues_opened?repo=syn-repo-research"],
  ["No filter matches", "/contributors?q=nobody"],
  ["Partial history", "/leaderboards/pr_merged?repo=syn-repo-website"],
  ["Unsupported capability", "/leaderboards/project_status_updates?repo=syn-repo-leaderboard"],
  ["Pending evidence", "/leaderboards/decision_records?proof=synthetic-fern"],
  ["Stale data and disconnected collector", "/leaderboards/pr_merged?snapshot=syn-r40-stale"],
  ["Rebuilding snapshot", "/leaderboards/pr_merged?snapshot=syn-r44-rebuilding"],
  ["Failed snapshot read", "/leaderboards/pr_merged?snapshot=syn-r45-failed"],
  ["Hidden contributor (indistinguishable from unknown)", "/contributors/synthetic-hazel"],
  ["Deleted contributor", "/contributors/synthetic-iris"],
  ["Source no longer public", "/contributions/syn-c-032"],
  ["Corrected result", "/contributions/syn-c-024"],
  ["Invalid link parameters", "/leaderboards/pr_merged?period=fortnight&repo=nope&snapshot=syn-r99"],
];

export function PrototypeGuidePage() {
  return (
    <>
      <PageHeader eyebrow="LB 13.04" title="Prototype guide">
        <p>
          This is a design prototype on synthetic data ({SYNTHETIC_DATASET_ID}). It exists to evaluate journeys, states
          and accessibility before the read API exists. It is not a production leaderboard, and none of its counts
          describe real people.
        </p>
      </PageHeader>
      <ReferenceScope>
        Primary navigation carries this selection. The walkthrough links below open their predefined example views.
      </ReferenceScope>
      <section className="section" aria-labelledby="journeys">
        <h2 id="journeys">Journeys</h2>
        {journeys.map((journey) => (
          <div key={journey.title}>
            <h3>{journey.title}</h3>
            <ol>
              {journey.steps.map(([label, href]) => (
                <li key={href + label}>
                  <Link to={href}>{label}</Link>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </section>
      <section className="section" aria-labelledby="required-states">
        <h2 id="required-states">Required states</h2>
        <ul>
          {requiredStates.map(([label, path]) => {
            const { href } = prototypeNavigation(path);
            return (
              <li key={label}>
                <Link to={href}>{label}</Link> <span className="mono muted small">{href}</span>
              </li>
            );
          })}
        </ul>
      </section>
      <section className="section" aria-labelledby="fixture">
        <h2 id="fixture">What the fixture contains</h2>
        <p>
          {Object.keys(fixtureMetrics).length} of 98 registry measures have synthetic rows. Every count on a board links
          to the rows behind it, and every row carries a fixture explanation. The remaining measures render as not
          measured.
        </p>
      </section>
    </>
  );
}

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <ReferenceScope>The overview and catalog links below carry this selection.</ReferenceScope>
      <EmptyState title="Nothing lives at this address">
        <ScopedLink to="/">Go to the overview</ScopedLink> or{" "}
        <ScopedLink to="/leaderboards">browse leaderboards</ScopedLink>.
      </EmptyState>
    </>
  );
}
