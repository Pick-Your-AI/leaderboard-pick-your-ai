import { createHash } from "node:crypto";
import {
  defaultDeliveryNormalizationVersion,
  discussionSourceNormalizationVersion,
  reviewSourceNormalizationVersion,
  relationshipPairNormalizationVersion,
} from "@pick-your-ai/github";
import {
  canonicalPublicScope,
  parsePublicWindows,
  publicScopeFilterKey,
  publicScopeKey,
  publicWindowPeriods,
  publicWindowsSchemaVersion,
} from "@pick-your-ai/contracts";

const schemaVersion = "private-publication-window-index/v1";
const fail = () => {
  throw new Error("publication_window_index_integrity_error");
};
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    fail();
};
const confirmationKeys = [
  "recognitionFingerprint",
  "configurationVersion",
  "configurationHash",
  "controlsConfigurationRevision",
  "aggregateExplanationHash",
  "dataMode",
  "scopeKey",
  "snapshotId",
  "revision",
];
const confirmationVersions = {
  reviewSourceNormalizationVersion,
  relationshipPairNormalizationVersion,
  discussionSourceNormalizationVersion,
  defaultDeliveryNormalizationVersion,
};
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const filterScope = (scope) => canonicalPublicScope({ ...scope, start: null, end: null });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** A bounded private pointer per explicitly approved filter/period. Call record
 * only inside the transaction that confirms the publication and advances its
 * private head. PostgreSQL allocation, history, and wall-clock time cannot
 * create or advance a discoverable choice. Old configuration namespaces remain
 * separate; this index does not rewrite retained snapshots or their period. */
export function createPublicationWindowIndex({
  configurationVersion,
  configurationHash,
  dataMode,
  templates,
  resolveMetricWindow,
}) {
  if (
    typeof configurationVersion !== "string" ||
    !configurationVersion.trim() ||
    !digest(configurationHash) ||
    !["public", "synthetic"].includes(dataMode) ||
    !Array.isArray(templates) ||
    templates.length > 100 ||
    typeof resolveMetricWindow !== "function"
  )
    fail();
  const namespace = hash([schemaVersion, configurationVersion, configurationHash, dataMode]);
  const profiles = new Map();
  for (const template of templates) {
    if (!object(template)) fail();
    const { period, ...input } = template;
    const scope = canonicalPublicScope(input);
    if (period === undefined || period === "custom") continue;
    if (!publicWindowPeriods.includes(period) || scope.start !== null || scope.end !== null) fail();
    const key = hash([publicScopeKey(scope), period]);
    if (profiles.has(key)) fail();
    profiles.set(key, { period, scope });
  }
  const identity = (scope, period) => hash([publicScopeFilterKey(scope), period]);
  const copyConfirmation = (input, scope) => {
    if (!object(input)) fail();
    const versionKeys = Object.keys(confirmationVersions).filter((key) => Object.hasOwn(input, key));
    const keys = [...confirmationKeys, ...versionKeys];
    exact(input, keys);
    if (
      versionKeys.some((key) => input[key] !== confirmationVersions[key]) ||
      input.configurationVersion !== configurationVersion ||
      input.configurationHash !== configurationHash ||
      input.dataMode !== dataMode ||
      input.scopeKey !== publicScopeKey(scope) ||
      (input.recognitionFingerprint !== null && !digest(input.recognitionFingerprint)) ||
      !Number.isSafeInteger(input.controlsConfigurationRevision) ||
      input.controlsConfigurationRevision < 0 ||
      !digest(input.aggregateExplanationHash) ||
      typeof input.snapshotId !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,200}$/.test(input.snapshotId) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1
    )
      fail();
    return Object.fromEntries(keys.map((key) => [key, input[key]]));
  };
  const confirmationEquals = (input, expected, scope) => {
    try {
      return same(copyConfirmation(input, scope), expected);
    } catch {
      return false;
    }
  };
  const copyEntry = (input) => {
    exact(input, ["period", "scope", "confirmation"]);
    const selected = canonicalPublicScope(input.scope);
    const scope = filterScope(selected);
    const confirmation = copyConfirmation(input.confirmation, selected);
    const parsed = parsePublicWindows(
      {
        schemaVersion: publicWindowsSchemaVersion,
        scope,
        windows: [
          {
            period: input.period,
            scope: input.scope,
            snapshotId: confirmation.snapshotId,
            revision: confirmation.revision,
          },
        ],
      },
      scope,
      resolveMetricWindow,
    ).windows[0];
    if (!profiles.has(identity(parsed.scope, parsed.period))) fail();
    return { period: parsed.period, scope: parsed.scope, confirmation };
  };
  const copyEntries = (input) => {
    if (!object(input) || Object.keys(input).length > profiles.size) fail();
    const entries = {};
    const scopes = new Map();
    const snapshots = new Map();
    for (const [key, value] of Object.entries(input)) {
      const entry = copyEntry(value);
      if (key !== identity(entry.scope, entry.period)) fail();
      const scopeKey = publicScopeKey(entry.scope);
      const publication = JSON.stringify([entry.confirmation.snapshotId, entry.confirmation.revision]);
      if (
        (scopes.has(scopeKey) && scopes.get(scopeKey) !== publication) ||
        (snapshots.has(entry.confirmation.snapshotId) && snapshots.get(entry.confirmation.snapshotId) !== scopeKey)
      )
        fail();
      scopes.set(scopeKey, publication);
      snapshots.set(entry.confirmation.snapshotId, scopeKey);
      entries[key] = entry;
    }
    return entries;
  };
  const load = (state) => {
    if (!object(state)) fail();
    if (state.pipelineWindowIndex === undefined) return {};
    if (!object(state.pipelineWindowIndex)) fail();
    const value = state.pipelineWindowIndex[namespace];
    if (value === undefined) return {};
    exact(value, ["schemaVersion", "configurationVersion", "configurationHash", "dataMode", "entries"]);
    if (
      value.schemaVersion !== schemaVersion ||
      value.configurationVersion !== configurationVersion ||
      value.configurationHash !== configurationHash ||
      value.dataMode !== dataMode
    )
      fail();
    return copyEntries(value.entries);
  };
  const approvedPeriods = (scope) =>
    publicWindowPeriods.filter((period) => {
      if (!profiles.has(identity(scope, period))) return false;
      if (period === "all") return scope.start === null && scope.end === null;
      if (scope.end === null) return false;
      try {
        const bounds = resolveMetricWindow(period, scope.end);
        return bounds.from === scope.start && bounds.to === scope.end && bounds.from < bounds.to;
      } catch {
        return false;
      }
    });

  return {
    /** Null is an unapproved filter or changed private authority. An approved
     * filter without a confirmed named publication has a legitimate empty menu.
     * SQL/current-control checks still belong to the source's final read fence. */
    read(state, requested) {
      const scope = canonicalPublicScope(requested);
      if (scope.start !== null || scope.end !== null) fail();
      if (!publicWindowPeriods.some((period) => profiles.has(identity(scope, period)))) return null;
      const entries = load(state);
      const windows = [];
      for (const period of publicWindowPeriods) {
        const entry = entries[identity(scope, period)];
        if (!entry) continue;
        if (
          !confirmationEquals(state.pipelineHeads?.[publicScopeKey(entry.scope)], entry.confirmation, entry.scope) ||
          !confirmationEquals(
            state.pipelinePublications?.[entry.confirmation.snapshotId],
            entry.confirmation,
            entry.scope,
          )
        )
          return null;
        windows.push(entry);
      }
      return { scope, windows };
    },

    /** The caller supplies the resolved publication's complete explicit label
     * set. Matching the duration of a legacy/custom publication is insufficient.
     * Every alias advances atomically to one exact current confirmation. */
    record(state, scopeInput, periods, inputConfirmation) {
      if (
        !Array.isArray(periods) ||
        periods.length > publicWindowPeriods.length ||
        new Set(periods).size !== periods.length ||
        periods.some((period) => !publicWindowPeriods.includes(period))
      )
        fail();
      if (periods.length === 0) return false;
      const scope = canonicalPublicScope(scopeInput);
      const expectedPeriods = approvedPeriods(scope);
      if (
        !same(
          publicWindowPeriods.filter((period) => periods.includes(period)),
          expectedPeriods,
        )
      )
        fail();
      const confirmation = copyConfirmation(inputConfirmation, scope);
      const entriesToRecord = expectedPeriods.map((period) => copyEntry({ period, scope, confirmation }));
      if (!confirmationEquals(state.pipelinePublications?.[confirmation.snapshotId], confirmation, scope)) fail();
      const head = state.pipelineHeads?.[publicScopeKey(scope)];
      if (!head || !Number.isSafeInteger(head.revision) || head.revision < 1) fail();
      // Historical acknowledgement is allowed by the existing confirmation
      // transaction. It cannot promote that older revision into discovery.
      if (head.revision > confirmation.revision) return false;
      if (!confirmationEquals(head, confirmation, scope)) fail();
      const entries = load(state);
      let changed = false;
      for (const entry of entriesToRecord) {
        const key = identity(scope, entry.period);
        const prior = entries[key];
        // Revisions belong to one exact scope. A later rolling cutoff often
        // starts at revision one and must still supersede an older cutoff.
        if (prior && scope.end !== null && prior.scope.end > scope.end) continue;
        if (prior && prior.scope.end === scope.end) {
          if (
            publicScopeKey(prior.scope) !== publicScopeKey(scope) ||
            prior.confirmation.revision > confirmation.revision ||
            (prior.confirmation.revision === confirmation.revision &&
              prior.confirmation.snapshotId !== confirmation.snapshotId)
          )
            fail();
        }
        if (!same(prior, entry)) {
          entries[key] = entry;
          changed = true;
        }
      }
      if (!changed) return false;
      const next = copyEntries(entries);
      state.pipelineWindowIndex = {
        ...state.pipelineWindowIndex,
        [namespace]: { schemaVersion, configurationVersion, configurationHash, dataMode, entries: next },
      };
      return true;
    },
  };
}
