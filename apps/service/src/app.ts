import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { metricRegistrySchema, type MetricRegistry } from "@pick-your-ai/contracts";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import { projectRead, PublicReadError, unavailableSource, type PublicRead, type PublicScope, type PublicSnapshotSource } from "./public-source.js";

export interface ServiceOptions {
  source?: PublicSnapshotSource;
  registry?: MetricRegistry;
  now?: () => number;
  sourceTimeoutMs?: number;
  maxConcurrentReads?: number;
  maxConcurrentStreams?: number;
  cursorSecret?: string;
  serviceVersion?: string;
}
const allowed = new Set(["organization", "repository", "workstream", "start", "end", "snapshot", "metric", "limit", "cursor", "format"]);
const identifier = /^[A-Za-z0-9_.:-]{1,200}$/;
function fail(status: number, code: string): never { throw new PublicReadError(status, code); }
const csv = (value: unknown) => {
  const text = String(value ?? "");
  return `"${(/^[\s\u0000-\u001f]*[=+@-]/u.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`;
};
export function createService(options: ServiceOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: 1024, routerOptions: { maxParamLength: 200 } });
  const source = options.source ?? unavailableSource;
  const registry = metricRegistrySchema.parse(options.registry ?? metricRegistryV1);
  const now = options.now ?? Date.now;
  const secret = options.cursorSecret ?? randomBytes(32).toString("hex");
  const timeout = options.sourceTimeoutMs ?? 2000;
  const maxReads = options.maxConcurrentReads ?? 16;
  const maxStreams = options.maxConcurrentStreams ?? 16;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10000 || !Number.isInteger(maxReads) || maxReads < 1 || maxReads > 128 ||
      !Number.isInteger(maxStreams) || maxStreams < 1 || maxStreams > 128 || secret.length < 32) throw new Error("invalid_service_limits");
  let reads = 0;
  let streams = 0;
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof PublicReadError ? error.status : 503;
    reply.code(status).header("Cache-Control", "no-store").send({ error: error instanceof PublicReadError ? error.code : "public_projection_unavailable" });
  });
  app.addHook("onRequest", async request => {
    if (request.url.length > 4096) fail(414, "query_too_large");
  });
  function query(request: FastifyRequest) {
    const params = new URL(request.url, "http://localhost").searchParams;
    for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) fail(400, "invalid_query");
    const item = (key: string) => {
      const value = params.get(key);
      if (value !== null && !identifier.test(value)) fail(400, "invalid_query");
      return value;
    };
    const date = (key: string) => {
      const value = params.get(key);
      if (value === null) return null;
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(400, "invalid_date");
      return value;
    };
    const scope: PublicScope = { organization: item("organization") ?? "Pick-Your-AI", repository: item("repository"),
      workstream: item("workstream"), start: date("start"), end: date("end") };
    if ((scope.start === null) !== (scope.end === null) || (scope.start !== null && scope.end !== null &&
      (scope.start >= scope.end || Date.parse(scope.end) - Date.parse(scope.start) > 366 * 86400000))) fail(400, "invalid_date_window");
    const limitText = params.get("limit") ?? "50";
    if (!/^[1-9]\d{0,2}$/.test(limitText) || Number(limitText) > 100) fail(400, "invalid_limit");
    const metric = item("metric");
    if (metric !== null && !registry.metrics.some(entry => entry.id === metric)) fail(400, "unknown_metric");
    const format = params.get("format") ?? "json";
    if (!["json", "csv"].includes(format)) fail(400, "unsupported_export_format");
    return { scope, limit: Number(limitText), metric, snapshot: item("snapshot"), cursor: params.get("cursor"), format };
  }
  async function load(scope: PublicScope, pin: string | null): Promise<PublicRead> {
    if (reads >= maxReads) fail(429, "read_budget_exceeded");
    reads++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Keep a slot occupied until the provider actually settles, even if it ignores cancellation.
    const pending = Promise.resolve().then(() => source.read(scope, pin, controller.signal)).finally(() => { reads--; });
    try {
      const result = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new PublicReadError(503, "snapshot_source_timeout")); }, timeout); }),
      ]);
      if (result === null) fail(pin ? 410 : 503, pin ? "snapshot_expired_refetch" : "public_snapshot_unavailable");
      const projected = projectRead(result, scope, pin);
      if (projected.selected.snapshot.metricDefinitionVersion !== registry.policy_version) fail(409, "metric_definition_unavailable");
      const knownMetrics = new Set(registry.metrics.map(metric => metric.id));
      if (projected.selected.rows.some(row => !knownMetrics.has(row.result.metricId))) fail(409, "metric_definition_unavailable");
      return projected;
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  function send(request: FastifyRequest, reply: FastifyReply, body: unknown, contentType = "application/json; charset=utf-8") {
    const serialized = typeof body === "string" ? body : JSON.stringify(body);
    const etag = `"${createHash("sha256").update(serialized).digest("hex")}"`;
    reply.header("ETag", etag).header("Cache-Control", "public, max-age=0, must-revalidate")
      .header("X-Content-Type-Options", "nosniff").type(contentType);
    const matches = request.headers["if-none-match"]?.split(",").map(value => value.trim().replace(/^W\//, ""));
    if (matches?.includes(etag) || matches?.includes("*")) return reply.code(304).send();
    return reply.send(serialized);
  }
  function meta(read: PublicRead) {
    const snapshot = read.selected.snapshot;
    return { schemaVersion: snapshot.schemaVersion, snapshotId: snapshot.snapshotId, revision: snapshot.revision,
      generatedAt: snapshot.generatedAt, metricDefinitionVersion: snapshot.metricDefinitionVersion,
      computationVersion: snapshot.computationVersion, policyVersion: read.controls.version,
      head: read.head, scope: read.selected.scope, coverage: snapshot.coverage,
      disabledMetrics: read.selected.disabledMetrics ?? [], methodology: read.selected.methodology ?? [] };
  }
  function sign(value: string) { return createHmac("sha256", secret).update(value).digest("base64url"); }
  function decodeCursor(cursor: string): { pin: string; policy: string; offset: number; binding: string; expires: number } {
    if (cursor.length > 2048) fail(400, "invalid_cursor");
    const [payload, signature, extra] = cursor.split(".");
    if (!payload || !signature || extra || !/^[\w-]+$/.test(payload) || !/^[\w-]+$/.test(signature)) fail(400, "invalid_cursor");
    const actual = Buffer.from(signature);
    const expected = Buffer.from(sign(payload));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail(410, "cursor_expired_refetch");
    try {
      const value = JSON.parse(Buffer.from(payload, "base64url").toString()) as ReturnType<typeof decodeCursor>;
      if (!identifier.test(value.pin) || !identifier.test(value.policy) || !Number.isSafeInteger(value.offset) || value.offset < 1 || value.offset > 10000 ||
          typeof value.binding !== "string" || !Number.isFinite(value.expires)) fail(400, "invalid_cursor");
      if (value.expires < now()) fail(410, "cursor_expired_refetch");
      return value;
    } catch (error) { if (error instanceof PublicReadError) throw error; return fail(400, "invalid_cursor"); }
  }
  function ranked(read: PublicRead, metric: string) {
    const actors = new Map(read.selected.actors.map(actor => [actor.actorId, actor.actor]));
    const policy = read.selected.ranking.find(entry => entry.metricId === metric);
    const direction = policy?.direction;
    const ordered = read.selected.rows.filter(row => row.result.metricId === metric)
      .sort((a, b) => {
        const av = a.result.value, bv = b.result.value;
        const delta = av === undefined ? (bv === undefined ? 0 : 1) : bv === undefined ? -1 : (direction === "ascending" ? av - bv : bv - av);
        return (policy?.rank === false ? 0 : delta) || (a.actorId < b.actorId ? -1 : a.actorId > b.actorId ? 1 : 0);
      });
    let rank = 0;
    return ordered.map((row, index) => {
      if (index === 0 || row.result.value !== ordered[index - 1]?.result.value) rank++;
      return { rank: policy?.rank === false || row.result.value === undefined ? null : rank,
        actorId: row.actorId, actor: actors.get(row.actorId), result: row.result, evidenceIds: row.evidenceIds };
    });
  }
  const definition = (metric: string) => registry.metrics.find(entry => entry.id === metric)!;
  async function board(request: FastifyRequest, reply: FastifyReply, exporting: boolean) {
    const q = query(request);
    if (q.metric === null) fail(400, "metric_required");
    const binding = JSON.stringify([q.scope, q.metric, q.limit]);
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (cursor && (cursor.binding !== binding || (q.snapshot !== null && q.snapshot !== cursor.pin))) fail(400, "cursor_scope_mismatch");
    const read = await load(q.scope, cursor?.pin ?? q.snapshot);
    const disabled = read.selected.disabledMetrics?.find(entry => entry.id === q.metric);
    if (disabled) return reply.code(503).header("Cache-Control", "no-store").send({ ...meta(read), error: "metric_disabled", metric: disabled });
    if (cursor && cursor.policy !== read.controls.version) fail(410, "cursor_policy_changed_refetch");
    const offset = cursor?.offset ?? 0;
    const rows = ranked(read, q.metric);
    const page = rows.slice(offset, offset + q.limit);
    const nextOffset = offset + page.length;
    let nextCursor: string | null = null;
    if (nextOffset < rows.length) {
      const value = Buffer.from(JSON.stringify({ pin: read.selected.snapshot.snapshotId, policy: read.controls.version,
        offset: nextOffset, binding, expires: Math.floor(now() / 300000) * 300000 + 900000 })).toString("base64url");
      nextCursor = `${value}.${sign(value)}`;
    }
    const share = new URLSearchParams({ organization: q.scope.organization, metric: q.metric, snapshot: read.selected.snapshot.snapshotId });
    for (const key of ["repository", "workstream", "start", "end"] as const) if (q.scope[key] !== null) share.set(key, q.scope[key]);
    const body = { ...meta(read), metric: definition(q.metric), ranking: read.selected.ranking.find(entry => entry.metricId === q.metric) ?? null,
      rows: page, totalRows: rows.length, nextCursor,
      shareUrl: `/api/v1/boards?${share.toString()}` };
    if (exporting && q.format === "csv") {
      const evidence = new Map(read.selected.evidence.map(entry => [entry.contribution.contributionId, entry]));
      const lines: unknown[][] = [["snapshot", "revision", "policy", "metric", "definition", "unit", "start", "end", "repository", "workstream", "actor", "rank", "state", "value", "sources", "generated_at", "next_cursor"]];
      for (const row of page) lines.push([body.snapshotId, body.revision, body.policyVersion, q.metric, body.metric.counting_rule,
        body.metric.definition.unit, q.scope.start, q.scope.end, q.scope.repository, q.scope.workstream, row.actor?.login ?? row.actorId,
        row.rank, row.result.state, row.result.value, row.evidenceIds.map(id => evidence.get(id)!.artifact.publicUrl).join(" "), body.generatedAt, nextCursor]);
      reply.header("Content-Disposition", 'attachment; filename="leaderboard.csv"');
      return send(request, reply, lines.map(line => line.map(csv).join(",")).join("\r\n") + "\r\n", "text/csv; charset=utf-8");
    }
    return send(request, reply, body);
  }
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/api/v1", async (_request, reply) => reply.header("Cache-Control", "no-store").send({
    status: options.source ? "configured" : "scaffold", revision: null,
    message: options.source ? "Read the selected scope health endpoint for publication status." : "No approved public snapshot source is configured.",
    endpoints: ["metrics", "boards", "contributors/:actorId", "evidence/:contributionId", "health", "updates", "exports"],
  }));
  app.get("/api/v1/metrics", async (request, reply) => {
    query(request);
    return send(request, reply, registry);
  });
  app.get("/api/v1/boards", (request, reply) => board(request, reply, false));
  app.get("/api/v1/exports", (request, reply) => board(request, reply, true));
  app.get<{ Params: { actorId: string } }>("/api/v1/contributors/:actorId", async (request, reply) => {
    const q = query(request);
    if (q.cursor) fail(400, "cursor_not_supported");
    const read = await load(q.scope, q.snapshot);
    const actor = read.selected.actors.find(actor => actor.actorId === request.params.actorId);
    if (!actor) fail(404, "profile_unavailable");
    const rows = read.selected.rows.filter(row => row.actorId === actor.actorId && (q.metric === null || row.result.metricId === q.metric));
    const ids = new Set(rows.flatMap(row => row.evidenceIds));
    const evidence = read.selected.evidence.filter(entry => ids.has(entry.contribution.contributionId))
      .sort((a, b) => (b.occurredAt ?? "").localeCompare(a.occurredAt ?? "") || a.contribution.contributionId.localeCompare(b.contribution.contributionId));
    return send(request, reply, { ...meta(read), actor: actor.actor, actorId: actor.actorId, results: rows.map(row => row.result),
      roleBreakdown: [...new Set(evidence.flatMap(entry => entry.contribution.roles))].sort().map(role => ({ role,
        contributions: evidence.filter(entry => entry.contribution.roles.includes(role)).length })),
      timeline: evidence.slice(0, q.limit), timelineTruncated: evidence.length > q.limit,
      evidenceCount: evidence.length, evidenceIds: [...ids] });
  });
  app.get<{ Params: { contributionId: string } }>("/api/v1/evidence/:contributionId", async (request, reply) => {
    const q = query(request);
    const read = await load(q.scope, q.snapshot);
    const evidence = read.selected.evidence.find(entry => entry.contribution.contributionId === request.params.contributionId);
    if (!evidence) fail(404, "evidence_unavailable");
    return send(request, reply, { ...meta(read), ...evidence });
  });
  app.get("/api/v1/health", async (request, reply) => {
    const q = query(request);
    const read = await load(q.scope, q.snapshot);
    const sources = read.selected.snapshot.coverage.map(coverage => ({ source: coverage.source, scopeId: coverage.scopeId,
      state: coverage.state, lastSuccessfulSync: coverage.lastSuccessfulSync, reconciledThrough: coverage.sourceWatermark,
      webhookLagSeconds: null, degradedCapabilities: coverage.permissionsMissing,
      collectionState: coverage.sourceErrors.length ? "degraded" : coverage.state === "complete" ? "covered" : "unknown" }));
    const stale = sources.length === 0 || sources.some(entry => entry.state !== "complete" || entry.lastSuccessfulSync === null ||
      entry.reconciledThrough === null || now() < Date.parse(entry.lastSuccessfulSync) ||
      now() - Date.parse(entry.lastSuccessfulSync) > 300000 || entry.collectionState === "degraded");
    return send(request, reply, { ...meta(read), status: stale ? "stale_or_degraded" : "recently_reconciled",
      serviceVersion: options.serviceVersion ?? "0.1.0", lastSuccessfulPublish: read.head, sources });
  });
  app.get("/api/v1/updates", async (request, reply) => {
    if (streams >= maxStreams) fail(429, "stream_budget_exceeded");
    const q = query(request);
    if (q.snapshot || q.cursor) fail(400, "updates_require_current_scope");
    streams++;
    try {
      const read = await load(q.scope, null);
      const eventId = `${read.head.revision}:${read.head.snapshotId}:${read.controls.version}`;
      const prior = request.headers["last-event-id"];
      if (prior !== undefined && (typeof prior !== "string" || prior.length > 512 || !/^[A-Za-z0-9_.:-]+$/.test(prior))) fail(400, "invalid_event_cursor");
      const payload = { ...meta(read), action: "refetch_snapshot", pollingUrl: `/api/v1/health?${new URLSearchParams({ organization: q.scope.organization,
        ...Object.fromEntries(Object.entries(q.scope).filter(([key, value]) => key !== "organization" && value !== null)) }).toString()}` };
      const event = prior === eventId ? `: heartbeat ${read.head.revision}\n\n` :
        `id: ${eventId}\nevent: ${prior ? "reset" : "snapshot"}\ndata: ${JSON.stringify(payload)}\n\n`;
      reply.header("Cache-Control", "no-store").header("X-Accel-Buffering", "no").header("X-Content-Type-Options", "nosniff")
        .type("text/event-stream; charset=utf-8");
      return reply.send(`retry: 3000\n\n${event}`);
    } finally { streams--; }
  });
  return app;
}
