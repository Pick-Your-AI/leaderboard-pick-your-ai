import React from "react";
import { physicalMetricIds, type PublicPhysicalContext } from "@pick-your-ai/contracts";

const unknownMessages = {
  retained_context_unavailable: "This snapshot did not retain a complete change-size breakdown for this row.",
  selected_units_unbound: "The selected evidence records do not have a complete, matching change-size record.",
  current_context_unavailable: "A complete change-size breakdown is unavailable under current publication controls.",
  context_budget_exceeded: "The complete change-size breakdown exceeds the response limit.",
} as const;
const classes = [
  ["source", "Source", false],
  ["tests", "Tests", false],
  ["docs", "Documentation", false],
  ["generated", "Generated", true],
  ["vendor", "Vendor", true],
  ["lock", "Lockfiles", true],
  ["binary", "Binary", true],
  ["imported", "Imported", true],
] as const;
const count = (value: number) => value.toLocaleString("en-US");
const signed = (value: number) => (value > 0 ? "+" : "") + count(value);

export function isPhysicalContextMetric(metricId: string): boolean {
  return physicalMetricIds.some((id) => id === metricId);
}

/** Displays the already validated, currently public projection for this row. */
export function PhysicalContext({
  context,
  metricId,
}: {
  context?: PublicPhysicalContext | undefined;
  metricId: string;
}) {
  if (!isPhysicalContextMetric(metricId)) return null;
  if (!context || context.metricId !== metricId || context.state === "unknown")
    return (
      <div className="small" role="group" aria-label="Change-size context">
        <p>
          <strong>Change-size context unavailable.</strong>{" "}
          {!context
            ? "This snapshot has no retained change-size context."
            : context.metricId !== metricId
              ? "A matching change-size breakdown is unavailable for this metric."
              : context.state === "unknown"
                ? unknownMessages[context.reason]
                : "A complete change-size breakdown is unavailable for this row."}
        </p>
        <p>Counts, classification and revision links are unknown here. Missing context does not mean zero change.</p>
      </div>
    );

  const { summary } = context;
  return (
    <div className="small" role="group" aria-label="Change-size context" style={{ overflowWrap: "anywhere" }}>
      <p>
        <strong>Eligible delivered change:</strong> {count(summary.eligible.additions)} added lines;{" "}
        {count(summary.eligible.deletions)} removed lines;{" "}
        {signed(summary.eligible.additions - summary.eligible.deletions)} net lines (added minus removed);{" "}
        {count(summary.eligible.additions + summary.eligible.deletions)} changed lines; {count(summary.eligible.files)}{" "}
        file {summary.eligible.files === 1 ? "change" : "changes"}.
      </p>
      <p>
        <strong>PR sample count:</strong> {count(context.sampleCount)} verified default-branch integration{" "}
        {context.sampleCount === 1 ? "sample" : "samples"}; {count(context.unitCount)} selected evidence{" "}
        {context.unitCount === 1 ? "record" : "records"}. This sample covers this row's metric and filters; it is not a
        count of every merged PR.
      </p>
      <p>
        <strong>Raw examined change:</strong> {count(summary.raw.additions)} added lines; {count(summary.raw.deletions)}{" "}
        removed lines; {count(summary.raw.files)} file {summary.raw.files === 1 ? "change" : "changes"}.
      </p>
      <p>
        <strong>Excluded from delivered totals:</strong> {count(summary.raw.files - summary.eligible.files)} file{" "}
        {summary.raw.files - summary.eligible.files === 1 ? "change" : "changes"};{" "}
        {count(summary.raw.additions - summary.eligible.additions)} added lines;{" "}
        {count(summary.raw.deletions - summary.eligible.deletions)} removed lines. Exclusions cover generated, vendor,
        lockfile, binary and imported changes, plus formatting-only changes.
      </p>
      <p>
        <strong>Formatting-only exclusions:</strong> {count(summary.formattingOnly.files)} file{" "}
        {summary.formattingOnly.files === 1 ? "change" : "changes"}; {count(summary.formattingOnly.additions)} added
        lines; {count(summary.formattingOnly.deletions)} removed lines.
      </p>
      <p>
        <strong>Classifier coverage:</strong> the complete examined file inventory for these samples. Source-history
        coverage and freshness remain those shown for the board. These counts describe change size; they do not measure
        effort, quality or overall contributor merit.
      </p>
      <details className="coverage-note">
        <summary>Inspect classification and source pins</summary>
        <p>Classifier: {context.classifierVersion}. Each file change belongs to one class.</p>
        <dl>
          {classes.map(([key, label, excluded]) => {
            const bucket = summary.classes[key];
            return (
              <div key={key}>
                <dt>{label}</dt>
                <dd>
                  Raw: {count(bucket.raw.files)} file changes; {count(bucket.raw.additions)} added lines;{" "}
                  {count(bucket.raw.deletions)} removed lines.{" "}
                  {excluded ? (
                    "Excluded from delivered totals."
                  ) : (
                    <>
                      Eligible: {count(bucket.eligible.files)} file changes; {count(bucket.eligible.additions)} added
                      lines; {count(bucket.eligible.deletions)} removed lines.
                    </>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
        <p>
          Each integration is counted once in this sample. File changes count repository/path/PR units; the same path
          can contribute again in another PR. The links identify each integration's pinned source revisions.
        </p>
        <ol aria-label="Sample source pins">
          {context.samples.map((sample) => (
            <li key={sample.sampleId}>
              <p>
                <a href={sample.sourceUrl} rel="noreferrer noopener">
                  {sample.sourceUrl.replace("https://github.com/", "")}
                </a>{" "}
                · Integrated <time dateTime={sample.integratedAt}>{sample.integratedAt}</time>
              </p>
              <p>
                <a href={sample.beforeUrl} rel="noreferrer noopener">
                  Before revision <code style={{ whiteSpace: "normal" }}>{sample.before}</code>
                </a>
                {" · "}
                <a href={sample.afterUrl} rel="noreferrer noopener">
                  After revision <code style={{ whiteSpace: "normal" }}>{sample.after}</code>
                </a>
              </p>
              <p>Selected evidence IDs for this metric:</p>
              <ul>
                {sample.evidenceIds.map((id) => (
                  <li key={id}>
                    <code style={{ whiteSpace: "normal" }}>{id}</code>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
