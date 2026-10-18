import {
  evidence,
  metadata,
  parameters,
  ReadFailure,
  request,
  uiHref,
  type Evidence,
  type Metadata,
  type Selection,
} from "./client.ts";

export type PublicProof = Evidence & Metadata;

/** Both proof surfaces read and validate the same currently permitted projection. */
export async function readProof(
  base: string,
  id: string,
  selected: Selection,
  signal: AbortSignal,
): Promise<PublicProof> {
  const raw = await request(base, `evidence/${encodeURIComponent(id)}`, parameters(selected), signal);
  const value = evidence(raw, selected);
  if (value.contribution.contributionId !== id) throw new ReadFailure(502, "api_evidence_mismatch");
  return { ...metadata(raw, selected), ...value };
}

export function proofHref(path: string, selected: Selection, id: string): string {
  if (!selected.snapshot) throw new ReadFailure(400, "proof_requires_displayed_snapshot");
  const href = uiHref(path, selected, { cursor: selected.cursor });
  const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
  params.set("proof", id);
  return `${path}?${params}`;
}

export function withoutProof(url: { pathname: string; search: string }): string {
  const params = new URLSearchParams(url.search);
  params.delete("proof");
  params.sort();
  return `${url.pathname}?${params}`;
}

/** A drawer-only history transition preserves the background DOM and cursor. */
export function isProofTransition(
  previous: { pathname: string; search: string },
  next: { pathname: string; search: string },
): boolean {
  return (
    (new URLSearchParams(previous.search).has("proof") || new URLSearchParams(next.search).has("proof")) &&
    withoutProof(previous) === withoutProof(next)
  );
}
