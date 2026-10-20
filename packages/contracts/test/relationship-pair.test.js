import assert from "node:assert/strict";
import test from "node:test";
import { relationshipPairNormalizationVersion, relationshipPairSchema, relationshipPairKey } from "../dist/index.js";

const pair = (kind = "closing") => ({
  version: relationshipPairNormalizationVersion,
  kind,
  action: kind === "closing" ? "connect" : "reference",
  eventId: "synthetic-event",
  from: { repositoryId: "2", artifactId: "opaque-pr", kind: "pull_request" },
  to: { repositoryId: "3", artifactId: "opaque-issue", kind: "issue" },
});

test("private relationship identity conserves typed closing views and preserves reference direction", () => {
  const closing = pair();
  assert.equal(
    relationshipPairKey(closing),
    relationshipPairKey({ ...closing, from: closing.to, to: closing.from, eventId: "later", action: "disconnect" }),
  );
  const reference = pair("reference");
  assert.notEqual(
    relationshipPairKey(reference),
    relationshipPairKey({ ...reference, from: reference.to, to: reference.from }),
  );
  assert.notEqual(
    relationshipPairKey(reference),
    relationshipPairKey({ ...reference, from: { ...reference.from, repositoryId: "4" } }),
  );
});

test("private relationship admission rejects unknown fields, untyped closing endpoints and mismatched actions", () => {
  const cases = [
    { ...pair(), extra: true },
    { ...pair(), action: "reference" },
    { ...pair("reference"), action: "connect" },
    { ...pair(), to: { ...pair().to, kind: "pull_request" } },
    { ...pair(), to: { ...pair().to, repositoryId: "unknown" } },
    { ...pair(), to: { ...pair().to, artifactId: "opaque-pr" } },
    { ...pair(), from: { ...pair().from, kind: undefined } },
    { ...pair(), eventId: " event " },
    { ...pair(), version: "future" },
  ];
  for (const value of cases) assert.equal(relationshipPairSchema.safeParse(value).success, false);
  assert.equal(relationshipPairSchema.safeParse(pair()).success, true);
});
