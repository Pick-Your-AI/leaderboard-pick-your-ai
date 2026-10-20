import type { Evidence } from "./client.ts";

export type Group = {
  key: string;
  projectId: string | null;
  state: "project" | "empty" | "unknown";
  proofs: Evidence[];
};

/** Groups reference the current page's unique proofs; overlap never becomes a total. */
export function projectGroups(evidence: Evidence[]): Group[] {
  const groups = new Map<string, Group>();
  const append = (key: string, state: Group["state"], projectId: string | null, proof: Evidence) => {
    let group = groups.get(key);
    if (!group) {
      group = { key, state, projectId, proofs: [] };
      groups.set(key, group);
    }
    if (!group.proofs.some((entry) => entry.contribution.contributionId === proof.contribution.contributionId))
      group.proofs.push(proof);
  };
  for (const proof of evidence) {
    const context = proof.projectContext;
    if (!context || context.state === "unknown") append("unknown", "unknown", null, proof);
    else if (context.projects.length === 0) append("empty", "empty", null, proof);
    else for (const id of context.projects) append(JSON.stringify(["project", id]), "project", id, proof);
  }
  const order = { project: 0, empty: 1, unknown: 2 };
  return [...groups.values()].sort(
    (a, b) =>
      order[a.state] - order[b.state] ||
      (a.projectId === b.projectId ? 0 : (a.projectId ?? "") < (b.projectId ?? "") ? -1 : 1),
  );
}
