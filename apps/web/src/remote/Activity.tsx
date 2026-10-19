import { Receipt } from "./Evidence.tsx";
import React from "react";
import { compareSourceInstants } from "@pick-your-ai/contracts";
import {
  publicLink,
  uiHref,
  type Activity,
  type ActivityDetail,
  type ActivityGroup,
  type Selection,
} from "./client.ts";

const stateLabel = (state: ActivityGroup["activityState"]) =>
  ({
    observed: "Received public activity",
    pending: "In-progress work",
    accepted: "Independently accepted work",
    unknown: "Acceptance state unknown",
  })[state];
function Clock({ value }: { value: string | null }) {
  return value === null ? <>Unknown</> : <time dateTime={value}>{value}</time>;
}
function GroupSummary({ group, selected }: { group: ActivityGroup; selected: Selection }) {
  return (
    <>
      <h2>
        <a data-api-nav href={uiHref(`/contributors/${encodeURIComponent(group.actorId)}`, selected)}>
          {group.actor.displayName ?? group.actor.login ?? group.actorId}
        </a>{" "}
        · {stateLabel(group.activityState)}
      </h2>
      <p>
        Repository: {group.repositoryId ?? "Unknown"}. {group.artifactCount} artifacts · {group.factCount} canonical
        facts · {group.proofCount} evidence records.
      </p>
      <p>
        Action time: <Clock value={group.latestOccurredAt} />
        {group.earliestOccurredAt !== group.latestOccurredAt && (
          <>
            {" "}
            (earliest in this group: <Clock value={group.earliestOccurredAt} />)
          </>
        )}
        {group.latestOccurredAt === null && "; no event date or burst timing is inferred"}.
      </p>
      <p>
        Collected at: <Clock value={group.lastCollectedAt} />
        {group.firstCollectedAt !== group.lastCollectedAt && (
          <>
            {" "}
            (first collected: <Clock value={group.firstCollectedAt} />)
          </>
        )}
        {group.unknownCollectionCount > 0 && (
          <>; collection time unknown for {group.unknownCollectionCount} evidence records</>
        )}
        .
        {group.lastCollectedAt !== null &&
          group.latestOccurredAt !== null &&
          compareSourceInstants(group.lastCollectedAt, group.latestOccurredAt) > 0 && (
            <> Collection occurred after the action; this may be a delayed import.</>
          )}
      </p>
      <p>
        Published categories: {group.categoryIds.join(", ")}. Categories and state groups may overlap for the same fact;
        do not add their counts. No combined score is calculated.
      </p>
    </>
  );
}
export function ActivityFeed({ value, selected }: { value: Activity; selected: Selection }) {
  return (
    <>
      <p>
        {value.totalGroups} activity groups. Showing {value.groups.length} on this page, newest known action first;
        unknown action dates follow.
      </p>
      <p>
        Public facts from the same contributor, repository, work state and UTC hour are grouped to keep bursts compact.
        Previewing up to five artifacts per group; every source proof remains available. Repeated metric representations
        count as one canonical fact within each explicit work state. Acceptance can differ across category policies;
        state-group counts must not be added.
      </p>
      <p>
        Only retained public evidence is shown. Source proofs show supplied action metadata, independently evidenced
        acceptance dates and explicitly public revision/correction records. History coverage is stated per proof;
        missing records do not establish that no correction occurred. Current privacy controls still apply.
      </p>
      <ol className="directory" aria-label="Public activity groups">
        {value.groups.map((group) => (
          <li key={group.groupId}>
            <GroupSummary group={group} selected={selected} />
            <ul aria-label="Artifact preview">
              {group.artifactPreview.map((item) => (
                <li key={item.artifactId}>
                  <a href={publicLink(item.publicUrl)!} rel="noreferrer nofollow">
                    {item.kind}: {item.artifactId}
                  </a>
                </li>
              ))}
            </ul>
            {group.artifactCount > group.artifactPreview.length && (
              <p>{group.artifactCount - group.artifactPreview.length} more artifacts in this group.</p>
            )}
            <a data-api-nav href={uiHref(`/activity/${group.groupId}`, selected)}>
              Explore {group.proofCount} source proofs
            </a>
          </li>
        ))}
      </ol>
      {!value.groups.length && (
        <p>No public activity matches this selection. Missing evidence does not establish zero activity.</p>
      )}
      {value.nextCursor && (
        <nav aria-label="Activity pages">
          <a data-api-nav href={uiHref("/activity", selected, { cursor: value.nextCursor })}>
            Next activity page
          </a>
        </nav>
      )}
    </>
  );
}
export function ActivityProofs({ value, selected }: { value: ActivityDetail; selected: Selection }) {
  return (
    <>
      <GroupSummary group={value.group} selected={selected} />
      <p>
        Showing {value.proofs.length} of {value.group.proofCount} evidence records. Multiple records with the same
        canonical fact identify the same work; they are not extra activity or engagement.
      </p>
      <ol className="directory" aria-label="Grouped source proofs">
        {value.proofs.map((proof) => (
          <li key={proof.contribution.contributionId}>
            <h3>
              <a
                data-api-nav
                href={uiHref(`/contributions/${encodeURIComponent(proof.contribution.contributionId)}`, selected)}
              >
                {proof.contribution.contributionId}
              </a>
            </h3>
            <p>
              Canonical fact: <span className="mono">{proof.canonicalFactId}</span>
            </p>
            <Receipt value={proof} selected={selected} />
          </li>
        ))}
      </ol>
      {value.nextCursor && (
        <nav aria-label="Activity proof pages">
          <a data-api-nav href={uiHref(`/activity/${value.group.groupId}`, selected, { cursor: value.nextCursor })}>
            Next source proofs page
          </a>
        </nav>
      )}
      <p>
        <a data-api-nav href={uiHref("/activity", selected)}>
          Return to this snapshot’s activity
        </a>
      </p>
    </>
  );
}
