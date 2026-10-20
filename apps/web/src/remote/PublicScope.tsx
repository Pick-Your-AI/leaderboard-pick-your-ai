import React from "react";
import { publicContributionRoles, type PublicContributionRole, type PublicScope } from "@pick-your-ai/contracts";

const roleLabels: Record<PublicContributionRole, string> = {
  author: "Author",
  coauthor: "Coauthor",
  reviewer: "Reviewer",
  merger: "Merger",
  triager: "Triager",
  reporter: "Reporter",
  resolver: "Resolver",
  nominator: "Nominator",
  automation: "Automation",
};

export function PublicScopeControls({ selected }: { selected: PublicScope }) {
  return (
    <>
      <label>
        Project and workstream membership
        <select name="context" defaultValue={selected.context ?? "event"}>
          <option value="event">Membership at event time</option>
          <option value="current">Membership current at snapshot cutoff</option>
        </select>
      </label>
      <label>
        GitHub Project IDs
        <input name="project" defaultValue={selected.projects?.join(",") ?? ""} aria-describedby="project-scope-help" />
      </label>
      <p id="project-scope-help" className="small">
        Use stable GitHub Project IDs, separated by commas. Selected Projects form a union; overlapping membership
        counts a contribution once. Blank includes all Projects in the materialized scope.
      </p>
      <fieldset className="public-role-options" aria-describedby="role-scope-help">
        <legend>Contribution roles — any selected</legend>
        {publicContributionRoles.map((role) => (
          <label key={role}>
            <input type="checkbox" name="role" value={role} defaultChecked={selected.roles?.includes(role) ?? false} />
            {roleLabels[role]}
          </label>
        ))}
      </fieldset>
      <p id="role-scope-help" className="small">
        Leave every role unchecked to include all contribution roles. Roles describe contributions, and a contribution
        can have several roles.
      </p>
    </>
  );
}

export function PublicScopeProvenance({ scope, compact = false }: { scope: PublicScope; compact?: boolean }) {
  const membership = scope.context === "current" ? "current at snapshot cutoff" : "at event time";
  const projects = scope.projects?.length ? scope.projects.join(", ") : "all in this materialized scope";
  const roles = scope.roles?.length
    ? `${scope.roles.map((role) => roleLabels[role]).join(", ")} (any selected)`
    : "all";
  const description =
    `Membership: ${membership}. GitHub Projects: ${projects}. Contribution roles: ${roles}.` +
    (scope.branch === undefined ? "" : ` Merge target at merge: ${scope.branch}.`);
  const provenance = (
    <p className="public-scope-provenance" aria-label="Membership and contribution scope">
      {description}
    </p>
  );
  if (compact && description.length > 130) {
    return (
      <details className="public-scope-details">
        <summary>
          Membership: {membership}. GitHub Projects:{" "}
          {scope.projects?.length ? `${scope.projects.length} selected` : "all in this materialized scope"}.{" "}
          Contribution roles: {scope.roles?.length ? `${scope.roles.length} selected` : "all"}.
          {scope.branch === undefined ? "" : " Merge target selected."} Show full scope.
        </summary>
        {provenance}
      </details>
    );
  }
  return provenance;
}
