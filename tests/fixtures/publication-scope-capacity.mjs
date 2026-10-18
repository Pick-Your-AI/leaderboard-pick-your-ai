import { createHash } from "node:crypto";

/** Synthetic maximum-size scope examples. Contract tests independently verify
 * these fixed versioned keys against the production canonical serializer. */
export function maximalPublicationScopeCases() {
  const base = {
    organization: "SYNTHETIC_ORGANIZATION".padEnd(200, "O"),
    repository: "SYNTHETIC_REPOSITORY".padEnd(200, "R"),
    workstream: "SYNTHETIC_WORKSTREAM".padEnd(200, "W"),
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-02-01T00:00:00.000Z",
  };
  const projects = Array.from({ length: 100 }, (_, index) =>
    createHash("sha512").update(`SYNTHETIC_PROJECT_${index}`).digest("hex"),
  ).sort();
  const roles = [
    "author",
    "coauthor",
    "reviewer",
    "merger",
    "triager",
    "reporter",
    "resolver",
    "nominator",
    "automation",
  ].sort();
  const legacy = [base.organization, base.repository, base.workstream, base.start, base.end];
  return [
    { name: "legacy", scope: { ...base }, scopeKey: JSON.stringify(legacy) },
    {
      name: "v2",
      scope: { ...base, schemaVersion: "public-scope/v2", context: "current", projects: [...projects] },
      scopeKey: JSON.stringify([...legacy, ["public-scope/v2", "current", projects]]),
    },
    {
      name: "v3",
      scope: { ...base, schemaVersion: "public-scope/v3", context: "current", projects: [...projects], roles },
      scopeKey: JSON.stringify([...legacy, ["public-scope/v3", "current", projects, roles]]),
    },
  ];
}
