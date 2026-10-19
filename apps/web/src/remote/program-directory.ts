import { canonicalPublicScope } from "@pick-your-ai/contracts";
import { ReadFailure, uiHref, type Selection } from "./client.ts";
import { parseExportJSON } from "./export-json.ts";

export interface ProgramRecord {
  id: string;
  name: string;
  projectId: string;
  projectNumber: number;
  repositoryIds: readonly string[];
  fieldNames: readonly string[];
}
export interface ProgramDirectory {
  schemaVersion: "program-directory/v1";
  version: string;
  organization: string;
  observedOn: string;
  sourceUrl: string;
  repositories: readonly { id: string; name: string }[];
  programs: readonly ProgramRecord[];
}
const maximumBytes = 131_072;
const invalid = (): never => {
  throw new ReadFailure(502, "invalid_program_directory");
};
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || Object.keys(result).some((key) => !keys.includes(key)))
    return invalid();
  return result;
}
function text(value: unknown, maximum = 160): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
    return invalid();
  return value;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  return value;
}
function unique<T>(values: readonly T[]): void {
  if (new Set(values).size !== values.length) invalid();
}
function repositoryId(value: unknown): string {
  const id = text(value, 20);
  if (!/^[1-9][0-9]{0,19}$/.test(id)) return invalid();
  return id;
}

/** Display metadata is detached and bounded; it never approves a source or a materialization. */
export function programDirectory(value: unknown, organization: string): ProgramDirectory {
  const data = object(value, [
    "schemaVersion",
    "version",
    "organization",
    "observedOn",
    "sourceUrl",
    "repositories",
    "programs",
  ]);
  if (data.schemaVersion !== "program-directory/v1" || data.organization !== organization) return invalid();
  const org = text(data.organization, 39);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(org)) return invalid();
  const version = text(data.version, 100);
  const observedOn = text(data.observedOn, 10);
  if (
    !/^\d{4}-\d\d-\d\d$/.test(observedOn) ||
    !Number.isFinite(Date.parse(`${observedOn}T00:00:00.000Z`)) ||
    new Date(`${observedOn}T00:00:00.000Z`).toISOString().slice(0, 10) !== observedOn
  )
    return invalid();
  const sourceUrl = text(data.sourceUrl, 400);
  // A checked-in immutable record is an audit reference, not fetched source authorization.
  if (
    !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/blob\/[a-f0-9]{40}\/planning\/[A-Za-z0-9_.-]+\.json$/.test(
      sourceUrl,
    )
  )
    return invalid();
  const repositories = list(data.repositories, 100).map((entry) => {
    const row = object(entry, ["id", "name"]);
    const name = text(row.name, 100);
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === "." || name === "..") return invalid();
    return Object.freeze({ id: repositoryId(row.id), name });
  });
  unique(repositories.map((row) => row.id));
  unique(repositories.map((row) => row.name.toLowerCase()));
  const repositoryIds = new Set(repositories.map((row) => row.id));
  const programs = list(data.programs, 20).map((entry) => {
    const row = object(entry, ["id", "name", "projectId", "projectNumber", "repositoryIds", "fieldNames"]);
    const id = text(row.id, 64);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) return invalid();
    const projectId = text(row.projectId, 128);
    if (!/^[A-Za-z0-9_=.:-]+$/.test(projectId)) return invalid();
    if (!Number.isSafeInteger(row.projectNumber) || Number(row.projectNumber) < 1) return invalid();
    const refs = list(row.repositoryIds, 100).map(repositoryId);
    if (refs.some((ref) => !repositoryIds.has(ref))) return invalid();
    unique(refs);
    const fieldNames = list(row.fieldNames, 64).map((field) => text(field, 100));
    unique(fieldNames);
    return Object.freeze({
      id,
      name: text(row.name),
      projectId,
      projectNumber: Number(row.projectNumber),
      repositoryIds: Object.freeze(refs),
      fieldNames: Object.freeze(fieldNames),
    });
  });
  unique(programs.map((row) => row.id));
  unique(programs.map((row) => row.projectId));
  unique(programs.map((row) => row.projectNumber));
  return Object.freeze({
    schemaVersion: "program-directory/v1",
    version,
    organization: org,
    observedOn,
    sourceUrl,
    repositories: Object.freeze(repositories),
    programs: Object.freeze(programs),
  });
}

export function parseProgramDirectory(raw: string, organization: string): ProgramDirectory {
  try {
    if (new TextEncoder().encode(raw).byteLength > maximumBytes) return invalid();
    return programDirectory(parseExportJSON(raw), organization);
  } catch {
    return invalid();
  }
}

/** Bind the fixed filename to this deployment before an asset request can begin. */
export function programDirectoryAsset(base: string, origin: string): string {
  try {
    const current = new URL(origin);
    const deployment = new URL(base, current);
    if (
      current.origin !== origin ||
      !["https:", "http:"].includes(current.protocol) ||
      deployment.origin !== current.origin ||
      deployment.username ||
      deployment.password ||
      deployment.search ||
      deployment.hash ||
      !deployment.pathname.endsWith("/")
    )
      return invalid();
    const asset = new URL("program-directory.json", deployment);
    if (asset.origin !== current.origin || asset.pathname !== `${deployment.pathname}program-directory.json`)
      return invalid();
    return asset.href;
  } catch {
    return invalid();
  }
}

/** The asset always comes from this deployed frontend, never a URL supplied by the directory. */
export async function readProgramDirectory(
  assetUrl: string,
  organization: string,
  signal: AbortSignal,
): Promise<ProgramDirectory> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  requestSignal.throwIfAborted();
  const response = await fetch(assetUrl, {
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal: requestSignal,
    headers: { accept: "application/json" },
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => {
    void reader?.cancel().catch(() => {});
  };
  try {
    requestSignal.throwIfAborted();
    if (
      !response.ok ||
      response.redirected ||
      response.type === "opaqueredirect" ||
      !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "")
    )
      return invalid();
    reader = response.body?.getReader();
    if (!reader) return invalid();
    requestSignal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const chunk = await reader.read();
      requestSignal.throwIfAborted();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumBytes) return invalid();
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return parseProgramDirectory(new TextDecoder("utf-8", { fatal: true }).decode(bytes), organization);
  } finally {
    requestSignal.removeEventListener("abort", cancel);
    if (reader) {
      cancel();
      reader.releaseLock();
    } else void response.body?.cancel().catch(() => {});
  }
}

export function programRoute(path: string): string | null | false {
  if (path === "/programs") return null;
  if (!path.startsWith("/programs/")) return false;
  const id = path.slice("/programs/".length);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 64) throw new ReadFailure(400, "invalid_program_route");
  return id;
}

/** A program is a new exact scope, never a sum or a reuse of another view's pin. */
export function programSelection(
  selected: Selection,
  directory: ProgramDirectory,
  programs: readonly ProgramRecord[],
  context: "event" | "current",
  repository: string | null = null,
): Selection {
  if (
    selected.organization !== directory.organization ||
    programs.some((row) => !directory.programs.includes(row)) ||
    (repository !== null && !programs.some((row) => row.repositoryIds.includes(repository)))
  )
    return invalid();
  const next = { ...selected };
  delete next.schemaVersion;
  delete next.context;
  delete next.projects;
  delete next.roles;
  delete next.compare;
  delete next.compareStart;
  delete next.compareEnd;
  return {
    ...next,
    ...canonicalPublicScope({
      organization: directory.organization,
      repository,
      workstream: null,
      start: selected.start,
      end: selected.end,
      context,
      projects: programs.map((row) => row.projectId),
      roles: selected.roles ?? [],
    }),
    snapshot: null,
    cursor: null,
    proof: null,
    search: null,
    category: null,
    catalogQuery: null,
    department: null,
  };
}

export function programHref(
  path: string,
  selected: Selection,
  directory: ProgramDirectory,
  programs: readonly ProgramRecord[],
  context: "event" | "current",
  repository: string | null = null,
  department: string | null = null,
): string {
  return uiHref(path, { ...programSelection(selected, directory, programs, context, repository), department });
}
