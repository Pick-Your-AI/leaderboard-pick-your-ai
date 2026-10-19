import React from "react";
import type { MetricRegistry } from "@pick-your-ai/contracts";
import { getRegistryDepartments } from "@pick-your-ai/metrics";
import { uiHref, type Selection } from "./client.ts";
import { programHref, type ProgramDirectory, type ProgramRecord } from "./program-directory.ts";

export function Programs({
  directory,
  program,
  registry,
  selected,
}: {
  directory: ProgramDirectory;
  program: ProgramRecord | null;
  registry: MetricRegistry;
  selected: Selection;
}) {
  const entries = program ? [program] : directory.programs;
  const departments = getRegistryDepartments(registry);
  const context = selected.context ?? "event";
  const href = (
    path: string,
    programs: readonly ProgramRecord[],
    basis = context,
    repository: string | null = null,
    department: string | null = null,
  ) => programHref(path, selected, directory, programs, basis, repository, department);
  return (
    <section aria-label="Program discovery">
      <p>
        {program ? program.name : `${directory.programs.length} configured programs`}. This directory describes program
        identities and navigation. Contribution availability is checked in each selected view.
      </p>
      <p>
        Directory {directory.version}, recorded <time dateTime={directory.observedOn}>{directory.observedOn}</time>.{" "}
        <a href={directory.sourceUrl} rel="noreferrer">
          Read the pinned identity inventory
        </a>
        .
      </p>
      <p>
        Program links keep your dates, contribution roles and account-type filter, and start a new snapshot. Repository
        and workstream filters reset unless you choose a repository below.
      </p>
      <p>
        Membership at event time uses known historical associations. Membership current at snapshot cutoff uses the
        completed inventory selected by that snapshot; it is not a live GitHub lookup. Missing historical membership and
        unavailable views remain unknown, not zero.
      </p>
      <p>
        One contribution can appear in several program views. A union of selected Projects counts that contribution
        once; separate program totals must not be added together. Eligible unboarded work remains in the organization
        directory.
      </p>
      <p className="inline-list">
        <a data-api-nav href={href("/contributors", [], "event")}>
          Organization contributors, including unboarded work
        </a>
        {!program && directory.programs.length > 0 && (
          <>
            <a data-api-nav href={href("/contributors", directory.programs, "event")}>
              All listed programs — event membership
            </a>
            <a data-api-nav href={href("/contributors", directory.programs, "current")}>
              All listed programs — current membership
            </a>
          </>
        )}
        {program && (
          <a data-api-nav href={uiHref("/programs", selected, { snapshot: null, cursor: null })}>
            All programs
          </a>
        )}
      </p>
      {!entries.length && (
        <p>No programs are configured in this directory. Organization evidence remains separately available.</p>
      )}
      <ul className="directory">
        {entries.map((entry) => (
          <li key={entry.id}>
            <h2>
              {program ? (
                entry.name
              ) : (
                <a data-api-nav href={uiHref(`/programs/${entry.id}`, selected, { snapshot: null, cursor: null })}>
                  {entry.name}
                </a>
              )}
            </h2>
            <p>
              <a
                href={`https://github.com/orgs/${directory.organization}/projects/${entry.projectNumber}`}
                rel="noreferrer"
              >
                Open native GitHub Project {entry.projectNumber}
              </a>
              {" · "}
              <span className="mono">{entry.projectId}</span>
            </p>
            <p className="inline-list">
              <a data-api-nav href={href("/contributors", [entry], "event")}>
                Contributors with event-time membership
              </a>
              <a data-api-nav href={href("/contributors", [entry], "current")}>
                Contributors with current membership
              </a>
              <a data-api-nav href={href("/activity", [entry])}>
                Activity in this program
              </a>
            </p>
            <h3>Repository scope</h3>
            <p>
              These are configured program repository links, not evidence that every repository action belongs to the
              Project. Each contribution must independently match the selected Project and repository.
            </p>
            {entry.repositoryIds.length ? (
              <ul>
                {entry.repositoryIds.map((id) => {
                  const repository = directory.repositories.find((item) => item.id === id)!;
                  const related = directory.programs.filter(
                    (item) => item.id !== entry.id && item.repositoryIds.includes(id),
                  );
                  return (
                    <li key={id}>
                      <a data-api-nav href={href("/contributors", [entry], context, id)}>
                        {directory.organization}/{repository.name}
                      </a>
                      {" · repository ID "}
                      <span className="mono">{id}</span>
                      {related.length > 0 && (
                        <span>
                          {" "}
                          · also linked from {related.map((item) => item.name).join("; ")}. This does not create
                          duplicate organization credit.
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p>No repository display links are configured. No repository absence is inferred.</p>
            )}
            <h3>Contribution categories</h3>
            <p>
              Every registered category remains discoverable. A category link opens its definitions in this program
              scope; it does not activate a metric or claim measured work.
            </p>
            {departments.length ? (
              <ul className="inline-list">
                {departments.map((department) => (
                  <li key={department.id}>
                    <a data-api-nav href={href("/leaderboards", [entry], context, null, department.id)}>
                      {department.label}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Category navigation is unavailable in the served registry; no replacement categories are inferred.</p>
            )}
            <details>
              <summary>Status and custom fields</summary>
              {entry.fieldNames.length ? (
                <ul>
                  {entry.fieldNames.map((field) => (
                    <li key={field}>{field}</li>
                  ))}
                </ul>
              ) : (
                <p>No Status or custom fields are recorded in this display configuration.</p>
              )}
              <p>
                These recorded Status and custom field names preserve this Project's vocabulary. They are not translated
                into leaderboard status, contribution categories or workstreams. Field-option mappings require separate
                reviewed source configuration.
              </p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
