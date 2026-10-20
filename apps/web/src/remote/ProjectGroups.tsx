import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { uiHref, type Evidence, type Selection } from "./client.ts";

const groupPageSize = 10;
const referencePageSize = 20;
import { projectGroups } from "./project-groups.ts";

function Context({ proof }: { proof: Evidence }) {
  const context = proof.projectContext;
  if (!context || context.state === "unknown") return <p>Project membership unavailable for this evidence.</p>;
  return (
    <p>
      {context.projects.length === 0
        ? context.basis === "current"
          ? "No membership in the verified Project scope for this current observation"
          : "No membership in this event’s verified Project scope"
        : context.basis === "current"
          ? "Current membership observed"
          : "Membership in this event’s verified Project scope observed"}{" "}
      at <time dateTime={context.observedAt!}>{context.observedAt}</time>.
    </p>
  );
}

/** Only ten headings and one twenty-row reference/scope page are mounted. */
export function ProjectGroups({ evidence, selected }: { evidence: Evidence[]; selected: Selection }) {
  const groups = useMemo(() => projectGroups(evidence), [evidence]);
  const [groupPage, setGroupPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [referencePage, setReferencePage] = useState(0);
  const [scopeProofId, setScopeProofId] = useState<string | null>(null);
  const [scopePage, setScopePage] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusRequested = useRef(false);
  const id = useId();
  useEffect(() => {
    if (focusRequested.current) {
      focusRequested.current = false;
      heading.current?.focus();
    }
  }, [groupPage, expanded, referencePage, scopeProofId, scopePage]);
  const focus = () => {
    focusRequested.current = true;
  };
  const moveGroups = (next: number) => {
    focus();
    setGroupPage(next);
    setExpanded(null);
    setReferencePage(0);
    setScopeProofId(null);
    setScopePage(0);
  };
  const start = groupPage * groupPageSize;
  const visible = groups.slice(start, start + groupPageSize);
  return (
    <section aria-label="Project groups on this timeline page">
      <h3 tabIndex={-1} ref={heading}>
        Projects on this timeline page
      </h3>
      <p>
        These groups use verified Project membership supplied for each evidence record. Repository names and selected
        filters do not establish membership. A record may appear in several groups; group counts must not be added. The
        timeline lists each record once; each measure has its own count. These are collection observations, not live
        membership claims. Event dates remain separately visible in the evidence receipts.
      </p>
      <p role="status" aria-live="polite">
        {groups.length === 0
          ? "No evidence on this timeline page."
          : `Groups ${start + 1}–${start + visible.length} of ${groups.length} on this timeline page.`}
      </p>
      {visible.map((group, index) => {
        const open = expanded === group.key;
        const scopeProof = open
          ? group.proofs.find((proof) => proof.contribution.contributionId === scopeProofId)
          : undefined;
        const referenceStart = referencePage * referencePageSize;
        const references = group.proofs.slice(referenceStart, referenceStart + referencePageSize);
        const scope = scopeProof?.projectContext?.projectScope ?? [];
        const scopeStart = scopePage * referencePageSize;
        return (
          <section key={group.key} className="section" style={{ overflowWrap: "anywhere" }}>
            <h4>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={open ? `${id}-${index}` : undefined}
                onClick={() => {
                  focus();
                  setExpanded(open ? null : group.key);
                  setReferencePage(0);
                  setScopeProofId(null);
                  setScopePage(0);
                }}
              >
                {group.state === "project"
                  ? `Project ${group.projectId}`
                  : group.state === "empty"
                    ? "No membership in verified scope"
                    : "Project membership unavailable"}
              </button>
            </h4>
            {group.state === "project" && <p>Project name and link not supplied.</p>}
            <p>{group.proofs.length} evidence records on this timeline page.</p>
            {open && (
              <div id={`${id}-${index}`}>
                {scopeProof ? (
                  <>
                    <h5>Verified Project scope for this evidence</h5>
                    <Context proof={scopeProof} />
                    <p role="status" aria-live="polite">
                      Scope IDs {scopeStart + 1}–{Math.min(scopeStart + referencePageSize, scope.length)} of{" "}
                      {scope.length}.
                    </p>
                    <ul>
                      {scope.slice(scopeStart, scopeStart + referencePageSize).map((projectId) => (
                        <li key={projectId}>{projectId}</li>
                      ))}
                    </ul>
                    <nav aria-label="Verified Project scope pages">
                      <button
                        type="button"
                        disabled={scopePage === 0}
                        onClick={() => {
                          focus();
                          setScopePage(scopePage - 1);
                        }}
                      >
                        Previous scope page
                      </button>
                      <button
                        type="button"
                        disabled={scopeStart + referencePageSize >= scope.length}
                        onClick={() => {
                          focus();
                          setScopePage(scopePage + 1);
                        }}
                      >
                        Next scope page
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          focus();
                          setScopeProofId(null);
                          setScopePage(0);
                        }}
                      >
                        Back to group references
                      </button>
                    </nav>
                  </>
                ) : (
                  <>
                    <p role="status" aria-live="polite">
                      References {referenceStart + 1}–{referenceStart + references.length} of {group.proofs.length} on
                      this timeline page.
                    </p>
                    <ul aria-label="Project evidence references">
                      {references.map((proof) => (
                        <li key={proof.contribution.contributionId}>
                          <a
                            data-api-nav
                            href={uiHref(
                              `/contributions/${encodeURIComponent(proof.contribution.contributionId)}`,
                              selected,
                            )}
                          >
                            {proof.contribution.contributionId}
                          </a>
                          <Context proof={proof} />
                          {proof.projectContext?.state === "known" && (
                            <button
                              type="button"
                              onClick={() => {
                                focus();
                                setScopeProofId(proof.contribution.contributionId);
                                setScopePage(0);
                              }}
                            >
                              View verified Project scope
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                    <nav aria-label="Project evidence reference pages">
                      <button
                        type="button"
                        disabled={referencePage === 0}
                        onClick={() => {
                          focus();
                          setReferencePage(referencePage - 1);
                        }}
                      >
                        Previous reference page
                      </button>
                      <button
                        type="button"
                        disabled={referenceStart + referencePageSize >= group.proofs.length}
                        onClick={() => {
                          focus();
                          setReferencePage(referencePage + 1);
                        }}
                      >
                        Next reference page
                      </button>
                    </nav>
                  </>
                )}
              </div>
            )}
          </section>
        );
      })}
      {groups.length > groupPageSize && (
        <nav aria-label="Project group pages">
          <button type="button" disabled={groupPage === 0} onClick={() => moveGroups(groupPage - 1)}>
            Previous group page
          </button>
          <button
            type="button"
            disabled={start + groupPageSize >= groups.length}
            onClick={() => moveGroups(groupPage + 1)}
          >
            Next group page
          </button>
        </nav>
      )}
    </section>
  );
}
