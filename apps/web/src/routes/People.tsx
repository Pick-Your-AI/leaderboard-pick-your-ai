import React from "react";
import { CountLink } from "../components/CountLink.tsx";
import { PageHeader } from "../components/Layout.tsx";
import { PersonName, publicPersonLabel, ReceiptDrawer, ReceiptRow } from "../components/Receipt.tsx";
import { ScopeBar } from "../components/ScopeBar.tsx";
import { EmptyState, ErrorState, FreshnessIndicator, Loading, SnapshotNotices } from "../components/status.tsx";
import { families, familyLabel } from "../data/registry.ts";
import { buildProfile, listContributors } from "../data/source.ts";
import { formatDate, formatNumber, plural } from "../lib/format.ts";
import { useLatestSnapshotId, useRead, useScope } from "../lib/hooks.ts";
import { Link, useRouter, ScopedLink } from "../lib/router.tsx";
import { serializeScope } from "../lib/scope.ts";

export function ContributorsPage() {
  const { scope, params, hrefWith } = useScope();
  const { pathname, navigate } = useRouter();
  const latest = useLatestSnapshotId();
  const query = (params.q ?? "").trim().toLowerCase();
  const state = useRead(() => listContributors(scope, latest), [serializeScope(scope), latest]);

  return (
    <>
      <PageHeader eyebrow="Directory" title="Contributors">
        <p>
          Everyone with attributable public work in this scope, alphabetically. Being listed does not depend on rank or
          on accepted outcomes; observed and pending work count for inclusion.
        </p>
      </PageHeader>
      <ScopeBar timeWindow={state.status === "ready" ? state.data.window : null} />
      <form role="search" className="catalog-controls" onSubmit={(event) => event.preventDefault()}>
        <label>
          <span>Find a contributor</span>
          <input
            type="search"
            value={params.q ?? ""}
            onChange={(event) =>
              navigate(`${pathname}${serializeScope(scope, { ...params, q: event.target.value || null })}`, {
                replace: true,
              })
            }
          />
        </label>
      </form>
      {state.status === "loading" && <Loading label="contributors" />}
      {state.status === "error" && <ErrorState error={state.error} />}
      {state.status === "ready" &&
        (() => {
          const entries = state.data.entries.filter(
            (entry) =>
              !query ||
              (entry.person.publicState === "visible" &&
                (entry.person.login.toLowerCase().includes(query) ||
                  entry.person.displayName.toLowerCase().includes(query))),
          );
          const proof = state.data.entries.find((entry) => entry.person.login === params.proof);
          if (state.data.entries.length === 0) {
            return (
              <EmptyState title="No contributors in this scope">
                No attributable public activity was observed in this window.
              </EmptyState>
            );
          }
          if (entries.length === 0) {
            return (
              <EmptyState title="No contributors match">
                Nobody in this scope matches "{params.q}". <Link to={hrefWith("/contributors")}>Clear the search</Link>
              </EmptyState>
            );
          }
          return (
            <>
              <p role="status" className="muted">
                {plural(entries.length, "contributor")}
              </p>
              <ul className="directory">
                {entries.map((entry) => (
                  <li key={entry.person.actorId} className="directory-entry">
                    <PersonName person={entry.person} link={entry.person.publicState !== "deleted"} />
                    <span className="muted">
                      {entry.families.map(familyLabel).join(", ") || "Unclassified"} ·{" "}
                      <CountLink
                        to={hrefWith(
                          pathname,
                          { ...params, proof: entry.person.login, ui: "prototype" },
                          { ...state.data.scope, snapshot: state.data.snapshot.served.id },
                        )}
                        label={`${plural(entry.observedCount, "contribution")} in scope for ${publicPersonLabel(entry.person)}`}
                      >
                        {plural(entry.observedCount, "contribution")} in scope
                      </CountLink>{" "}
                      · first observed in scope {formatDate(entry.firstObservedAt)}
                    </span>
                  </li>
                ))}
              </ul>
              {params.proof && (
                <ReceiptDrawer
                  title={proof ? `Contributions: ${publicPersonLabel(proof.person)}` : "Evidence not found"}
                  onClose={() => navigate(hrefWith(pathname, { ...params, proof: null }))}
                  {...(proof && proof.person.publicState !== "deleted"
                    ? {
                        fullPageHref: hrefWith(
                          `/contributors/${encodeURIComponent(proof.person.login)}`,
                          { ui: "prototype" },
                          { ...state.data.scope, snapshot: state.data.snapshot.served.id },
                        ),
                      }
                    : {})}
                >
                  {proof ? (
                    <>
                      <p className="muted">
                        Fixture explanation: {plural(proof.observedCount, "contribution")} in this scope and snapshot.
                        Each attributable record is included once, even when it supports several measures. Pending and
                        observed work count for directory inclusion; excluded records do not. This is not a rank or an
                        overall score.
                      </p>
                      <ul className="receipt-list">
                        {proof.records.map((record) => (
                          <ReceiptRow key={record.id} record={record} />
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p>No public contribution explanation is available for this selection.</p>
                  )}
                </ReceiptDrawer>
              )}
            </>
          );
        })()}
    </>
  );
}

export function ProfilePage({ login }: { login: string }) {
  const { scope, hrefWith } = useScope();
  const latest = useLatestSnapshotId();
  const state = useRead(() => buildProfile(login, scope, latest), [login, serializeScope(scope), latest]);

  if (state.status === "loading") return <Loading label="profile" />;
  if (state.status === "error") return <ErrorState error={state.error} />;
  const profile = state.data;
  if (!profile) {
    // Suppressed and unknown profiles are indistinguishable on purpose.
    return (
      <>
        <PageHeader title="Profile not available" />
        <EmptyState title="There is no public profile at this address">
          The account may not exist, or there is nothing public to show.{" "}
          <ScopedLink to="/contributors">Browse all contributors</ScopedLink>.
        </EmptyState>
      </>
    );
  }
  const { person } = profile;
  if (person.publicState === "deleted") {
    return (
      <>
        <PageHeader eyebrow="Contributor" title="Deleted account" />
        <EmptyState title="This account was deleted">
          Its past public contributions still count on boards under a neutral "Deleted account" label. No profile
          details are shown.
        </EmptyState>
      </>
    );
  }
  const measuredFamilies = families.filter((family) => profile.measures.has(family.id));
  const quietFamilies = families.filter((family) => !profile.measures.has(family.id));

  return (
    <>
      <PageHeader
        eyebrow={person.actor.kind === "user" ? "Contributor · user account" : "Automation account"}
        title={person.displayName}
      >
        <p>
          <span className="mono">@{person.login}</span> · Identity{" "}
          {person.actor.identityState === "resolved" ? "resolved by stable account ID" : person.actor.identityState}. No
          overall score: each measure stands alone.
        </p>
      </PageHeader>
      <ScopeBar timeWindow={profile.window} />
      <div className="board-meta">
        <FreshnessIndicator view={profile.snapshot} compact />
      </div>
      <SnapshotNotices view={profile.snapshot} />
      <section className="section" aria-labelledby="first-observed">
        <h2 id="first-observed">First observed contribution</h2>
        {profile.firstObserved ? (
          <p>
            <ScopedLink to={`/contributions/${profile.firstObserved.id}`}>{profile.firstObserved.title}</ScopedLink>,
            observed {formatDate(profile.firstObserved.observedAt)}.{" "}
            <span className="muted">Earlier work may predate the known source history.</span>
          </p>
        ) : (
          <p className="muted">None observed.</p>
        )}
      </section>
      <section className="section" aria-labelledby="by-family">
        <h2 id="by-family">Measures by family</h2>
        {measuredFamilies.length === 0 && (
          <EmptyState title="No measured activity in this scope">Try a longer period or all repositories.</EmptyState>
        )}
        {measuredFamilies.map((family) => (
          <div key={family.id} className="family-measures">
            <h3>{family.label}</h3>
            <table className="data-table">
              <caption className="visually-hidden">
                {family.label} measures for {person.displayName}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Measure</th>
                  <th scope="col" className="numeric">
                    Counted
                  </th>
                  <th scope="col" className="numeric">
                    Pending
                  </th>
                  <th scope="col">Board position</th>
                </tr>
              </thead>
              <tbody>
                {profile.measures.get(family.id)!.map((measure) => (
                  <tr key={measure.metric.id}>
                    <th scope="row" data-label="Measure">
                      <Link to={hrefWith(`/leaderboards/${measure.metric.id}`, { proof: person.login })}>
                        {measure.metric.name}
                      </Link>
                    </th>
                    <td className="numeric" data-label="Counted">
                      <CountLink
                        to={hrefWith(
                          `/leaderboards/${measure.metric.id}`,
                          { proof: person.login, ui: "prototype" },
                          { ...profile.scope, snapshot: profile.snapshot.served.id },
                        )}
                        label={`${formatNumber(measure.value)} ${measure.metric.definition.unit}, ${person.displayName}, ${measure.metric.name}`}
                      >
                        {formatNumber(measure.value)} <span className="unit">{measure.metric.definition.unit}</span>
                      </CountLink>
                    </td>
                    <td className="numeric" data-label="Pending">
                      {measure.pending ? (
                        <CountLink
                          to={hrefWith(
                            `/leaderboards/${measure.metric.id}`,
                            { proof: person.login, ui: "prototype" },
                            { ...profile.scope, snapshot: profile.snapshot.served.id },
                          )}
                          label={`${plural(measure.pending, "pending contribution")}, ${person.displayName}, ${measure.metric.name}`}
                        >
                          {formatNumber(measure.pending)}
                        </CountLink>
                      ) : (
                        <span className="muted">None</span>
                      )}
                    </td>
                    <td data-label="Board position">
                      {measure.rank ?? <span className="muted">Listed, not ranked</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {quietFamilies.length > 0 && (
          <p className="muted">
            No measured activity in this scope for: {quietFamilies.map((family) => family.label).join(", ")}. Some of
            these are not measured in the prototype at all, which is different from no activity.
          </p>
        )}
      </section>
      <section className="section" aria-labelledby="timeline">
        <h2 id="timeline">Contributions in scope</h2>
        {profile.records.length ? (
          <ul className="receipt-list">
            {profile.records.map((record) => (
              <ReceiptRow key={record.id} record={record} />
            ))}
          </ul>
        ) : (
          <p className="muted">None in this scope.</p>
        )}
      </section>
    </>
  );
}
