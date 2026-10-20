import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
export { createGithubCollectionSource } from "./github-source.mjs";
export { createPipeline, migratePipeline } from "./runtime.mjs";
export { migrateDiscussionFeedback } from "./discussion-feedback-store.mjs";
export { PipelineDerivedRetirementStore, migratePipelineDerivedRetirement } from "./derived-retirement.mjs";

/** Dist boundaries are explicit; production defaults always use this checkout. */
export async function loadPipelineComponents(roots = {}) {
  const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const load = (name, path) => import(pathToFileURL(resolve(roots[name] ?? root, path)).href);
  const [ingestion, metrics, contracts, service, controls, controlServer, controlConfiguration, github] =
    await Promise.all([
      load("ingestion", "packages/ingestion/dist/index.js"),
      load("metrics", "packages/metrics/dist/index.js"),
      load("contracts", "packages/contracts/dist/index.js"),
      load("service", "apps/service/dist/app.js"),
      load("controls", "apps/controls/src/store.mjs"),
      load("controls", "apps/controls/src/server.mjs"),
      load("controls", "apps/controls/src/configuration.mjs"),
      load("github", "packages/github/dist/index.js"),
    ]);
  return {
    ingestion,
    metrics,
    contracts,
    service,
    controls: { ...controls, ...controlServer, ...controlConfiguration },
    github,
  };
}
