import Fastify from "fastify";

export function createService() {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/api/v1", async () => ({
    status: "scaffold",
    revision: null,
    message: "Public snapshots are not available in this local scaffold."
  }));

  return app;
}
