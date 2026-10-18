import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Private collector state. Implementations must durably replace an entire value. */
export interface CheckpointStore {
  load(key: string): Promise<unknown | undefined>;
  save(key: string, value: unknown): Promise<void>;
}

export interface FileCheckpointOptions {
  /** Maximum UTF-8 bytes per persisted JSON record; defaults to 64 MiB. */
  maxBytes?: number;
}

export class CheckpointLimitError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Checkpoint exceeds its ${maxBytes}-byte limit`);
    this.name = "CheckpointLimitError";
  }
}

/** Single-process, single-writer store; use a transactional store for shared workers. */
export class FileCheckpointStore implements CheckpointStore {
  private readonly maxBytes: number;

  constructor(
    private readonly directory: string,
    options: FileCheckpointOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    // Leave one exactly representable byte for the overflow probe.
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes >= Number.MAX_SAFE_INTEGER)
      throw new RangeError("maxBytes must be a positive safe integer below Number.MAX_SAFE_INTEGER");
  }

  private path(key: string): string {
    return join(this.directory, `${createHash("sha256").update(key).digest("hex")}.json`);
  }

  async load(key: string): Promise<unknown | undefined> {
    let file;
    try {
      file = await open(this.path(key), "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Checkpoint is unreadable or corrupt", { cause: error });
    }
    try {
      // Read the same opened file throughout, including an overflow byte. A
      // pathname/stat check followed by readFile could race replacement/growth.
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
      return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
    } catch (error) {
      if (error instanceof CheckpointLimitError) throw error;
      throw new Error("Checkpoint is unreadable or corrupt", { cause: error });
    } finally {
      await file.close();
    }
  }

  async save(key: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("Checkpoint must be JSON serializable");
    // Reject before creating a temporary file or replacing accepted progress.
    if (Buffer.byteLength(serialized, "utf8") > this.maxBytes) throw new CheckpointLimitError(this.maxBytes);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(key);
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
      // Persist the directory entry on systems supporting directory fsync.
      if (process.platform !== "win32") {
        const directory = await open(this.directory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}
