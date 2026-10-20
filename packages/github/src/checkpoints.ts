import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Private collector state. Implementations must durably replace an entire value. */
export interface CheckpointStore {
  load(key: string): Promise<unknown | undefined>;
  save(key: string, value: unknown): Promise<void>;
  /** An explicit repository boundary; the transport's source/quota identity is not a repository. */
  forRepository?(repositoryId: number): RepositoryCheckpointStore;
}

export interface RepositoryCheckpointRetirementBinding {
  operationId: string;
  policyId: string;
  authorizationId: string;
}

export interface RepositoryCheckpointRetirementReceipt extends RepositoryCheckpointRetirementBinding {
  schemaVersion: "repository-checkpoint-retirement/v1";
  repositoryId: number;
  checkpointPayloadsRemoved: true;
  legacyUnscopedPayloads: "outside_scope";
}

export interface RepositoryCheckpointRetirementPreflight extends RepositoryCheckpointRetirementBinding {
  schemaVersion: "repository-checkpoint-retirement-preflight/v1";
  repositoryId: number;
  state: "active" | "fenced";
}

export interface RepositoryCheckpointStore extends CheckpointStore {
  readonly repositoryId: number;
  assertActive(): Promise<void>;
  /** Optional capability for protected drivers; existing scoped clients remain compatible. */
  preflightRetirement?(
    binding: RepositoryCheckpointRetirementBinding,
  ): Promise<RepositoryCheckpointRetirementPreflight>;
  /** The protected host must authorize this exact binding before calling retirement. */
  retire(binding: RepositoryCheckpointRetirementBinding): Promise<RepositoryCheckpointRetirementReceipt>;
}

export interface FileCheckpointOptions {
  /** Maximum UTF-8 bytes per persisted JSON record; defaults to 64 MiB. */
  maxBytes?: number;
  /** Durable private authority, outside cache payloads and their restore/expiry operations. */
  tombstoneDirectory?: string;
}

export type FileCheckpointStoreOptions = FileCheckpointOptions;

export class CheckpointLimitError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Checkpoint exceeds its ${maxBytes}-byte limit`);
    this.name = "CheckpointLimitError";
  }
}

interface RepositoryCheckpointTombstone extends RepositoryCheckpointRetirementBinding {
  schemaVersion: "repository-checkpoint-tombstone/v1";
  repositoryId: number;
}

// One process may construct several clients/stores for the same private directory.
// All of their operations on a repository share the same serialization boundary.
const repositoryOperations = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = repositoryOperations.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  repositoryOperations.set(key, current);
  return current.finally(() => {
    if (repositoryOperations.get(key) === current) repositoryOperations.delete(key);
  });
}

function binding(value: RepositoryCheckpointRetirementBinding): RepositoryCheckpointRetirementBinding {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !["operationId", "policyId", "authorizationId"].every(
      (key) =>
        Object.hasOwn(value, key) &&
        typeof value[key as keyof RepositoryCheckpointRetirementBinding] === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value[key as keyof RepositoryCheckpointRetirementBinding]),
    )
  )
    throw new Error("invalid_repository_checkpoint_retirement");
  return { operationId: value.operationId, policyId: value.policyId, authorizationId: value.authorizationId };
}

export { binding as validateRepositoryCheckpointRetirementBinding };

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function disjoint(left: string, right: string): void {
  if (contains(left, right) || contains(right, left))
    throw new Error("Repository checkpoint authority must be outside the cache directory");
}

function canonicalLocation(path: string): string {
  // The cache need not exist yet. Resolve its closest existing ancestor so two
  // configured paths through ancestor aliases still share one repository queue.
  for (let ancestor = path; ; ancestor = dirname(ancestor)) {
    try {
      return resolve(realpathSync(ancestor), relative(ancestor, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || ancestor === dirname(ancestor)) throw error;
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function privateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await privateDirectory(dirname(path));
      await mkdir(path, { mode: 0o700 }).catch((next: NodeJS.ErrnoException) => {
        if (next.code !== "EEXIST") throw next;
      });
    } else if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  // Create each ancestor durably before its child. Retrying a stopped mkdir also
  // syncs its parent, rather than treating an existing entry as already durable.
  await syncDirectory(path);
  await syncDirectory(dirname(path));
}

async function directoryIfPresent(path: string): Promise<boolean> {
  try {
    const status = await lstat(path);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("Unsafe checkpoint directory");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function encode(value: unknown, maxBytes: number): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Checkpoint must be JSON serializable");
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw new CheckpointLimitError(maxBytes);
  return serialized;
}

async function replace(target: string, serialized: string): Promise<void> {
  await privateDirectory(dirname(target));
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(serialized);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
    await syncDirectory(dirname(target));
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Single-process private store. Shared processes require a transactional checkpoint backend. */
export class FileCheckpointStore implements CheckpointStore {
  private readonly directory: string;
  private readonly tombstoneDirectory: string;
  private readonly repositoryLockRoot: string;
  private readonly maxBytes: number;

  constructor(directory: string, options: FileCheckpointOptions = {}) {
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    // Leave one exactly representable byte for the overflow probe.
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes >= Number.MAX_SAFE_INTEGER)
      throw new RangeError("maxBytes must be a positive safe integer below Number.MAX_SAFE_INTEGER");
    this.directory = resolve(directory);
    this.tombstoneDirectory = resolve(options.tombstoneDirectory ?? `${this.directory}.repository-retention`);
    disjoint(this.directory, this.tombstoneDirectory);
    this.repositoryLockRoot = canonicalLocation(this.directory);
  }

  private path(key: string): string {
    return join(this.directory, `${createHash("sha256").update(key).digest("hex")}.json`);
  }

  async load(key: string): Promise<unknown | undefined> {
    return this.loadPath(this.path(key), false);
  }

  private async loadPath(target: string, scoped: boolean): Promise<unknown | undefined> {
    let file;
    try {
      file = await open(
        target,
        scoped ? constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) : "r",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Checkpoint is unreadable or corrupt", { cause: error });
    }
    try {
      if (scoped && !(await file.stat()).isFile()) throw new Error();
      // Bound bytes consumed from this descriptor, even if its file grows or
      // the pathname is replaced. Neither a separate stat nor readFile is sufficient.
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, this.maxBytes + 1));
      const chunks: Buffer[] = [];
      let size = 0;
      for (;;) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, this.maxBytes - size + 1), null);
        if (bytesRead === 0) break;
        size += bytesRead;
        if (size > this.maxBytes) throw new CheckpointLimitError(this.maxBytes);
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
      // Reject damaged bytes without changing the existing JSON/BOM boundary.
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, size));
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof CheckpointLimitError) throw error;
      throw new Error("Checkpoint is unreadable or corrupt", { cause: error });
    } finally {
      await file.close();
    }
  }

  async save(key: string, value: unknown): Promise<void> {
    const serialized = encode(value, this.maxBytes);
    await replace(this.path(key), serialized);
  }

  forRepository(repositoryId: number): RepositoryCheckpointStore {
    if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) throw new Error("invalid_checkpoint_repository");
    const namespace = join(this.directory, "repositories-v1");
    const payload = join(namespace, String(repositoryId));
    const marker = join(this.tombstoneDirectory, `${repositoryId}.json`);
    const queue = <T>(operation: () => Promise<T>) =>
      serialized(join(this.repositoryLockRoot, "repositories-v1", String(repositoryId)), operation);
    const locations = async () => {
      const cacheExists = await directoryIfPresent(this.directory);
      const authorityExists = await directoryIfPresent(this.tombstoneDirectory);
      if (cacheExists && authorityExists)
        disjoint(await realpath(this.directory), await realpath(this.tombstoneDirectory));
    };
    const readMarker = async (): Promise<RepositoryCheckpointTombstone | undefined> => {
      let file;
      try {
        file = await open(marker, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error("Repository checkpoint authority is unreadable or corrupt");
      }
      try {
        if (!(await file.stat()).isFile()) throw new Error();
        const bytes = Buffer.alloc(4097);
        let length = 0;
        while (length < bytes.length) {
          const result = await file.read(bytes, length, bytes.length - length, null);
          if (result.bytesRead === 0) break;
          length += result.bytesRead;
        }
        if (length > 4096) throw new Error();
        const text = bytes.subarray(0, length).toString("utf8");
        const value = JSON.parse(text) as RepositoryCheckpointTombstone;
        if (
          value === null ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.keys(value).length !== 5 ||
          value.schemaVersion !== "repository-checkpoint-tombstone/v1" ||
          value.repositoryId !== repositoryId
        )
          throw new Error();
        const { schemaVersion, repositoryId: storedId, ...storedBinding } = value;
        const checked = { schemaVersion, repositoryId: storedId, ...binding(storedBinding) };
        // Only this store writes the private marker format. Ambiguous duplicate
        // keys or other byte rewrites must not silently select a new authority.
        if (text !== JSON.stringify(checked)) throw new Error();
        return checked;
      } catch {
        throw new Error("Repository checkpoint authority is unreadable or corrupt");
      } finally {
        await file.close();
      }
    };
    const requireBinding = (
      prior: RepositoryCheckpointTombstone | undefined,
      approved: RepositoryCheckpointRetirementBinding,
    ) => {
      if (
        !prior ||
        prior.operationId !== approved.operationId ||
        prior.policyId !== approved.policyId ||
        prior.authorizationId !== approved.authorizationId
      )
        throw new Error("repository_checkpoint_retirement_conflict");
    };
    const assertActive = async () => {
      await locations();
      if (await readMarker()) throw new Error("repository_checkpoint_retired");
      await directoryIfPresent(namespace);
      await directoryIfPresent(payload);
    };
    return Object.freeze({
      repositoryId,
      assertActive: () => queue(assertActive),
      load: (key: string) =>
        queue(async () => {
          await assertActive();
          const target = join(payload, `${createHash("sha256").update(key).digest("hex")}.json`);
          return this.loadPath(target, true);
        }),
      save: (key: string, value: unknown) =>
        queue(async () => {
          await assertActive();
          const serialized = encode(value, this.maxBytes);
          await replace(join(payload, `${createHash("sha256").update(key).digest("hex")}.json`), serialized);
        }),
      preflightRetirement: async (requested: RepositoryCheckpointRetirementBinding) => {
        const approved = binding(requested);
        return queue(async () => {
          await locations();
          const prior = await readMarker();
          if (prior) requireBinding(prior, approved);
          await directoryIfPresent(namespace);
          await directoryIfPresent(payload);
          const result: RepositoryCheckpointRetirementPreflight = {
            schemaVersion: "repository-checkpoint-retirement-preflight/v1",
            repositoryId,
            ...approved,
            state: prior ? "fenced" : "active",
          };
          return result;
        });
      },
      retire: async (requested: RepositoryCheckpointRetirementBinding) => {
        const approved = binding(requested);
        return queue(async () => {
          await locations();
          let prior = await readMarker();
          if (!prior) {
            await privateDirectory(this.tombstoneDirectory);
            await locations();
            const temporary = `${marker}.${randomUUID()}.tmp`;
            try {
              const file = await open(temporary, "wx", 0o600);
              try {
                await file.writeFile(
                  JSON.stringify({ schemaVersion: "repository-checkpoint-tombstone/v1", repositoryId, ...approved }),
                );
                await file.sync();
              } finally {
                await file.close();
              }
              // Atomic create without replacement: a concurrent or existing authority is never overwritten.
              await link(temporary, marker).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "EEXIST") throw error;
              });
            } finally {
              await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
              });
            }
            prior = await readMarker();
          }
          requireBinding(prior, approved);
          // Also sync on retries: a previous attempt may have stopped after linking its marker.
          await syncDirectory(this.tombstoneDirectory);
          await directoryIfPresent(namespace);
          await directoryIfPresent(payload);
          await rm(payload, { recursive: true, force: true });
          if (await directoryIfPresent(namespace)) await syncDirectory(namespace);
          const receipt: RepositoryCheckpointRetirementReceipt = {
            schemaVersion: "repository-checkpoint-retirement/v1",
            repositoryId,
            ...approved,
            checkpointPayloadsRemoved: true,
            legacyUnscopedPayloads: "outside_scope",
          };
          return receipt;
        });
      },
    });
  }
}
