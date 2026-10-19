import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ago, clock, components, harness, publicScope } from "./harness.mjs";

/**
 * Synthetic protected collector plus the actual compiled GitHub producer.
 * No normalized facts, aliases, observations or creation proofs are fabricated.
 * This is not a native transfer-discovery, webhook-delivery or source-enablement fixture.
 */
export async function issueTransferHarness(t, options = {}) {
  const sameNativeId = options.sameNativeId === true;
  const numericFallback = options.numericFallback === true;
  const sourceSlug = "synthetic-org/synthetic-source";
  const targetSlug = "synthetic-org/synthetic-target";
  const sourceDatabaseId = 1001;
  const targetDatabaseId = sameNativeId ? sourceDatabaseId : 1002;
  const defaultSourceId = numericFallback ? `github:issue:${sourceDatabaseId}` : "SYNTHETIC_ISSUE_A";
  const sourceId = options.sourceId ?? defaultSourceId;
  const defaultTargetId = sameNativeId
    ? sourceId
    : numericFallback
      ? `github:issue:${targetDatabaseId}`
      : "SYNTHETIC_ISSUE_B";
  const targetId = options.targetId ?? defaultTargetId;
  for (const id of [sourceId, targetId]) {
    assert.ok(
      typeof id === "string" && id.length > 0 && id.length <= 128 && !/[^A-Za-z0-9_=.:-]/.test(id),
      "Synthetic node IDs must fit the complete bounded collector identity",
    );
  }
  if (sameNativeId) assert.equal(targetId, sourceId, "The same-native-ID fixture must use one identity");
  if (numericFallback) {
    assert.equal(sourceId, `github:issue:${sourceDatabaseId}`);
    assert.equal(targetId, `github:issue:${targetDatabaseId}`);
  }
  const sourceSubjectId = numericFallback ? String(sourceDatabaseId) : sourceId;
  const targetSubjectId = numericFallback ? String(targetDatabaseId) : targetId;
  const sourceUrl = `https://github.com/${sourceSlug}/issues/1`;
  const targetUrl = `https://github.com/${targetSlug}/issues/9`;
  const bornAt = ago(2);
  const transferAt = ago(1);
  const reporter = { id: 101, node_id: "U_SYNTHETIC_REPORTER", login: "synthetic-reporter", type: "User" };
  const mover = { id: 202, node_id: "U_SYNTHETIC_MOVER", login: "synthetic-mover", type: "User" };
  const unrelatedReporter = {
    id: 303,
    node_id: "U_SYNTHETIC_UNRELATED",
    login: "synthetic-unrelated",
    type: "User",
  };
  let generation = 1;
  let includeTarget = options.includeTarget !== false;
  // Equal native identities need no invented transfer edge. Explicit true can
  // separately exercise a real same-ID transfer proof if the caller requests it.
  let includeTransfer = options.includeTransfer ?? !sameNativeId;
  assert.equal(typeof includeTransfer, "boolean");
  const explicitOpened = options.explicitOpened === true;
  let omitEnrichment = false;
  let targetPrivate = false;
  const records = new Map();
  const scans = new Map();
  const sourceCalls = [];
  const normalizerCalls = [];
  const key = (repositoryId, family, subjectId, revision) =>
    JSON.stringify([repositoryId, family, subjectId, revision]);

  function issue(id, nativeId, number, url, author = reporter) {
    return {
      id,
      ...(nativeId === null ? {} : { node_id: nativeId }),
      number,
      html_url: url,
      title: "Synthetic transfer conservation issue",
      created_at: bornAt,
      updated_at: transferAt,
      state: "open",
      user: structuredClone(author),
    };
  }

  function capture(repositoryId, family, subjectId, label, raw) {
    // A new scan generation gets a fresh opaque source revision. Historical
    // creation/transfer clocks and event IDs remain unchanged across replays.
    const rawHash = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
    const sourceRevision = `synthetic-${label}:${generation}:${rawHash}`;
    const sourceUrl = raw.payload.issue.html_url;
    const transition = raw.action !== "snapshot";
    const fact = {
      subjectId,
      sourceRevision,
      sourceUrl,
      evidence: transition ? "observed_transition" : "current_state",
      actorId: transition ? String(raw.payload.sender.id) : null,
      occurredAt: transition ? raw.occurredAt : null,
      state: raw.action === "transferred" ? "present" : "open",
    };
    const recordKey = key(repositoryId, family, subjectId, sourceRevision);
    const entry = { fact, raw };
    if (records.has(recordKey)) assert.deepEqual(records.get(recordKey), entry);
    else records.set(recordKey, structuredClone(entry));
    return fact;
  }

  function factsFor(repositoryId, family) {
    assert.ok(repositoryId === 2 || repositoryId === 3, "Only the two approved synthetic repositories exist");
    const original = issue(sourceDatabaseId, numericFallback ? null : sourceId, 1, sourceUrl);
    const target = issue(targetDatabaseId, numericFallback ? null : targetId, 9, targetUrl);
    const snapshot = (value) => ({
      family: "issue",
      action: "snapshot",
      source: "github_rest",
      payload: { issue: value },
    });
    if (family === "issues" && repositoryId === 3)
      return includeTarget ? [capture(3, family, targetSubjectId, "target-current", snapshot(target))] : [];
    if (family === "issues") {
      const unrelated = issue(
        1003,
        "SYNTHETIC_UNRELATED_ISSUE",
        2,
        `https://github.com/${sourceSlug}/issues/2`,
        unrelatedReporter,
      );
      const facts = [
        capture(2, family, sourceSubjectId, "source-current", snapshot(original)),
        capture(2, family, unrelated.node_id, "unrelated-current", snapshot(unrelated)),
      ];
      if (explicitOpened)
        facts.push(
          capture(2, family, sourceSubjectId, "source-opened", {
            family: "issue",
            action: "opened",
            source: "github_webhook",
            eventId: "synthetic-original-opened",
            occurredAt: bornAt,
            payload: { issue: original, sender: reporter },
          }),
        );
      return facts;
    }
    assert.equal(family, "relationships", "Only issue views and explicit transfer observations are collected");
    if (repositoryId !== 2 || !includeTransfer) return [];
    return [
      capture(2, family, sourceSubjectId, "transfer", {
        family: "relationship",
        action: "transferred",
        source: "github_webhook",
        eventId: "synthetic-original-transfer",
        occurredAt: transferAt,
        payload: {
          issue: original,
          sender: mover,
          destination: {
            repositoryId: 3,
            stableId: targetId,
            slug: targetSlug,
            url: targetUrl,
            visibility: "public",
            allowed: true,
          },
        },
      }),
    ];
  }

  const fixture = {
    sourceId,
    targetId,
    sourceSubjectId,
    targetSubjectId,
    sourceUrl,
    targetUrl,
    sourceSlug,
    targetSlug,
    bornAt,
    transferAt,
    sameNativeId,
    numericFallback,
    explicitOpened,
    unrelatedId: "SYNTHETIC_UNRELATED_ISSUE",
    reporterId: "101",
    moverId: "202",
    unrelatedReporterId: "303",
    sourceCalls,
    normalizerCalls,
    get generation() {
      return generation;
    },
    get includeTarget() {
      return includeTarget;
    },
    get includeTransfer() {
      return includeTransfer;
    },
    set generation(value) {
      assert.ok(Number.isSafeInteger(value) && value > 0, "A positive safe synthetic generation is required");
      generation = value;
    },
    omitTransferEnrichment(value = true) {
      assert.equal(typeof value, "boolean");
      omitEnrichment = value;
    },
    omitTargetView(value = true) {
      assert.equal(typeof value, "boolean");
      includeTarget = !value;
    },
    setTargetView(value) {
      assert.equal(typeof value, "boolean");
      includeTarget = value;
    },
    setTransferObservation(value) {
      assert.equal(typeof value, "boolean");
      includeTransfer = value;
    },
    setTransferEnrichment(value) {
      assert.equal(typeof value, "boolean");
      omitEnrichment = !value;
    },
    setTargetPrivate(value = true) {
      assert.equal(typeof value, "boolean");
      targetPrivate = value;
    },
  };

  const h = await harness(t, {
    memoryDatabase: options.memoryDatabase !== false,
    authorizePolicyPreview: async () => true,
    policyComparisonAuthorityCurrent: () => true,
    configure(config) {
      config.repositories = [
        {
          id: 2,
          installationId: 1,
          slug: sourceSlug,
          families: ["issues", "relationships"],
          approvalReceipt: "synthetic-transfer-source-approved",
        },
        {
          id: 3,
          installationId: 1,
          slug: targetSlug,
          families: ["issues"],
          approvalReceipt: "synthetic-transfer-target-approved",
        },
      ];
      const policy = config.policies[0];
      policy.policy.sources = ["github_rest", "github_webhook"];
      policy.signature = components.metrics.stableJSON(policy.policy);
      config.scopes = [null, "2", "3"].map((repository) => ({ ...publicScope, repository, context: "current" }));
      options.configure?.(config);
    },
    async probeRepository(repository) {
      assert.ok(repository.id === 2 || repository.id === 3);
      assert.equal(repository.slug, repository.id === 2 ? sourceSlug : targetSlug);
      return {
        repositoryId: repository.id,
        installationId: repository.installationId,
        visibility: repository.id === 3 && targetPrivate ? "private" : "public",
        checkedAt: clock(),
      };
    },
    source: {
      async readPage(request) {
        const scanKey = JSON.stringify([request.runId, request.repositoryId, request.family]);
        if (!scans.has(scanKey)) scans.set(scanKey, factsFor(request.repositoryId, request.family));
        const facts = scans.get(scanKey);
        const offset = request.cursor === null ? 0 : Number(request.cursor);
        assert.ok(Number.isSafeInteger(offset) && offset >= 0 && offset <= facts.length);
        assert.ok(Number.isSafeInteger(request.limit) && request.limit > 0);
        const selected = facts.slice(offset, offset + request.limit);
        sourceCalls.push({
          runId: request.runId,
          repositoryId: request.repositoryId,
          family: request.family,
          generation,
          cursor: request.cursor,
          factCount: selected.length,
        });
        return {
          repositoryId: request.repositoryId,
          visibility: "public",
          isSynthetic: true,
          expectedCount: facts.length,
          facts: structuredClone(selected),
          nextCursor: offset + selected.length < facts.length ? String(offset + selected.length) : null,
        };
      },
    },
    normalizerFactory() {
      return async (input) => {
        const entry = records.get(
          key(input.repository.id, input.family, input.fact.subjectId, input.fact.sourceRevision),
        );
        assert.ok(entry, "Enrichment must match an actually captured synthetic source row");
        assert.deepEqual(input.fact, entry.fact, "The collector must retain the exact bounded source fact");
        const raw = structuredClone(entry.raw);
        const unavailable = raw.action === "transferred" && omitEnrichment;
        normalizerCalls.push({
          repositoryId: input.repository.id,
          family: input.family,
          subjectId: input.fact.subjectId,
          sourceRevision: input.fact.sourceRevision,
          observedAt: input.observedAt,
          omittedTransferPayload: unavailable,
        });
        return components.github.normalizeGithubObservation({
          repository: { id: input.repository.id, slug: input.repository.slug, visibility: "public" },
          proof: {
            verified: true,
            source: raw.source,
            revision: input.fact.sourceRevision,
            ...(raw.eventId ? { eventId: raw.eventId } : {}),
            isSynthetic: true,
          },
          family: raw.family,
          action: raw.action,
          observedAt: input.observedAt,
          ...(raw.occurredAt ? { occurredAt: raw.occurredAt } : {}),
          // Missing enrichment is an unavailable payload, not a false private
          // destination. The actual producer determines its empty result/reasons.
          payload: unavailable ? {} : raw.payload,
        });
      };
    },
  });
  return { ...h, fixture };
}
