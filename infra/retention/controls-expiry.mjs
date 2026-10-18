import { createHash } from "node:crypto";

/** Protected host job. Existing authentication deadlines are the retention policy. */
export async function expireControlsAuthentication(store, { receiptId, cutoff, authorize, now = Date.now }) {
  if (
    !store?.transaction ||
    typeof receiptId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(receiptId) ||
    !Number.isSafeInteger(cutoff) ||
    cutoff < 0 ||
    cutoff > now() ||
    typeof authorize !== "function"
  )
    throw new Error("invalid_authentication_expiry_request");
  const binding = createHash("sha256")
    .update(JSON.stringify([receiptId, cutoff]))
    .digest("hex");
  if ((await authorize({ receiptId, cutoff, operation: "expire_authentication" })) !== true)
    throw new Error("authentication_expiry_not_authorized");
  return store.transaction((state) => {
    const existing = state.authenticationExpiryReceipts?.[receiptId];
    if (existing) {
      if (existing.binding !== binding) throw new Error("authentication_expiry_receipt_conflict");
      return structuredClone(existing);
    }
    const receipts = state.authenticationExpiryReceipts ?? {};
    if (Object.keys(receipts).length >= 10000) throw new Error("authentication_expiry_receipt_budget_exceeded");
    const counts = { sessions: 0, oauth: 0 };
    for (const family of ["sessions", "oauth"]) {
      for (const [key, value] of Object.entries(state[family] ?? {})) {
        // Malformed expiry does not authorize deletion of an unknown record.
        if (Number.isSafeInteger(value?.expires) && value.expires >= 0 && value.expires <= cutoff) {
          delete state[family][key];
          counts[family]++;
        }
      }
    }
    const receipt = { schemaVersion: "authentication-expiry/v1", receiptId, binding, cutoff, ...counts };
    state.authenticationExpiryReceipts = { ...receipts, [receiptId]: receipt };
    return structuredClone(receipt);
  });
}
