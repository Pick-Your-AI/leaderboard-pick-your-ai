import { verifiedIdentityCorrectionProposalSchema } from "./identity-corrections.js";

export const verifiedIdentityCorrectionProposalEncodingVersion = "leaderboard-verified-identity-correction-proposal/v1";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Encode a strict, detached proposal using the documented versioned UTF-8 format. */
export function encodeVerifiedIdentityCorrectionProposal(input: unknown): Uint8Array<ArrayBuffer> {
  const proposal = verifiedIdentityCorrectionProposalSchema.parse(input);
  return new TextEncoder().encode(`${verifiedIdentityCorrectionProposalEncodingVersion}\n${canonicalJson(proposal)}`);
}

/** Bind proposal content only; this does not verify proofs, reviewer authority or application. */
export async function digestVerifiedIdentityCorrectionProposal(input: unknown): Promise<string> {
  // Complete validation and private byte allocation before yielding to the caller.
  const bytes = encodeVerifiedIdentityCorrectionProposal(input);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("SHA-256 requires Web Crypto SubtleCrypto.");
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
