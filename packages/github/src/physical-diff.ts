import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type FileClass = "source" | "tests" | "docs" | "generated" | "vendor" | "lock" | "binary" | "imported";
export interface PhysicalFile {
  path: string;
  previousPath?: string;
  additions: number;
  deletions: number;
  binary?: boolean;
  formattingOnly?: boolean;
  imported?: boolean;
  generated?: boolean;
}
export interface PinnedPhysicalDiff {
  before: string;
  after: string;
  complete: boolean;
  files: readonly PhysicalFile[];
}
export interface ClassifiedPhysicalDiff {
  complete: boolean;
  additions: number | null;
  deletions: number | null;
  changed: number | null;
  net: number | null;
  filesChanged: number | null;
  rawAdditions: number;
  rawDeletions: number;
  files: Array<PhysicalFile & { classification: FileClass; eligible: boolean; reason: string | null }>;
  reasons: string[];
}
export function pinnedSha(value: string): boolean {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}
function path(value: string): void {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === ".." || part === ".") ||
    /[\x00-\x1f]/.test(value)
  )
    throw new Error("Unsafe diff path");
}
export function classifyFile(file: PhysicalFile): FileClass {
  path(file.path);
  if (file.previousPath) path(file.previousPath);
  const name = file.path.toLowerCase();
  if (file.binary) return "binary";
  if (file.imported) return "imported";
  if (
    file.generated ||
    /(?:^|\/)(?:generated|dist|build|coverage|\.next)(?:\/|$)|\.(?:min\.js|map|generated\.[^.]+)$/.test(name)
  )
    return "generated";
  if (/(?:^|\/)(?:vendor|node_modules|third_party|third-party)(?:\/|$)/.test(name)) return "vendor";
  if (
    /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|cargo\.lock|poetry\.lock|gemfile\.lock|composer\.lock)$/.test(
      name,
    )
  )
    return "lock";
  if (/(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)|\.(?:test|spec)\.[^.]+$/.test(name)) return "tests";
  if (/(?:^|\/)(?:docs?|documentation)(?:\/|$)|\.(?:md|mdx|rst|adoc)$/.test(name)) return "docs";
  return "source";
}
/** Physical text changes only; neither effort, authorship percentage nor quality. */
export function classifyPhysicalDiff(diff: PinnedPhysicalDiff): ClassifiedPhysicalDiff {
  if (!pinnedSha(diff.before) || !pinnedSha(diff.after) || diff.before === diff.after)
    throw new Error("Distinct pinned before/after SHAs are required");
  const complete = diff.complete;
  if (typeof complete !== "boolean") throw new Error("Boolean diff completeness proof is required");
  if (diff.files.length > 10_000) throw new Error("Diff exceeds file bound");
  const seen = new Set<string>();
  const files = diff.files.map((file) => {
    if (seen.has(file.path)) throw new Error("Repeated diff path");
    seen.add(file.path);
    if (![file.additions, file.deletions].every((value) => Number.isSafeInteger(value) && value >= 0))
      throw new Error("Invalid physical line count");
    const classification = classifyFile(file);
    const reason = ["source", "tests", "docs"].includes(classification)
      ? file.formattingOnly
        ? "formatting_only"
        : null
      : classification;
    return { ...file, classification, eligible: reason === null, reason };
  });
  const rawAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const rawDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const eligible = files.filter((file) => file.eligible);
  const additions = eligible.reduce((sum, file) => sum + file.additions, 0);
  const deletions = eligible.reduce((sum, file) => sum + file.deletions, 0);
  if (
    ![rawAdditions, rawDeletions, additions, deletions, additions + deletions, rawAdditions + rawDeletions].every(
      Number.isSafeInteger,
    )
  )
    throw new Error("Physical aggregate exceeds safe integer bound");
  return {
    complete,
    additions: complete ? additions : null,
    deletions: complete ? deletions : null,
    changed: complete ? additions + deletions : null,
    net: complete ? additions - deletions : null,
    filesChanged: complete ? eligible.length : null,
    rawAdditions,
    rawDeletions,
    files,
    reasons: complete ? [] : ["incomplete_or_truncated_diff"],
  };
}

function numstat(bytes: string): PhysicalFile[] {
  const tokens = bytes.split("\0");
  const files: PhysicalFile[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!token) continue;
    const parts = token.split("\t");
    if (parts.length < 3) throw new Error("Malformed bounded Git diff output");
    const additions = parts.shift()!,
      deletions = parts.shift()!;
    let name = parts.join("\t");
    let previousPath: string | undefined;
    if (!name) {
      previousPath = tokens[++index];
      name = tokens[++index] ?? "";
    }
    const binary = additions === "-" || deletions === "-";
    if (!binary && (!/^\d+$/.test(additions) || !/^\d+$/.test(deletions))) throw new Error("Malformed Git line count");
    files.push({
      path: name,
      ...(previousPath ? { previousPath } : {}),
      additions: binary ? 0 : Number(additions),
      deletions: binary ? 0 : Number(deletions),
      binary,
    });
  }
  return files;
}

/** Local, bounded read-only fallback: no shell, external diff, textconv, fetch or checkout. */
export async function readPinnedGitDiff(options: {
  repositoryPath: string;
  before: string;
  after: string;
  maxFiles?: number;
  maxBytes?: number;
  timeoutMs?: number;
  importedPaths?: readonly string[];
  generatedPaths?: readonly string[];
}): Promise<PinnedPhysicalDiff> {
  if (!pinnedSha(options.before) || !pinnedSha(options.after)) throw new Error("Pinned SHAs required for Git fallback");
  const maxFiles = options.maxFiles ?? 3000,
    maxBytes = options.maxBytes ?? 8 * 1024 * 1024,
    timeout = options.timeoutMs ?? 30_000;
  if (![maxFiles, maxBytes, timeout].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new Error("Invalid Git resource bounds");
  const exec = promisify(execFile);
  const argumentsFor = (ignoreWhitespace: boolean) => [
    "--no-optional-locks",
    "-C",
    options.repositoryPath,
    "-c",
    "core.hooksPath=",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--numstat",
    "-z",
    "--find-renames",
    ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
    options.before,
    options.after,
    "--",
  ];
  // Sequential execution limits subprocess resource use and keeps failure atomic.
  const raw = await exec("git", argumentsFor(false), {
    timeout,
    maxBuffer: maxBytes,
    encoding: "utf8",
    windowsHide: true,
  });
  const substantive = await exec("git", argumentsFor(true), {
    timeout,
    maxBuffer: maxBytes,
    encoding: "utf8",
    windowsHide: true,
  });
  const files = numstat(raw.stdout),
    nonWhitespace = new Map(numstat(substantive.stdout).map((file) => [file.path, file]));
  if (files.length > maxFiles) return { before: options.before, after: options.after, complete: false, files: [] };
  return {
    before: options.before,
    after: options.after,
    complete: true,
    files: files.map((file) => ({
      ...file,
      formattingOnly:
        !file.binary &&
        file.additions + file.deletions > 0 &&
        (nonWhitespace.get(file.path)?.additions ?? 0) + (nonWhitespace.get(file.path)?.deletions ?? 0) === 0,
      imported: options.importedPaths?.includes(file.path) ?? false,
      generated: options.generatedPaths?.includes(file.path) ?? false,
    })),
  };
}
