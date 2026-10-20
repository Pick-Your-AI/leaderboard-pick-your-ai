import { Operations } from "./Operations.tsx";
import { PolicyComparison } from "./PolicyComparison.tsx";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  canAcceptEvidence,
  canReview,
  control,
  ControlsFailure,
  evidenceSubmissionInput,
  sourceUseReviewInput,
  verifiedEvidenceTerms,
  verifiedExternalTutorialTerms,
  verifiedSession,
  type EvidenceInvitation,
  type EvidenceTerms,
  type Receipt,
  type Session,
} from "./client.ts";
import {
  AttributionInvitation,
  EvidenceIntakeDetails,
  EvidenceIntakeFields,
  SourceUseReviewFields,
  useControlFormErrors,
} from "./EvidenceIntake.tsx";

import { Amendment } from "./Amendment.tsx";
import { Configuration, type ConfigurationState } from "./Configuration.tsx";
import { Spotlights, type Nomination } from "./Spotlights.tsx";
import { SpotlightRotation } from "./SpotlightRotation.tsx";
import { LocaleReviewFields, localizationReviewInput } from "./LocaleReviewFields.tsx";

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
function RequestForm({
  run,
  actorId,
  terms,
  tutorialTerms,
}: {
  run: Run;
  actorId: string;
  terms: EvidenceTerms | null;
  tutorialTerms: EvidenceTerms | null;
}) {
  const [kind, setKind] = useState("correction");
  const { errors, showErrors } = useControlFormErrors();
  return (
    <section>
      <h2>Submit a private request</h2>
      <p>
        Requests are stored by the controls service. A receipt is not an accepted correction or a response-time
        commitment. Do not include credentials or private source content.
      </p>
      <form
        noValidate={kind === "evidence"}
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = new FormData(form);
          if (kind === "evidence") {
            const evidence = evidenceSubmissionInput(data, terms, actorId, categories, tutorialTerms);
            showErrors(form, evidence.ok ? {} : evidence.errors);
            if (!evidence.ok) return;
            if (await run("/controls/requests", { kind, ...evidence.value })) form.reset();
            return;
          }
          const input = {
            kind,
            detail: data.get("detail"),
            ...(data.get("locator") ? { locator: data.get("locator") } : {}),
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
        {kind === "evidence" ? (
          <EvidenceIntakeFields
            actorId={actorId}
            terms={terms}
            tutorialTerms={tutorialTerms}
            categories={categories}
            errors={errors}
          />
        ) : (
          <>
            <Field label="Details">
              <textarea name="detail" required maxLength={2000} />
            </Field>
            <Field label="Public GitHub source URL">
              <input name="locator" type="url" />
            </Field>
          </>
        )}
        <button type="submit" disabled={kind === "evidence" && !terms}>
          Submit request
        </button>
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
          <textarea
            name="highlights"
            defaultValue={profile.highlights.join("\n")}
            aria-describedby="profile-link-help"
          />
        </Field>
        <p id="profile-link-help">
          Use public https://github.com/owner/repository links without query strings. Issue, review and discussion
          comment anchors are supported. These are contributor-provided links, not verified contribution evidence.
        </p>
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
  terms,
  tutorialTerms,
}: {
  receipt: Receipt;
  session: Session;
  run: Run;
  admin: boolean;
  terms: EvidenceTerms | null;
  tutorialTerms: EvidenceTerms | null;
}) {
  const [decision, setDecision] = useState("reject");
  const { errors, showErrors } = useControlFormErrors();
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
      {r.kind === "evidence" && <EvidenceIntakeDetails receipt={r} />}
      <details>
        <summary>Audit history</summary>
        <pre>{JSON.stringify(r.history, null, 2)}</pre>
      </details>
      {own && r.kind === "evidence" && !["withdrawn", "merged"].includes(r.status) && (
        <Amendment receipt={r} categories={categories} terms={terms} tutorialTerms={tutorialTerms} run={run} />
      )}
      {own && r.kind === "evidence" && r.status === "accepted" && r.intakeEligibility?.state === "eligible" && (
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
          noValidate={decision === "accept"}
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const d = new FormData(form);
            const sourceUseReview = decision === "accept" ? sourceUseReviewInput(d) : null;
            if (sourceUseReview) {
              const next = sourceUseReview.ok ? {} : sourceUseReview.errors;
              if (!canAcceptEvidence(r))
                next.sourceUseRationale =
                  "Current intake and participant consent are required before accepting this claim.";
              showErrors(form, next);
              if (!sourceUseReview.ok || !canAcceptEvidence(r) || !form.reportValidity()) return;
            }
            await run(`/controls/requests/${r.id}/review`, {
              version: r.version,
              decision,
              reason: d.get("reason"),
              conflict: false,
              ...(decision === "accept"
                ? {
                    policyVersion: d.get("policy"),
                    sourceReviewedPublic: d.get("source") === "on",
                    ...(sourceUseReview?.ok ? { sourceUseReview: sourceUseReview.value } : {}),
                    ...localizationReviewInput(d),
                  }
                : {}),
              ...(decision === "merge" ? { duplicateOf: d.get("duplicate") } : {}),
            });
          }}
        >
          <Field label="Review decision">
            <select value={decision} onChange={(e) => setDecision(e.target.value)}>
              <option value="reject">Reject</option>
              {r.kind === "evidence" && (
                <option value="accept" disabled={!canAcceptEvidence(r)}>
                  Accept evidence
                </option>
              )}
              <option value="rollback">Roll back decision</option>
              {r.kind === "evidence" && <option value="merge">Merge duplicate</option>}
            </select>
          </Field>
          <Field label="Decision reason">
            <textarea name="reason" required maxLength={2000} />
          </Field>
          {decision === "accept" && (
            <>
              <SourceUseReviewFields errors={errors} />
              <LocaleReviewFields />
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
  const [invitations, setInvitations] = useState<EvidenceInvitation[]>([]);
  const [terms, setTerms] = useState<EvidenceTerms | null>(null);
  const [tutorialTerms, setTutorialTerms] = useState<EvidenceTerms | null>(null);
  const [termsError, setTermsError] = useState("");
  const [configuration, setConfiguration] = useState<unknown>(null);
  const [nominations, setNominations] = useState<Nomination[]>([]);
  const generation = useRef(0);
  const noticeElement = useRef<HTMLParagraphElement>(null);
  const pendingFocus = useRef<{ generation: number; origin: HTMLElement; kind: "notice" | "origin" } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    pendingFocus.current = null;
    if (
      !pending ||
      pending.generation !== generation.current ||
      document.hidden ||
      document.activeElement !== document.body
    )
      return;
    if (pending.kind === "notice") {
      if (!pending.origin.isConnected) noticeElement.current?.focus();
    } else if (pending.origin.isConnected) pending.origin.focus();
  });
  const [profile, setProfile] = useState<ProfileData | null>(null);
  function clear() {
    pendingFocus.current = null;
    setSession(null);
    setReceipts([]);
    setInvitations([]);
    setTerms(null);
    setTutorialTerms(null);
    setTermsError("");
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
      const [p, r, i, editorial, evidenceTerms] = await Promise.all([
        control<ProfileData>("/controls/profile"),
        control<{ requests: Receipt[] }>("/controls/requests"),
        control<{ invitations: typeof invitations }>("/controls/invitations"),
        control<{ nominations: Nomination[] }>("/controls/spotlights/queue"),
        control<{ terms: unknown; externalTutorialTerms?: unknown }>("/controls/evidence-terms")
          .then((result) => ({
            terms: verifiedEvidenceTerms(result.terms),
            tutorialTerms:
              result.externalTutorialTerms === undefined
                ? null
                : verifiedExternalTutorialTerms(result.externalTutorialTerms),
            error: "",
          }))
          .catch((error: unknown) => {
            if (error instanceof ControlsFailure && [401, 403].includes(error.status)) throw error;
            return {
              terms: null,
              tutorialTerms: null,
              error:
                "Current submission terms could not be loaded. Reload before submitting or amending evidence. Other requests, decline and withdrawal remain available.",
            };
          }),
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
      setTerms(evidenceTerms.terms);
      setTutorialTerms(evidenceTerms.tutorialTerms);
      setTermsError(evidenceTerms.error);
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
    const focusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pendingFocus.current = null;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await control<unknown>(path, session, input);
      if (current !== generation.current || document.hidden) return false;
      if (path === "/controls/logout" || path === "/controls/sessions/revoke") {
        clear();
        if (focusOrigin && focusOrigin !== document.body)
          pendingFocus.current = { generation: current, origin: focusOrigin, kind: "notice" };
        setNotice("Session revoked.");
      } else {
        current += 1;
        const fresh = await reload();
        if (!fresh || current !== generation.current || document.hidden) return false;
        if (focusOrigin && focusOrigin !== document.body)
          pendingFocus.current = { generation: current, origin: focusOrigin, kind: "notice" };
        setNotice(`Service confirmed: ${JSON.stringify(result)}`);
      }
      return true;
    } catch (e) {
      if (current !== generation.current || document.hidden) return false;
      if (e instanceof ControlsFailure && [401, 403].includes(e.status)) clear();
      if (focusOrigin && focusOrigin !== document.body)
        pendingFocus.current = { generation: current, origin: focusOrigin, kind: "origin" };
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
      {notice && (
        <p role="status" tabIndex={-1} ref={noticeElement}>
          {notice}
        </p>
      )}
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
              {termsError && <p>{termsError}</p>}
              {!admin && (
                <>
                  {profile && <Profile run={run} profile={profile} />}
                  <RequestForm run={run} actorId={session.actorId} terms={terms} tutorialTerms={tutorialTerms} />
                  <section>
                    <h2>Attribution invitations</h2>
                    {invitations.length === 0 && <p>No invitations.</p>}
                    {invitations.map((invitation) => (
                      <AttributionInvitation
                        key={`${invitation.id}:${invitation.version}`}
                        invitation={invitation}
                        run={run}
                      />
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
                    <ReceiptCard
                      key={`${r.id}:${r.version}`}
                      receipt={r}
                      session={session}
                      run={run}
                      admin={admin}
                      terms={terms}
                      tutorialTerms={tutorialTerms}
                    />
                  ))}
              </section>
              <Spotlights nominations={nominations} session={session} run={run} admin={admin} />
              <SpotlightRotation nominations={nominations} session={session} run={run} admin={admin} />
              {admin && session.roles.includes("reviewer") && (
                <PolicyComparison
                  session={session}
                  onAuthorityLost={() => {
                    ++generation.current;
                    setBusy(false);
                    clear();
                    setError("Your reviewer authority or session changed. Reload your account before continuing.");
                  }}
                />
              )}
              {admin && session.roles.includes("operator") && (
                <>
                  <Operations session={session} />
                  <Configuration
                    key={JSON.stringify(configuration)}
                    state={configuration as ConfigurationState}
                    session={session}
                    run={run}
                  />
                </>
              )}
            </fieldset>
          )}
        </>
      )}
    </main>
  );
}
