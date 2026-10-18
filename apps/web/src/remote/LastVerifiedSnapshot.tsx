import React from "react";

export interface SnapshotReference {
  snapshotId: string;
  generatedAt: string;
}

/** A historical reference, never retained contributor content or current health. */
export function LastVerifiedSnapshot({ value }: { value: SnapshotReference }) {
  return (
    <>
      <h3>Last verified snapshot</h3>
      <p>
        Snapshot <strong>{value.snapshotId}</strong> · generated{" "}
        <time dateTime={value.generatedAt}>{value.generatedAt}</time>
      </p>
      <p>Contributor details remain hidden until current publication controls can be checked.</p>
    </>
  );
}
