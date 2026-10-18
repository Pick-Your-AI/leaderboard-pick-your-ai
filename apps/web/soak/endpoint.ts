import assert from "node:assert/strict";

/** Separate owned runs may use distinct ports; the preview always stays on loopback. */
export function soakEndpoint(value = process.env.WALL_SOAK_PORT ?? "4277") {
  assert(/^[1-9][0-9]{3,4}$/.test(value), "WALL_SOAK_PORT must be a decimal port from 1024 to 65535");
  const port = Number(value);
  assert(port >= 1024 && port <= 65535, "WALL_SOAK_PORT must be a decimal port from 1024 to 65535");
  return { port, baseURL: `http://127.0.0.1:${port}` };
}
