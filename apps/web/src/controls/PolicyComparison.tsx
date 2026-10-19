import { useEffect, useRef, useState } from "react";
import { ControlsFailure, type Session } from "./client.ts";
import { PolicyAudit } from "./PolicyAudit.tsx";
import {
  comparePolicy,
  policyInputs,
  readCandidatePolicy,
  rereadPolicy,
  type FrozenPolicyInput,
  type PolicyPreview,
} from "./policy-comparison-client.ts";

/** Private previews are opt-in, session-bound and never persisted in browser storage. */
export function PolicyComparison({ session, onAuthorityLost }: { session: Session; onAuthorityLost: () => void }) {
  const [inputs, setInputs] = useState<FrozenPolicyInput[] | null>(null);
  const [selected, setSelected] = useState("");
  const [candidate, setCandidate] = useState("");
  const [savedId, setSavedId] = useState("");
  const [result, setResult] = useState<PolicyPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const generation = useRef(0);
  const mounted = useRef(false);
  const latestSession = useRef(session);
  latestSession.current = session;
  const input = inputs?.find((entry) => entry.inputId === selected);
  const permitted = () => !document.hidden && session.roles.includes("reviewer") && session.expires > Date.now();
  function clearResult() {
    ++generation.current;
    setResult(null);
    setPage(0);
    setError("");
    setBusy(false);
  }
  function clear() {
    clearResult();
    setInputs(null);
    setSelected("");
    setCandidate("");
    setSavedId("");
  }
  useEffect(() => {
    mounted.current = true;
    clear();
    const hide = () => {
      if (document.hidden) clear();
    };
    document.addEventListener("visibilitychange", hide);
    const timer = setTimeout(clear, Math.max(0, session.expires - Date.now()));
    return () => {
      mounted.current = false;
      ++generation.current;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [session]);
  useEffect(() => {
    if (!input) return;
    const timer = setTimeout(
      () => {
        clear();
        setError("The frozen input expired. Reload retained inputs.");
      },
      Math.max(0, Date.parse(input.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [input]);
  async function run(work: () => Promise<void>) {
    if (!permitted() || busy) return;
    const current = ++generation.current;
    setBusy(true);
    setError("");
    setResult(null);
    setPage(0);
    try {
      await work();
    } catch (e) {
      if (!mounted.current || latestSession.current !== session || !permitted()) return;
      if (e instanceof ControlsFailure && [401, 403].includes(e.status)) {
        clear();
        onAuthorityLost();
        return;
      }
      if (current !== generation.current) return;
      setError(e instanceof Error ? e.message : "Private preview unavailable. No policy change has been confirmed.");
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  async function load() {
    await run(async () => {
      const current = generation.current;
      setInputs(null);
      setSelected("");
      setCandidate("");
      setSavedId("");
      const records = await policyInputs();
      if (current !== generation.current || !permitted()) return;
      setInputs(records);
    });
  }
  async function preview(saved = false) {
    if (!input || Date.parse(input.expiresAt) <= Date.now()) return;
    await run(async () => {
      const current = generation.current;
      const value = saved
        ? await rereadPolicy(input, savedId)
        : await comparePolicy(input, readCandidatePolicy(candidate, input), session);
      if (current !== generation.current || !permitted() || Date.parse(input.expiresAt) <= Date.now()) return;
      setResult(value);
      setSavedId(value.comparisonId);
      if (saved) setCandidate(JSON.stringify(value.candidatePolicy));
    });
  }
  if (!session.roles.includes("reviewer")) return null;
  return (
    <section className="policy-comparison" aria-labelledby="policy-preview-title">
      <h2 id="policy-preview-title">Private policy comparison</h2>
      <p>
        Compare a candidate policy with the approved baseline on the same retained dataset. Values and ranks describe a
        preview. Designated approval and release notes are required before a policy can be released.
      </p>
      <button type="button" disabled={busy} onClick={() => void load()}>
        Load retained policy inputs
      </button>
      {busy && <p role="status">Checking private comparison…</p>}
      {error && <p role="alert">{error}</p>}
      {inputs?.length === 0 && (
        <p>No authorized frozen input is retained. A new approved collection must retain an input before comparison.</p>
      )}
      {inputs && inputs.length > 0 && (
        <>
          <label className="control-field">
            Frozen input
            <select
              value={selected}
              onChange={(e) => {
                clearResult();
                setSelected(e.target.value);
                setCandidate("");
                setSavedId("");
              }}
            >
              <option value="">Choose a retained snapshot</option>
              {inputs.map((entry) => (
                <option key={entry.inputId} value={entry.inputId}>
                  {entry.snapshot.snapshotId} · revision {entry.snapshot.revision} · cutoff {entry.cutoff}
                </option>
              ))}
            </select>
          </label>
          {input && (
            <>
              <p>
                Frozen cutoff: {input.cutoff}. Retained until: {input.expiresAt}. Scope hash:{" "}
                <code>{input.scopeHash}</code>.
              </p>
              <ul>
                {input.policies.map((p) => (
                  <li key={p.metricId}>
                    {p.metricId} · baseline version {p.version} · hash <code>{p.policyHash}</code>
                  </li>
                ))}
              </ul>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void preview();
                }}
              >
                <label className="control-field">
                  Complete candidate policy JSON
                  <textarea
                    value={candidate}
                    rows={10}
                    maxLength={8192}
                    required
                    spellCheck={false}
                    onChange={(e) => {
                      clearResult();
                      setCandidate(e.target.value);
                    }}
                  />
                </label>
                <p>
                  Supply the complete proposed metric policy, including its version. The service selects the retained
                  baseline and validates the candidate.
                </p>
                <button disabled={busy}>Compare candidate policy</button>
              </form>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void preview(true);
                }}
              >
                <label className="control-field">
                  Saved comparison ID
                  <input
                    value={savedId}
                    pattern="[a-f0-9]{64}"
                    maxLength={64}
                    required
                    onChange={(e) => {
                      clearResult();
                      setSavedId(e.target.value);
                    }}
                  />
                </label>
                <button disabled={busy}>Recheck saved comparison</button>
              </form>
            </>
          )}
        </>
      )}
      {result && (
        <div>
          <h3>Candidate preview result</h3>
          <p role="status">Private preview confirmed. Public rankings have not changed.</p>
          <p>
            Baseline {result.before.policyVersion} → candidate {result.after.policyVersion}. This is recalculation on
            identical frozen input; rank differences are not live contributor progress.
          </p>
          {result.redactionsApplied && (
            <p>Current privacy restrictions removed evidence. Affected rows and all comparison ranks are withheld.</p>
          )}
          <p>
            {result.changes.length} visible changed contributors. Baseline rows: {result.before.rows.length}; candidate
            rows: {result.after.rows.length}.
          </p>
          <details>
            <summary>Policies and coverage</summary>
            <h4>Baseline policy</h4>
            <pre>{JSON.stringify(result.beforePolicy, null, 2)}</pre>
            <h4>Candidate policy</h4>
            <pre>{JSON.stringify(result.candidatePolicy, null, 2)}</pre>
            <h4>Coverage</h4>
            <pre>{JSON.stringify({ before: result.before.coverage, after: result.after.coverage }, null, 2)}</pre>
          </details>
          {result.changes.length > 0 && (
            <>
              <div className="policy-difference-table" role="region" aria-label="Policy difference table" tabIndex={0}>
                <table>
                  <caption>
                    Policy recalculation differences, contributors {page * 25 + 1}–
                    {Math.min((page + 1) * 25, result.changes.length)} of {result.changes.length}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Contributor ID</th>
                      <th scope="col">Value before → after</th>
                      <th scope="col">Rank before → after</th>
                      <th scope="col">Evidence and causes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.changes.slice(page * 25, (page + 1) * 25).map((change) => (
                      <tr key={change.actorId}>
                        <th scope="row">{change.actorId}</th>
                        <td>
                          {change.beforeValue ?? "Unknown"} → {change.afterValue ?? "Unknown"}
                        </td>
                        <td>
                          {change.beforeRank ?? "Unavailable"} → {change.afterRank ?? "Unavailable"}
                        </td>
                        <td>
                          <details>
                            <summary>
                              {change.included.length} included; {change.excluded.length} excluded
                            </summary>
                            <pre>{JSON.stringify(change.causes, null, 2)}</pre>
                          </details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>
                Previous changes
              </button>
              <button
                type="button"
                disabled={(page + 1) * 25 >= result.changes.length}
                onClick={() => setPage(page + 1)}
              >
                Next changes
              </button>
            </>
          )}
          <PolicyAudit key={result.responseHash} result={result} />
          <details>
            <summary>Private comparison receipt</summary>
            <dl>
              <dt>Comparison ID</dt>
              <dd>{result.comparisonId}</dd>
              <dt>Stored result hash</dt>
              <dd>{result.resultHash}</dd>
              <dt>Current response hash</dt>
              <dd>{result.responseHash}</dd>
            </dl>
          </details>
        </div>
      )}
    </section>
  );
}
