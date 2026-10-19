import React from "react";
import { ActivityGroupContents, ActivityTimes, stateLabel } from "./Activity.tsx";
import { publicLink, uiHref, type Selection } from "./client.ts";
import type { ActivityBurst, ActivityBurstDetail, ActivityBursts } from "./activity-bursts.ts";

function BurstSummary({ burst, selected }: { burst: ActivityBurst; selected: Selection }) {
  const actor = burst.previewGroups[0]!.actor;
  return (
    <>
      <h2>
        <a data-api-nav href={uiHref(`/contributors/${encodeURIComponent(burst.actorId)}`, selected)}>
          {actor.displayName ?? actor.login ?? burst.actorId}
        </a>{" "}
        · {stateLabel(burst.activityState)}
      </h2>
      <p>
        {burst.latestOccurredAt === null
          ? "One repository group with an unknown action time."
          : `${burst.groupCount} repository groups in one UTC hour.`}{" "}
        This compact display preserves each repository group and its source proofs. A group with no supplied repository
        is identified as unknown when expanded.
      </p>
      <ActivityTimes group={burst} />
      <p>
        Published categories: {burst.categoryIds.join(", ")}. Categories and state groups may overlap for the same fact;
        do not add their counts. No combined score is calculated.
      </p>
    </>
  );
}
export function CompactActivityFeed({ value, selected }: { value: ActivityBursts; selected: Selection }) {
  return (
    <>
      <p>
        {value.totalBursts} compact activity entries. Showing {value.bursts.length} on this page, newest known action
        first; unknown action dates follow.
      </p>
      <p>
        Public facts from the same contributor, work state and UTC hour share one entry across repositories, so bulk
        updates stay compact. Unknown action dates remain separate. Previewing up to five artifacts per entry; expand a
        burst to explore every original repository group and source proof.
      </p>
      <p>
        Only retained public evidence is shown. Received activity, in-progress work and independently accepted work
        remain separate. Source proofs show supplied action metadata, independently evidenced acceptance dates and
        explicitly public revision/correction records. History coverage is stated per proof; missing records do not
        establish that no correction occurred. Current privacy controls still apply.
      </p>
      <ol className="directory" aria-label="Public activity groups">
        {value.bursts.map((burst) => (
          <li key={burst.burstId}>
            {burst.groupCount === 1 ? (
              <ActivityGroupContents group={burst.previewGroups[0]!} selected={selected} />
            ) : (
              <>
                <BurstSummary burst={burst} selected={selected} />
                <ul aria-label="Artifact preview">
                  {burst.previewGroups
                    .flatMap((group) => group.artifactPreview.map((item) => ({ group, item })))
                    .slice(0, 5)
                    .map(({ group, item }) => (
                      <li key={`${group.groupId}:${item.artifactId}`}>
                        <a href={publicLink(item.publicUrl)!} rel="noreferrer nofollow">
                          {group.repositoryId ?? "Unknown repository"} · {item.kind}: {item.artifactId}
                        </a>
                      </li>
                    ))}
                </ul>
                <a data-api-nav href={uiHref(`/activity/bursts/${burst.burstId}`, selected)}>
                  Explore {burst.groupCount} repository groups
                </a>
              </>
            )}
          </li>
        ))}
      </ol>
      {!value.bursts.length && (
        <p>No public activity matches this selection. Missing evidence does not establish zero activity.</p>
      )}
      {value.nextCursor && (
        <nav aria-label="Activity pages">
          <a data-api-nav href={uiHref("/activity/bursts", selected, { cursor: value.nextCursor })}>
            Next activity page
          </a>
        </nav>
      )}
    </>
  );
}
export function ActivityBurstGroups({ value, selected }: { value: ActivityBurstDetail; selected: Selection }) {
  return (
    <>
      <BurstSummary burst={value.burst} selected={selected} />
      <p>
        Showing {value.groups.length} of {value.burst.groupCount} original repository groups, newest known action first.
        Every group retains its original source-proof link.
      </p>
      <ol className="directory" aria-label="Burst repository groups">
        {value.groups.map((group) => (
          <li key={group.groupId}>
            <ActivityGroupContents group={group} selected={selected} />
          </li>
        ))}
      </ol>
      {value.nextCursor && (
        <nav aria-label="Repository group pages">
          <a
            data-api-nav
            href={uiHref(`/activity/bursts/${value.burst.burstId}`, selected, { cursor: value.nextCursor })}
          >
            Next repository groups page
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
