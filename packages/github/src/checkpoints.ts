import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Private collector state. Implementations must durably replace an entire value. */
export interface CheckpointStore {
  load(key: string): Promise<unknown | undefined>;
  save(key: string, value: unknown): Promise<void>;
}

/** Single-process, single-writer store; use a transactional store for shared workers. */
export class FileCheckpointStore implements CheckpointStore {
  constructor(private readonly directory: string) {}

  private path(key: string): string {
    return join(this.directory, `${createHash("sha256").update(key).digest("hex")}.json`);
  }

  async load(key: string): Promise<unknown | undefined> {
    try {
      return JSON.parse(await readFile(this.path(key), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Checkpoint is unreadable or corrupt", { cause: error });
    }
  }

  async save(key: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(key);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(value));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, target);
      // Persist the directory entry on systems supporting directory fsync.
      if (process.platform !== "win32") {
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}
