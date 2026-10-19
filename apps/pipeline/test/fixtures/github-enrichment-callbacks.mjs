import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { createGithubEnrichmentSource } from "../../src/github-enrichment-source.mjs";

export const scenarios = [
  "valid synchronous result",
  "ordinary thrown error",
  "returned rejected promise",
  "thrown rejected promise",
  "returned nested rejection",
  "thrown nested rejection",
  "returned cyclic rejection",
  "thrown cyclic rejection",
  "returned foreign thenable",
  "returned throwing then getter",
  "returned native promise with shadowed then",
  "thrown native promise with shadowed then",
];
export const cases = [
  ...["clock", "authorization"].flatMap((boundary) => scenarios.map((scenario) => ({ boundary, scenario }))),
  ...[
    "valid synchronous result",
    "returned rejected promise",
    "thrown rejected promise",
    "returned native promise with shadowed then",
    "returned native promise with shadowed rest",
    "returned native promise with view methods",
  ].map((scenario) => ({
    boundary: "repository binding",
    scenario,
  })),
];

const time = Date.parse("2026-10-19T12:00:00Z");
const revision = "a".repeat(40);
const slug = "synthetic-org/synthetic-repo";
const publicRoot = `https://github.com/${slug}`;
const apiRoot = `/repos/${slug}`;

function value(scenario, counters, view) {
  const error = () => new Error("synthetic host rejection");
  const rejected = () => Promise.reject(error());
  if (scenario.includes("nested rejection")) return Promise.reject(rejected());
  if (scenario.includes("cyclic rejection")) {
    let reject;
    const promise = new Promise((_, no) => {
      reject = no;
    });
    reject(promise);
    return promise;
  }
  if (scenario === "returned foreign thenable")
    return {
      then(resolve) {
        counters.foreignThenCalls += 1;
        resolve();
      },
    };
  if (scenario === "returned throwing then getter")
    return Object.defineProperty({}, "then", {
      get() {
        counters.foreignGetters += 1;
        throw error();
      },
    });
  if (scenario === "returned native promise with shadowed rest")
    return Object.defineProperty(rejected(), "rest", {
      get() {
        counters.foreignGetters += 1;
        throw error();
      },
    });
  if (scenario === "returned native promise with view methods")
    return Object.assign(Promise.resolve(), { then: undefined, rest: view.rest });
  if (scenario.includes("shadowed then"))
    return Object.defineProperty(rejected(), "then", {
      get() {
        counters.foreignGetters += 1;
        throw error();
      },
    });
  return rejected();
}

async function observe({ boundary, scenario }) {
  const counters = { callbackCalls: 0, providerReads: 0, outcomeReads: 0, foreignGetters: 0, foreignThenCalls: 0 };
  const unhandledRejections = [];
  const listener = (reason) => {
    unhandledRejections.push({
      nativePromise: types.isPromise(reason),
      message: reason instanceof Error ? reason.message : null,
    });
  };
  process.on("unhandledRejection", listener);
  const repository = { id: 2, private: false, full_name: slug, visibility: "public", html_url: publicRoot };
  const payload = {
    node_id: "SYNTHETIC_COMMIT",
    sha: revision,
    html_url: `${publicRoot}/commit/${revision}`,
    stats: { additions: 9, deletions: 2, total: 11 },
  };
  const view = {
    async rest(_source, endpoint) {
      counters.providerReads += 1;
      if (endpoint === apiRoot) return repository;
      if (endpoint === `${apiRoot}/commits/${revision}`) return payload;
      throw new Error("unexpected synthetic endpoint");
    },
  };
  const callback = () => {
    counters.callbackCalls += 1;
    if (scenario === "valid synchronous result")
      return boundary === "clock" ? time : boundary === "authorization" ? undefined : view;
    if (scenario === "ordinary thrown error") throw new Error("synthetic synchronous host failure");
    const result = value(scenario, counters, view);
    if (scenario.startsWith("thrown ")) throw result;
    return result;
  };
  const options = {
    client: { forRepository: () => view },
    sourceId: "installation:1",
    policyVersion: "synthetic-outcome-v1",
    repositories: [{ id: 2, slug, installationId: 1 }],
    now: () => time,
    readOutcome: async ({ binding }) => {
      counters.outcomeReads += 1;
      return {
        schemaVersion: "github-enrichment-outcome/v1",
        ...binding,
        recordId: "synthetic-decision-1",
        evidenceId: "synthetic-evidence-1",
        acceptedOutcome: true,
        recordedAt: time - 1000,
        validUntil: time + 60000,
      };
    },
  };
  const input = {
    repositoryId: 2,
    family: "commits",
    fact: {
      subjectId: "SYNTHETIC_COMMIT",
      sourceRevision: revision,
      sourceUrl: payload.html_url,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "present",
    },
    signal: new AbortController().signal,
    assertAuthorized: () => undefined,
  };
  if (boundary === "clock") options.now = callback;
  else if (boundary === "authorization") input.assertAuthorized = callback;
  else options.client.forRepository = callback;
  let result = null;
  let error = null;
  try {
    result = await createGithubEnrichmentSource(options).readMetadata(input);
  } catch (failure) {
    error = { name: failure.name, message: failure.message };
  }
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", listener);
  return { boundary, scenario, result, error, counters, unhandledRejections };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const observations = [];
  for (const selected of cases) observations.push(await observe(selected));
  console.log(JSON.stringify(observations));
}
