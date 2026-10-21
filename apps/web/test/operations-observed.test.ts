import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalPublicScope, publicContributionRoles, publicScopeKey } from "@pick-your-ai/contracts";
import { control } from "../src/controls/client.ts";
import {
  checkedOperatorHealth,
  checkedReplayResult,
  operatorPublicationScopeKeyLimit,
  type OperatorReadAuthority,
  type OperatorHealthResponse,
  type OperatorReplayResultResponse,
} from "../src/controls/operations-observed.ts";

const authority: OperatorReadAuthority = {
  repositoryId: 9,
  sourceGeneration: "2",
  policyVersion: "current-policy",
  authorityRevision: "grant-3",
};
const receiptId = "11111111-1111-1111-1111-111111111111",
  deliveryId = "22222222-2222-2222-2222-222222222222";
const expected = { ...authority, receiptId, deliveryId };
const start = "2026-10-18T12:00:00.000Z",
  processed = "2026-10-18T12:00:01.250Z",
  completed = "2026-10-18T12:00:03.500Z";
const asOf = "2026-10-18T12:00:10.000Z",
  recent = "2026-10-18T12:00:08.000Z",
  old = "2026-10-18T11:58:00.000Z";
const scopes = [
  { scopeKey: "repository:9:code", snapshotId: "a".repeat(64), revision: 1 },
  { scopeKey: "organization:all:code", snapshotId: "b".repeat(64), revision: 3 },
];
const clone = <T>(value: T): T => structuredClone(value);
const capacityProjects = Array.from({ length: 100 }, (_, index) =>
  createHash("sha512").update(`SYNTHETIC operator capacity Project ${index}`).digest("hex"),
);
function capacityScope(withRoles: boolean, index = 0) {
  const identifier = (dimension: string) =>
    createHash("sha512")
      .update(`SYNTHETIC operator capacity ${dimension} ${index}`)
      .digest("hex")
      .repeat(2)
      .slice(0, 200);
  return canonicalPublicScope({
    organization: identifier("organization"),
    repository: identifier("repository"),
    workstream: identifier("workstream"),
    start,
    end: asOf,
    context: "current",
    projects: capacityProjects,
    ...(withRoles ? { roles: [...publicContributionRoles] } : {}),
  });
}
function health(): OperatorHealthResponse {
  return {
    ...authority,
    asOf,
    freshnessBudgetSeconds: 60,
    collector: {
      state: "quiet",
      families: [
        {
          family: "issues",
          state: "quiet",
          reason: "completed_empty_window",
          lastAttemptAt: recent,
          lastSuccessAt: recent,
          reconciledThrough: recent,
          items: 0,
          expectedItems: 0,
        },
      ],
    },
    intake: {
      retained: 0,
      pending: 0,
      leased: 0,
      quarantined: 0,
      oldestPendingAt: null,
      queueAgeSeconds: null,
      latestReceivedAt: null,
      latestSourceAt: null,
      lagSeconds: null,
    },
    publication: {
      pending: 0,
      leased: 0,
      quarantined: 0,
      oldestPendingAt: null,
      queueAgeSeconds: null,
      state: "unknown",
      completedAt: null,
      delaySeconds: null,
      policyVersion: null,
      publications: [],
    },
    quota: {
      state: "available",
      scopeKey: "c".repeat(64),
      resources: ["core", "search", "code_search", "graphql", "unknown"].map((resource) => ({
        resource: resource as OperatorHealthResponse["quota"]["resources"][number]["resource"],
        state: "unknown",
        observation: null,
      })),
    },
  };
}
function observedHealth(): OperatorHealthResponse {
  const value = health();
  value.intake = {
    retained: 4,
    pending: 1,
    leased: 1,
    quarantined: 1,
    oldestPendingAt: start,
    queueAgeSeconds: 10,
    latestReceivedAt: processed,
    latestSourceAt: start,
    lagSeconds: 1.25,
  };
  value.publication = {
    pending: 1,
    leased: 0,
    quarantined: 0,
    oldestPendingAt: processed,
    queueAgeSeconds: 8.75,
    state: "verified",
    completedAt: completed,
    delaySeconds: 3.5,
    policyVersion: "publication-policy-before-current",
    publications: clone(scopes),
  };
  value.quota.resources[0] = {
    resource: "core",
    state: "observed",
    observation: {
      observedAt: recent,
      responseStatus: 429,
      limit: 5000,
      remaining: 0,
      used: 5000,
      resetAt: "2026-10-18T13:00:00.000Z",
      retryAfterSeconds: 0,
    },
  };
  return value;
}

test("a recent completed window with a reconciliation gap retains its earlier watermark and unknown state", () => {
  const value = health();
  value.collector.state = "unknown";
  Object.assign(value.collector.families[0]!, {
    state: "unknown",
    reason: "reconciliation_gap",
    reconciledThrough: old,
  });
  assert.deepEqual(checkedOperatorHealth(value, authority), value);
  for (const invalid of [
    { state: "quiet" },
    { lastSuccessAt: null },
    { reconciledThrough: null },
    { lastAttemptAt: old },
  ]) {
    const changed = clone(value);
    Object.assign(changed.collector.families[0]!, invalid);
    assert.throws(() => checkedOperatorHealth(changed, authority));
  }
});
function replay(
  status: OperatorReplayResultResponse["status"] = "published",
  reason?: OperatorReplayResultResponse["reason"],
): OperatorReplayResultResponse {
  const value: OperatorReplayResultResponse = {
    ...expected,
    status,
    reason: reason ?? "verified_publication",
    queuedAt: start,
    processedAt: processed,
    publicationCompletedAt: completed,
    processingDelaySeconds: 1.25,
    publicationDelaySeconds: 3.5,
    replayPolicyVersion: "replay-policy-before-current",
    publicationPolicyVersion: "publication-policy-before-replay",
    publications: clone(scopes),
  };
  if (status !== "published")
    Object.assign(value, {
      publicationCompletedAt: null,
      publicationDelaySeconds: null,
      publicationPolicyVersion: null,
      publications: [],
    });
  return value;
}
function early(
  status: OperatorReplayResultResponse["status"],
  reason: OperatorReplayResultResponse["reason"],
): OperatorReplayResultResponse {
  return { ...replay(status, reason), processedAt: null, processingDelaySeconds: null };
}
function mutate<T>(value: T, change: (draft: T) => void): T {
  const result = clone(value);
  change(result);
  return result;
}
type ObjectPath = Array<string | number>;
function objectPaths(value: unknown, path: ObjectPath = []): ObjectPath[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => objectPaths(item, [...path, index]));
  return [path, ...Object.entries(value).flatMap(([key, child]) => objectPaths(child, [...path, key]))];
}
function at(value: unknown, path: ObjectPath): Record<string, unknown> {
  let result: any = value;
  for (const key of path) result = result[key];
  return result;
}

test("health preserves zero and unavailable observations, including a future quota reset", () => {
  const value = observedHealth(),
    checked = checkedOperatorHealth(value, authority);
  assert.deepEqual(checked, value);
  assert.equal(checked.quota.resources[0]!.observation!.remaining, 0);
  assert.equal(checked.quota.resources[1]!.observation, null);
  assert.equal(checked.publication.policyVersion, "publication-policy-before-current");
  assert.deepEqual(
    checkedOperatorHealth(
      mutate(health(), (x) => {
        x.quota = { state: "unavailable", scopeKey: null, resources: [] };
      }),
      authority,
    ).quota,
    { state: "unavailable", scopeKey: null, resources: [] },
  );
});
test("all authority dimensions and exact receipt/delivery identities bind the read", () => {
  for (const [key, wrong] of Object.entries({
    repositoryId: 10,
    sourceGeneration: "3",
    policyVersion: "new-policy",
    authorityRevision: "revoked-grant",
  })) {
    assert.throws(() => checkedOperatorHealth({ ...health(), [key]: wrong }, authority), key);
    assert.throws(() => checkedReplayResult({ ...replay(), [key]: wrong }, expected), key);
  }
  for (const key of ["receiptId", "deliveryId"] as const)
    assert.throws(
      () => checkedReplayResult({ ...replay(), [key]: "33333333-3333-3333-3333-333333333333" }, expected),
      key,
    );
  for (const change of [
    { repositoryId: 0 },
    { repositoryId: Number.MAX_SAFE_INTEGER + 1 },
    { sourceGeneration: "01" },
    { sourceGeneration: "-1" },
    { sourceGeneration: "1".repeat(20) },
    { authorityRevision: "" },
    { policyVersion: "raw private policy text" },
  ]) {
    assert.throws(() => checkedOperatorHealth({ ...health(), ...change }, { ...authority, ...change }));
    assert.throws(() => checkedReplayResult({ ...replay(), ...change }, { ...expected, ...change }));
  }
});
test("opaque legacy receipt IDs follow the protected route grammar while delivery IDs remain UUIDs", () => {
  for (const receiptId of ["legacy_Receipt-9", "r", "R".repeat(128)]) {
    for (const value of [
      early("unknown", "legacy_unbound"),
      replay("unavailable", "result_binding_unavailable"),
      replay(),
    ]) {
      assert.equal(checkedReplayResult({ ...value, receiptId }, { ...expected, receiptId }).receiptId, receiptId);
    }
    assert.throws(() =>
      checkedReplayResult({ ...replay(), deliveryId: receiptId }, { ...expected, deliveryId: receiptId }),
    );
  }
  for (const receiptId of ["", "a/b", "a.b", "a:b", "a?b", "a#b", " a", "a ", "é", "r".repeat(129)]) {
    assert.throws(() =>
      checkedReplayResult({ ...early("unknown", "legacy_unbound"), receiptId }, { ...expected, receiptId }),
    );
  }
});
test("every health object rejects omitted or extra fields instead of retaining private payloads", () => {
  const value = observedHealth();
  for (const path of objectPaths(value)) {
    const added = clone(value);
    at(added, path).privateRawPayload = "private diagnostic text";
    assert.throws(() => checkedOperatorHealth(added, authority), /Observed operations response changed or is invalid/);
    for (const key of Object.keys(at(value, path))) {
      const missing = clone(value);
      delete at(missing, path)[key];
      assert.throws(() => checkedOperatorHealth(missing, authority), path.join(".") + ":" + key);
    }
  }
});
test("every replay object rejects omitted or extra fields and malformed top-level values", () => {
  const value = replay();
  for (const path of objectPaths(value)) {
    const added = clone(value);
    at(added, path).privateRawPayload = "private diagnostic text";
    assert.throws(() => checkedReplayResult(added, expected));
    for (const key of Object.keys(at(value, path))) {
      const missing = clone(value);
      delete at(missing, path)[key];
      assert.throws(() => checkedReplayResult(missing, expected), path.join(".") + ":" + key);
    }
  }
  for (const invalid of [null, undefined, [], "published", true, 1]) {
    assert.throws(() => checkedOperatorHealth(invalid, authority));
    assert.throws(() => checkedReplayResult(invalid, expected));
  }
});
test("calendar normalization, offsets, missing milliseconds and future observed health times are rejected", () => {
  for (const time of [
    "2026-02-30T12:00:00.000Z",
    "2025-02-29T12:00:00.000Z",
    "2026-10-18T24:00:00.000Z",
    "2026-10-18T12:00:60.000Z",
    "2026-10-18T12:00:00Z",
    "2026-10-18T12:00:00.000+00:00",
    "2026-10-18T12:00:00.0000Z",
    "2026-10-18 12:00:00.000Z",
  ]) {
    assert.throws(() => checkedOperatorHealth({ ...health(), asOf: time }, authority), time);
    assert.throws(() => checkedReplayResult({ ...replay(), queuedAt: time }, expected), time);
  }
  for (const path of [
    ["intake", "oldestPendingAt"],
    ["intake", "latestReceivedAt"],
    ["intake", "latestSourceAt"],
    ["publication", "oldestPendingAt"],
    ["publication", "completedAt"],
    ["collector", "families", 0, "lastAttemptAt"],
    ["collector", "families", 0, "lastSuccessAt"],
    ["collector", "families", 0, "reconciledThrough"],
    ["quota", "resources", 0, "observation", "observedAt"],
  ] as ObjectPath[]) {
    const value = observedHealth();
    at(value, path.slice(0, -1))[path.at(-1)!] = "2026-10-18T12:00:10.001Z";
    assert.throws(() => checkedOperatorHealth(value, authority), path.join("."));
  }
});
test("validators use response clocks and never the browser current time or a network read", (t) => {
  t.mock.method(Date, "now", () => {
    throw Error("browser clock must not be consulted");
  });
  t.mock.method(globalThis, "fetch", () => {
    throw Error("no request belongs in a response validator");
  });
  const futureHealth = JSON.parse(JSON.stringify(observedHealth()).replaceAll("2026-10-18", "2099-10-18"));
  const futureReplay = JSON.parse(JSON.stringify(replay()).replaceAll("2026-10-18", "2099-10-18"));
  assert.equal(checkedOperatorHealth(futureHealth, authority).asOf, "2099-10-18T12:00:10.000Z");
  assert.equal(checkedReplayResult(futureReplay, expected).publicationDelaySeconds, 3.5);
});
test("queue and intake lag values are recomputed and null remains distinct from zero", () => {
  const value = observedHealth();
  for (const [section, field] of [
    ["intake", "queueAgeSeconds"],
    ["intake", "lagSeconds"],
    ["publication", "queueAgeSeconds"],
  ]) {
    for (const wrong of [null, 0, 42, -1, NaN, Infinity, "10"]) {
      const bad = clone(value);
      (bad as any)[section!][field!] = wrong;
      assert.throws(() => checkedOperatorHealth(bad, authority), section + ":" + field + ":" + String(wrong));
    }
  }
  const simultaneous = mutate(value, (x) => {
    x.intake.latestSourceAt = x.intake.latestReceivedAt;
    x.intake.lagSeconds = 0;
  });
  assert.equal(checkedOperatorHealth(simultaneous, authority).intake.lagSeconds, 0);
  const skewed = mutate(value, (x) => {
    x.intake.latestSourceAt = completed;
    x.intake.lagSeconds = null;
  });
  assert.equal(checkedOperatorHealth(skewed, authority).intake.lagSeconds, null);
  assert.throws(() =>
    checkedOperatorHealth(
      mutate(skewed, (x) => {
        x.intake.lagSeconds = 0;
      }),
      authority,
    ),
  );
  assert.throws(() =>
    checkedOperatorHealth(
      mutate(health(), (x) => {
        x.intake.queueAgeSeconds = 0;
      }),
      authority,
    ),
  );
});
test("counts reject coercion, fractions and overflow and cannot exceed known retained intake", () => {
  for (const bad of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 0.5, "0", undefined, false]) {
    for (const [section, field] of [
      ["intake", "retained"],
      ["intake", "pending"],
      ["intake", "leased"],
      ["intake", "quarantined"],
      ["publication", "pending"],
      ["publication", "leased"],
      ["publication", "quarantined"],
    ]) {
      const value: any = observedHealth();
      value[section!][field!] = bad;
      assert.throws(() => checkedOperatorHealth(value, authority));
    }
  }
  for (const budget of [0, 86401, 0.5, "60", null])
    assert.throws(() => checkedOperatorHealth({ ...health(), freshnessBudgetSeconds: budget }, authority));
  assert.throws(() =>
    checkedOperatorHealth(
      mutate(observedHealth(), (x) => {
        x.intake.retained = 2;
      }),
      authority,
    ),
  );
  assert.throws(() =>
    checkedOperatorHealth(
      mutate(observedHealth(), (x) => {
        x.intake.retained = Number.MAX_SAFE_INTEGER;
        x.intake.pending = Number.MAX_SAFE_INTEGER;
        x.intake.leased = Number.MAX_SAFE_INTEGER;
      }),
      authority,
    ),
  );
  const unknown = mutate(observedHealth(), (x) => {
    x.intake.retained = null;
    x.intake.pending = null;
    x.publication.quarantined = null;
  });
  assert.equal(checkedOperatorHealth(unknown, authority).intake.pending, null);
});
test("collector empty windows require actual recent complete zero counts, not an empty queue", () => {
  const value = health();
  for (const change of [
    { items: null },
    { expectedItems: null },
    { items: 1 },
    { expectedItems: 1 },
    { lastAttemptAt: null },
    { lastSuccessAt: null },
    { reconciledThrough: null },
    { lastAttemptAt: old },
    { lastSuccessAt: old },
    { reconciledThrough: old },
  ])
    assert.throws(() =>
      checkedOperatorHealth(
        mutate(value, (x) => Object.assign(x.collector.families[0]!, change)),
        authority,
      ),
    );
  const unknown = mutate(value, (x) => {
    x.collector.state = "unknown";
    Object.assign(x.collector.families[0]!, {
      state: "unknown",
      reason: "no_current_attempt",
      lastAttemptAt: null,
      lastSuccessAt: null,
      reconciledThrough: null,
      items: null,
      expectedItems: null,
    });
  });
  assert.equal(checkedOperatorHealth(unknown, authority).collector.state, "unknown");
  const disconnected = mutate(unknown, (x) => {
    x.collector.state = "disconnected";
    Object.assign(x.collector.families[0]!, {
      state: "disconnected",
      reason: "source_read_failed",
      lastAttemptAt: old,
    });
  });
  assert.equal(checkedOperatorHealth(disconnected, authority).collector.state, "disconnected");
});
test("all advertised collector reason families have coherent state and evidence prerequisites", () => {
  const cases: Array<
    [OperatorHealthResponse["collector"]["state"], Partial<OperatorHealthResponse["collector"]["families"][number]>]
  > = [
    ["degraded", { reason: "source_schema_drift", lastAttemptAt: old }],
    ["degraded", { reason: "source_commit_failed" }],
    ["degraded", { reason: "collection_failed" }],
    ["overdue", { reason: "attempt_overdue", lastAttemptAt: old }],
    ["overdue", { reason: "reconciliation_overdue", reconciledThrough: old }],
    ["collecting", { reason: "partial_collection" }],
    ["unknown", { reason: "completion_time_unknown", lastSuccessAt: null }],
    ["unknown", { reason: "source_count_unknown", items: null }],
    ["unknown", { reason: "source_count_unknown", items: 3, expectedItems: 5 }],
    ["progress", { reason: "completed_observed_window", items: 3, expectedItems: 3 }],
  ];
  for (const [state, change] of cases) {
    const value = health();
    value.collector.state = state;
    Object.assign(value.collector.families[0]!, change, { state });
    assert.equal(checkedOperatorHealth(value, authority).collector.state, state);
    assert.throws(() =>
      checkedOperatorHealth(
        mutate(value, (x) => {
          x.collector.families[0]!.state = "quiet";
        }),
        authority,
      ),
    );
  }
  assert.throws(() =>
    checkedOperatorHealth(
      mutate(health(), (x) => {
        x.collector.families[0]!.reason = "private failure details" as any;
      }),
      authority,
    ),
  );
});
test("collector aggregate cannot conceal a disconnected, overdue or unknown configured family", () => {
  const value = health();
  value.collector.families.push({
    ...value.collector.families[0]!,
    family: "reviews",
    state: "disconnected",
    reason: "source_read_failed",
  });
  assert.throws(() => checkedOperatorHealth(value, authority));
  value.collector.state = "disconnected";
  assert.equal(checkedOperatorHealth(value, authority).collector.state, "disconnected");
  value.collector.families.push({
    ...value.collector.families[0]!,
    family: "comments",
    state: "overdue",
    reason: "attempt_overdue",
    lastAttemptAt: old,
  });
  assert.equal(checkedOperatorHealth(value, authority).collector.state, "disconnected");
  value.collector.state = "overdue";
  assert.throws(() => checkedOperatorHealth(value, authority));
});
test("only the complete bounded set of known source families can be rendered", () => {
  for (const families of [
    [],
    [health().collector.families[0]!, health().collector.families[0]!],
    [{ ...health().collector.families[0]!, family: "private_family" }],
    Array(13).fill(health().collector.families[0]!),
  ])
    assert.throws(() => checkedOperatorHealth({ ...health(), collector: { state: "quiet", families } }, authority));
  const value = health();
  value.collector.families = [
    "issues",
    "pull_requests",
    "commits",
    "reviews",
    "comments",
    "releases",
    "discussions",
    "timelines",
    "content_edits",
    "project_history",
    "relationships",
    "project_current",
  ].map((family) => ({ ...value.collector.families[0]!, family: family as any }));
  assert.equal(checkedOperatorHealth(value, authority).collector.families.length, 12);
});
test("quota resources are exactly five unique buckets and each observation state is explicit", () => {
  const value = observedHealth();
  for (const resources of [
    [],
    value.quota.resources.slice(1),
    [...value.quota.resources, value.quota.resources[0]!],
    [value.quota.resources[0]!, ...value.quota.resources.slice(0, 4)],
    [{ ...value.quota.resources[0]!, resource: "rest" }, ...value.quota.resources.slice(1)],
  ])
    assert.throws(() => checkedOperatorHealth({ ...value, quota: { ...value.quota, resources } }, authority));
  for (const change of [{ state: "unavailable" }, { scopeKey: null }, { scopeKey: "not-a-hash" }])
    assert.throws(() => checkedOperatorHealth({ ...value, quota: { ...value.quota, ...change } }, authority));
  for (const [state, observation] of [
    ["unknown", value.quota.resources[0]!.observation],
    ["unavailable", {}],
    ["observed", null],
    ["available", null],
  ])
    assert.throws(() =>
      checkedOperatorHealth(
        mutate(value, (x) => Object.assign(x.quota.resources[0]!, { state, observation })),
        authority,
      ),
    );
  value.quota.resources[1]!.state = "unavailable";
  assert.equal(checkedOperatorHealth(value, authority).quota.resources[1]!.state, "unavailable");
});
test("quota observations preserve independent null/zero fields and reject malformed counts and calendars", () => {
  for (const key of ["limit", "remaining", "used", "retryAfterSeconds"]) {
    for (const bad of [-1, 0.25, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "0"]) {
      const value = observedHealth();
      (value.quota.resources[0]!.observation as any)[key] = bad;
      assert.throws(() => checkedOperatorHealth(value, authority), key);
    }
    const value = observedHealth();
    (value.quota.resources[0]!.observation as any)[key] = null;
    assert.equal((checkedOperatorHealth(value, authority).quota.resources[0]!.observation as any)[key], null);
  }
  for (const status of [99, 600, 200.5, "200", null])
    assert.throws(() =>
      checkedOperatorHealth(
        mutate(observedHealth(), (x) => {
          x.quota.resources[0]!.observation!.responseStatus = status as any;
        }),
        authority,
      ),
    );
  assert.throws(() =>
    checkedOperatorHealth(
      mutate(observedHealth(), (x) => {
        x.quota.resources[0]!.observation!.resetAt = "2026-02-30T00:00:00.000Z";
      }),
      authority,
    ),
  );
  const independentlyRetained = mutate(observedHealth(), (x) => {
    x.quota.resources[0]!.observation!.remaining = 6000;
  });
  assert.equal(
    checkedOperatorHealth(independentlyRetained, authority).quota.resources[0]!.observation!.remaining,
    6000,
  );
});
test("health only exposes completed publication references for a verified result", () => {
  for (const state of ["unknown", "unavailable"] as const) {
    const value = mutate(health(), (x) => {
      x.publication.state = state;
    });
    assert.equal(checkedOperatorHealth(value, authority).publication.state, state);
    for (const [key, leak] of Object.entries({
      completedAt: completed,
      delaySeconds: 0,
      policyVersion: "old-policy",
      publications: scopes,
    })) {
      assert.throws(() =>
        checkedOperatorHealth(
          mutate(value, (x) => {
            (x.publication as any)[key] = leak;
          }),
          authority,
        ),
      );
    }
  }
  for (const [key, missing] of Object.entries({
    completedAt: null,
    delaySeconds: null,
    policyVersion: null,
    publications: [],
  }))
    assert.throws(() =>
      checkedOperatorHealth(
        mutate(observedHealth(), (x) => {
          (x.publication as any)[key] = missing;
        }),
        authority,
      ),
    );
});
test("all replay statuses preserve the distinction between intake, processing and publication", () => {
  const values = [
    { ...early("unknown", "legacy_unbound"), queuedAt: null, replayPolicyVersion: null },
    early("queued", "awaiting_intake"),
    early("processing", "intake_in_progress"),
    early("failed", "intake_failed"),
    early("superseded", "later_replay_queued"),
    replay("processed", "no_new_publication_notice"),
    replay("processed", "awaiting_publication"),
    replay("processing", "publication_in_progress"),
    replay("failed", "publication_failed"),
    early("unavailable", "source_generation_changed"),
    { ...early("unavailable", "result_binding_unavailable"), queuedAt: null, replayPolicyVersion: null },
    { ...replay("unavailable", "result_binding_unavailable"), processingDelaySeconds: null },
    replay("unavailable", "publication_verification_unavailable"),
    replay(),
  ];
  for (const value of values) assert.deepEqual(checkedReplayResult(value, expected), value, value.reason);
  assert.equal(checkedReplayResult(replay(), expected).publicationPolicyVersion, "publication-policy-before-replay");
});
test("replay state/reason mismatches and unknown reasons never become a success message", () => {
  const value = replay();
  for (const status of [
    "unknown",
    "queued",
    "processing",
    "failed",
    "superseded",
    "processed",
    "unavailable",
    "complete",
  ])
    assert.throws(() => checkedReplayResult({ ...value, status }, expected));
  for (const reason of ["awaiting_intake", "intake_failed", "private failure text", "", null])
    assert.throws(() => checkedReplayResult({ ...value, reason }, expected));
  assert.throws(() => checkedReplayResult({ ...early("queued", "awaiting_intake"), status: "processed" }, expected));
});
test("replay publication data is forbidden for every unpublished status, including unavailable and legacy", () => {
  const values = [
    early("unknown", "legacy_unbound"),
    early("queued", "awaiting_intake"),
    early("processing", "intake_in_progress"),
    early("failed", "intake_failed"),
    early("superseded", "later_replay_queued"),
    replay("processed", "awaiting_publication"),
    replay("unavailable", "publication_verification_unavailable"),
  ];
  for (const value of values) {
    for (const [key, leaked] of Object.entries({
      publicationCompletedAt: completed,
      publicationDelaySeconds: 0,
      publicationPolicyVersion: "some-policy",
      publications: scopes,
    }))
      assert.throws(() => checkedReplayResult({ ...value, [key]: leaked }, expected), value.status + ":" + key);
  }
});
test("processed and published outcomes require the ordered original clocks and exact delays", () => {
  for (const change of [
    { queuedAt: null },
    { processedAt: null },
    { replayPolicyVersion: null },
    { processingDelaySeconds: null },
    { processingDelaySeconds: 0 },
    { processingDelaySeconds: 1.251 },
    { processedAt: "2026-10-18T11:59:59.999Z" },
    { publicationCompletedAt: start },
    { publicationCompletedAt: null },
    { publicationPolicyVersion: null },
    { publicationDelaySeconds: null },
    { publicationDelaySeconds: 1.25 },
    { publicationDelaySeconds: 3.501 },
  ])
    assert.throws(() => checkedReplayResult({ ...replay(), ...change }, expected));
  for (const change of [
    { processedAt: processed },
    { processingDelaySeconds: 0 },
    { queuedAt: null },
    { replayPolicyVersion: null },
  ])
    assert.throws(() => checkedReplayResult({ ...early("queued", "awaiting_intake"), ...change }, expected));
  const zero = {
    ...replay(),
    processedAt: start,
    publicationCompletedAt: start,
    processingDelaySeconds: 0,
    publicationDelaySeconds: 0,
  };
  assert.equal(checkedReplayResult(zero, expected).publicationDelaySeconds, 0);
});
test("unavailable processing bindings may retain uncertain observations without inventing elapsed time", () => {
  const uncertain = { ...replay("unavailable", "result_binding_unavailable"), processingDelaySeconds: null };
  assert.equal(checkedReplayResult(uncertain, expected).processingDelaySeconds, null);
  assert.throws(() => checkedReplayResult({ ...uncertain, processedAt: old }, expected));
  assert.throws(() => checkedReplayResult({ ...uncertain, processingDelaySeconds: 0 }, expected));
  assert.throws(() => checkedReplayResult({ ...uncertain, queuedAt: null }, expected));
  assert.throws(() => checkedReplayResult({ ...uncertain, reason: "source_generation_changed" }, expected));
});
test("publication scope sets are bounded and unique with exact positive revisions and hash identities", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => ({
    scopeKey: "scope:" + i,
    snapshotId: "d".repeat(64),
    revision: i + 1,
  }));
  assert.equal(checkedReplayResult({ ...replay(), publications: hundred }, expected).publications.length, 100);
  const values: unknown[] = [
    [],
    [...hundred, { ...hundred[0]!, scopeKey: "scope:100" }],
    [scopes[0], { ...scopes[0], snapshotId: "f".repeat(64) }],
    [{ ...scopes[0], scopeKey: "" }],
    [{ ...scopes[0], scopeKey: "x".repeat(operatorPublicationScopeKeyLimit + 1) }],
    [{ ...scopes[0], snapshotId: "A".repeat(64) }],
    [{ ...scopes[0], snapshotId: "a".repeat(63) }],
  ];
  for (const bad of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"])
    values.push([{ ...scopes[0], revision: bad }]);
  for (const publications of values) {
    assert.throws(() => checkedReplayResult({ ...replay(), publications }, expected));
    assert.throws(() =>
      checkedOperatorHealth(
        { ...observedHealth(), publication: { ...observedHealth().publication, publications } },
        authority,
      ),
    );
  }
});
for (const withRoles of [false, true])
  test(`maximum canonical ${withRoles ? "v3 role and" : "v2"} Project scope survives health and replay reads`, () => {
    const scope = capacityScope(withRoles),
      scopeKey = publicScopeKey(scope);
    assert.equal(scope.schemaVersion, withRoles ? "public-scope/v3" : "public-scope/v2");
    assert.equal(scope.organization.length, 200);
    assert.equal(scope.repository!.length, 200);
    assert.equal(scope.workstream!.length, 200);
    assert.equal(scope.projects!.length, 100);
    assert.equal(new Set(scope.projects).size, 100);
    assert.ok(scope.projects!.every((project) => /^[a-f0-9]{128}$/.test(project)));
    if (withRoles) {
      assert.equal(publicContributionRoles.length, 9);
      assert.deepEqual(scope.roles, [...publicContributionRoles].sort());
    } else assert.equal(Object.hasOwn(scope, "roles"), false);
    assert.equal(scopeKey.length, withRoles ? 13_895 : 13_796);
    assert.equal(operatorPublicationScopeKeyLimit, 16_384);
    assert.ok(scopeKey.length < operatorPublicationScopeKeyLimit);
    const publications = [{ ...scopes[0]!, scopeKey }];
    assert.deepEqual(checkedReplayResult({ ...replay(), publications }, expected).publications, publications);
    assert.deepEqual(
      checkedOperatorHealth(
        { ...observedHealth(), publication: { ...observedHealth().publication, publications } },
        authority,
      ).publication.publications,
      publications,
    );
  });
test("100 maximum canonical scopes fit the controls byte cap and retain every health/result reference", async (t) => {
  const previous = globalThis.fetch;
  try {
    for (const withRoles of [false, true]) {
      const publications = Array.from({ length: 100 }, (_, index) => ({
        scopeKey: publicScopeKey(capacityScope(withRoles, index)),
        snapshotId: createHash("sha256").update(`SYNTHETIC operator capacity snapshot ${index}`).digest("hex"),
        revision: Number.MAX_SAFE_INTEGER,
      }));
      assert.equal(new Set(publications.map((publication) => publication.scopeKey)).size, 100);
      const maximumAuthority = {
        repositoryId: Number.MAX_SAFE_INTEGER,
        sourceGeneration: "9".repeat(19),
        policyVersion: "p".repeat(128),
        authorityRevision: "a".repeat(128),
      };
      const maximumExpected = { ...maximumAuthority, receiptId: "r".repeat(128), deliveryId };
      const healthValue = {
        ...observedHealth(),
        ...maximumAuthority,
        publication: { ...observedHealth().publication, policyVersion: "h".repeat(128), publications },
      };
      const replayValue = {
        ...replay(),
        ...maximumExpected,
        replayPolicyVersion: "r".repeat(128),
        publicationPolicyVersion: "h".repeat(128),
        publications,
      };
      const healthBody = JSON.stringify(healthValue),
        replayBody = JSON.stringify(replayValue);
      const healthBytes = Buffer.byteLength(healthBody, "utf8"),
        replayBytes = Buffer.byteLength(replayBody, "utf8");
      assert.ok(healthBytes < 2_000_000);
      assert.ok(replayBytes < 2_000_000);
      globalThis.fetch = async (path) => {
        const healthPath = `/controls/operations/${maximumAuthority.repositoryId}/health`;
        const replayPath = `/controls/operations/${maximumAuthority.repositoryId}/replays/${maximumExpected.receiptId}`;
        assert.ok(path === healthPath || path === replayPath);
        return new Response(path === healthPath ? healthBody : replayBody, {
          headers: { "content-type": "application/json" },
        });
      };
      const readHealth = checkedOperatorHealth(
        await control(`/controls/operations/${maximumAuthority.repositoryId}/health`),
        maximumAuthority,
      );
      const readReplay = checkedReplayResult(
        await control(`/controls/operations/${maximumAuthority.repositoryId}/replays/${maximumExpected.receiptId}`),
        maximumExpected,
      );
      assert.deepEqual(readHealth, healthValue);
      assert.deepEqual(readReplay, replayValue);
      t.diagnostic(JSON.stringify({ version: withRoles ? "v3" : "v2", scopes: 100, healthBytes, replayBytes }));
    }
  } finally {
    globalThis.fetch = previous;
  }
});
test("both returned responses detach all mutable children from the untrusted input", () => {
  const input = observedHealth(),
    output = checkedOperatorHealth(input, authority);
  assert.notEqual(input, output);
  assert.notEqual(input.collector.families, output.collector.families);
  input.collector.families[0]!.items = 100;
  input.quota.resources[0]!.observation!.remaining = 1;
  input.publication.publications[0]!.revision = 999;
  assert.equal(output.collector.families[0]!.items, 0);
  assert.equal(output.quota.resources[0]!.observation!.remaining, 0);
  assert.equal(output.publication.publications[0]!.revision, 1);
  output.publication.publications[0]!.snapshotId = "f".repeat(64);
  assert.equal(input.publication.publications[0]!.snapshotId, "a".repeat(64));
  const before = replay(),
    after = checkedReplayResult(before, expected);
  before.publications[0]!.revision = 4;
  assert.equal(after.publications[0]!.revision, 1);
  after.publications[1]!.revision = 8;
  assert.equal(before.publications[1]!.revision, 3);
});
test("sparse arrays, prototype fields, accessors and symbol extras are rejected without evaluation", () => {
  const sparse = Array(1);
  assert.throws(() => checkedReplayResult({ ...replay(), publications: sparse }, expected));
  const accessor = replay();
  Object.defineProperty(accessor, "status", {
    enumerable: true,
    get() {
      throw Error("accessor must not run");
    },
  });
  assert.throws(() => checkedReplayResult(accessor, expected), /Observed operations response changed or is invalid/);
  const inherited = Object.assign(Object.create({ privatePayload: "not JSON" }), health());
  assert.throws(() => checkedOperatorHealth(inherited, authority));
  const extra = health();
  Object.defineProperty(extra, Symbol("private"), { value: "hidden" });
  assert.throws(() => checkedOperatorHealth(extra, authority));
});

test("operator health admits the separately configured native Project curation family", () => {
  const value = health();
  value.collector.families[0]!.family = "project_curation_history";
  value.collector.families[0]!.expectedItems = null;
  value.collector.families[0]!.state = "unknown";
  value.collector.families[0]!.reason = "source_count_unknown";
  value.collector.state = "unknown";
  const checked = checkedOperatorHealth(value, authority);
  assert.equal(checked.collector.families[0]!.family, "project_curation_history");
  assert.equal(checked.collector.families[0]!.items, 0);
  assert.equal(checked.collector.families[0]!.expectedItems, null);
  assert.equal(checked.collector.state, "unknown");
  const falseQuiet = clone(value);
  falseQuiet.collector.state = "quiet";
  falseQuiet.collector.families[0]!.state = "quiet";
  falseQuiet.collector.families[0]!.reason = "completed_empty_window";
  assert.throws(() => checkedOperatorHealth(falseQuiet, authority));
  const invalid = clone(value);
  (invalid.collector.families[0] as { family: string }).family = "project_history_and_curation";
  assert.throws(() => checkedOperatorHealth(invalid, authority));
});
