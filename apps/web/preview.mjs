import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Resolve the workspace's actual Vite CLI without assuming a hoisted package layout.
const manifest = new URL(import.meta.resolve("vite/package.json"));
const metadata = JSON.parse(await readFile(manifest, "utf8"));
const cli = new URL(metadata.bin.vite, manifest);
process.argv.splice(1, 1, fileURLToPath(cli), "preview");
await import(cli.href);
