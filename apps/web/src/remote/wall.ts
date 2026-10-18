import { getLeadMetrics } from "@pick-your-ai/metrics";
import type { MetricRegistry } from "@pick-your-ai/contracts";
import {
  board,
  catalog,
  directory,
  health,
  parameters,
  portfolioParameters,
  request,
  selection,
  uiHref,
  ReadFailure,
  type Board,
  type Directory,
  type Health,
  type Metadata,
  type Selection,
} from "./client.ts";
import { verifyBoardDefinition } from "./registry.ts";

export type WallMode = "frozen" | "single" | "cycle";
export type WallFormat = "landscape" | "portrait" | "overlay";
export interface WallOptions {
  mode: WallMode | null;
  boards: string[] | null;
  interval: number;
  format: WallFormat;
}
export interface WallPosition {
  stage: number;
  cursor: string | null;
  page: number;
  previousRank: number | null;
}
export const firstWallPage = (): WallPosition => ({ stage: 0, cursor: null, page: 1, previousRank: null });
const wallKeys = ["mode", "boards", "interval", "format"];

/** Display choices stay local. Only the existing exact source scope goes to the API. */
export function readWallQuery(query: string): { selected: Selection; options: WallOptions } {
  const params = new URLSearchParams(query);
  for (const key of wallKeys) if (params.getAll(key).length > 1) throw new ReadFailure(400, "duplicate_wall_option");
  const mode = params.get("mode");
  if (mode !== null && !["frozen", "single", "cycle"].includes(mode)) throw new ReadFailure(400, "invalid_wall_mode");
  const format = params.get("format") ?? "landscape";
  if (!["landscape", "portrait", "overlay"].includes(format)) throw new ReadFailure(400, "invalid_wall_format");
  const interval = params.get("interval") ?? "30";
  if (!/^\d{2,3}$/.test(interval) || Number(interval) < 20 || Number(interval) > 300)
    throw new ReadFailure(400, "invalid_wall_interval");
  const boards = params.has("boards") ? params.get("boards")!.split(",") : null;
  if (
    boards &&
    (boards.length > 10 ||
      new Set(boards).size !== boards.length ||
      boards.some((id) => !/^[A-Za-z0-9_.:-]{1,200}$/.test(id)))
  )
    throw new ReadFailure(400, "invalid_wall_boards");
  if (mode && mode !== "cycle" && boards && boards.length !== 1)
    throw new ReadFailure(400, "single_wall_board_required");
  for (const key of wallKeys) params.delete(key);
  const selected = selection(params.toString());
  if (
    selected.cursor ||
    selected.proof ||
    selected.search ||
    selected.category ||
    selected.catalogQuery ||
    selected.department
  )
    throw new ReadFailure(400, "unsupported_wall_filter");
  if (mode === "frozen" && !selected.snapshot) throw new ReadFailure(400, "frozen_wall_requires_snapshot");
  if (mode && mode !== "frozen" && selected.snapshot) throw new ReadFailure(400, "live_wall_cannot_pin_snapshot");
  return {
    selected,
    options: { mode: mode as WallMode | null, boards, interval: Number(interval), format: format as WallFormat },
  };
}

export function wallBoards(registry: MetricRegistry, requested: string[] | null): string[] {
  const allowed = getLeadMetrics("wall", registry).map((metric) => metric.id);
  const selected = requested ?? allowed.slice(0, 1);
  if (!selected.length || selected.some((id) => !allowed.includes(id)))
    throw new ReadFailure(400, "unsupported_registry_wall_board");
  return selected;
}

export function wallHref(selected: Selection, options: WallOptions, snapshot: string | null): string {
  const params = new URLSearchParams(
    uiHref("/live", selected, { snapshot: options.mode === "frozen" ? snapshot : null }).split("?")[1],
  );
  if (options.mode) params.set("mode", options.mode);
  if (options.boards) params.set("boards", options.boards.join(","));
  params.set("interval", String(options.interval));
  params.set("format", options.format);
  return `/live?${params}`;
}

export type WallContent = { kind: "board"; value: Board } | { kind: "contributors"; value: Directory };
export interface WallFrame {
  registry: MetricRegistry;
  health: Health;
  boards: string[];
  content: WallContent;
  position: WallPosition;
}
export const wallPageSize = (format: WallFormat) => (format === "overlay" ? 3 : 6);

function samePublication(first: Metadata, second: Metadata): void {
  for (const key of [
    "snapshotId",
    "revision",
    "generatedAt",
    "metricDefinitionVersion",
    "computationVersion",
    "policyVersion",
  ] as const)
    if (first[key] !== second[key]) throw new ReadFailure(409, "wall_publication_changed_during_read");
  for (const key of ["snapshotId", "revision", "publishedAt"] as const)
    if (first.head[key] !== second.head[key]) throw new ReadFailure(409, "wall_publication_changed_during_read");
}

export async function readWallFrame(
  base: string,
  selected: Selection,
  options: WallOptions,
  position: WallPosition,
  pin: string | null,
  signal: AbortSignal,
): Promise<WallFrame> {
  const exact = {
    ...selected,
    snapshot: selected.snapshot ?? pin,
    cursor: null,
    limit: String(wallPageSize(options.format)),
  };
  const [registry, status] = await Promise.all([
    request(base, "metrics", new URLSearchParams(), signal).then(catalog),
    request(base, "health", parameters(exact), signal).then((value) => health(value, exact)),
  ]);
  if (registry.policy_version !== status.metricDefinitionVersion)
    throw new ReadFailure(409, "metric_definition_unavailable");
  const boards = wallBoards(registry, options.boards);
  const stages = options.mode === "cycle" ? boards.length + 1 : 1;
  if (position.stage < 0 || position.stage >= stages) throw new ReadFailure(400, "invalid_wall_page");
  const page = { ...exact, snapshot: status.snapshotId, cursor: position.cursor };
  let content: WallContent;
  if (position.stage === boards.length) {
    const value = directory(await request(base, "contributors", portfolioParameters(page, true), signal), page);
    if (value.contributors.length > Number(page.limit)) throw new ReadFailure(502, "invalid_wall_page");
    content = { kind: "contributors", value };
  } else {
    page.metric = boards[position.stage]!;
    const value = board(
      await request(base, "boards", parameters(page, { board: true, cursor: page.cursor }), signal),
      page,
    );
    verifyBoardDefinition(registry, value.metric);
    if (value.rows.length > Number(page.limit)) throw new ReadFailure(502, "invalid_wall_page");
    content = { kind: "board", value };
  }
  samePublication(status, content.value);
  if (content.value.nextCursor && content.value.nextCursor === position.cursor)
    throw new ReadFailure(502, "repeated_wall_cursor");
  return { registry, health: status, boards, content, position };
}

/** Visit every bounded page, including the unranked roll, before adopting a newer snapshot. */
export function nextWallPage(frame: WallFrame, mode: WallMode): { position: WallPosition; pin: string } {
  const { position, content } = frame;
  if (content.value.nextCursor)
    return {
      position: {
        ...position,
        cursor: content.value.nextCursor,
        page: position.page + 1,
        previousRank: content.kind === "board" ? (content.value.rows.at(-1)?.rank ?? null) : null,
      },
      pin: content.value.snapshotId,
    };
  const stages = mode === "cycle" ? frame.boards.length + 1 : 1;
  if (position.stage + 1 < stages)
    return { position: { ...firstWallPage(), stage: position.stage + 1 }, pin: content.value.snapshotId };
  return {
    position: firstWallPage(),
    pin: mode === "frozen" ? content.value.snapshotId : frame.health.head.snapshotId,
  };
}
