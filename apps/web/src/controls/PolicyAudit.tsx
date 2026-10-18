import { Fragment, useId, useState } from "react";
import { type PolicyAuditEntry, type PolicyPreview } from "./policy-comparison-client.ts";

const pageSize = 25;
const conditions: Record<string, [string, string]> = {
  repeated_policy_unit: [
    "Repeated policy unit",
    "These additional facts were grouped under the published aggregation rule.",
  ],
  duplicate_observation: ["Duplicate observation", "Several adapter observations refer to the same canonical action."],
  conflicting_revision: ["Conflicting revision", "The retained copies disagree about the same fact revision."],
  ambiguous_canonical_action: ["Conflicting source action", "The retained facts disagree about one canonical action."],
  conflicting_policy_unit: ["Conflicting measurement", "Facts in one policy unit supply different measurement inputs."],
  unreviewed_revision: ["Correction review missing", "This revision has no qualifying correction receipt."],
  missing_independent_acceptance: [
    "Independent acceptance unconfirmed",
    "The required independent acceptance could not be established.",
  ],
  excluded_by_policy_or_correction: [
    "Policy or correction exclusion",
    "The fact is excluded under its retained policy or correction state.",
  ],
  unknown_actor: ["Actor unresolved", "The available input does not establish an eligible actor identity."],
  observation_after_cutoff: ["Observation after cutoff", "This observation arrived after the frozen input cutoff."],
  acceptance_after_cutoff: ["Acceptance after cutoff", "This acceptance is later than the frozen input cutoff."],
  outside_window: ["Outside selected window", "The effective event is outside the selected half-open time window."],
};
const describe = (reason: string): [string, string] => {
  if (/^included_(count|sum|ratio|duration)_(observed|qualified|reviewed)$/.test(reason))
    return [
      "Included in calculation",
      "The retained aggregation includes this fact under the selected policy. This audit label alone does not establish independent source verification.",
    ];
  return Object.hasOwn(conditions, reason)
    ? conditions[reason]!
    : [
        "Other calculation condition",
        "Review the recorded condition and its source context before drawing a conclusion.",
      ];
};

/** Renders only the already-authorized, redacted audit supplied with this preview. */
export function PolicyAudit({ result }: { result: PolicyPreview }) {
  const auditId = useId();
  const [side, setSide] = useState<"before" | "after">("before");
  const [condition, setCondition] = useState("");
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [factPage, setFactPage] = useState(0);
  const aggregate = result[side];
  const entries = aggregate.audit
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !condition || entry.reason === condition);
  const reasons = [...new Set(aggregate.audit.map((entry) => entry.reason))].sort();
  function reset() {
    setPage(0);
    setExpanded(null);
    setFactPage(0);
  }
  function move(next: number) {
    setPage(next);
    setExpanded(null);
    setFactPage(0);
  }
  function inspect(index: number) {
    setExpanded(expanded === index ? null : index);
    setFactPage(0);
  }
  const actor = (entry: PolicyAuditEntry) => entry.actorId ?? "Unknown actor";
  return (
    <section aria-labelledby="policy-audit-title">
      <h3 id="policy-audit-title">Calculation evidence audit</h3>
      <p>
        Inspect included, grouped and excluded evidence recorded by the metric calculation. These entries support human
        review; they do not establish contributor intent or authorize a penalty. The visible list follows the current
        access restrictions.
      </p>
      <div className="control-field">
        <label htmlFor={auditId + "-policy"}>Audit policy</label>
        <select
          id={auditId + "-policy"}
          value={side}
          onChange={(event) => {
            setSide(event.target.value as "before" | "after");
            setCondition("");
            reset();
          }}
        >
          <option value="before">Baseline · {result.before.policyVersion}</option>
          <option value="after">Candidate · {result.after.policyVersion}</option>
        </select>
      </div>
      <div className="control-field">
        <label htmlFor={auditId + "-condition"}>Audit condition</label>
        <select
          id={auditId + "-condition"}
          value={condition}
          onChange={(event) => {
            setCondition(event.target.value);
            reset();
          }}
        >
          <option value="">All recorded conditions</option>
          {reasons.map((reason) => (
            <option key={reason} value={reason}>
              {describe(reason)[0]} · {reason}
            </option>
          ))}
        </select>
      </div>
      <p role="status">{entries.length} visible audit entries for this selection.</p>
      {entries.length === 0 ? (
        <p>
          No visible audit entries match. An empty list does not establish complete source history or absence of an
          issue.
        </p>
      ) : (
        <>
          <div className="policy-difference-table" role="region" aria-label="Policy audit table" tabIndex={0}>
            <table>
              <caption>
                {side === "before" ? "Baseline" : "Candidate"} audit entries {page * pageSize + 1}–
                {Math.min((page + 1) * pageSize, entries.length)} of {entries.length}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Recorded condition</th>
                  <th scope="col">Actor identity</th>
                  <th scope="col">Evidence inspection</th>
                </tr>
              </thead>
              <tbody>
                {entries.slice(page * pageSize, (page + 1) * pageSize).map(({ entry, index }) => (
                  <Fragment key={index}>
                    <tr>
                      <th scope="row">
                        {describe(entry.reason)[0]}
                        <p>{describe(entry.reason)[1]}</p>
                        <code>{entry.reason}</code>
                      </th>
                      <td>{actor(entry)}</td>
                      <td>
                        <button
                          type="button"
                          aria-label={
                            "Inspect " +
                            entry.factIds.length +
                            " fact " +
                            (entry.factIds.length === 1 ? "identity" : "identities") +
                            " for audit entry " +
                            (index + 1)
                          }
                          aria-expanded={expanded === index}
                          onClick={() => inspect(index)}
                        >
                          Inspect {entry.factIds.length} fact {entry.factIds.length === 1 ? "identity" : "identities"}
                        </button>
                      </td>
                    </tr>
                    {expanded === index && (
                      <tr>
                        <td colSpan={3}>
                          <h4>Fact identities for audit entry {index + 1}</h4>
                          <p>
                            These identities belong to this retained calculation and condition. They are not a count of
                            all source events or a finding about the actor.
                          </p>
                          <p role="status">
                            Fact identities {factPage * pageSize + 1}–
                            {Math.min((factPage + 1) * pageSize, entry.factIds.length)} of {entry.factIds.length}
                          </p>
                          <pre>{entry.factIds.slice(factPage * pageSize, (factPage + 1) * pageSize).join("\n")}</pre>
                          <button type="button" disabled={factPage === 0} onClick={() => setFactPage(factPage - 1)}>
                            Previous fact identities
                          </button>
                          <button
                            type="button"
                            disabled={(factPage + 1) * pageSize >= entry.factIds.length}
                            onClick={() => setFactPage(factPage + 1)}
                          >
                            Next fact identities
                          </button>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" disabled={page === 0} onClick={() => move(page - 1)}>
            Previous audit entries
          </button>
          <button type="button" disabled={(page + 1) * pageSize >= entries.length} onClick={() => move(page + 1)}>
            Next audit entries
          </button>
        </>
      )}
    </section>
  );
}
