import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  actorFilterSchema,
  canonicalPublicScope,
  publicScopeKey,
  publicScopeParameters,
  publicRoleScopeSchemaVersion,
  achievementMilestoneVersion,
  achievementMilestonesPageSchema,
  participationHistoryResponseByteLimit,
  metricRegistrySchema,
  type ActorFilter,
  type MetricRegistry,
} from "@pick-your-ai/contracts";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import { comparePublishedRanks, type ComparedRanks } from "./rank-comparison.js";
import { acceptedAchievements, ACHIEVEMENT_RULE_VERSION } from "./achievements.js";
import { acceptedMilestones } from "./achievement-milestones.js";
import { renderContributorCard, renderContributorCardImage } from "./cards.js";
import { renderPublicExport } from "./exports.js";
import { publicParticipation } from "./participation.js";
import { publicOrganizationHistory, validateParticipationHistoryRead } from "./participation-history.js";
import {
  activityGroupingVersion,
  activityIndex,
  activityPageByteLimit,
  activityPreviewLimit,
  newest,
  publicPortfolio as portfolio,
} from "./activity.js";
import {
  projectRead,
  filterPublicActors,
  readSuppressedContributionIds,
  PublicReadError,
  unavailableSource,
  type PublicRead,
  type PortfolioEvidence,
  type PublicScope,
  type PublicSnapshotSource,
} from "./public-source.js";

export interface ServiceOptions {
  source?: PublicSnapshotSource;
  registry?: MetricRegistry;
  now?: () => number;
  sourceTimeoutMs?: number;
  maxConcurrentReads?: number;
  maxConcurrentStreams?: number;
  cursorSecret?: string;
  serviceVersion?: string;
  approvedAchievementRuleVersion?: typeof ACHIEVEMENT_RULE_VERSION | typeof achievementMilestoneVersion;
}
const allowed = new Set([
  "actors",
  "organization",
  "repository",
  "workstream",
  "context",
  "project",
  "role",
  "start",
  "end",
  "snapshot",
  "metric",
  "limit",
  "cursor",
  "format",
  "search",
  "category",
  "compare",
  "compareStart",
  "compareEnd",
]);
const identifier = /^[A-Za-z0-9_.:-]{1,200}$/;
// Admit the complete canonical scope even when all 100 maximum-length Project
// IDs require percent encoding, together with bounded route/query/cursor fields.
const requestTargetByteLimit = 48 * 1024;
const retainedHeaderByteLimit = 16 * 1024;
const retainedHeaderCountLimit = 1000;
function fail(status: number, code: string): never {
  throw new PublicReadError(status, code);
}
export function createService(options: ServiceOptions = {}) {
  const app = Fastify({
    logger: false,
    bodyLimit: 1024,
    routerOptions: { maxParamLength: 200 },
    http: { maxHeaderSize: requestTargetByteLimit + retainedHeaderByteLimit + 1024 },
  });
  // Capture one overflow header so Node's count truncation cannot conceal it.
  // The application retains the parser's original 1,000-header capacity.
  app.server.maxHeadersCount = retainedHeaderCountLimit + 1;
  const source = options.source ?? unavailableSource;
  const registry = metricRegistrySchema.parse(options.registry ?? metricRegistryV1);
  const now = options.now ?? Date.now;
  const secret = options.cursorSecret ?? randomBytes(32).toString("hex");
  const timeout = options.sourceTimeoutMs ?? 2000;
  const maxReads = options.maxConcurrentReads ?? 16;
  const maxStreams = options.maxConcurrentStreams ?? 16;
  if (
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 10000 ||
    !Number.isInteger(maxReads) ||
    maxReads < 1 ||
    maxReads > 128 ||
    !Number.isInteger(maxStreams) ||
    maxStreams < 1 ||
    maxStreams > 128 ||
    secret.length < 32
  )
    throw new Error("invalid_service_limits");
  let reads = 0;
  let streams = 0;
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof PublicReadError ? error.status : 503;
    reply
      .code(status)
      .header("Cache-Control", "no-store")
      .send({ error: error instanceof PublicReadError ? error.code : "public_projection_unavailable" });
  });
  app.addHook("onRequest", async (request) => {
    if (Buffer.byteLength(request.url, "latin1") > requestTargetByteLimit) fail(414, "query_too_large");
    const fields = request.raw.rawHeaders;
    if (fields.length > retainedHeaderCountLimit * 2) fail(431, "headers_too_large");
    // Node exposes parsed HTTP header names/values as Latin-1 byte strings.
    // Include normal line framing. Node excludes leading OWS from its native
    // size accounting, so neither limit claims an exact wire-byte ceiling.
    let headerBytes = 2;
    for (let index = 0; index < fields.length; index += 2) {
      headerBytes += Buffer.byteLength(fields[index]!, "latin1") + Buffer.byteLength(fields[index + 1]!, "latin1") + 4;
      if (headerBytes > retainedHeaderByteLimit) fail(431, "headers_too_large");
    }
  });
  function query(request: FastifyRequest) {
    const params = new URL(request.url, "http://localhost").searchParams;
    for (const key of params.keys())
      if (!allowed.has(key) || params.getAll(key).length !== 1) fail(400, "invalid_query");
    const actorSelection = actorFilterSchema.safeParse(params.get("actors") ?? "all");
    if (!actorSelection.success) fail(400, "invalid_actor_filter");
    const item = (key: string) => {
      const value = params.get(key);
      if (value !== null && !identifier.test(value)) fail(400, "invalid_query");
      return value;
    };
    const date = (key: string) => {
      const value = params.get(key);
      if (value === null) return null;
      if (
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value
      )
        fail(400, "invalid_date");
      return value;
    };
    const compare = item("compare");
    const compareStart = date("compareStart"),
      compareEnd = date("compareEnd");
    if (
      (compareStart === null) !== (compareEnd === null) ||
      (compareStart !== null &&
        compareEnd !== null &&
        (compareStart >= compareEnd || Date.parse(compareEnd) - Date.parse(compareStart) > 366 * 86400000)) ||
      (compare === null && (compareStart !== null || compareEnd !== null))
    )
      fail(400, "invalid_comparison_window");
    if (
      compare !== null &&
      !["/api/v1/boards", "/api/v1/exports"].includes(new URL(request.url, "http://localhost").pathname)
    )
      fail(400, "unsupported_filter");
    let scope: PublicScope = {
      organization: item("organization") ?? "Pick-Your-AI",
      repository: item("repository"),
      workstream: item("workstream"),
      start: date("start"),
      end: date("end"),
    };
    if (
      (scope.start === null) !== (scope.end === null) ||
      (scope.start !== null &&
        scope.end !== null &&
        (scope.start >= scope.end || Date.parse(scope.end) - Date.parse(scope.start) > 366 * 86400000))
    )
      fail(400, "invalid_date_window");
    try {
      scope = canonicalPublicScope({
        ...scope,
        ...(params.has("context") ? { context: params.get("context") } : {}),
        ...(params.has("project") ? { projects: params.get("project")!.split(",") } : {}),
        ...(params.has("role") ? { roles: params.get("role")!.split(",") } : {}),
      });
    } catch {
      fail(400, "invalid_public_scope");
    }
    const limitText = params.get("limit") ?? "50";
    if (!/^[1-9]\d{0,2}$/.test(limitText) || Number(limitText) > 100) fail(400, "invalid_limit");
    const metric = item("metric");
    if (metric !== null && !registry.metrics.some((entry) => entry.id === metric)) fail(400, "unknown_metric");
    const category = item("category");
    if (category !== null && !registry.metrics.some((entry) => entry.id === category)) fail(400, "unknown_category");
    const search = params.get("search");
    if (search !== null && !/^[A-Za-z0-9-]{1,39}$/.test(search)) fail(400, "invalid_search");
    const format = params.get("format") ?? "json";
    if (!["json", "csv"].includes(format)) fail(400, "unsupported_export_format");
    return {
      actors: actorSelection.data,
      comparison:
        compare === null
          ? null
          : {
              snapshotId: compare,
              scope: { ...scope, ...(compareStart === null ? {} : { start: compareStart, end: compareEnd }) },
            },
      scope,
      limit: Number(limitText),
      metric,
      category,
      search: search?.toLowerCase() ?? null,
      snapshot: item("snapshot"),
      cursor: params.get("cursor"),
      format,
    };
  }
  async function boundedRead<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (reads >= maxReads) fail(429, "read_budget_exceeded");
    reads++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Keep a slot occupied until the provider actually settles, even if it ignores cancellation.
    const pending = Promise.resolve()
      .then(() => read(controller.signal))
      .finally(() => {
        reads--;
      });
    try {
      const result = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new PublicReadError(503, "snapshot_source_timeout"));
          }, timeout);
        }),
      ]);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
  function project(result: PublicRead | null, scope: PublicScope, pin: string | null, actors: ActorFilter): PublicRead {
    if (result === null) fail(pin ? 410 : 503, pin ? "snapshot_expired_refetch" : "public_snapshot_unavailable");
    const projected = projectRead(result, scope, pin, registry.metrics);
    if (projected.selected.snapshot.metricDefinitionVersion !== registry.policy_version)
      fail(409, "metric_definition_unavailable");
    const knownMetrics = new Set(registry.metrics.map((metric) => metric.id));
    if (
      projected.selected.rows.some((row) => !knownMetrics.has(row.result.metricId)) ||
      [...projected.selected.evidence, ...(projected.selected.portfolioEvidence ?? [])].some((entry) =>
        entry.contribution.metricIds.some((metricId) => !knownMetrics.has(metricId)),
      )
    )
      fail(409, "metric_definition_unavailable");
    return filterPublicActors(projected, actors);
  }
  async function load(
    scope: PublicScope,
    pin: string | null,
    actors: ActorFilter,
    health = false,
  ): Promise<PublicRead> {
    return project(
      await boundedRead((signal) => {
        // Providers receive detached inputs. Their normalization/mutation cannot
        // replace the request that later authorizes the returned projection.
        const selectedScope = canonicalPublicScope(scope);
        return health && source.readHealth
          ? source.readHealth(selectedScope, pin, signal)
          : source.read(selectedScope, pin, signal);
      }),
      scope,
      pin,
      actors,
    );
  }
  async function loadBoard(
    q: ReturnType<typeof query>,
    pin: string | null,
  ): Promise<{ read: PublicRead; compared?: ComparedRanks }> {
    if (!q.comparison) return { read: await load(q.scope, pin, q.actors) };
    if (!source.readComparison) {
      const read = await load(q.scope, pin, q.actors);
      return { read, compared: comparePublishedRanks(read, null, null, null, q.metric!) };
    }
    const paired = await boundedRead((signal) =>
      source.readComparison!(
        canonicalPublicScope(q.scope),
        pin,
        { snapshotId: q.comparison!.snapshotId, scope: canonicalPublicScope(q.comparison!.scope) },
        signal,
      ),
    );
    if (paired?.previous) {
      const authority = (read: PublicRead) =>
        JSON.stringify([
          read.controls.version,
          [...read.controls.suppressedActorIds].sort(),
          [...read.controls.suppressedArtifactIds].sort(),
          [...read.controls.revokedSnapshotIds].sort(),
          readSuppressedContributionIds(read.controls).sort(),
        ]);
      // A broken provider pairing must not publish earlier current rows under a
      // different privacy authority merely because movement can be withheld.
      if (authority(paired.current) !== authority(paired.previous)) fail(503, "public_comparison_authority_changed");
    }
    const read = project(paired?.current ?? null, q.scope, pin, q.actors);
    let previous: PublicRead | null = null;
    if (paired?.previous) {
      try {
        previous = project(paired.previous, q.comparison.scope, q.comparison.snapshotId, q.actors);
      } catch {
        /* Unavailable/revoked history cannot expose old rows or change current totals. */
      }
    }
    return {
      read,
      compared: comparePublishedRanks(
        read,
        previous,
        paired?.currentHistory ?? null,
        paired?.previousHistory ?? null,
        q.metric!,
      ),
    };
  }
  function send(
    request: FastifyRequest,
    reply: FastifyReply,
    body: unknown,
    contentType = "application/json; charset=utf-8",
    cacheControl = "public, max-age=0, must-revalidate",
  ) {
    const serialized = typeof body === "string" ? body : JSON.stringify(body);
    const etag = `"${createHash("sha256").update(serialized).digest("hex")}"`;
    reply
      .header("ETag", etag)
      .header("Cache-Control", cacheControl)
      .header("X-Content-Type-Options", "nosniff")
      .type(contentType);
    const matches = request.headers["if-none-match"]?.split(",").map((value) => value.trim().replace(/^W\//, ""));
    if (matches?.includes(etag) || matches?.includes("*")) return reply.code(304).send();
    return reply.send(serialized);
  }
  function meta(read: PublicRead) {
    const snapshot = read.selected.snapshot;
    const extendedScope = read.selected.scope.schemaVersion !== undefined;
    return {
      schemaVersion:
        read.selected.scope.schemaVersion === publicRoleScopeSchemaVersion
          ? "public-read/v3"
          : extendedScope
            ? "public-read/v2"
            : snapshot.schemaVersion,
      ...(extendedScope ? { snapshotSchemaVersion: snapshot.schemaVersion } : {}),
      snapshotId: snapshot.snapshotId,
      revision: snapshot.revision,
      generatedAt: snapshot.generatedAt,
      metricDefinitionVersion: snapshot.metricDefinitionVersion,
      computationVersion: snapshot.computationVersion,
      policyVersion: read.controls.version,
      head: read.head,
      scope: read.selected.scope,
      actorFilter: read.actorFilter ?? "all",
      coverage: snapshot.coverage,
      disabledMetrics: read.selected.disabledMetrics ?? [],
      methodology: read.selected.methodology ?? [],
    };
  }
  function sign(value: string) {
    return createHmac("sha256", secret).update(value).digest("base64url");
  }
  // New Project sets can be longer than a cursor. Keep legacy cursor bytes while
  // binding each complete versioned scope to a fixed-size collision-resistant key.
  function cursorScope(scope: PublicScope) {
    return scope.schemaVersion !== undefined
      ? [scope.schemaVersion, createHash("sha256").update(publicScopeKey(scope)).digest("hex")]
      : scope;
  }
  function decodeCursor(cursor: string): {
    pin: string;
    policy: string;
    offset: number;
    binding: string;
    expires: number;
  } {
    if (cursor.length > 2048) fail(400, "invalid_cursor");
    const [payload, signature, extra] = cursor.split(".");
    if (!payload || !signature || extra || !/^[\w-]+$/.test(payload) || !/^[\w-]+$/.test(signature))
      fail(400, "invalid_cursor");
    const actual = Buffer.from(signature);
    const expected = Buffer.from(sign(payload));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail(410, "cursor_expired_refetch");
    try {
      const value = JSON.parse(Buffer.from(payload, "base64url").toString()) as ReturnType<typeof decodeCursor>;
      if (
        !identifier.test(value.pin) ||
        !identifier.test(value.policy) ||
        !Number.isSafeInteger(value.offset) ||
        value.offset < 1 ||
        value.offset > 20000 ||
        typeof value.binding !== "string" ||
        !Number.isFinite(value.expires)
      )
        fail(400, "invalid_cursor");
      if (value.expires < now()) fail(410, "cursor_expired_refetch");
      return value;
    } catch (error) {
      if (error instanceof PublicReadError) throw error;
      return fail(400, "invalid_cursor");
    }
  }
  function ranked(read: PublicRead, metric: string) {
    const actors = new Map(read.selected.actors.map((actor) => [actor.actorId, actor.actor]));
    const policy = read.selected.ranking.find((entry) => entry.metricId === metric);
    const direction = policy?.direction;
    const ordered = read.selected.rows
      .filter((row) => row.result.metricId === metric)
      .sort((a, b) => {
        const av = a.result.value,
          bv = b.result.value;
        const delta =
          av === undefined
            ? bv === undefined
              ? 0
              : 1
            : bv === undefined
              ? -1
              : direction === "ascending"
                ? av - bv
                : bv - av;
        return (policy?.rank === false ? 0 : delta) || (a.actorId < b.actorId ? -1 : a.actorId > b.actorId ? 1 : 0);
      });
    let rank = 0;
    return ordered.map((row, index) => {
      if (index === 0 || row.result.value !== ordered[index - 1]?.result.value) rank++;
      return {
        rank: policy?.rank === false || row.result.value === undefined ? null : rank,
        actorId: row.actorId,
        actor: actors.get(row.actorId),
        result: row.result,
        evidenceIds: row.evidenceIds,
        ...(row.pending === undefined ? {} : { pending: row.pending }),
      };
    });
  }
  function page<T>(
    items: T[],
    q: ReturnType<typeof query>,
    read: PublicRead,
    cursor: ReturnType<typeof decodeCursor> | null,
    binding: string,
    byteLimit = Infinity,
  ) {
    if (cursor && cursor.policy !== read.controls.version) fail(410, "cursor_policy_changed_refetch");
    const offset = cursor?.offset ?? 0;
    const entries: T[] = [];
    let bytes = 0;
    for (const item of items.slice(offset, offset + q.limit)) {
      const size = byteLimit === Infinity ? 0 : Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > byteLimit) {
        if (!entries.length) fail(503, "activity_item_too_large");
        break;
      }
      entries.push(item);
      bytes += size;
    }
    const nextOffset = offset + entries.length;
    let nextCursor: string | null = null;
    if (nextOffset < items.length) {
      const value = Buffer.from(
        JSON.stringify({
          pin: read.selected.snapshot.snapshotId,
          policy: read.controls.version,
          offset: nextOffset,
          binding,
          expires: Math.floor(now() / 300000) * 300000 + 900000,
        }),
      ).toString("base64url");
      nextCursor = `${value}.${sign(value)}`;
    }
    return { entries, nextCursor };
  }
  function boundCursor(q: ReturnType<typeof query>, binding: string) {
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (cursor && (cursor.binding !== binding || (q.snapshot !== null && q.snapshot !== cursor.pin)))
      fail(400, "cursor_scope_mismatch");
    return cursor;
  }
  function categories(entries: PortfolioEvidence[]) {
    return [...new Set(entries.flatMap((entry) => entry.contribution.metricIds))].sort().map((metricId) => {
      const matching = entries.filter((entry) => entry.contribution.metricIds.includes(metricId));
      const count = (state: PortfolioEvidence["activityState"]) =>
        new Set(matching.filter((entry) => entry.activityState === state).map((entry) => entry.contribution.artifactId))
          .size;
      return {
        metricId,
        observed: count("observed"),
        pending: count("pending"),
        accepted: count("accepted"),
        unknown: count("unknown"),
      };
    });
  }
  const definition = (metric: string) => registry.metrics.find((entry) => entry.id === metric)!;
  async function board(request: FastifyRequest, reply: FastifyReply, exporting: boolean) {
    const q = query(request);
    if (q.metric === null) fail(400, "metric_required");
    if (q.category || q.search) fail(400, "unsupported_filter");
    const binding = JSON.stringify([
      "board",
      cursorScope(q.scope),
      q.metric,
      q.limit,
      q.actors,
      ...(q.comparison ? [{ ...q.comparison, scope: cursorScope(q.comparison.scope) }] : []),
    ]);
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (cursor && (cursor.binding !== binding || (q.snapshot !== null && q.snapshot !== cursor.pin)))
      fail(400, "cursor_scope_mismatch");
    const { read, compared } = await loadBoard(q, cursor?.pin ?? q.snapshot);
    const disabled = read.selected.disabledMetrics?.find((entry) => entry.id === q.metric);
    if (disabled)
      return reply
        .code(503)
        .header("Cache-Control", "no-store")
        .send({ ...meta(read), error: "metric_disabled", metric: disabled });
    if (cursor && cursor.policy !== read.controls.version) fail(410, "cursor_policy_changed_refetch");
    const offset = cursor?.offset ?? 0;
    const movement = new Map(compared?.movement.map((row) => [row.actorId, row]) ?? []);
    const rows = ranked(read, q.metric).map((row) => ({
      ...row,
      ...(compared ? { movement: movement.get(row.actorId)! } : {}),
    }));
    const page = rows.slice(offset, offset + q.limit);
    const nextOffset = offset + page.length;
    let nextCursor: string | null = null;
    if (nextOffset < rows.length) {
      const value = Buffer.from(
        JSON.stringify({
          pin: read.selected.snapshot.snapshotId,
          policy: read.controls.version,
          offset: nextOffset,
          binding,
          expires: Math.floor(now() / 300000) * 300000 + 900000,
        }),
      ).toString("base64url");
      nextCursor = `${value}.${sign(value)}`;
    }
    const share = new URLSearchParams({
      actors: q.actors,
      organization: q.scope.organization,
      metric: q.metric,
      snapshot: read.selected.snapshot.snapshotId,
    });
    for (const [key, value] of Object.entries(publicScopeParameters(q.scope)))
      if (key !== "organization") share.set(key, value);
    if (q.comparison) {
      share.set("compare", q.comparison.snapshotId);
      if (q.comparison.scope.start !== null && q.comparison.scope.end !== null) {
        share.set("compareStart", q.comparison.scope.start);
        share.set("compareEnd", q.comparison.scope.end);
      }
    }
    const body = {
      ...meta(read),
      ...(compared ? { comparison: compared.comparison } : {}),
      metric: definition(q.metric),
      ranking: read.selected.ranking.find((entry) => entry.metricId === q.metric) ?? null,
      diagnostics:
        read.selected.diagnostics?.filter(
          (entry) => entry.metricId === q.metric && page.some((row) => row.actorId === entry.actorId),
        ) ?? [],
      rows: page,
      totalRows: rows.length,
      nextCursor,
      shareUrl: `/api/v1/boards?${share.toString()}`,
    };
    if (exporting) {
      const exported = renderPublicExport(read, body, q.format as "json" | "csv");
      // Downloads cannot be cached past a current-source authorization decision.
      reply
        .header("Content-Disposition", `attachment; filename="leaderboard.${q.format}"`)
        .header("X-Leaderboard-Actor-Filter", q.actors)
        .header("Content-Security-Policy", "sandbox; default-src 'none'");
      return send(request, reply, exported.body, exported.contentType, "no-store");
    }
    return send(request, reply, body);
  }
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/api/v1", async (_request, reply) =>
    reply.header("Cache-Control", "no-store").send({
      status: options.source ? "configured" : "scaffold",
      revision: null,
      message: options.source
        ? "Read the selected scope health endpoint for publication status."
        : "No approved public snapshot source is configured.",
      endpoints: [
        "metrics",
        "boards",
        "contributors",
        "contributors/:actorId",
        "cards/:actorId",
        "cards/:actorId/image",
        "contributors/:actorId/achievements",
        "activity",
        "activity/:groupId",
        "evidence/:contributionId",
        "health",
        "updates",
        "exports",
      ],
    }),
  );
  app.get("/api/v1/metrics", async (request, reply) => {
    query(request);
    return send(request, reply, registry);
  });
  app.get("/api/v1/boards", (request, reply) => board(request, reply, false));
  app.get("/api/v1/exports", (request, reply) => board(request, reply, true));
  async function activity(request: FastifyRequest, reply: FastifyReply, groupId: string | null) {
    const q = query(request);
    if (q.metric) fail(400, "use_category_filter");
    if (q.search || q.format !== "json") fail(400, "unsupported_filter");
    if (groupId !== null && !/^[a-f0-9]{64}$/.test(groupId)) fail(400, "invalid_activity_group");
    const binding = JSON.stringify([
      "activity",
      activityGroupingVersion,
      groupId,
      cursorScope(q.scope),
      q.category,
      q.limit,
      q.actors,
    ]);
    const cursor = boundCursor(q, binding);
    const read = await load(q.scope, cursor?.pin ?? q.snapshot, q.actors);
    if (cursor && cursor.policy !== read.controls.version) fail(410, "cursor_policy_changed_refetch");
    const disabled = read.selected.disabledMetrics?.find((entry) => entry.id === q.category);
    if (disabled)
      return reply
        .code(503)
        .header("Cache-Control", "no-store")
        .send({ ...meta(read), error: "metric_disabled", metric: disabled });
    const index = activityIndex(read, q.category);
    const common = {
      ...meta(read),
      category: q.category,
      groupingVersion: activityGroupingVersion,
      previewLimit: activityPreviewLimit,
      correctionHistory: "per_proof",
    };
    let body: unknown;
    if (groupId === null) {
      const { entries: groups, nextCursor } = page(index.groups, q, read, cursor, binding, activityPageByteLimit);
      body = { ...common, groups, totalGroups: index.groups.length, nextCursor };
    } else {
      const group = index.groups.find((entry) => entry.groupId === groupId);
      if (!group) fail(404, "activity_group_unavailable");
      const { entries: proofs, nextCursor } = page(
        index.proofs.get(groupId)!,
        q,
        read,
        cursor,
        binding,
        activityPageByteLimit,
      );
      body = { ...common, group, proofs, nextCursor };
    }
    // Metadata is bounded separately by the source contract. Never exceed the public client byte ceiling.
    if (Buffer.byteLength(JSON.stringify(body)) > 1_500_000) fail(503, "activity_response_too_large");
    return send(request, reply, body);
  }
  app.get("/api/v1/activity", (request, reply) => activity(request, reply, null));
  app.get<{ Params: { groupId: string } }>("/api/v1/activity/:groupId", (request, reply) =>
    activity(request, reply, request.params.groupId),
  );
  app.get("/api/v1/contributors", async (request, reply) => {
    const q = query(request);
    if (q.metric) fail(400, "use_category_filter");
    const binding = JSON.stringify(["directory", cursorScope(q.scope), q.search, q.category, q.limit, q.actors]);
    const cursor = boundCursor(q, binding);
    const read = await load(q.scope, cursor?.pin ?? q.snapshot, q.actors);
    const entries = portfolio(read, q.category);
    const byActor = new Map<string, PortfolioEvidence[]>();
    for (const entry of entries) {
      const id = entry.contribution.actorId!;
      const values = byActor.get(id) ?? [];
      values.push(entry);
      byActor.set(id, values);
    }
    const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const actors = read.selected.actors
      .filter(
        (entry) => byActor.has(entry.actorId) && (!q.search || entry.actor.login?.toLowerCase().includes(q.search)),
      )
      .sort(
        (a, b) =>
          compare(a.actor.login?.toLowerCase() ?? "", b.actor.login?.toLowerCase() ?? "") ||
          compare(a.actorId, b.actorId),
      );
    const { entries: selectedActors, nextCursor } = page(actors, q, read, cursor, binding);
    return send(request, reply, {
      ...meta(read),
      search: q.search,
      category: q.category,
      contributors: selectedActors.map((entry) => {
        const contributions = byActor.get(entry.actorId)!;
        return {
          actorId: entry.actorId,
          actor: entry.actor,
          categories: categories(contributions),
          roles: [...new Set(contributions.flatMap((item) => item.contribution.roles))].sort(),
          evidenceCount: contributions.length,
        };
      }),
      totalContributors: actors.length,
      nextCursor,
    });
  });
  app.get<{ Params: { actorId: string } }>("/api/v1/contributors/:actorId", async (request, reply) => {
    const q = query(request);
    if (q.search || (q.category && q.metric && q.category !== q.metric)) fail(400, "unsupported_filter");
    const category = q.category ?? q.metric;
    const binding = JSON.stringify([
      "profile",
      request.params.actorId,
      cursorScope(q.scope),
      category,
      q.limit,
      q.actors,
    ]);
    const cursor = boundCursor(q, binding);
    const read = await load(q.scope, cursor?.pin ?? q.snapshot, q.actors);
    const actor = read.selected.actors.find((actor) => actor.actorId === request.params.actorId);
    if (!actor) fail(404, "profile_unavailable");
    const rows = read.selected.rows.filter(
      (row) => row.actorId === actor.actorId && (category === null || row.result.metricId === category),
    );
    const evidence = portfolio(read, category)
      .filter((entry) => entry.contribution.actorId === actor.actorId)
      .sort(
        (a, b) =>
          newest(a.occurredAt, b.occurredAt) ||
          (a.contribution.contributionId < b.contribution.contributionId
            ? -1
            : a.contribution.contributionId > b.contribution.contributionId
              ? 1
              : 0),
      );
    const { entries: timeline, nextCursor } = page(evidence, q, read, cursor, binding);
    return send(request, reply, {
      ...meta(read),
      actor: actor.actor,
      actorId: actor.actorId,
      category,
      results: rows.map((row) => row.result),
      activitySummary: publicParticipation(read, actor.actorId, category),
      categories: categories(evidence),
      diagnostics:
        read.selected.diagnostics?.filter(
          (entry) => entry.actorId === actor.actorId && rows.some((row) => row.result.metricId === entry.metricId),
        ) ?? [],
      roleBreakdown: [...new Set(evidence.flatMap((entry) => entry.contribution.roles))].sort().map((role) => ({
        role,
        contributions: evidence.filter((entry) => entry.contribution.roles.includes(role)).length,
      })),
      timeline,
      nextCursor,
      timelineTruncated: nextCursor !== null,
      evidenceCount: evidence.length,
      evidenceIds: timeline.map((entry) => entry.contribution.contributionId),
    });
  });
  async function participationHistory(
    request: FastifyRequest,
    reply: FastifyReply,
    actorId: string,
    proof: { historyKey: string; contributionId: string } | null,
  ) {
    const q = query(request);
    const params = new URL(request.url, "http://localhost").searchParams;
    if (
      !identifier.test(actorId) ||
      actorId === "." ||
      actorId === ".." ||
      ["metric", "search", "cursor", "limit", "format"].some((key) => params.has(key))
    )
      fail(400, "invalid_history_query");
    if (
      proof &&
      (!/^[a-f0-9]{64}$/.test(proof.historyKey) ||
        !identifier.test(proof.contributionId) ||
        proof.contributionId === "." ||
        proof.contributionId === "..")
    )
      fail(400, "invalid_history_query");
    const historyReader = source.readParticipationHistory?.bind(source);
    const paired = historyReader
      ? validateParticipationHistoryRead(
          await boundedRead((signal) => historyReader(canonicalPublicScope(q.scope), q.snapshot, actorId, signal)),
        )
      : null;
    const read = historyReader
      ? project(paired?.current ?? null, q.scope, q.snapshot, q.actors)
      : await load(q.scope, q.snapshot, q.actors);
    if (!read.selected.actors.some((entry) => entry.actorId === actorId)) fail(404, "contributor_unavailable");
    const history = publicOrganizationHistory(paired, read, actorId, q.category, registry.metrics);
    if (
      proof &&
      (history.state !== "known" ||
        history.historyKey !== proof.historyKey ||
        history.firstProof.proof.contributionId !== proof.contributionId)
    )
      fail(409, "participation_history_changed_refetch");
    const body = { ...meta(read), actorId, profileCategory: q.category, history };
    if (Buffer.byteLength(JSON.stringify(body)) > participationHistoryResponseByteLimit)
      fail(503, "participation_history_response_too_large");
    return send(request, reply, body, "application/json; charset=utf-8", "no-store");
  }
  app.get<{ Params: { actorId: string } }>("/api/v1/contributors/:actorId/participation-history", (request, reply) =>
    participationHistory(request, reply, request.params.actorId, null),
  );
  app.get<{ Params: { actorId: string; historyKey: string; contributionId: string } }>(
    "/api/v1/contributors/:actorId/participation-history/:historyKey/evidence/:contributionId",
    (request, reply) =>
      participationHistory(request, reply, request.params.actorId, {
        historyKey: request.params.historyKey,
        contributionId: request.params.contributionId,
      }),
  );
  app.get<{ Params: { actorId: string } }>("/api/v1/contributors/:actorId/achievements", async (request, reply) => {
    const q = query(request);
    const version = options.approvedAchievementRuleVersion;
    const milestones = version === achievementMilestoneVersion;
    if (q.metric || (!milestones && (q.category || q.cursor)) || q.search || q.format !== "json")
      fail(400, "unsupported_filter");
    if (version !== ACHIEVEMENT_RULE_VERSION && !milestones) fail(503, "achievement_policy_unapproved");
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const read = await load(q.scope, cursor?.pin ?? q.snapshot, q.actors);
    if (!read.selected.actors.some((actor) => actor.actorId === request.params.actorId))
      fail(404, "profile_unavailable");
    if (milestones) {
      if (read.selected.disabledMetrics?.some((entry) => entry.id === q.category)) fail(503, "metric_disabled");
      const result = acceptedMilestones(read, request.params.actorId, q.category, registry.metrics);
      // Bind paging to the actual current projection as well as the existing policy/snapshot
      // token. Changed privacy, names or proof cannot silently replace an earlier page cohort.
      const digest = createHash("sha256");
      for (const entry of [...result.achievements, ...result.coContributions])
        digest.update(JSON.stringify(entry)).update("\n");
      const binding = JSON.stringify([
        "achievement-milestones/v2",
        request.params.actorId,
        cursorScope(q.scope),
        q.category,
        q.limit,
        q.actors,
        digest.digest("hex"),
      ]);
      boundCursor(q, binding);
      const { entries, nextCursor } = page(result.coContributions, q, read, cursor, binding, 1_000_000);
      const extension = achievementMilestonesPageSchema.parse({
        ...result,
        coContributions: entries,
        totalCoContributions: result.coContributions.length,
        pageSize: q.limit,
        nextCursor,
      });
      const body = { ...meta(read), actorId: request.params.actorId, ...extension };
      if (Buffer.byteLength(JSON.stringify(body)) > 1_500_000) fail(503, "achievement_response_too_large");
      return send(request, reply, body, "application/json; charset=utf-8", "no-store");
    }
    return send(
      request,
      reply,
      {
        ...meta(read),
        actorId: request.params.actorId,
        ruleVersion: ACHIEVEMENT_RULE_VERSION,
        achievements: acceptedAchievements(read, request.params.actorId),
      },
      "application/json; charset=utf-8",
      "no-store",
    );
  });
  app.get<{ Params: { actorId: string } }>("/api/v1/cards/:actorId/image", async (request, reply) => {
    const q = query(request);
    if (!q.metric || q.category || q.cursor || q.search || q.format !== "json")
      fail(400, "card_requires_single_metric");
    const metric = registry.metrics.find((entry) => entry.id === q.metric);
    if (!metric) fail(404, "metric_unavailable");
    const read = await load(q.scope, q.snapshot, q.actors);
    const svg = renderContributorCardImage(read, request.params.actorId, metric, q.snapshot !== null);
    reply
      .header("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'none'")
      .header("Referrer-Policy", "no-referrer");
    return send(request, reply, svg, "image/svg+xml; charset=utf-8", "no-store");
  });
  app.get<{ Params: { actorId: string } }>("/api/v1/cards/:actorId", async (request, reply) => {
    const q = query(request);
    if (!q.metric || q.category || q.cursor || q.search || q.format !== "json")
      fail(400, "card_requires_single_metric");
    const metric = registry.metrics.find((entry) => entry.id === q.metric);
    if (!metric) fail(404, "metric_unavailable");
    const read = await load(q.scope, q.snapshot, q.actors);
    const html = renderContributorCard(read, request.params.actorId, metric, q.snapshot !== null);
    reply
      .header(
        "Content-Security-Policy",
        "default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
      )
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "SAMEORIGIN");
    return send(request, reply, html, "text/html; charset=utf-8", "no-store");
  });
  app.get<{ Params: { contributionId: string } }>("/api/v1/evidence/:contributionId", async (request, reply) => {
    const q = query(request);
    const read = await load(q.scope, q.snapshot, q.actors);
    const evidence = [
      ...(read.selected.pendingEvidence ?? []),
      ...(read.selected.portfolioEvidence ?? []),
      ...read.selected.evidence,
    ].find((entry) => entry.contribution.contributionId === request.params.contributionId);
    if (!evidence) fail(404, "evidence_unavailable");
    return send(request, reply, { ...meta(read), ...evidence });
  });
  app.get("/api/v1/health", async (request, reply) => {
    const q = query(request);
    const read = await load(q.scope, q.snapshot, q.actors, true);
    const sources = read.selected.snapshot.coverage.map((coverage) => {
      const current = coverage.source.startsWith("github_")
        ? (read.currentSourceHealth?.find((entry) => entry.scopeId === coverage.scopeId) ?? null)
        : null;
      return {
        source: coverage.source,
        scopeId: coverage.scopeId,
        state: coverage.state,
        lastSuccessfulSync: coverage.lastSuccessfulSync,
        reconciledThrough: coverage.sourceWatermark,
        webhookLagSeconds: current?.webhookLagSeconds ?? null,
        currentCollection:
          current === null
            ? null
            : { scope: "repository", webhookLagBasis: "oldest_unfinished_retained_receipt", ...current },
        degradedCapabilities: coverage.permissionsMissing,
        collectionState: coverage.sourceErrors.length
          ? "degraded"
          : coverage.state === "complete"
            ? "covered"
            : "unknown",
      };
    });
    const stale =
      sources.length === 0 ||
      sources.some(
        (entry) =>
          entry.state !== "complete" ||
          entry.lastSuccessfulSync === null ||
          entry.reconciledThrough === null ||
          now() < Date.parse(entry.lastSuccessfulSync) ||
          now() - Date.parse(entry.lastSuccessfulSync) > 300000 ||
          entry.collectionState === "degraded" ||
          (entry.currentCollection !== null &&
            (!["reconciled", "no_activity_in_window"].includes(entry.currentCollection.state) ||
              entry.currentCollection.webhookState === "degraded" ||
              (entry.currentCollection.webhookLagSeconds !== null && entry.currentCollection.webhookLagSeconds > 300) ||
              [entry.currentCollection.lastSuccessfulSync, entry.currentCollection.reconciledThrough].some(
                (value) => value === null || now() < Date.parse(value) || now() - Date.parse(value) > 300000,
              ))),
      );
    return send(request, reply, {
      ...meta(read),
      status: stale ? "stale_or_degraded" : "recently_reconciled",
      serviceVersion: options.serviceVersion ?? "0.1.0",
      lastSuccessfulPublish: read.head,
      sources,
    });
  });
  app.get("/api/v1/updates", async (request, reply) => {
    if (streams >= maxStreams) fail(429, "stream_budget_exceeded");
    const q = query(request);
    if (q.snapshot || q.cursor) fail(400, "updates_require_current_scope");
    streams++;
    try {
      const read = await load(q.scope, null, q.actors);
      const eventId = `${read.head.revision}:${read.head.snapshotId}:${read.controls.version}${q.actors === "all" ? "" : `:${q.actors}`}`;
      const prior = request.headers["last-event-id"];
      if (prior !== undefined && (typeof prior !== "string" || prior.length > 512 || !/^[A-Za-z0-9_.:-]+$/.test(prior)))
        fail(400, "invalid_event_cursor");
      const payload = {
        ...meta(read),
        action: "refetch_snapshot",
        pollingUrl: `/api/v1/health?${new URLSearchParams({
          actors: q.actors,
          ...publicScopeParameters(q.scope),
        }).toString()}`,
      };
      const event =
        prior === eventId
          ? `: heartbeat ${read.head.revision}\n\n`
          : `id: ${eventId}\nevent: ${prior ? "reset" : "snapshot"}\ndata: ${JSON.stringify(payload)}\n\n`;
      reply
        .header("Cache-Control", "no-store")
        .header("X-Accel-Buffering", "no")
        .header("X-Content-Type-Options", "nosniff")
        .type("text/event-stream; charset=utf-8");
      return reply.send(`retry: 3000\n\n${event}`);
    } finally {
      streams--;
    }
  });
  return app;
}
