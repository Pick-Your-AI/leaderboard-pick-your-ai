import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BoardTable, MethodDisclosure, type BoardSort } from "../components/BoardTable.tsx";
import { CountLink } from "../components/CountLink.tsx";
import { PageHeader } from "../components/Layout.tsx";
import { publicPersonLabel, ReceiptDrawer, ReceiptRow } from "../components/Receipt.tsx";
import { ScopeBar } from "../components/ScopeBar.tsx";
import {
  CoverageNote,
  EmptyState,
  ErrorState,
  FreshnessIndicator,
  Loading,
  Notice,
  SnapshotNotices,
} from "../components/status.tsx";
import { familyLabel, getMetric, releaseEligibilityLabels } from "../data/registry.ts";
import { contributorProofSelector, matchesContributorProof, type Board, type BoardRow } from "../data/source.ts";
import { plural } from "../lib/format.ts";
import { useLatestSnapshotId, usePrefersReducedMotion, useRead, useScope } from "../lib/hooks.ts";
import { Link, useRouter, ScopedLink } from "../lib/router.tsx";
import { serializeScope, mayFollowUpdates } from "../lib/scope.ts";

import { buildSelectedBoard, validatePrototypeView } from "../data/metric-selection.ts";

const PAGE_SIZE = 25;

function subscribeVisibility(listener: () => void) {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

function changedRows(before: Board | null, after: Board | null): number {
  if (!before || !after) return 0;
  const previous = new Map(before.rows.map((row) => [row.person.actorId, `${row.rank}:${row.value}:${row.pending}`]));
  let changed = 0;
  for (const row of after.rows)
    if (previous.get(row.person.actorId) !== `${row.rank}:${row.value}:${row.pending}`) changed += 1;
  return changed + Math.max(0, before.rows.length - after.rows.length);
}

/** Held-update control: new snapshots wait for the reader unless they opt in to follow. */
function UpdateControl({
  pendingId,
  follow,
  reducedMotion,
  onFollow,
  onApply,
}: {
  pendingId: string | null;
  follow: boolean;
  reducedMotion: boolean;
  onFollow: (follow: boolean) => void;
  onApply: () => void;
}) {
  return (
    <div className="update-control">
      {pendingId ? (
        <p>
          <span className="health health-warn">
            <span aria-hidden="true">◑</span> Update held
          </span>{" "}
          Snapshot {pendingId} is ready.{" "}
          <button type="button" className="button" onClick={onApply}>
            Apply updates
          </button>
        </p>
      ) : (
        <p className="muted">Showing the latest snapshot. New snapshots are held until you apply them.</p>
      )}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={follow}
          disabled={reducedMotion}
          onChange={(event) => onFollow(event.target.checked)}
        />
        <span>
          Follow updates automatically when I am not reading the table
          {reducedMotion ? " (disabled for reduced motion)" : ""}
        </span>
      </label>
    </div>
  );
}

export function BoardPage({ metricId }: { metricId: string }) {
  const metric = getMetric(metricId);
  const { scope, params, hrefWith } = useScope();
  const { pathname, navigate } = useRouter();
  const latest = useLatestSnapshotId();
  const reducedMotion = usePrefersReducedMotion();
  const visible = useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "visible",
    () => false,
  );
  const selectionError = useMemo(() => {
    try {
      validatePrototypeView(metricId, params);
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error("Unsupported metric view");
    }
  }, [metricId, params.state, params.date_basis]);
  const [shownLatest, setShownLatest] = useState(latest);
  const [follow, setFollow] = useState(false);
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const regionRef = useRef<HTMLDivElement>(null);
  const scopeKey = serializeScope(scope);
  const state = useRead(
    () => buildSelectedBoard(metricId, scope, shownLatest, params),
    [metricId, scopeKey, shownLatest, params.state, params.date_basis],
  );

  const sort: BoardSort = params.sort === "name" ? "name" : "rank";
  const limit = Math.max(PAGE_SIZE, Number.parseInt(params.rows ?? "", 10) || PAGE_SIZE);
  const proof = params.proof ?? null;
  const pendingId = !scope.snapshot && latest !== shownLatest ? latest : null;

  const apply = useCallback(() => {
    if (selectionError) return;
    const before = buildSelectedBoard(metricId, scope, shownLatest, params);
    const after = buildSelectedBoard(metricId, scope, latest, params);
    setShownLatest(latest);
    const changed = changedRows(before, after);
    setAnnouncement(
      `Updated to snapshot ${latest}. ${changed === 0 ? "No ranked values changed." : `${plural(changed, "row")} changed.`}`,
    );
  }, [metricId, scope, shownLatest, latest, params.state, params.date_basis, selectionError]);

  useEffect(() => {
    // Drawer cleanup restores focus before React processes its focus event.
    // Consult the DOM as well so closing proof cannot apply an update in that gap.
    const focusReturnedToTable = regionRef.current?.contains(document.activeElement) ?? false;
    if (
      pendingId &&
      follow &&
      !reducedMotion &&
      visible &&
      mayFollowUpdates(pointerInside, focusInside || focusReturnedToTable, Boolean(proof))
    )
      apply();
  }, [pendingId, follow, reducedMotion, visible, pointerInside, focusInside, proof, apply]);

  const routeHref = useCallback(
    (extra: Record<string, string | null>) => hrefWith(pathname, { ...params, ...extra }),
    [hrefWith, pathname, params],
  );

  const countHref = useCallback(
    (selector: string | null, displayed: Board) =>
      hrefWith(
        `/leaderboards/${displayed.metric.id}`,
        { ...params, proof: selector, ui: "prototype" },
        { ...displayed.scope, snapshot: displayed.snapshot.served.id },
      ),
    [hrefWith, params],
  );

  const proofRow = useMemo(() => {
    if (state.status !== "ready" || !state.data || !proof) return null;
    const row = state.data.rows.find((candidate) =>
      matchesContributorProof(proof, candidate.person, [...candidate.ranked, ...candidate.pendingRecords]),
    );
    if (row) return { person: row.person, ranked: row.ranked, pending: row.pendingRecords };
    const pendingOnly = state.data.pendingOnly.find((candidate) =>
      matchesContributorProof(proof, candidate.person, candidate.records),
    );
    return pendingOnly ? { person: pendingOnly.person, ranked: [], pending: pendingOnly.records } : null;
  }, [state, proof]);

  if (!metric) return null;
  // A changed URL must not display a previous successful table while the
  // asynchronous read catches up with an unsupported selection.
  if (selectionError)
    return (
      <>
        <PageHeader title={metric.name} />
        <ScopeBar metricId={metricId} timeWindow={null} />
        <ErrorState error={selectionError} />
      </>
    );

  const engagement = {
    onFocus: () => setFocusInside(true),
    onBlur: (event: React.FocusEvent) => {
      if (!regionRef.current?.contains(event.relatedTarget as Node | null)) setFocusInside(false);
    },
    onPointerEnter: () => setPointerInside(true),
    onPointerLeave: () => setPointerInside(false),
  };

  return (
    <>
      <PageHeader eyebrow={`${familyLabel(metric.family)} · leaderboard`} title={metric.name}>
        <p>
          {metric.counting_rule}. Unit: {metric.definition.unit}. Date basis:{" "}
          <span className="mono">{metric.event_clock}</span>.{" "}
          {releaseEligibilityLabels[metric.definition.release_eligibility] ?? metric.definition.release_eligibility}.
        </p>
      </PageHeader>
      <ScopeBar metricId={metricId} timeWindow={state.status === "ready" && state.data ? state.data.window : null} />
      <div className="visually-hidden" aria-live="polite" role="status">
        {announcement}
      </div>
      {state.status === "loading" && <Loading label="board" />}
      {state.status === "error" && <ErrorState error={state.error} />}
      {state.status === "ready" && state.data && (
        <BoardBody
          board={state.data}
          scopeDensity={scope.density}
          sort={sort}
          limit={limit}
          routeHref={routeHref}
          countHref={countHref}
          regionRef={regionRef}
          engagement={engagement}
          update={
            scope.snapshot ? (
              <p className="muted">This link pins snapshot {scope.snapshot}. It never changes.</p>
            ) : (
              <UpdateControl
                pendingId={pendingId}
                follow={follow}
                reducedMotion={reducedMotion}
                onFollow={setFollow}
                onApply={apply}
              />
            )
          }
        />
      )}
      {proof && state.status === "ready" && (
        <ReceiptDrawer
          title={proofRow ? `Evidence: ${publicPersonLabel(proofRow.person)}` : "Evidence not found"}
          onClose={() => navigate(routeHref({ proof: null }))}
          {...(proofRow && proofRow.person.publicState === "visible"
            ? { fullPageHref: hrefWith(`/contributors/${encodeURIComponent(proofRow.person.login)}`) }
            : {})}
        >
          {proofRow ? (
            <>
              <p>
                {plural(proofRow.ranked.length, "contribution")} counted,{" "}
                {plural(proofRow.pending.length, "contribution")} pending and not ranked, in this scope and snapshot.
              </p>
              <p className="muted">Fixture explanation: {state.data?.fixture?.explanation}</p>
              <h3>Counted</h3>
              {proofRow.ranked.length ? (
                <ul className="receipt-list">
                  {proofRow.ranked.map((record) => (
                    <ReceiptRow key={record.id} record={record} />
                  ))}
                </ul>
              ) : (
                <p className="muted">None.</p>
              )}
              <h3>Pending, not ranked</h3>
              {proofRow.pending.length ? (
                <ul className="receipt-list">
                  {proofRow.pending.map((record) => (
                    <ReceiptRow key={record.id} record={record} />
                  ))}
                </ul>
              ) : (
                <p className="muted">None.</p>
              )}
            </>
          ) : (
            <p>No public contribution explanation is available for this selection.</p>
          )}
        </ReceiptDrawer>
      )}
    </>
  );
}

function BoardBody({
  board,
  scopeDensity,
  sort,
  limit,
  routeHref,
  countHref,
  regionRef,
  engagement,
  update,
}: {
  board: Board;
  scopeDensity: "comfortable" | "compact";
  sort: BoardSort;
  limit: number;
  routeHref: (extra: Record<string, string | null>) => string;
  countHref: (selector: string | null, displayed: Board) => string;
  regionRef: React.RefObject<HTMLDivElement | null>;
  engagement: React.HTMLAttributes<HTMLDivElement>;
  update: React.ReactNode;
}) {
  const selectorFor = (row: BoardRow) => contributorProofSelector(row.person, [...row.ranked, ...row.pendingRecords]);
  const proofHref = (row: BoardRow) => routeHref({ proof: selectorFor(row) });
  return (
    <>
      <div className="board-meta">
        <FreshnessIndicator view={board.snapshot} />
        <CoverageNote items={board.coverage} windowStart={board.window.start} />
      </div>
      <SnapshotNotices view={board.snapshot} />
      {board.coverageState !== "complete" && board.status === "measured" && (
        <Notice tone="warn" title="Partial history">
          Some repositories in this scope have incomplete source history, so these values may be low. Missing activity
          is not counted as zero.
        </Notice>
      )}
      {update}
      <MethodDisclosure metric={board.metric} />

      {board.status === "not_measured" && (
        <EmptyState
          title={
            board.coverageState === "unavailable" ? "Unsupported source capability" : "Not measured in this prototype"
          }
        >
          <p>
            {board.coverageState === "unavailable"
              ? `The source needed for this measure is unavailable in this scope (${
                  board.coverage.flatMap((item) => item.permissionsMissing).join(", ") || "no supported adapter"
                }). Nothing is shown as zero.`
              : "This measure is defined in the metric registry, but the synthetic prototype has no fixture for it. It is not zero, and it is not ranked."}
          </p>
          <p>
            <ScopedLink to={`/methodology/${board.metric.id}`}>Read its method sheet</ScopedLink> or{" "}
            <ScopedLink to="/prototype">see which boards have prototype data</ScopedLink>.
          </p>
        </EmptyState>
      )}
      {board.status === "empty_complete" && (
        <EmptyState title="No eligible activity in this complete scope">
          Every source for this scope reports complete coverage for the whole window, and no eligible activity occurred.
          This is a true zero.
        </EmptyState>
      )}
      {board.status === "empty_incomplete" && (
        <EmptyState title="Nothing observed, but coverage is incomplete">
          No activity was observed, but at least one source in this scope has partial or unknown coverage. This is not a
          zero.
        </EmptyState>
      )}
      {board.rows.length > 0 && (
        <div ref={regionRef} {...engagement}>
          <BoardTable
            board={board}
            density={scopeDensity}
            sort={sort}
            limit={limit}
            sortHref={(next) => routeHref({ sort: next === "rank" ? null : next })}
            proofHref={proofHref}
            countHref={(row) => countHref(selectorFor(row), board)}
            moreHref={routeHref({ rows: String(limit + PAGE_SIZE) })}
          />
        </div>
      )}
      {board.pendingOnly.length > 0 && (
        <section className="section" aria-labelledby="pending-only">
          <h2 id="pending-only">Also active, not ranked</h2>
          <p className="muted">
            These contributors have only pending work for this measure in this scope. They are listed, not ranked.
          </p>
          <ul className="people-list">
            {board.pendingOnly.map((entry) => (
              <li key={entry.person.actorId}>
                <Link to={routeHref({ proof: contributorProofSelector(entry.person, entry.records) })}>
                  {publicPersonLabel(entry.person)}
                </Link>
                :{" "}
                <CountLink
                  to={countHref(contributorProofSelector(entry.person, entry.records), board)}
                  label={`${plural(entry.records.length, "pending contribution")}, ${publicPersonLabel(entry.person)}`}
                >
                  {plural(entry.records.length, "pending contribution")}
                </CountLink>
              </li>
            ))}
          </ul>
        </section>
      )}
      {board.excluded.length > 0 && (
        <section className="section" aria-labelledby="excluded">
          <h2 id="excluded">Excluded under stated policy</h2>
          <ul className="receipt-list">
            {board.excluded.map((record) => (
              <ReceiptRow key={record.id} record={record} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
