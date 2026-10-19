import { createHash } from "node:crypto";

const messages = {
  source_unavailable: "Source collection failed. Check source availability and retry state.",
  permission_revoked: "Source permission was revoked. Keep publication suppressed and verify installation access.",
  schema_changed: "Source schema validation failed. Keep the capability disabled and review the source contract.",
  publication_failed: "Snapshot publication failed. Preserve the last safe revision and inspect the transaction.",
  restore_failed: "Recovery verification failed. Keep the restored environment isolated.",
};
const stages = new Set(["collection", "normalization", "publication", "recovery", "read"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");

/** Fixed-field telemetry: raw exceptions, account names, URLs, tokens and payloads are never accepted. */
export class OperationalMonitor {
  constructor({ now = Date.now, freshnessBudgetMs, alertCooldownMs, retentionMs, maximumEntries = 1000, sink } = {}) {
    for (const value of [freshnessBudgetMs, alertCooldownMs, retentionMs, maximumEntries]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("Explicit positive telemetry budgets are required");
    }
    if (maximumEntries > 10000) throw new Error("Telemetry entry bound exceeded");
    if (retentionMs < alertCooldownMs) throw new Error("Telemetry retention must cover the alert cooldown");
    Object.assign(this, { now, freshnessBudgetMs, alertCooldownMs, retentionMs, maximumEntries, sink });
    this.sources = new Map();
    this.entries = [];
    this.alerts = new Map();
    this.pending = new Map();
  }
  sourceKey(source) {
    if (typeof source !== "string" || source.length < 1 || source.length > 200)
      throw new Error("Bounded source identity required");
    return hash(source);
  }
  success({ source, stage, latencyMs, revision = null }) {
    if (
      !stages.has(stage) ||
      !Number.isFinite(latencyMs) ||
      latencyMs < 0 ||
      (revision !== null && (typeof revision !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(revision)))
    )
      throw new Error("Invalid telemetry");
    const sourceKey = this.sourceKey(source);
    const at = this.now();
    this.sources.delete(`${sourceKey}:${stage}`);
    this.sources.set(`${sourceKey}:${stage}`, { at, lastSuccessAt: at, failed: false, revision });
    this.entries.push({ at, sourceKey, stage, state: "success", latencyMs, revision });
    return this.purge();
  }
  async failure({ source, stage, code, traceId }) {
    if (
      !stages.has(stage) ||
      typeof code !== "string" ||
      !Object.hasOwn(messages, code) ||
      typeof traceId !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,100}$/.test(traceId)
    )
      throw new Error("Invalid failure telemetry");
    const sourceKey = this.sourceKey(source);
    const at = this.now();
    const existing = this.sources.get(`${sourceKey}:${stage}`);
    const prior = existing && existing.at >= at - this.retentionMs ? existing : null;
    this.sources.delete(`${sourceKey}:${stage}`);
    this.sources.set(`${sourceKey}:${stage}`, {
      at,
      lastSuccessAt: prior?.lastSuccessAt ?? null,
      failed: true,
      revision: prior?.revision ?? null,
    });
    const event = { at, sourceKey, stage, state: "failure", code, traceId, revision: prior?.revision ?? null };
    this.entries.push(event);
    this.purge();
    const key = `${sourceKey}:${code}`;
    // Coalesce simultaneous failures; an alert is recorded as delivered only after the sink acknowledges it.
    if (this.pending.has(key)) return this.pending.get(key);
    if (at - (this.alerts.get(key) ?? -Infinity) < this.alertCooldownMs) return { state: "throttled", sourceKey, code };
    // Reserve one bounded slot per in-flight attempt or acknowledged cooldown identity.
    const reserved = new Set([...this.alerts.keys(), ...this.pending.keys()]);
    if (reserved.size >= this.maximumEntries)
      return { state: "undelivered", sourceKey, code, reason: "destination_capacity_exceeded" };
    if (!this.sink) return { state: "undelivered", sourceKey, code, reason: "approved_alert_destination_missing" };
    const sending = (async () => {
      try {
        const receipt = await Promise.resolve().then(() => this.sink({ ...event, message: messages[code] }));
        if (
          !receipt ||
          receipt.accepted !== true ||
          typeof receipt.id !== "string" ||
          !/^[A-Za-z0-9_.:-]{1,200}$/.test(receipt.id)
        ) {
          return { state: "undelivered", sourceKey, code, reason: "destination_did_not_acknowledge" };
        }
        this.alerts.set(key, this.now());
        this.purge();
        return { state: "delivered", sourceKey, code, receiptId: receipt.id };
      } catch {
        return { state: "undelivered", sourceKey, code, reason: "destination_unavailable" };
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, sending);
    return sending;
  }
  purge() {
    const now = this.now();
    const cutoff = now - this.retentionMs;
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.at >= cutoff).slice(-this.maximumEntries);
    for (const [key, value] of this.sources) if (value.at < cutoff) this.sources.delete(key);
    while (this.sources.size > this.maximumEntries) this.sources.delete(this.sources.keys().next().value);
    for (const [key, at] of this.alerts) if (now - at >= this.alertCooldownMs) this.alerts.delete(key);
    return { removed: before - this.entries.length, retained: this.entries.length };
  }
  status(source, stage = "collection") {
    if (!stages.has(stage)) throw new Error("Invalid telemetry stage");
    this.purge();
    const value = this.sources.get(`${this.sourceKey(source)}:${stage}`);
    if (!value) return { state: "unknown", lagMs: null, revision: null };
    return {
      state: value.failed ? "error" : this.now() - value.lastSuccessAt > this.freshnessBudgetMs ? "stale" : "fresh",
      lagMs: value.lastSuccessAt === null ? null : Math.max(0, this.now() - value.lastSuccessAt),
      revision: value.revision,
    };
  }
  internal() {
    this.purge();
    return structuredClone(this.entries);
  }
}
