import React, { useEffect, useState } from "react";
import { control, type Session } from "./client.ts";
import type { Nomination } from "./Spotlights.tsx";
import { publicLink } from "../remote/client.ts";
import {
  editorialDimensionsVersion,
  editorialPeriod,
  type EditorialPeriod,
} from "../remote/editorial-rotation-client.ts";

interface Declaration {
  id: string;
  owner: string;
  version: number;
  revision: number;
  digest: string;
  claimId: string;
  claimVersion: number;
  nominationVersion: number;
  workstreams: string[];
  behindScenes: boolean;
  newcomerPeriod: EditorialPeriod | null;
  status: "pending" | "accepted" | "rejected" | "withdrawn";
  historyCount: number;
  currentContext:
    | { state: "unavailable" }
    | {
        state: "current";
        sourceUrl: string;
        category: string;
        selectionExplanation: string;
        selectedAt: string;
      };
}
function queue(value: unknown): Declaration[] {
  const result = value as { schemaVersion?: unknown; records?: unknown } | null;
  if (
    result?.schemaVersion !== editorialDimensionsVersion ||
    !Array.isArray(result.records) ||
    result.records.length > 256
  )
    throw Error("Editorial declarations are unavailable.");
  const records = result.records.map((raw): Declaration => {
    const r = raw as Declaration;
    if (
      !r ||
      typeof r.id !== "string" ||
      typeof r.owner !== "string" ||
      typeof r.digest !== "string" ||
      typeof r.claimId !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,200}$/.test(r.claimId) ||
      !Number.isSafeInteger(r.claimVersion) ||
      r.claimVersion < 1 ||
      !Number.isSafeInteger(r.nominationVersion) ||
      r.nominationVersion < 1 ||
      !/^[a-f0-9-]{36}$/.test(r.id) ||
      !/^[1-9][0-9]{0,19}$/.test(r.owner) ||
      !Number.isSafeInteger(r.version) ||
      r.version < 1 ||
      !Number.isSafeInteger(r.revision) ||
      r.revision < 1 ||
      typeof r.status !== "string" ||
      !["pending", "accepted", "rejected", "withdrawn"].includes(r.status) ||
      !/^[a-f0-9]{64}$/.test(r.digest) ||
      !Array.isArray(r.workstreams) ||
      r.workstreams.length > 4 ||
      !r.workstreams.every(
        (v) =>
          typeof v === "string" &&
          v.trim() === v &&
          v.length > 0 &&
          v.length <= 100 &&
          !/[\uD800-\uDFFF]/u.test(v) &&
          !/[\u0000-\u001f\u007f]/.test(v),
      ) ||
      new Set(r.workstreams).size !== r.workstreams.length ||
      typeof r.behindScenes !== "boolean" ||
      !Number.isSafeInteger(r.historyCount) ||
      r.historyCount < 1 ||
      r.historyCount > 65
    )
      throw Error("Editorial declarations are unavailable.");
    // Optional display context cannot remove an otherwise valid consent record.
    // A v1 locator may be valid for its original purpose but unsafe as this link.
    const context = r.currentContext;
    const safeContext =
      context?.state === "current" &&
      typeof context.sourceUrl === "string" &&
      context.sourceUrl.length <= 2048 &&
      publicLink(context.sourceUrl) === context.sourceUrl &&
      new URL(context.sourceUrl).hostname === "github.com" &&
      typeof context.category === "string" &&
      Boolean(context.category.trim()) &&
      context.category.length <= 200 &&
      typeof context.selectionExplanation === "string" &&
      Boolean(context.selectionExplanation.trim()) &&
      context.selectionExplanation.length <= 1000 &&
      typeof context.selectedAt === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(context.selectedAt) &&
      Number.isFinite(Date.parse(context.selectedAt)) &&
      new Date(context.selectedAt).toISOString() === context.selectedAt;
    return {
      id: r.id,
      owner: r.owner,
      version: r.version,
      revision: r.revision,
      digest: r.digest,
      claimId: r.claimId,
      claimVersion: r.claimVersion,
      nominationVersion: r.nominationVersion,
      workstreams: [...r.workstreams],
      behindScenes: r.behindScenes,
      newcomerPeriod: editorialPeriod(r.newcomerPeriod),
      status: r.status,
      historyCount: r.historyCount,
      currentContext: safeContext ? { ...context } : { state: "unavailable" },
    };
  });
  if (new Set(records.map((r) => r.id)).size !== records.length) throw Error("Editorial declarations are unavailable.");
  return records;
}

export function SpotlightRotation({
  nominations,
  session,
  run,
  admin,
}: {
  nominations: Nomination[];
  session: Session;
  admin: boolean;
  run: (path: string, input: unknown) => Promise<boolean>;
}) {
  const [records, setRecords] = useState<Declaration[] | null>(null);
  const [error, setError] = useState(false);
  const [assessing, setAssessing] = useState<Record<string, boolean>>({});
  const [accepting, setAccepting] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let active = true;
    setRecords(null);
    setError(false);
    void control<unknown>("/controls/spotlight-rotation/queue")
      .then(queue)
      .then((value) => {
        if (active && !document.hidden) setRecords(value);
      })
      .catch(() => {
        if (active && !document.hidden) {
          setRecords(null);
          setError(true);
        }
      });
    return () => {
      active = false;
    };
  }, [session, nominations]);
  const owned = nominations.filter((n) => n.owner === session.actorId && n.status === "accepted");
  return (
    <section aria-labelledby="editorial-dimensions-controls-title">
      <h2 id="editorial-dimensions-controls-title">Editorial dimension consent and review</h2>
      <p>
        Choose how an already accepted spotlight may be described. Editorial workstream names are reviewed descriptions,
        not GitHub Project membership or product workstream IDs. These choices do not change rankings.
      </p>
      <p>
        Newcomer assessments are explicitly dated: first qualifying accepted contribution in the requested period.
        Missing reviewed organization history remains unknown. Consent does not establish a newcomer identity.
      </p>
      <p>
        Capacity: 32 admitted descriptions, including at most 8 history assessments. Withdrawal remains available when
        eligibility changes.
      </p>
      {error ? (
        <p role="alert">Declarations could not be read. Reload before changing them; no success is confirmed.</p>
      ) : records === null ? (
        <p role="status">Checking current dimension declarations…</p>
      ) : (
        <>
          {owned.map((n) => {
            const record = records.find((r) => r.id === n.id);
            const assess = assessing[n.id] ?? Boolean(record?.newcomerPeriod);
            return (
              <form
                key={`${n.id}:${record?.version ?? 0}`}
                onSubmit={async (event) => {
                  event.preventDefault();
                  const d = new FormData(event.currentTarget);
                  await run("/controls/spotlight-rotation", {
                    nominationId: n.id,
                    version: record?.version ?? null,
                    consent: d.get("consent") === "on",
                    workstreams: String(d.get("workstreams") ?? "")
                      .split("\n")
                      .map((v) => v.trim())
                      .filter(Boolean),
                    behindScenes: d.get("behindScenes") === "on",
                    newcomerPeriod: assess ? { start: d.get("start"), end: d.get("end") } : null,
                  });
                }}
              >
                <h3>
                  {record ? "Amend" : "Propose"} dimensions for nomination {n.id}
                </h3>
                <label className="control-field">
                  Editorial workstream descriptions — one per line, at most four
                  <textarea name="workstreams" maxLength={403} defaultValue={record?.workstreams.join("\n") ?? ""} />
                </label>
                <label>
                  <input name="behindScenes" type="checkbox" defaultChecked={record?.behindScenes ?? false} />I consent
                  to a reviewed behind-the-scenes description of this contribution.
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={assess}
                    onChange={(e) => setAssessing({ ...assessing, [n.id]: e.target.checked })}
                  />
                  I consent to a publicly dated newcomer assessment using reviewed organization history.
                </label>
                {assess && (
                  <>
                    <p>
                      Use exact UTC whole-second timestamps ending .000Z. The period must have ended and be at most 366
                      days.
                    </p>
                    <label className="control-field">
                      Inclusive UTC start
                      <input
                        name="start"
                        required
                        maxLength={24}
                        placeholder="2026-10-01T00:00:00.000Z"
                        defaultValue={record?.newcomerPeriod?.start ?? ""}
                      />
                    </label>
                    <label className="control-field">
                      Exclusive UTC end
                      <input
                        name="end"
                        required
                        maxLength={24}
                        placeholder="2026-10-18T00:00:00.000Z"
                        defaultValue={record?.newcomerPeriod?.end ?? ""}
                      />
                    </label>
                  </>
                )}
                <label>
                  <input name="consent" type="checkbox" required /> I consent to these exact public descriptions and any
                  dated assessment. Amendment removes prior dimension approval until independent review.
                </label>
                <button>Submit dimension proposal</button>
              </form>
            );
          })}
          {!owned.length && (
            <p>
              An accepted spotlight nomination is needed to propose dimensions. Existing dimension consent can still be
              withdrawn below.
            </p>
          )}
          {records.map((record) => (
            <article key={`${record.id}:${record.version}`}>
              <h3>Dimension declaration for {record.id}</h3>
              <p>
                {record.status}; revision {record.revision}; version {record.version}. {record.historyCount} private
                audit events retained.
              </p>
              <p>
                Bound nomination version: {record.nominationVersion}. Bound contribution: {record.claimId}; version{" "}
                {record.claimVersion}.
              </p>
              <p style={{ overflowWrap: "anywhere" }}>
                Exact declaration digest: <code>{record.digest}</code>.
              </p>
              {record.currentContext.state === "current" ? (
                <div>
                  <p>Current matching contribution context: {record.currentContext.category}.</p>
                  <p>{record.currentContext.selectionExplanation}</p>
                  <p>
                    Spotlight selected{" "}
                    <time dateTime={record.currentContext.selectedAt}>{record.currentContext.selectedAt}</time>.
                  </p>
                  <a href={record.currentContext.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
                    Open the bound contribution source
                  </a>
                </div>
              ) : (
                <p>
                  Current matching contribution context is unavailable or changed. Review is disabled; owner withdrawal
                  remains available.
                </p>
              )}
              <p>
                Editorial workstreams: {record.workstreams.join("; ") || "None requested"}. Behind-the-scenes:{" "}
                {record.behindScenes ? "Requested" : "Not requested"}.
              </p>
              {record.newcomerPeriod && (
                <p>
                  Dated assessment: {record.newcomerPeriod.start} inclusive to {record.newcomerPeriod.end} exclusive.
                  This request is not a known result.
                </p>
              )}
              {record.owner === session.actorId && record.status !== "withdrawn" && (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const d = new FormData(e.currentTarget);
                    await run(`/controls/spotlight-rotation/${record.id}`, {
                      version: record.version,
                      action: "withdraw",
                      reason: d.get("reason"),
                    });
                  }}
                >
                  <label className="control-field">
                    Private withdrawal reason
                    <textarea name="reason" required maxLength={1000} />
                  </label>
                  <button>Withdraw dimension consent</button>
                  <p>
                    This withdraws the dimension choices. Your separate spotlight nomination has its own withdrawal
                    control.
                  </p>
                </form>
              )}
              {admin &&
                session.roles.includes("reviewer") &&
                record.owner !== session.actorId &&
                record.status === "pending" &&
                record.currentContext.state === "current" && (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const d = new FormData(e.currentTarget);
                      await run(`/controls/spotlight-rotation/${record.id}`, {
                        version: record.version,
                        action: d.get("action"),
                        reason: d.get("reason"),
                        conflict: false,
                        ...(d.get("action") === "accept" ? { publicExplanation: d.get("publicExplanation") } : {}),
                      });
                    }}
                  >
                    <label className="control-field">
                      Dimension decision
                      <select
                        name="action"
                        defaultValue="reject"
                        onChange={(e) => setAccepting({ ...accepting, [record.id]: e.target.value === "accept" })}
                      >
                        <option value="reject">Reject</option>
                        <option value="accept">Accept exact declaration</option>
                      </select>
                    </label>
                    <label className="control-field">
                      Private dimension decision reason
                      <textarea name="reason" required maxLength={1000} />
                    </label>
                    {accepting[record.id] && (
                      <label className="control-field">
                        Public dimension explanation
                        <textarea name="publicExplanation" required maxLength={1000} />
                      </label>
                    )}
                    <label>
                      <input type="checkbox" required /> I independently reviewed the exact descriptions, linked
                      contribution and period; I am not the owner or a collaborator and have no conflict. No newcomer
                      result is asserted by this approval.
                    </label>
                    <button>Record dimension decision</button>
                  </form>
                )}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
