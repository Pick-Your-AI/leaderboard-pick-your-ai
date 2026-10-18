import { exactKeys, requireThat } from "./store.mjs";

export const previewAuthorityLimitsV1 = Object.freeze({
  schemaVersion: "policy-preview-authority/v1",
  lifetimeMs: 60_000,
  configurations: 100,
  reviewers: 10_000,
});

/** An authoritative in-process cache, supplied by host policy/roster administration.
 * It starts empty and never infers or manufactures an approval. Revocations must
 * replace this cache synchronously as part of the authoritative update itself;
 * an eventually consistent copy of another authority cannot supply this fence.
 */
export function createPolicyPreviewAuthority({ now = Date.now } = {}) {
  let active = null;
  return Object.freeze({
    replace(value) {
      exactKeys(value, ["schemaVersion", "revision", "validUntil", "configurationHashes", "reviewers"]);
      const timestamp = now();
      requireThat(
        value.schemaVersion === previewAuthorityLimitsV1.schemaVersion &&
          Number.isSafeInteger(value.revision) &&
          value.revision >= 0 &&
          value.revision > (active?.revision ?? -1),
        409,
        "Preview authority revision must advance",
      );
      requireThat(
        Number.isSafeInteger(value.validUntil) &&
          value.validUntil > timestamp &&
          value.validUntil <= timestamp + previewAuthorityLimitsV1.lifetimeMs,
        409,
        "Invalid preview authority lifetime",
      );
      requireThat(
        Array.isArray(value.configurationHashes) &&
          value.configurationHashes.length <= previewAuthorityLimitsV1.configurations &&
          value.configurationHashes.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)),
        400,
        "Invalid approved configuration hashes",
      );
      requireThat(
        Array.isArray(value.reviewers) && value.reviewers.length <= previewAuthorityLimitsV1.reviewers,
        400,
        "Invalid reviewer authority",
      );
      const reviewers = new Map();
      for (const reviewer of value.reviewers) {
        exactKeys(reviewer, ["actorId", "roleVersion"]);
        requireThat(
          typeof reviewer.actorId === "string" &&
            /^[1-9][0-9]{0,19}$/.test(reviewer.actorId) &&
            typeof reviewer.roleVersion === "string" &&
            reviewer.roleVersion.length > 0 &&
            reviewer.roleVersion.length <= 100 &&
            !reviewers.has(reviewer.actorId),
          400,
          "Invalid reviewer authority",
        );
        reviewers.set(reviewer.actorId, reviewer.roleVersion);
      }
      active = {
        revision: value.revision,
        validUntil: value.validUntil,
        configurations: new Set(value.configurationHashes),
        reviewers,
      };
      return {
        schemaVersion: previewAuthorityLimitsV1.schemaVersion,
        revision: active.revision,
        validUntil: active.validUntil,
      };
    },
    isCurrent({ configurationHash, actorId, roleVersion }) {
      return Boolean(
        active &&
        active.validUntil > now() &&
        active.configurations.has(configurationHash) &&
        active.reviewers.has(actorId) &&
        active.reviewers.get(actorId) === roleVersion,
      );
    },
  });
}
