import { PublicReadError, type PortfolioEvidence } from "./public-source.js";

// The existing browser reader bounds the complete UTF-8 response to this value.
export const profileResponseByteLimit = 2_000_000;

/** Page complete proofs without dropping fixed metadata or changing cursor offsets. */
export function profilePage(
  evidence: PortfolioEvidence[],
  offset: number,
  limit: number,
  envelope: Record<string, unknown>,
  cursorAt: (offset: number) => string,
) {
  const body = (timeline: PortfolioEvidence[], nextCursor: string | null) => ({
    ...envelope,
    timeline,
    nextCursor,
    timelineTruncated: nextCursor !== null,
    evidenceIds: timeline.map((entry) => entry.contribution.contributionId),
  });
  const fixedBytes = Buffer.byteLength(JSON.stringify(body([], null)));
  const candidates = evidence.slice(offset, offset + limit);
  let proofBytes = 0;
  let idBytes = 0;
  let selectedCount = 0;
  let selectedCursor: string | null = null;
  for (let index = 0; index < candidates.length; index++) {
    const proof = candidates[index]!;
    proofBytes += Buffer.byteLength(JSON.stringify(proof));
    idBytes += Buffer.byteLength(JSON.stringify(proof.contribution.contributionId));
    const count = index + 1;
    const nextCursor = offset + count < evidence.length ? cursorAt(offset + count) : null;
    // The empty envelope already includes []/[] and null/false. Account for both
    // arrays' commas and the actual cursor. A final null cursor may be smaller.
    const size =
      fixedBytes +
      proofBytes +
      idBytes +
      2 * index +
      Buffer.byteLength(JSON.stringify(nextCursor)) -
      4 +
      (nextCursor === null ? 0 : -1);
    if (size <= profileResponseByteLimit) {
      selectedCount = count;
      selectedCursor = nextCursor;
    }
  }
  if ((candidates.length > 0 && selectedCount === 0) || fixedBytes > profileResponseByteLimit)
    throw new PublicReadError(503, "profile_response_too_large");
  const result = body(candidates.slice(0, selectedCount), selectedCursor);
  if (Buffer.byteLength(JSON.stringify(result)) > profileResponseByteLimit)
    throw new PublicReadError(503, "profile_response_too_large");
  return result;
}
