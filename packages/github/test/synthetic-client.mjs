import assert from "node:assert/strict";

/** Test-only transport stub; repository retirement is tested with the real filesystem store. */
export function syntheticRepositoryClient(repositoryId, methods) {
  const client = {
    ...methods,
    forRepository(requestedId) {
      assert.equal(requestedId, repositoryId, "the adapter must bind its verified repository identity");
      return client;
    },
  };
  return client;
}

/** In-memory fixture state, with separate namespaces and no claimed durable retirement support. */
export function syntheticCheckpointStore(legacy = new Map()) {
  const repositories = new Map();
  const access = (values) => ({
    load: async (key) => structuredClone(values.get(key)),
    save: async (key, value) => values.set(key, structuredClone(value)),
  });
  return {
    ...access(legacy),
    forRepository(repositoryId) {
      assert.ok(Number.isSafeInteger(repositoryId) && repositoryId > 0);
      if (!repositories.has(repositoryId)) repositories.set(repositoryId, new Map());
      return {
        repositoryId,
        ...access(repositories.get(repositoryId)),
        assertActive: async () => {},
        retire: async () => {
          throw new Error("Synthetic memory fixture cannot certify durable retirement");
        },
      };
    },
  };
}
