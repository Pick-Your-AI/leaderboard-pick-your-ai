import React, { useState } from "react";
import type { Session } from "./client.ts";
interface Metric {
  id: string;
  enabled: boolean;
  reason?: string;
  policyVersion: string;
  policyLink: string;
}
interface Document {
  repositories: unknown[];
  projects: unknown[];
  metrics: Metric[];
}
interface Proposal {
  id: string;
  version: string;
  versionNumber: number;
  owner: string;
  status: string;
  digest: string;
  baseRevision: number;
  document: Document;
  history: unknown[];
  preview?: {
    digest: string;
    configurationDigest: string;
    baseRevision: number;
    source: { validUntil: number; [key: string]: unknown };
    before: unknown;
    after: unknown;
  };
  approval?: { id: string; actor: string; configurationDigest: string; previewDigest: string };
}
export interface ConfigurationState {
  revision: number;
  active: Proposal | null;
  proposals: Record<string, Proposal>;
  history: unknown[];
}
type Run = (path: string, input: unknown) => Promise<boolean>;
export function Configuration({ state, session, run }: { state: ConfigurationState; session: Session; run: Run }) {
  const [error, setError] = useState("");
  const [document, setDocument] = useState(
    JSON.stringify(state.active?.document ?? { repositories: [], projects: [], metrics: [] }, null, 2),
  );
  const [target, setTarget] = useState(state.active?.document.metrics[0]?.id ?? "");
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const d = new FormData(e.currentTarget);
    try {
      await run("/controls/configuration/proposals", {
        baseRevision: state.revision,
        version: d.get("version"),
        document: JSON.parse(document),
      });
    } catch {
      setError("Configuration must be valid JSON. Nothing was submitted.");
    }
  };
  return (
    <section>
      <h2>Configuration and operations</h2>
      <p>
        Active revision {state.revision}. Proposals do not change public coverage. Source-tested preview and independent
        operator approval are required before activation. Collection diagnostics and audited inbox replay are in the
        separate operations panel.
      </p>
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>Current configuration and audit</summary>
        <pre>{JSON.stringify({ active: state.active, history: state.history }, null, 2)}</pre>
      </details>
      <h3>Propose configuration</h3>
      <p>
        Supply allowed repositories with installation IDs and capabilities, Project field mappings, and every known
        metric with enabled state and historical policy version/link. Do not include credentials. The server validates
        the registry and verifies source permissions and schemas during preview.
      </p>
      <form onSubmit={submit}>
        <label className="control-field">
          New configuration version
          <input name="version" pattern="[A-Za-z][A-Za-z0-9_.-]{0,99}" required maxLength={100} />
        </label>
        <label className="control-field">
          Configuration document (JSON)
          <textarea
            value={document}
            onChange={(e) => setDocument(e.target.value)}
            required
            maxLength={120000}
            rows={14}
          />
        </label>
        <label>
          <input type="checkbox" required /> Create a proposal against active revision {state.revision}; no activation
          yet
        </label>
        <button>Create configuration proposal</button>
      </form>
      {state.active && (
        <>
          <h3>Disable one metric</h3>
          <p>
            This proposal preserves repositories, Project mappings and historical policy links. Other metrics retain
            their current enabled state.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              const document = {
                ...state.active!.document,
                metrics: state.active!.document.metrics.map((m) =>
                  m.id === target ? { ...m, enabled: false, reason: d.get("reason") } : m,
                ),
              };
              await run("/controls/configuration/proposals", {
                baseRevision: state.revision,
                version: d.get("version"),
                document,
              });
            }}
          >
            <label className="control-field">
              Metric to disable
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                {state.active.document.metrics.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                    {m.enabled ? "" : " (already disabled)"}
                  </option>
                ))}
              </select>
            </label>
            <p>
              Historical policy: {state.active.document.metrics.find((m) => m.id === target)?.policyVersion} ·{" "}
              {state.active.document.metrics.find((m) => m.id === target)?.policyLink}
            </p>
            <label className="control-field">
              Public disable explanation
              <textarea name="reason" required maxLength={500} />
              <span>
                This explanation is published with the disabled metric. Do not include private request details or
                personal information.
              </span>
            </label>
            <label className="control-field">
              Disable proposal version
              <input name="version" required pattern="[A-Za-z][A-Za-z0-9_.-]{0,99}" maxLength={100} />
            </label>
            <label>
              <input type="checkbox" required /> Propose disabling {target} against revision {state.revision}
            </label>
            <button disabled={!target}>Propose metric disable</button>
          </form>
        </>
      )}
      <h3>Proposal review</h3>
      {Object.values(state.proposals).length === 0 && <p>No configuration proposals.</p>}
      {Object.values(state.proposals).map((p) => {
        const current = p.baseRevision === state.revision;
        const validPreview =
          p.preview &&
          p.preview.configurationDigest === p.digest &&
          p.preview.baseRevision === state.revision &&
          p.preview.source.validUntil > Date.now();
        return (
          <article key={`${p.id}:${p.versionNumber}`}>
            <h4>
              {p.version} · {p.status}
            </h4>
            <p>
              Proposal {p.id}, version {p.versionNumber}, base revision {p.baseRevision}, digest {p.digest}
            </p>
            <details>
              <summary>Proposed document and audit</summary>
              <pre>{JSON.stringify({ document: p.document, history: p.history }, null, 2)}</pre>
            </details>
            {p.preview && (
              <>
                <h5>Source-tested coverage preview</h5>
                <p>
                  Preview digest: {p.preview.digest}. Source receipt expires{" "}
                  {new Date(p.preview.source.validUntil).toISOString()}.
                </p>
                <pre>
                  {JSON.stringify(
                    { before: p.preview.before, after: p.preview.after, source: p.preview.source },
                    null,
                    2,
                  )}
                </pre>
              </>
            )}
            {!current && p.status !== "activated" && (
              <p>This proposal is stale. Create a new proposal against the current revision.</p>
            )}
            {current && p.status !== "activated" && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await run(`/controls/configuration/proposals/${p.id}/preview`, { version: p.versionNumber });
                }}
              >
                <label>
                  <input type="checkbox" required /> Source-test proposal {p.version}, version {p.versionNumber};
                  replace any previous approval
                </label>
                <button>Preview configuration</button>
              </form>
            )}
            {current &&
              p.status === "previewed" &&
              validPreview &&
              (p.owner === session.actorId ? (
                <p>Another operator must independently approve your proposal.</p>
              ) : (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    await run(`/controls/configuration/proposals/${p.id}/approve`, {
                      version: p.versionNumber,
                      previewDigest: p.preview!.digest,
                      conflict: false,
                    });
                  }}
                >
                  <label>
                    <input type="checkbox" required /> I have no conflict and approve configuration digest {p.digest}{" "}
                    with preview {p.preview!.digest}
                  </label>
                  <button>Approve tested preview</button>
                </form>
              ))}
            {current &&
              p.status === "approved" &&
              validPreview &&
              p.approval?.configurationDigest === p.digest &&
              p.approval.previewDigest === p.preview!.digest && (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    await run(`/controls/configuration/proposals/${p.id}/activate`, {
                      version: p.versionNumber,
                      approvalId: p.approval!.id,
                    });
                  }}
                >
                  <p>
                    Independent approver: {p.approval.actor}. Approval receipt: {p.approval.id}. Activation rechecks
                    source permissions and approval authority.
                  </p>
                  <label>
                    <input type="checkbox" required /> Activate {p.version}, digest {p.digest}, approval {p.approval.id}
                    , replacing revision {state.revision}
                  </label>
                  <button>Activate approved configuration</button>
                </form>
              )}
            {p.status === "activated" && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await run("/controls/configuration/rollback", {
                    baseRevision: state.revision,
                    version: new FormData(e.currentTarget).get("version"),
                    targetDigest: p.digest,
                  });
                }}
              >
                <label className="control-field">
                  Rollback proposal version
                  <input name="version" required pattern="[A-Za-z][A-Za-z0-9_.-]{0,99}" maxLength={100} />
                </label>
                <label>
                  <input type="checkbox" required /> Propose restoring digest {p.digest}; requires a new tested preview
                  and independent approval
                </label>
                <button>Propose restoration</button>
              </form>
            )}
          </article>
        );
      })}
    </section>
  );
}
