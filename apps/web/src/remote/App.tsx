import { ContributorRecognition, EditorialSpotlights } from "./Recognition.tsx";
import { EvidenceDrawer, EvidenceProof, Receipt } from "./Evidence.tsx";
import { isProofTransition, proofHref, readProof, withoutProof } from "./proof.ts";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { actorFilterLabels, type MetricDefinition, type MetricRegistry } from "@pick-your-ai/contracts";
import { startLiveUpdates, type LiveState } from "@pick-your-ai/service/live-client";
import { applyThemePreference, readThemePreference, type ThemePreference } from "../lib/theme.ts";
import { ActivityFeed, ActivityProofs } from "./Activity.tsx";
import { RegistryCatalog, RegistryMetadata } from "./Registry.tsx";
import {
  discoverMetrics,
  isCatalogPath,
  registryMetric,
  validateCatalogRoute,
  verifyBoardDefinition,
} from "./registry.ts";
import {
  activity,
  activityDetail,
  type Activity,
  type ActivityDetail,
  apiBase,
  board,
  controlsNavigationBase,
  directory,
  portfolioParameters,
  catalog,
  exportPage,
  health,
  parameters,
  profile,
  publicLink,
  ReadFailure,
  request,
  selection,
  uiHref,
  type Board,
  type Directory,
  type CategoryTotal,
  type Diagnostic,
  type Evidence,
  type Health,
  type Metadata,
  type Profile,
  type Selection,
} from "./client.ts";

type Data =
  | { kind: "catalog" }
  | { kind: "method"; metricId: string }
  | { kind: "health"; value: Health }
  | { kind: "board"; value: Board }
  | { kind: "activity"; value: Activity }
  | { kind: "activity-detail"; value: ActivityDetail }
  | { kind: "directory"; value: Directory }
  | { kind: "profile"; value: Profile }
  | { kind: "evidence"; value: Evidence & Metadata }
  | { kind: "unavailable" };
type State =
  | { status: "loading" }
  | { status: "error"; error: ReadFailure }
  | { status: "ready"; data: Data; registry: MetricRegistry };
const unknownLiveState: LiveState = { transport: "unavailable", freshness: "unknown", checkedAt: null };
function CurrentFreshness({ value }: { value: LiveState }) {
  const transport = {
    stream: "Connected for snapshot notices",
    polling: "Polling for updates",
    paused: "Paused while this page is hidden",
    unavailable: "Update checks unavailable",
  }[value.transport];
  const freshness = {
    unknown: "Unknown",
    recently_reconciled: "Recently reconciled",
    stale_or_degraded: "Stale or degraded",
  }[value.freshness];
  return (
    <section aria-label="Current source freshness" className="notice notice-info">
      <h2>Current source freshness</h2>
      <p>Update connection: {transport}.</p>
      <p>Source freshness: {freshness}.</p>
      <p>
        {value.checkedAt ? (
          <>
            Last successful health check: <time dateTime={value.checkedAt}>{value.checkedAt}</time>.
          </>
        ) : (
          "No successful health check for this scope."
        )}
      </p>
      <p>This check describes the current publication. A pinned snapshot retains its own source dates.</p>
    </section>
  );
}
const fallback: Selection = {
  actors: "all",
  organization: "Pick-Your-AI",
  repository: null,
  workstream: null,
  start: null,
  end: null,
  snapshot: null,
  limit: "50",
  cursor: null,
  metric: "pr_opened",
  search: null,
  category: null,
};
const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ReadFailure(400, "invalid_route");
  }
};
const name = (actor: Profile["actor"], actorId: string) => actor.displayName ?? actor.login ?? actorId;
const title = (path: string) =>
  path === "/"
    ? "Public contribution evidence"
    : path.startsWith("/contributions/")
      ? "Contribution evidence"
      : path.startsWith("/contributors/")
        ? "Contributor portfolio"
        : path.startsWith("/methodology")
          ? "Methodology"
          : path === "/leaderboards"
            ? "Measures"
            : path === "/contributors"
              ? "Contributor directory"
              : path === "/activity" || path.startsWith("/activity/")
                ? "Public activity"
                : path === "/coverage" || path === "/health"
                  ? "Source coverage and health"
                  : path === "/live"
                    ? "Live board"
                    : path === "/corrections"
                      ? "Corrections and privacy"
                      : "Contribution board";
function Source({ href, children }: { href: string | null | undefined; children: React.ReactNode }) {
  const safe = publicLink(href);
  return safe ? (
    <a href={safe} rel="noreferrer nofollow">
      {children}
    </a>
  ) : (
    <span>Public source link unavailable</span>
  );
}
function ControlsEntry() {
  const configured = import.meta.env.VITE_PUBLIC_CONTROLS_BASE;
  if (!configured) return <p>No protected contributor-controls endpoint is configured.</p>;
  try {
    return (
      <p>
        <a href={`${controlsNavigationBase(configured)}/auth/login`}>Open configured account authentication</a>. This
        public UI does not implement private request forms or name a staffed privacy destination.
      </p>
    );
  } catch {
    return <p>The configured contributor-controls URL is invalid.</p>;
  }
}
function Value({
  result,
  diagnostic,
  pending = diagnostic?.pending,
}: {
  result: Board["rows"][number]["result"];
  diagnostic?: Diagnostic | undefined;
  pending?: Board["rows"][number]["pending"] | undefined;
}) {
  return (
    <>
      <strong>
        {result.value === undefined
          ? "Unknown"
          : result.value.toLocaleString(undefined, { maximumSignificantDigits: 21 })}
      </strong>{" "}
      {pending && (pending.valueClass === "qualified" ? "accepted" : pending.valueClass)}{" "}
      <span className="muted">
        {result.state}; coverage {result.coverage.state}
      </span>
      <p className="small">
        {pending?.count == null ? "Pending unknown" : `${pending.count.toLocaleString()} pending`}
        {pending?.state === "partial" ? " (partial coverage)" : ""}; pending work is not ranked.
      </p>
      {diagnostic && (
        <p className="small">
          Numerator {diagnostic.numerator ?? "unknown"}; denominator {diagnostic.denominator ?? "unknown"}; samples{" "}
          {diagnostic.sampleCount}; censored {diagnostic.censored}; missing readiness {diagnostic.missingReadiness}; p75{" "}
          {diagnostic.p75 ?? "unknown"}.
        </p>
      )}
    </>
  );
}
function Meta({ value, selected }: { value: Metadata; selected: Selection }) {
  return (
    <section aria-label="Snapshot provenance" className="notice notice-info">
      <p>
        Snapshot <strong>{value.snapshotId}</strong> · revision {value.revision} · generated{" "}
        <time dateTime={value.generatedAt}>{value.generatedAt}</time>
      </p>
      <p>
        Definition {value.metricDefinitionVersion} · computation {value.computationVersion} · current publication
        controls {value.policyVersion}
      </p>
      <p>
        {selected.start ?? "All-time materialized scope"}
        {selected.end ? ` to ${selected.end} (exclusive)` : ""} · {selected.organization}
        {selected.repository ? ` · repository ${selected.repository}` : ""}
        {selected.workstream ? ` · workstream ${selected.workstream}` : ""}
        {` · ${actorFilterLabels[value.actorFilter ?? "all"]}`}
      </p>
      <a data-api-nav href={uiHref(location.pathname, selected, { snapshot: value.snapshotId })}>
        Permalink to this snapshot
      </a>
      {value.disabledMetrics.length > 0 && (
        <p>Disabled measures: {value.disabledMetrics.map((item) => `${item.id}: ${item.reason}`).join("; ")}</p>
      )}
    </section>
  );
}
function Filters({
  selected,
  path,
  navigate,
}: {
  selected: Selection;
  path: string;
  navigate: (href: string) => void;
}) {
  return (
    <details className="method">
      <summary>Exact scope and snapshot</summary>
      <form
        className="remote-filters"
        onSubmit={(event) => {
          event.preventDefault();
          const input = new FormData(event.currentTarget);
          const params = new URLSearchParams();
          for (const key of [
            "organization",
            "repository",
            "workstream",
            "start",
            "end",
            "snapshot",
            "limit",
            "metric",
            "search",
            "category",
            "actors",
          ]) {
            const value = String(input.get(key) ?? "").trim();
            if (value) params.set(key, value);
          }
          if (isCatalogPath(path)) {
            if (selected.catalogQuery) params.set("q", selected.catalogQuery);
            if (selected.department) params.set("department", selected.department);
          }
          params.set("ui", "api");
          navigate(`${path}?${params}`);
        }}
      >
        <p>
          Use one stable repository/workstream ID. Dates are paired canonical UTC timestamps; blank dates request an
          explicitly materialized all-time scope. Unsupported scopes remain unavailable.
        </p>
        <label>
          Activity selection
          <select name="actors" defaultValue={selected.actors ?? "all"}>
            <option value="all">All activity</option>
            <option value="user">User accounts</option>
            <option value="automation">Automation</option>
          </select>
        </label>
        <p className="small">
          User accounts can run automation. Automation includes classified automation accounts and positively known
          automated execution. These views may overlap. Account type and unknown execution do not certify manual work or
          detect AI assistance.
        </p>
        {(["organization", "repository", "workstream", "start", "end", "snapshot", "limit", "metric"] as const).map(
          (key) => (
            <label key={key}>
              {key}
              <input
                name={key}
                defaultValue={selected[key] ?? ""}
                placeholder={key === "start" || key === "end" ? "YYYY-MM-DDTHH:mm:ss.000Z" : ""}
              />
            </label>
          ),
        )}
        {(path.startsWith("/contributors") || path === "/activity" || path.startsWith("/activity/")) && (
          <>
            <input type="hidden" name="category" value={selected.category ?? ""} />
            {path === "/contributors" && <input type="hidden" name="search" value={selected.search ?? ""} />}
          </>
        )}
        <button className="button" type="submit">
          Read exact scope
        </button>
      </form>
    </details>
  );
}
function Methods({ metric, registry, meta }: { metric: MetricDefinition; registry: MetricRegistry; meta?: Metadata }) {
  const method = meta?.methodology.find((item) => item.metricId === metric.id);
  return (
    <section className="section">
      <h2>{metric.name}</h2>
      <dl className="receipt">
        <dt>Definition</dt>
        <dd>{metric.counting_rule}</dd>
        <dt>Unit and aggregation</dt>
        <dd>
          {metric.definition.unit}; {metric.definition.aggregation}
        </dd>
        <dt>Numerator</dt>
        <dd>{metric.definition.numerator}</dd>
        <dt>Source definition</dt>
        <dd>{metric.source}</dd>
        <dt>Event clock</dt>
        <dd>{metric.event_clock}</dd>
        <dt>Attribution</dt>
        <dd>{metric.attribution}</dd>
        <dt>Denominator</dt>
        <dd>{metric.definition.denominator.definition}</dd>
        <dt>Coverage</dt>
        <dd>{metric.coverage_class}</dd>
        <dt>Release eligibility</dt>
        <dd>{metric.definition.release_eligibility}</dd>
        <dt>Published policy</dt>
        <dd>
          {method ? (
            <>
              {method.policyVersion} · signature <span className="mono">{method.policySignature}</span>
              <br />
              <Source href={method.policyLink}>Reviewed policy source</Source>
            </>
          ) : (
            "No published policy signature supplied for this selection."
          )}
        </dd>
      </dl>
      <RegistryMetadata registry={registry} metric={metric} />
      <p>Registry presence alone does not enable a measure or prove source coverage.</p>
    </section>
  );
}
function CategoryCounts({ categories, registry }: { categories: CategoryTotal[]; registry: MetricDefinition[] }) {
  return (
    <ul>
      {categories.map((item) => (
        <li key={item.metricId}>
          {registry.find((metric) => metric.id === item.metricId)?.name ?? item.metricId}: {item.observed} observed;{" "}
          {item.pending} in progress; {item.accepted} independently accepted; {item.unknown} acceptance unknown
        </li>
      ))}
    </ul>
  );
}

export function RemoteApp() {
  const [url, setUrl] = useState(() => ({ pathname: location.pathname, search: location.search }));
  const urlRef = useRef(url);
  urlRef.current = url;
  const proofOpener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    document.title = `${title(url.pathname)} · PickYour.AI Credits`;
  }, [url.pathname]);
  const [state, setState] = useState<State>({ status: "loading" });
  const [checking, setChecking] = useState(false);
  const [live, setLive] = useState<{ base: string; scope: string; value: LiveState } | null>(null);
  const [nonce, setNonce] = useState(0),
    [heldPin, setHeldPin] = useState<string | null>(null);
  const [follow, setFollow] = useState(false),
    [pointerInside, setPointerInside] = useState(false),
    [focusInside, setFocusInside] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const region = useRef<HTMLDivElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    focusOnLoad = useRef(false);
  const active = useRef<AbortController | null>(null);
  const activeExport = useRef<AbortController | null>(null);
  const displayedPortfolio = useRef<{ location: string; href: string } | null>(null);
  const navigate = useCallback((href: string) => {
    // Make the previous page reproducible when Back is used after a new head arrives.
    // Store only the pin in the URL; no contributor response is kept in browser history.
    if (displayedPortfolio.current?.location === `${location.pathname}${location.search}`)
      history.replaceState(null, "", displayedPortfolio.current.href);
    history.pushState(null, "", href);
    active.current?.abort();
    activeExport.current?.abort();
    setState({ status: "loading" });
    setHeldPin(null);
    setFollow(false);
    focusOnLoad.current = true;
    setUrl({ pathname: location.pathname, search: location.search });
    window.scrollTo(0, 0);
  }, []);
  useEffect(() => () => activeExport.current?.abort(), []);
  useEffect(() => {
    const pop = () => {
      const next = { pathname: location.pathname, search: location.search };
      const drawerOnly = isProofTransition(urlRef.current, next);
      active.current?.abort();
      activeExport.current?.abort();
      if (!drawerOnly) {
        setState({ status: "loading" });
        setHeldPin(null);
        focusOnLoad.current = true;
      }
      setUrl(next);
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => applyThemePreference(theme), [theme]);
  const parsed = useMemo(() => {
    try {
      const selected = selection(url.search);
      validateCatalogRoute(url.pathname, url.search);
      if (
        selected.proof &&
        (!selected.snapshot ||
          !(
            /^\/leaderboards\/[^/]+$/.test(url.pathname) ||
            /^\/projects\/[^/]+$/.test(url.pathname) ||
            url.pathname === "/live"
          ))
      )
        throw new ReadFailure(400, "invalid_proof_selection");
      const project = /^\/projects\/([^/]+)$/.exec(url.pathname);
      const metric = /^\/(?:leaderboards|methodology)\/([^/]+)$/.exec(url.pathname);
      const routeId = (value: string) => {
        const id = decode(value);
        if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(id)) throw new ReadFailure(400, "invalid_route");
        return id;
      };
      if (project) {
        const id = routeId(project[1]!);
        if (selected.workstream && selected.workstream !== id)
          throw new ReadFailure(400, "conflicting_workstream_selection");
        selected.workstream = id;
      }
      if (metric && metric[1] !== "changes") {
        const id = routeId(metric[1]!);
        if (new URLSearchParams(url.search).has("metric") && selected.metric !== id)
          throw new ReadFailure(400, "conflicting_metric_selection");
        selected.metric = id;
      }
      return { selected, base: apiBase(import.meta.env.VITE_PUBLIC_API_BASE || "/api/v1"), error: null };
    } catch (error) {
      return {
        selected: fallback,
        base: "",
        error: error instanceof ReadFailure ? error : new ReadFailure(400, "invalid_selection"),
      };
    }
  }, [url]);
  const { selected } = parsed;
  const refresh = useCallback(() => {
    active.current?.abort();
    setChecking(true);
    setNonce((value) => value + 1);
  }, []);
  // Registry-only pages do not require a source snapshot. Snapshot subscriptions
  // follow the current scope, never a historical pin, cursor or proof selection.
  const liveScope =
    parsed.error || isCatalogPath(url.pathname) || /^\/methodology\/[^/]+$/.test(url.pathname)
      ? null
      : parameters(selected, { snapshot: null }).toString();
  const liveState = live?.base === parsed.base && live.scope === liveScope ? live.value : unknownLiveState;
  useEffect(() => {
    if (liveScope === null) return;
    const base = new URL(parsed.base);
    return startLiveUpdates({
      basePath: base.pathname.replace(/\/$/, ""),
      scope: Object.fromEntries(new URLSearchParams(liveScope)),
      onState: (value) => setLive({ base: parsed.base, scope: liveScope, value }),
      // A notice invalidates the complete public projection even while a reader
      // holds an older snapshot. Existing hold/apply controls govern reordering.
      onSnapshot: refresh,
      validateHealth: (body) => {
        health(body, { ...selected, snapshot: null });
      },
      fetch: (input, init) => fetch(new URL(String(input), base.origin), init),
      ...(globalThis.EventSource
        ? { eventSource: (path: string) => new EventSource(new URL(path, base.origin), { withCredentials: false }) }
        : {}),
    });
  }, [parsed.base, liveScope, refresh]);
  // Revalidate selected data even under a snapshot pin. Old aggregates are never a privacy cache.
  useEffect(() => {
    const revalidate = () => {
      if (document.visibilityState === "visible") refresh();
      else {
        active.current?.abort();
        activeExport.current?.abort();
        setState({ status: "loading" });
      }
    };
    const timer = setInterval(revalidate, 20_000);
    addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      clearInterval(timer);
      removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    if (parsed.error) {
      setChecking(false);
      setState({ status: "error", error: parsed.error });
      return () => controller.abort();
    }
    const pin = selected.snapshot ?? heldPin;
    const exact: Selection = { ...selected, snapshot: pin };
    const qs = parameters(exact);
    const boardQuery = parameters(exact, { board: true, cursor: selected.cursor });
    const load = async (): Promise<Data> => {
      const path = url.pathname;
      if (isCatalogPath(path)) return { kind: "catalog" };
      if (/^\/methodology\/[^/]+$/.test(path)) return { kind: "method", metricId: exact.metric };
      if (path === "/" || path === "/health" || path === "/coverage")
        return { kind: "health", value: health(await request(parsed.base, "health", qs, controller.signal), exact) };
      const actor = /^\/contributors\/([^/]+)$/.exec(path),
        contribution = /^\/contributions\/([^/]+)$/.exec(path);
      if (actor) {
        const id = decode(actor[1]!);
        const data = profile(
          await request(
            parsed.base,
            `contributors/${encodeURIComponent(id)}`,
            portfolioParameters(exact),
            controller.signal,
          ),
          exact,
        );
        if (data.actorId !== id) throw new ReadFailure(502, "api_actor_mismatch");
        return { kind: "profile", value: data };
      }
      if (path === "/contributors")
        return {
          kind: "directory",
          value: directory(
            await request(parsed.base, "contributors", portfolioParameters(exact, true), controller.signal),
            exact,
          ),
        };
      if (contribution) {
        const id = decode(contribution[1]!);
        return { kind: "evidence", value: await readProof(parsed.base, id, exact, controller.signal) };
      }
      if (path === "/activity")
        return {
          kind: "activity",
          value: activity(await request(parsed.base, "activity", portfolioParameters(exact), controller.signal), exact),
        };
      const activityGroup = /^\/activity\/([a-f0-9]{64})$/.exec(path);
      if (activityGroup) {
        const value = activityDetail(
          await request(parsed.base, `activity/${activityGroup[1]}`, portfolioParameters(exact), controller.signal),
          exact,
        );
        if (value.group.groupId !== activityGroup[1]) throw new ReadFailure(502, "api_activity_group_mismatch");
        return { kind: "activity-detail", value };
      }
      if (/^\/leaderboards\/[^/]+$/.test(path) || path === "/live" || /^\/projects\/[^/]+$/.test(path))
        return {
          kind: "board",
          value: board(await request(parsed.base, "boards", boardQuery, controller.signal), exact),
        };
      return { kind: "unavailable" };
    };
    void Promise.all([request(parsed.base, "metrics", new URLSearchParams(), controller.signal).then(catalog), load()])
      .then(([registry, data]) => {
        if (controller.signal.aborted) return;
        if ("value" in data && registry.policy_version !== data.value.metricDefinitionVersion)
          throw new ReadFailure(409, "metric_definition_unavailable");
        if (data.kind === "method") registryMetric(registry, data.metricId);
        if (data.kind === "catalog") discoverMetrics(registry, selected);
        if (data.kind === "board") verifyBoardDefinition(registry, data.value.metric);
        setChecking(false);
        if (
          data.kind === "directory" ||
          data.kind === "profile" ||
          data.kind === "activity" ||
          data.kind === "activity-detail"
        )
          displayedPortfolio.current = {
            location: `${url.pathname}${url.search}`,
            href: uiHref(url.pathname, selected, { snapshot: data.value.snapshotId, cursor: selected.cursor }),
          };
        else displayedPortfolio.current = null;
        setState({ status: "ready", registry, data });
        if ("value" in data && !selected.snapshot && !heldPin) setHeldPin(data.value.snapshotId);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setChecking(false);
          setState({
            status: "error",
            error: error instanceof ReadFailure ? error : new ReadFailure(503, "public_read_unavailable"),
          });
        }
      });
    return () => controller.abort();
  }, [parsed, heldPin, nonce, selected, url.pathname]);
  useEffect(() => {
    if (state.status !== "loading" && focusOnLoad.current) {
      if (!selected.proof) heading.current?.focus();
      focusOnLoad.current = false;
    }
  }, [state, selected.proof]);
  const data = state.status === "ready" ? state.data : null;
  const meta = data && "value" in data ? data.value : null;
  const pending = meta && !selected.snapshot && meta.head.snapshotId !== meta.snapshotId ? meta.head.snapshotId : null;
  const apply = useCallback(() => {
    if (pending) {
      active.current?.abort();
      setState({ status: "loading" });
      setHeldPin(pending);
      setAnnouncement(`Applying snapshot ${pending}.`);
    }
  }, [pending]);
  useEffect(() => {
    if (
      pending &&
      !selected.proof &&
      follow &&
      !reduced &&
      !pointerInside &&
      !focusInside &&
      !region.current?.contains(document.activeElement) &&
      document.visibilityState === "visible"
    )
      apply();
  }, [pending, selected.proof, follow, reduced, pointerInside, focusInside, apply]);
  const link = (
    path: string,
    text: string,
    override: { snapshot?: string | null; cursor?: string | null; metric?: string } = {},
  ) => (
    <a data-api-nav href={uiHref(path, selected, override)}>
      {text}
    </a>
  );
  const pinned = { ...selected, snapshot: meta?.snapshotId ?? selected.snapshot };
  const closeProof = useCallback(() => {
    if (history.state?.apiProofDrawer === true) history.back();
    else {
      history.replaceState(null, "", withoutProof(urlRef.current));
      setUrl({ pathname: location.pathname, search: location.search });
    }
  }, []);
  const download = async (format: "json" | "csv") => {
    activeExport.current?.abort();
    const controller = new AbortController();
    activeExport.current = controller;
    try {
      const blob = await exportPage(parsed.base, pinned, format, controller.signal);
      const href = URL.createObjectURL(blob),
        anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `contributions-${meta?.snapshotId ?? "selected"}.${format}`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      refresh();
    } catch (error) {
      if (!controller.signal.aborted) {
        active.current?.abort();
        setState({
          status: "error",
          error: error instanceof ReadFailure ? error : new ReadFailure(503, "export_unavailable"),
        });
      }
    }
  };
  const catalogEntries = state.status === "ready" ? state.registry.metrics : [];
  return (
    <div
      className="remote-app"
      onClick={(event) => {
        const target = (event.target as Element).closest<HTMLAnchorElement>("a[data-api-nav], a[data-api-proof]");
        if (
          !target ||
          event.defaultPrevented ||
          event.button !== 0 ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        // The display has its own bounded page lifecycle. A normal same-tab
        // navigation tears down this reader and its in-flight requests first.
        if (new URL(target.href).pathname === "/live") return;
        event.preventDefault();
        if (target.hasAttribute("data-api-proof")) {
          proofOpener.current = target;
          // Only a reproducible URL and a drawer marker enter history, never API data.
          // Switching proofs replaces the open panel, rather than growing a hidden panel stack.
          if (selected.proof) history.replaceState(history.state, "", target.getAttribute("href")!);
          else {
            history.replaceState(null, "", uiHref(url.pathname, pinned, { cursor: selected.cursor }));
            history.pushState({ apiProofDrawer: true }, "", target.getAttribute("href")!);
          }
          setFollow(false);
          setUrl({ pathname: location.pathname, search: location.search });
        } else navigate(target.getAttribute("href")!);
      }}
    >
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <div className="header-inner">
          <a data-api-nav href={uiHref("/", selected)} className="wordmark">
            PickYour.AI Credits
          </a>
          <nav aria-label="Primary">
            <ul>
              {[
                ["/", "Overview"],
                ["/leaderboards", "Measures"],
                ["/contributors", "Contributors"],
                ["/activity", "Activity"],
                ["/methodology", "Methodology"],
                ["/coverage", "Coverage"],
                ["/live", "Live"],
              ].map(([path, label]) => (
                <li key={path}>{link(path!, label!)}</li>
              ))}
            </ul>
          </nav>
          <label className="theme-toggle">
            Theme
            <select value={theme} onChange={(event) => setTheme(event.target.value as ThemePreference)}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </div>
      </header>
      <main id="main" className="page">
        <header className="page-header">
          <p className="eyebrow">PUBLIC API READ</p>
          <h1 ref={heading} tabIndex={-1}>
            {title(url.pathname)}
          </h1>
          <p>Evidence-backed public reads. Unknown values and unavailable scopes remain explicit.</p>
        </header>
        <Filters key={`${url.pathname}${url.search}`} selected={selected} path={url.pathname} navigate={navigate} />
        <div className="visually-hidden" role="status" aria-live="polite">
          {announcement}
        </div>
        <p>
          <button type="button" className="button button-ghost" onClick={refresh}>
            Recheck current publication controls
          </button>
          {checking && <span className="muted"> Rechecking…</span>}
        </p>
        {liveScope !== null && <CurrentFreshness value={liveState} />}
        {state.status === "loading" && <p role="status">Loading current public data…</p>}
        {state.status === "error" && (
          <section className="notice notice-error" role="alert">
            <h2>
              {state.error.status === 404
                ? "Public record unavailable"
                : state.error.status === 410
                  ? "Selection expired or revoked"
                  : "Public read unavailable"}
            </h2>
            <p>{state.error.code}</p>
            <p>No fixture data or stored personal content is shown after this failure.</p>
            {link(url.pathname, "Restart from the current publication", { snapshot: null, cursor: null })}
          </section>
        )}
        {meta && <Meta value={meta} selected={selected} />}
        {meta && (
          <section aria-label="Publication updates" className="update-control">
            <p>
              {selected.snapshot
                ? `Pinned snapshot ${selected.snapshot}; current publication controls are still rechecked.`
                : pending
                  ? `Update held: snapshot ${pending} is available.`
                  : "Showing the selected publication. Notices trigger a full read; publication controls are also rechecked every 20 seconds while visible."}
            </p>
            {pending && (
              <button type="button" className="button" onClick={apply} disabled={Boolean(selected.proof)}>
                Apply new snapshot
              </button>
            )}
            {!selected.snapshot && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={follow}
                  disabled={reduced}
                  onChange={(event) => setFollow(event.target.checked)}
                />
                Follow while not reading the evidence{reduced ? " (disabled for reduced motion)" : ""}
              </label>
            )}
          </section>
        )}
        <div
          ref={region}
          onPointerEnter={() => setPointerInside(true)}
          onPointerLeave={() => setPointerInside(false)}
          onFocus={() => setFocusInside(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusInside(false);
          }}
        >
          {data?.kind === "catalog" && state.status === "ready" && (
            <RegistryCatalog
              key={`${url.pathname}${url.search}`}
              registry={state.registry}
              selected={selected}
              path={url.pathname}
              navigate={navigate}
            />
          )}
          {data?.kind === "method" && state.status === "ready" && (
            <>
              <Methods metric={registryMetric(state.registry, data.metricId)} registry={state.registry} />
              <p>
                This method sheet describes the loaded registry definition. It does not assert an available snapshot or
                published policy for this scope.
              </p>
              {link(`/leaderboards/${data.metricId}`, "Check published board availability", { metric: data.metricId })}
            </>
          )}
          {data?.kind === "health" && url.pathname === "/" && import.meta.env.VITE_PUBLIC_CONTROLS_BASE && (
            <EditorialSpotlights
              controlsBase={import.meta.env.VITE_PUBLIC_CONTROLS_BASE}
              organization="Pick-Your-AI"
              selected={selected}
            />
          )}
          {data?.kind === "health" && (
            <>
              <h2>{data.value.status === "recently_reconciled" ? "Recently reconciled" : "Stale or degraded"}</h2>
              <p>
                Service {data.value.serviceVersion}. Reconciliation does not establish live webhooks; webhook lag is
                unknown.
              </p>
              {data.value.sources.map((source, index) => (
                <section className="section" key={`${source.source}-${index}`}>
                  <h3>{source.source}</h3>
                  <p>
                    {source.state}; collection {source.collectionState}
                  </p>
                  <p>Last successful sync: {source.lastSuccessfulSync ?? "Unknown"}</p>
                  <p>Reconciled through: {source.reconciledThrough ?? "Unknown"}</p>
                </section>
              ))}
              {link("/leaderboards", "Browse published metric definitions")}
            </>
          )}
          {data?.kind === "board" && state.status === "ready" && (
            <>
              <h2>{data.value.metric.name}</h2>
              <p className="inline-list">
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => {
                    void download("json");
                  }}
                >
                  Download current JSON page
                </button>
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => {
                    void download("csv");
                  }}
                >
                  Download current CSV page
                </button>
              </p>
              {url.pathname.startsWith("/methodology/") ? (
                <Methods metric={data.value.metric} registry={state.registry} meta={data.value} />
              ) : (
                <>
                  <p>
                    {data.value.ranking?.rank === false
                      ? "Descriptive values; no rank is assigned."
                      : data.value.ranking
                        ? `Approved ${data.value.ranking.direction} ordering. Ties retain the API’s dense ranks.`
                        : "No ranking policy is supplied."}
                  </p>
                  <div className="table-region" role="region" aria-label="Published contributions" tabIndex={0}>
                    <table className="board-table" role="table">
                      <caption>
                        {data.value.metric.name} · {data.value.metric.definition.unit} · {data.value.totalRows}{" "}
                        published rows; this page has {data.value.rows.length}
                      </caption>
                      <thead role="rowgroup">
                        <tr role="row">
                          <th scope="col" role="columnheader">
                            Rank
                          </th>
                          <th scope="col" role="columnheader">
                            Contributor
                          </th>
                          <th scope="col" role="columnheader">
                            Value and state
                          </th>
                          <th scope="col" role="columnheader">
                            Evidence
                          </th>
                        </tr>
                      </thead>
                      <tbody role="rowgroup">
                        {data.value.rows.map((row) => (
                          <tr key={row.actorId} role="row">
                            <td role="cell" data-label="Rank">
                              {row.rank === null ? "Unranked" : row.rank}
                            </td>
                            <th role="rowheader" scope="row">
                              <a data-api-nav href={uiHref(`/contributors/${encodeURIComponent(row.actorId)}`, pinned)}>
                                {name(row.actor, row.actorId)}
                              </a>
                            </th>
                            <td role="cell" data-label="Value">
                              <Value
                                result={row.result}
                                pending={row.pending}
                                diagnostic={data.value.diagnostics.find(
                                  (item) => item.actorId === row.actorId && item.metricId === row.result.metricId,
                                )}
                              />
                            </td>
                            <td role="cell" data-label="Evidence">
                              {row.evidenceIds.length
                                ? row.evidenceIds.map((id) => (
                                    <p key={id}>
                                      <a data-api-proof href={proofHref(url.pathname, pinned, id)}>
                                        {id}
                                      </a>
                                    </p>
                                  ))
                                : "No evidence IDs supplied"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {data.value.rows.length === 0 && (
                    <p>
                      No public rows are available in this selection. An empty page does not establish zero activity.
                    </p>
                  )}
                  {data.value.nextCursor && (
                    <p>
                      <a data-api-nav href={uiHref(url.pathname, pinned, { cursor: data.value.nextCursor })}>
                        Next cursor page
                      </a>
                    </p>
                  )}
                  <Methods metric={data.value.metric} registry={state.registry} meta={data.value} />
                </>
              )}
            </>
          )}
          {(data?.kind === "directory" || data?.kind === "profile" || data?.kind === "activity") && (
            <>
              <form
                className="remote-filters"
                aria-label="Contribution filters"
                onSubmit={(event) => {
                  event.preventDefault();
                  const input = new FormData(event.currentTarget);
                  const filtered = {
                    ...pinned,
                    category: String(input.get("category") ?? "") || null,
                    search: String(input.get("search") ?? "").trim() || null,
                  };
                  navigate(uiHref(url.pathname, filtered, { cursor: null }));
                }}
              >
                {data.kind === "directory" && (
                  <label>
                    Public username
                    <input name="search" type="search" maxLength={39} defaultValue={selected.search ?? ""} />
                  </label>
                )}
                <label>
                  Contribution category
                  <select name="category" defaultValue={selected.category ?? ""}>
                    <option value="">All published categories</option>
                    {catalogEntries.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="button" type="submit">
                  Filter contributions
                </button>
              </form>
              <p>
                Observed and in-progress work is shown before acceptance when attributable public evidence is available.
                Category artifact counts can overlap and are not a personal score. Membership, mentions and assignment
                alone do not establish contributions.
              </p>
            </>
          )}
          {data?.kind === "activity" && <ActivityFeed value={data.value} selected={pinned} />}
          {data?.kind === "activity-detail" && <ActivityProofs value={data.value} selected={pinned} />}
          {data?.kind === "directory" && (
            <>
              <p>
                {data.value.totalContributors} contributors with public evidence in this selection. Showing{" "}
                {data.value.contributors.length} on this page.
              </p>
              <ul className="directory">
                {data.value.contributors.map((item) => (
                  <li key={item.actorId}>
                    <h2>
                      <a data-api-nav href={uiHref(`/contributors/${encodeURIComponent(item.actorId)}`, pinned)}>
                        {name(item.actor, item.actorId)}
                      </a>
                    </h2>
                    <p>
                      Public GitHub identity: {item.actor.login ?? item.actorId}. Roles: {item.roles.join(", ")}
                    </p>
                    <CategoryCounts categories={item.categories} registry={catalogEntries} />
                  </li>
                ))}
              </ul>
              {data.value.contributors.length === 0 && (
                <p>No public contributors match this selection. This does not establish zero activity.</p>
              )}
              {data.value.nextCursor && (
                <nav aria-label="Contributor directory pages">
                  <a data-api-nav href={uiHref(url.pathname, pinned, { cursor: data.value.nextCursor })}>
                    Next contributors page
                  </a>
                </nav>
              )}
            </>
          )}
          {data?.kind === "profile" && (
            <>
              <h2>{name(data.value.actor, data.value.actorId)}</h2>
              <p>
                Stable actor {data.value.actorId}; account kind {data.value.actor.kind}; execution mode{" "}
                {data.value.actor.executionMode}.
              </p>
              <h3>Independent category artifact counts</h3>
              <CategoryCounts categories={data.value.categories} registry={catalogEntries} />
              <h3>Measure results</h3>
              <ul>
                {data.value.results.map((result) => (
                  <li key={result.metricId}>
                    {link(
                      `/leaderboards/${result.metricId}`,
                      catalogEntries.find((metric) => metric.id === result.metricId)?.name ?? result.metricId,
                      { snapshot: data.value.snapshotId, metric: result.metricId },
                    )}
                    :{" "}
                    <Value
                      result={result}
                      diagnostic={data.value.diagnostics.find(
                        (item) => item.actorId === data.value.actorId && item.metricId === result.metricId,
                      )}
                    />
                  </li>
                ))}
              </ul>
              <ContributorRecognition
                key={`${data.value.actorId}:${data.value.snapshotId}:${data.value.policyVersion}`}
                base={parsed.base}
                selected={selected}
                snapshotId={data.value.snapshotId}
                actorId={data.value.actorId}
                metricIds={data.value.results.map((result) => result.metricId)}
              />
              <h3>Participant roles</h3>
              <ul>
                {data.value.roleBreakdown.map((item) => (
                  <li key={item.role}>
                    {item.role}: {item.contributions}
                  </li>
                ))}
              </ul>
              <h3>Published evidence</h3>
              <p>
                {data.value.evidenceCount} public evidence records.{" "}
                {data.value.timelineTruncated
                  ? "More records are available on the next timeline page."
                  : "This is the last page in this selected timeline."}
              </p>
              {data.value.timeline.map((item) => (
                <section className="section" key={item.contribution.contributionId}>
                  <a
                    data-api-nav
                    href={uiHref(`/contributions/${encodeURIComponent(item.contribution.contributionId)}`, pinned)}
                  >
                    {item.contribution.contributionId}
                  </a>
                  <Receipt value={item} selected={pinned} />
                </section>
              ))}
              {data.value.nextCursor && (
                <nav aria-label="Contribution timeline pages">
                  <a data-api-nav href={uiHref(url.pathname, pinned, { cursor: data.value.nextCursor })}>
                    Next timeline page
                  </a>
                </nav>
              )}
            </>
          )}
          {data?.kind === "evidence" && <EvidenceProof value={data.value} selected={pinned} />}
          {data?.kind === "unavailable" && (
            <section className="notice notice-info">
              <h2>This capability is not available in this UI</h2>
              <p>
                The public read API does not supply this workflow. No correction or private request is submitted here.
              </p>
              {url.pathname === "/corrections" && <ControlsEntry />}
            </section>
          )}
        </div>
      </main>
      {selected.proof && !parsed.error && (
        <EvidenceDrawer
          key={proofHref(url.pathname, pinned, selected.proof)}
          base={parsed.base}
          id={selected.proof}
          selected={pinned}
          recheck={nonce}
          onRecheck={refresh}
          boardIncludesProof={
            data?.kind === "board" ? data.value.rows.some((row) => row.evidenceIds.includes(selected.proof!)) : null
          }
          parentError={state.status === "error" ? state.error : null}
          onClose={closeProof}
          opener={proofOpener.current}
        />
      )}
      <footer className="app-footer">
        <div className="footer-inner">
          <p>
            {link("/corrections", "Corrections and privacy")} · Anonymous public reading; no overall productivity score.
          </p>
          <p>
            <a href="/?ui=prototype">Open the explicitly synthetic design prototype</a>
          </p>
        </div>
      </footer>
    </div>
  );
}
