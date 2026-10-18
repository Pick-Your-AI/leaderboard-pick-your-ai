import React, { useEffect, useRef, useState } from "react";
import { canReview, control, ControlsFailure, verifiedSession, type Receipt, type Session } from "./client.ts";

import { Spotlights, type Nomination } from "./Spotlights.tsx";

type Run = (path: string, input: unknown) => Promise<boolean>;
const categories = [
  "governance",
  "deployment_work",
  "mentorship",
  "reliability",
  "project_configuration",
  "ordering",
  "public_moderation",
  "other",
];
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="control-field">
      {label}
      {children}
    </label>
  );
}
function RequestForm({ run }: { run: Run }) {
  const [kind, setKind] = useState("correction");
  return (
    <section>
      <h2>Submit a private request</h2>
      <p>
        Requests are stored by the controls service. A receipt is not an accepted correction or a response-time
        commitment. Do not include credentials or private source content.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = new FormData(form);
          const input = {
            kind,
            detail: data.get("detail"),
            ...(data.get("locator") ? { locator: data.get("locator") } : {}),
            ...(kind === "evidence"
              ? {
                  category: data.get("category"),
                  scope: data.get("scope"),
                  consent: data.get("consent") === "on",
                  collaborators: String(data.get("collaborators") ?? "")
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                }
              : {}),
          };
          if (await run("/controls/requests", input)) form.reset();
        }}
      >
        <Field label="Request kind">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="correction">Factual correction</option>
            <option value="privacy">Privacy request</option>
            <option value="identity">Identity dispute</option>
            <option value="evidence">Contribution evidence</option>
          </select>
        </Field>
        <Field label="Details">
          <textarea name="detail" required maxLength={2000} />
        </Field>
        <Field label="Public GitHub source URL">
          <input name="locator" type="url" required={kind === "evidence"} />
        </Field>
        {kind === "evidence" && (
          <>
            <Field label="Category">
              <select name="category">
                {categories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field label="Contribution scope">
              <input name="scope" required maxLength={300} />
            </Field>
            <Field label="Collaborator GitHub numeric IDs, comma separated">
              <input name="collaborators" />
            </Field>
            <label>
              <input type="checkbox" name="consent" required /> I consent to public attribution of this evidence if
              independently accepted.
            </label>
          </>
        )}
        <button type="submit">Submit request</button>
      </form>
    </section>
  );
}
interface ProfileData {
  bio: string;
  highlights: string[];
  public: boolean;
  suppressed: boolean;
}
function Profile({ run, profile }: { run: Run; profile: ProfileData }) {
  return (
    <section>
      <h2>Optional public profile</h2>
      <p>
        Review your saved bio and highlights before replacing them. Unchecked public display keeps this optional
        presentation private.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const d = new FormData(e.currentTarget);
          await run("/controls/profile", {
            bio: d.get("bio"),
            highlights: String(d.get("highlights") ?? "")
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
            public: d.get("public") === "on",
          });
        }}
      >
        <Field label="Bio (up to 500 characters)">
          <input name="bio" maxLength={500} defaultValue={profile.bio} />
        </Field>
        <Field label="Public GitHub highlights (up to six, one URL per line)">
          <textarea name="highlights" defaultValue={profile.highlights.join("\n")} />
        </Field>
        <label>
          <input name="public" type="checkbox" defaultChecked={profile.public} /> Publish this optional profile
        </label>
        <label>
          <input type="checkbox" required /> Replace my optional profile with these values
        </label>
        <button>Save profile</button>
      </form>
      <h3>Public display preference</h3>
      <p>
        Suppression hides your contributions from this service's public projections. It does not remove GitHub history
        or copies held by others.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const d = new FormData(e.currentTarget);
          await run("/controls/profile/suppression", { suppressed: d.get("display") === "suppress" });
        }}
      >
        <Field label="Display choice">
          <select name="display" defaultValue={profile.suppressed ? "suppress" : "restore"}>
            <option value="suppress">Suppress my public display</option>
            <option value="restore">Restore my public display</option>
          </select>
        </Field>
        <label>
          <input type="checkbox" required /> Apply this choice to my account
        </label>
        <button>Apply display preference</button>
      </form>
    </section>
  );
}
function ReceiptCard({
  receipt: r,
  session,
  run,
  admin,
}: {
  receipt: Receipt;
  session: Session;
  run: Run;
  admin: boolean;
}) {
  const [decision, setDecision] = useState("reject");
  const own = r.owner === session.actorId;
  return (
    <article className="control-receipt">
      <h3>Receipt {r.id}</h3>
      <p>
        {r.kind} · {r.status} · version {r.version}
      </p>
      <p>{r.detail}</p>
      {r.locator && <p>Source: {r.locator}</p>}
      {r.scope && (
        <p>
          Scope: {r.scope} · {r.category}
        </p>
      )}
      {r.policyVersion && <p>Policy: {r.policyVersion}</p>}
      <details>
        <summary>Audit history</summary>
        <pre>{JSON.stringify(r.history, null, 2)}</pre>
      </details>
      {own && r.kind === "evidence" && r.status === "accepted" && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await run("/controls/spotlights", { claimId: r.id, consent: true });
          }}
        >
          <label>
            <input type="checkbox" required /> I opt in to editorial spotlight consideration for this accepted evidence
          </label>
          <button>Nominate for spotlight</button>
        </form>
      )}
      {own && !["withdrawn", "merged", "applied"].includes(r.status) && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await run(`/controls/requests/${r.id}/withdraw`, { version: r.version });
          }}
        >
          <label>
            <input type="checkbox" required /> Withdraw receipt {r.id}
          </label>
          <button>Withdraw request</button>
        </form>
      )}
      {own && ["accepted", "rejected"].includes(r.status) && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await run(`/controls/requests/${r.id}/appeal`, {
              version: r.version,
              reason: new FormData(e.currentTarget).get("reason"),
            });
          }}
        >
          <Field label="Appeal reason">
            <textarea name="reason" required maxLength={2000} />
          </Field>
          <button>Appeal decision</button>
        </form>
      )}
      {admin && canReview(r, session) && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            await run(`/controls/requests/${r.id}/review`, {
              version: r.version,
              decision,
              reason: d.get("reason"),
              conflict: false,
              ...(decision === "accept"
                ? { policyVersion: d.get("policy"), sourceReviewedPublic: d.get("source") === "on" }
                : {}),
              ...(decision === "merge" ? { duplicateOf: d.get("duplicate") } : {}),
            });
          }}
        >
          <Field label="Review decision">
            <select value={decision} onChange={(e) => setDecision(e.target.value)}>
              <option value="reject">Reject</option>
              {r.kind === "evidence" && <option value="accept">Accept evidence</option>}
              <option value="rollback">Roll back decision</option>
              {r.kind === "evidence" && <option value="merge">Merge duplicate</option>}
            </select>
          </Field>
          <Field label="Decision reason">
            <textarea name="reason" required maxLength={2000} />
          </Field>
          {decision === "accept" && (
            <>
              <Field label="Approved policy version">
                <input name="policy" required maxLength={100} />
              </Field>
              <label>
                <input type="checkbox" name="source" required /> I reviewed the source and verified it is public
              </label>
            </>
          )}
          {decision === "merge" && (
            <Field label="Canonical accepted receipt ID">
              <input name="duplicate" required />
            </Field>
          )}
          <label>
            <input type="checkbox" required /> I have no conflict of interest and confirm this decision for receipt{" "}
            {r.id}, version {r.version}
          </label>
          <button>Record review decision</button>
          {r.kind !== "evidence" && (
            <p>Acceptance requires verified specialist downstream handling and is unavailable here.</p>
          )}
        </form>
      )}
    </article>
  );
}
export function ControlsApp() {
  const admin = location.pathname.replace(/\/+$/, "") === "/admin";
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [invitations, setInvitations] = useState<
    Array<{ id: string; version: number; locator: string; scope: string; consent: string }>
  >([]);
  const [configuration, setConfiguration] = useState<unknown>(null);
  const [nominations, setNominations] = useState<Nomination[]>([]);
  const generation = useRef(0);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  function clear() {
    setSession(null);
    setReceipts([]);
    setInvitations([]);
    setConfiguration(null);
    setProfile(null);
    setNominations([]);
    setNotice("");
  }
  async function reload() {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    clear();
    try {
      const s = verifiedSession(await control<Session>("/controls/session"));
      const [p, r, i, editorial] = await Promise.all([
        control<ProfileData>("/controls/profile"),
        control<{ requests: Receipt[] }>("/controls/requests"),
        control<{ invitations: typeof invitations }>("/controls/invitations"),
        control<{ nominations: Nomination[] }>("/controls/spotlights/queue"),
      ]);
      let c: unknown = null;
      if (admin && s.roles.includes("operator")) c = await control("/controls/configuration");
      if (current !== generation.current || document.hidden) return;
      verifiedSession(s);
      if (
        !p ||
        typeof p.bio !== "string" ||
        typeof p.public !== "boolean" ||
        typeof p.suppressed !== "boolean" ||
        !Array.isArray(p.highlights) ||
        !p.highlights.every((v) => typeof v === "string") ||
        !Array.isArray(r.requests) ||
        !Array.isArray(i.invitations)
      )
        throw new Error("Invalid controls response.");
      if (!Array.isArray(editorial.nominations)) throw new Error("Invalid nomination response.");
      setNominations(editorial.nominations);
      setProfile(p);
      setSession(s);
      setReceipts(r.requests);
      setInvitations(i.invitations);
      setConfiguration(c);
      return true;
    } catch (e) {
      if (current !== generation.current) return;
      clear();
      setError(e instanceof Error ? e.message : "Controls service unavailable.");
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    document.title = admin ? "Protected administration" : "Your account";
    void reload();
    const visibility = () => {
      if (document.hidden) {
        ++generation.current;
        setBusy(false);
        clear();
      } else void reload();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      ++generation.current;
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(
      () => {
        ++generation.current;
        setBusy(false);
        clear();
        setError("Your session ended. Sign in again.");
      },
      Math.max(0, session.expires - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [session]);
  const run: Run = async (path, input) => {
    if (busy || !session || document.hidden) return false;
    let current = generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await control<unknown>(path, session, input);
      if (current !== generation.current || document.hidden) return false;
      if (path === "/controls/logout" || path === "/controls/sessions/revoke") {
        clear();
        setNotice("Session revoked.");
      } else {
        current += 1;
        const fresh = await reload();
        if (!fresh || current !== generation.current || document.hidden) return false;
        setNotice(`Service confirmed: ${JSON.stringify(result)}`);
      }
      return true;
    } catch (e) {
      if (current !== generation.current || document.hidden) return false;
      if (e instanceof ControlsFailure && [401, 403].includes(e.status)) clear();
      setError(e instanceof Error ? e.message : "Request failed.");
      return false;
    } finally {
      if (current === generation.current && !document.hidden) setBusy(false);
    }
  };
  const authorized = !admin || !!session?.roles.some((r) => ["operator", "reviewer", "privacy"].includes(r));
  return (
    <main className="controls-page">
      <nav aria-label="Account navigation">
        <a href="/">Public leaderboard</a> · <a href="/account">Account</a> · <a href="/admin">Administration</a>
      </nav>
      <h1>{admin ? "Protected administration" : "Your account"}</h1>
      {loading && <p role="status">Checking your controls session…</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!loading && !session && (
        <section>
          <h2>Sign in required</h2>
          <p>
            Use the configured GitHub identity provider. No role or identity can be supplied by this page. After
            completing sign-in, return to this page and check your session.
          </p>
          <a href="/controls/auth/login">Sign in with GitHub</a>{" "}
          <button onClick={() => void reload()}>Check session</button>
        </section>
      )}
      {session && (
        <>
          <p>
            Verified GitHub account ID: {session.actorId}. Session expires{" "}
            {new Date(session.expires).toLocaleTimeString()}.
          </p>
          <button disabled={busy} onClick={() => void reload()}>
            Reload receipts
          </button>
          <button disabled={busy} onClick={() => void run("/controls/logout", {})}>
            Sign out
          </button>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await run("/controls/sessions/revoke", {});
            }}
          >
            <label>
              <input type="checkbox" required /> Revoke all my controls sessions
            </label>
            <button disabled={busy}>Revoke sessions</button>
          </form>
          {!authorized ? (
            <p role="alert">This account has no administration role.</p>
          ) : (
            <fieldset disabled={busy || loading}>
              <legend>{admin ? "Authorized administration" : "Account controls"}</legend>
              {!admin && (
                <>
                  {profile && <Profile run={run} profile={profile} />}
                  <RequestForm run={run} />
                  <section>
                    <h2>Attribution invitations</h2>
                    {invitations.length === 0 && <p>No invitations.</p>}
                    {invitations.map((i) => (
                      <article key={i.id}>
                        <p>
                          {i.locator} · {i.scope} · {i.consent}
                        </p>
                        <form
                          onSubmit={async (e) => {
                            e.preventDefault();
                            await run(`/controls/requests/${i.id}/consent`, {
                              version: i.version,
                              consent: new FormData(e.currentTarget).get("consent") === "accept",
                            });
                          }}
                        >
                          <Field label="Attribution consent">
                            <select name="consent">
                              <option value="decline">Decline</option>
                              <option value="accept">Accept</option>
                            </select>
                          </Field>
                          <label>
                            <input type="checkbox" required /> Confirm my choice for {i.id}
                          </label>
                          <button>Save consent</button>
                        </form>
                      </article>
                    ))}
                  </section>
                </>
              )}
              <section>
                <h2>{admin ? "Review queue" : "Your request receipts"}</h2>
                {receipts.filter((r) => admin || r.owner === session.actorId).length === 0 && (
                  <p>No visible requests.</p>
                )}
                {receipts
                  .filter((r) => admin || r.owner === session.actorId)
                  .map((r) => (
                    <ReceiptCard key={`${r.id}:${r.version}`} receipt={r} session={session} run={run} admin={admin} />
                  ))}
              </section>
              <Spotlights nominations={nominations} session={session} run={run} admin={admin} />
              {admin && session.roles.includes("operator") && (
                <section>
                  <h2>Configuration and operations</h2>
                  <p>
                    Current versioned configuration is read-only here. Configuration publication requires source
                    verification and independent approval through the controls API. Collection diagnostics and replay
                    controls are not yet available through this UI.
                  </p>
                  <pre>{JSON.stringify(configuration, null, 2)}</pre>
                </section>
              )}
            </fieldset>
          )}
        </>
      )}
    </main>
  );
}
