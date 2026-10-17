import { createService } from "./app.js";

const host = process.env.SERVICE_HOST ?? "127.0.0.1";
const port = Number(process.env.SERVICE_PORT ?? "3001");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("SERVICE_PORT must be an integer between 1 and 65535");
}

const app = createService();
await app.listen({ host, port });
console.info(`Local scaffold service listening on http://${host}:${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().finally(() => process.exit(0));
  });
}
