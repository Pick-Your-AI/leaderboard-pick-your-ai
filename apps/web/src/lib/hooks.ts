import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useRouter } from "./router.tsx";
import { parseScope, routeParams, serializeScope, type Scope, type ScopeIssue } from "./scope.ts";
import { scopeContext, SourceError } from "../data/source.ts";
import { deferredLatestSnapshotId, initialLatestSnapshotId } from "../data/synthetic.ts";

/** Scope parsed from the URL, plus a setter that writes it back to the URL. */
export function useScope(): {
  scope: Scope;
  issues: ScopeIssue[];
  params: Record<string, string>;
  setScope: (next: Scope, extra?: Record<string, string | null>) => void;
  hrefWith: (path: string, extra?: Record<string, string | null>, override?: Partial<Scope>) => string;
} {
  const { search, pathname, navigate } = useRouter();
  const parsed = useMemo(() => parseScope(search, scopeContext), [search]);
  const params = useMemo(() => routeParams(search), [search]);
  const setScope = useCallback(
    (next: Scope, extra: Record<string, string | null> = params) => {
      navigate(`${pathname}${serializeScope(next, extra)}`);
    },
    [navigate, pathname, params],
  );
  const hrefWith = useCallback(
    (path: string, extra: Record<string, string | null> = {}, override: Partial<Scope> = {}) =>
      `${path}${serializeScope({ ...parsed.scope, ...override }, extra)}`,
    [parsed.scope],
  );
  return { ...parsed, params, setScope, hrefWith };
}

/**
 * Simulated publication of the next synthetic snapshot. A page loads on r42;
 * r43 is published a short time later so held updates can be evaluated.
 * `?arrive=now` publishes it immediately for walkthroughs.
 */
const listeners = new Set<() => void>();
let latestSnapshotId = initialLatestSnapshotId;
let timer: ReturnType<typeof setTimeout> | null = null;

function publishNext() {
  latestSnapshotId = deferredLatestSnapshotId;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer && latestSnapshotId === initialLatestSnapshotId) {
    const immediate = new URLSearchParams(window.location.search).get("arrive") === "now";
    timer = setTimeout(publishNext, immediate ? 0 : 20_000);
  }
  return () => listeners.delete(listener);
}

export function useLatestSnapshotId(): string {
  return useSyncExternalStore(subscribe, () => latestSnapshotId, () => latestSnapshotId);
}

export type AsyncState<T> =
  | { status: "loading" }
  | { status: "error"; error: SourceError | Error }
  | { status: "ready"; data: T };

/**
 * Run a synchronous prototype read as if it were a network request so the
 * loading and failure states are real code paths, not mock-ups.
 */
export function useRead<T>(read: () => T, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState((previous) => (previous.status === "ready" ? previous : { status: "loading" }));
    const handle = setTimeout(() => {
      if (cancelled) return;
      try {
        setState({ status: "ready", data: read() });
      } catch (error) {
        setState({ status: "error", error: error instanceof Error ? error : new Error(String(error)) });
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, deps);
  return state;
}

export function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  return useSyncExternalStore(
    (listener) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
