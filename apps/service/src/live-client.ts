/** Browser transport helper. Notices request complete refetches; they are never ranking deltas. */
export interface LiveState {
  transport: "stream" | "polling" | "paused" | "unavailable";
  freshness: "unknown" | "recently_reconciled" | "stale_or_degraded";
  checkedAt: string | null;
}
export interface LiveOptions {
  scope?: Record<string, string>;
  basePath?: string;
  onState(state: LiveState): void;
  onSnapshot(notice: { snapshotId: string; revision: number; policyVersion: string }): void;
  fetch?: typeof fetch;
  eventSource?: (url: string) => EventSource;
  document?: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
  intervalMs?: number;
}
export function startLiveUpdates(options: LiveOptions): () => void {
  const base = options.basePath ?? "/api/v1";
  if (!/^\/(?!\/)[A-Za-z0-9_/-]+$/.test(base)) throw new Error("invalid_api_base_path");
  const interval = options.intervalMs ?? 3000;
  if (!Number.isFinite(interval) || interval < 50 || interval > 30000) throw new Error("invalid_poll_interval");
  const params = new URLSearchParams(options.scope).toString();
  const url = (path: string) => `${base}/${path}${params ? `?${params}` : ""}`;
  const fetcher = options.fetch ?? fetch;
  const document = options.document ?? globalThis.document;
  const streamFactory = options.eventSource ?? (globalThis.EventSource ? (url: string) => new EventSource(url, { withCredentials: false }) : null);
  let stopped = false, generation = 0, failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let stream: EventSource | null = null;
  let etag: string | null = null, lastNotice = "", retryStreamAt = 0;
  let highestRevision = -1;
  let lastHealth: LiveState["freshness"] = "unknown";
  let state: LiveState = { transport: "polling", freshness: "unknown", checkedAt: null };
  function emit(patch: Partial<LiveState>) { state = { ...state, ...patch }; options.onState({ ...state }); }
  function accept(value: unknown) {
    if (!value || typeof value !== "object") throw new Error("invalid_notice");
    const notice = value as { snapshotId: string; revision: number; policyVersion: string };
    if (typeof notice.snapshotId !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(notice.snapshotId) ||
        !Number.isSafeInteger(notice.revision) || notice.revision < 0 || typeof notice.policyVersion !== "string" ||
        !/^[A-Za-z0-9_.:-]{1,200}$/.test(notice.policyVersion)) throw new Error("invalid_notice");
    if (notice.revision < highestRevision) return;
    highestRevision = notice.revision;
    const key = JSON.stringify([notice.snapshotId, notice.revision, notice.policyVersion]);
    if (key !== lastNotice) { lastNotice = key; options.onSnapshot({ snapshotId: notice.snapshotId, revision: notice.revision, policyVersion: notice.policyVersion }); }
  }
  function openStream() {
    if (!streamFactory || stream || Date.now() < retryStreamAt || stopped || document?.hidden) return;
    try {
      const connection = streamFactory(url("updates"));
      stream = connection;
      connection.onopen = () => { if (connection === stream) emit({ transport: "stream" }); };
      const notice = (event: MessageEvent) => {
        if (connection !== stream || stopped || document?.hidden) return;
        try {
          const previous = lastNotice;
          accept(JSON.parse(String(event.data)));
          if (lastNotice !== previous) emit({ freshness: "unknown", checkedAt: null });
        } catch { connection.onerror?.(new Event("error")); }
      };
      connection.addEventListener("snapshot", notice as EventListener);
      connection.addEventListener("reset", notice as EventListener);
      connection.onerror = () => {
        if (connection !== stream) return;
        connection.close(); stream = null; retryStreamAt = Date.now() + 30000;
        emit({ transport: "polling" });
      };
    } catch { retryStreamAt = Date.now() + 30000; emit({ transport: "polling" }); }
  }
  async function poll() {
    if (stopped || document?.hidden) return;
    const current = generation;
    controller = new AbortController();
    const activeController = controller;
    const deadline = setTimeout(() => activeController.abort(), 5000);
    try {
      const response = await fetcher(url("health"), { headers: etag ? { "If-None-Match": etag } : {}, credentials: "omit", cache: "no-cache", signal: activeController.signal });
      if (stopped || current !== generation) return;
      if (response.status === 304) {
        if (!etag) throw new Error("unexpected_not_modified");
        emit({ transport: stream ? "stream" : "polling", freshness: lastHealth, checkedAt: new Date().toISOString() });
      } else {
        if (!response.ok) throw new Error("poll_unavailable");
        const body = await response.json() as Record<string, unknown>;
        if (stopped || current !== generation) return;
        if (body.status !== "recently_reconciled" && body.status !== "stale_or_degraded") throw new Error("invalid_health");
        if (typeof body.revision === "number" && body.revision < highestRevision) return;
        accept(body);
        etag = response.headers.get("ETag");
        lastHealth = body.status;
        emit({ transport: stream ? "stream" : "polling", freshness: body.status, checkedAt: new Date().toISOString() });
      }
      failures = 0;
      openStream();
    } catch {
      if (!stopped && current === generation) { failures++; emit({ transport: stream ? "stream" : "unavailable", freshness: "unknown" }); }
    } finally {
      clearTimeout(deadline);
      if (!stopped && current === generation && !document?.hidden) timer = setTimeout(() => { void poll(); }, Math.min(30000, interval * 2 ** Math.min(failures, 8)));
    }
  }
  function visibility() {
    generation++;
    if (timer) clearTimeout(timer);
    controller?.abort();
    stream?.close(); stream = null;
    if (document?.hidden) emit({ transport: "paused", freshness: "unknown" });
    else { emit({ transport: "polling", freshness: "unknown" }); void poll(); }
  }
  document?.addEventListener("visibilitychange", visibility);
  visibility();
  return () => {
    stopped = true; generation++;
    if (timer) clearTimeout(timer);
    controller?.abort(); stream?.close();
    document?.removeEventListener("visibilitychange", visibility);
  };
}
