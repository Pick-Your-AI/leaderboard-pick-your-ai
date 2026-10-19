import React, { useEffect, useRef, useState } from "react";
import { ReadFailure, type Selection } from "./client.ts";
import {
  readEditorialDimensions,
  type EditorialCard,
  type EditorialDimensionsResult,
} from "./editorial-rotation-client.ts";

function Assessment({ card }: { card: EditorialCard }) {
  const period = card.candidate.newcomerPeriod;
  if (!period) return null;
  const assessment = card.assessment;
  return (
    <div>
      <p>
        Dated newcomer assessment: <time dateTime={period.start}>{period.start}</time> inclusive to{" "}
        <time dateTime={period.end}>{period.end}</time> exclusive.
      </p>
      {assessment.state === "known" ? (
        <>
          <p>
            The first qualifying accepted contribution in reviewed organization history falls{" "}
            {assessment.value.history.newcomer ? "inside" : "outside"} this exact period. This is not a
            current-newcomer, joining-date or first-ever claim.
          </p>
          <p>
            First qualifying source occurrence:{" "}
            <time dateTime={assessment.value.history.firstProof.proof.occurredAt}>
              {assessment.value.history.firstProof.proof.occurredAt}
            </time>
            .{" "}
            <a href={assessment.value.history.firstProof.proof.sourceUrl} rel="noreferrer nofollow">
              Reviewed first-proof source
            </a>
          </p>
        </>
      ) : (
        <p>
          History assessment unknown for this period. No newcomer status is asserted.
          {assessment.state === "unknown" && <span> Availability: {assessment.reason.replaceAll("_", " ")}.</span>}
        </p>
      )}
    </div>
  );
}

export function EditorialDimensions({
  controlsBase,
  publicBase,
  organization,
  selected,
}: {
  controlsBase: string;
  publicBase: string;
  organization: string;
  selected: Selection;
}) {
  const key = JSON.stringify([controlsBase, publicBase, organization, selected]);
  const [state, setState] = useState<{ key: string; value?: EditorialDimensionsResult; error?: boolean }>({ key });
  const [activeSelection, setActiveSelection] = useState<{ key: string; id: string | null }>({ key, id: null });
  const [retry, setRetry] = useState(0);
  const region = useRef<HTMLDivElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  const pendingFocus = useRef(false);
  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    const refresh = async () => {
      controller?.abort();
      const attempt = new AbortController();
      controller = attempt;
      if (region.current?.contains(document.activeElement)) pendingFocus.current = true;
      setState({ key });
      if (document.hidden) return;
      try {
        const base = new URL(controlsBase, location.origin);
        if (
          base.origin !== location.origin ||
          base.pathname !== "/controls" ||
          base.search ||
          base.hash ||
          base.username ||
          base.password
        )
          throw new ReadFailure(500, "invalid_controls_configuration");
        const value = await readEditorialDimensions(base.href, publicBase, organization, selected, attempt.signal);
        if (active && controller === attempt && !attempt.signal.aborted && !document.hidden) {
          setActiveSelection((previous) => ({
            key,
            id:
              previous.key === key && value.ordered.some((card) => card.candidate.id === previous.id)
                ? previous.id
                : (value.ordered[0]?.candidate.id ?? null),
          }));
          setState({ key, value });
        }
      } catch {
        if (active && controller === attempt && !attempt.signal.aborted && !document.hidden)
          setState({ key, error: true });
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
    // key contains all immutable request inputs; a new read retires the old generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);
  const current = state.key === key ? state : null;
  const result = current?.value;
  const activeId = activeSelection.key === key ? activeSelection.id : null;
  const index = Math.max(0, result?.ordered.findIndex((card) => card.candidate.id === activeId) ?? 0);
  const card = result?.ordered[index];
  useEffect(() => {
    if (pendingFocus.current && (result || current?.error)) {
      pendingFocus.current = false;
      if (document.activeElement === document.body || !document.activeElement?.isConnected) heading.current?.focus();
    }
  }, [result, current?.error]);
  const move = (direction: number) => {
    if (result?.ordered.length)
      setActiveSelection({
        key,
        id: result.ordered[(index + direction + result.ordered.length) % result.ordered.length]!.candidate.id,
      });
  };
  return (
    <div ref={region} style={{ overflowWrap: "anywhere", minWidth: 0 }} aria-live="polite">
      <h3 ref={heading} tabIndex={-1}>
        Reviewed editorial dimensions
      </h3>
      <p>
        Editorial workstream descriptions rotate in UTF-8 name order, followed by behind-the-scenes and qualifying dated
        history assessments. Each lane uses the oldest selection first; each nomination appears once. These are reviewed
        descriptions, not mapped membership or rankings.
      </p>
      {current?.error ? (
        <>
          <p role="alert">Current dimension selections are unavailable. Previous history results have been cleared.</p>
          <button onClick={() => setRetry((n) => n + 1)}>Retry dimension read</button>
        </>
      ) : !result ? (
        <p>Checking current consent, descriptions and separately pinned history…</p>
      ) : (
        <>
          {!card ? (
            <p>
              No currently confirmed editorial dimension is available. Category-only spotlights remain available in the
              other view.
            </p>
          ) : (
            <>
              <p>
                Dimension spotlight {index + 1} of {result.ordered.length}.
              </p>
              <div role="group" aria-label="Editorial dimension navigation">
                <button disabled={result.ordered.length < 2} onClick={() => move(-1)}>
                  Previous dimension spotlight
                </button>{" "}
                <button disabled={result.ordered.length < 2} onClick={() => move(1)}>
                  Next dimension spotlight
                </button>
              </div>
              <article>
                <h4>
                  {card.candidate.workstreams.length
                    ? `Editorial workstream: ${card.candidate.workstreams.join("; ")}`
                    : card.candidate.behindScenes
                      ? "Reviewed behind-the-scenes contribution"
                      : "Dated newcomer assessment"}
                </h4>
                <p>{card.candidate.label}</p>
                {card.candidate.behindScenes && <p>Independently reviewed behind-the-scenes description.</p>}
                {card.candidate.bio && <p>{card.candidate.bio}</p>}
                <p>{card.candidate.selectionExplanation}</p>
                <p>{card.candidate.classificationExplanation}</p>
                <p>
                  Selected <time dateTime={card.candidate.selectedAt}>{card.candidate.selectedAt}</time>.
                </p>
                <a href={card.candidate.sourceUrl} rel="noreferrer nofollow">
                  Reviewed dimension evidence
                </a>
                <Assessment card={card} />
              </article>
            </>
          )}
          {result.cards.some((c) => c.candidate.newcomerPeriod !== null) && (
            <details>
              <summary>Dated history assessment availability</summary>
              <p>Different requested periods are separate editorial assessments, not one cohort or denominator.</p>
              {result.cards
                .filter((c) => c.candidate.newcomerPeriod !== null)
                .map((c) => (
                  <div key={c.candidate.id}>
                    <h4>Nomination {c.candidate.id}</h4>
                    <Assessment card={c} />
                  </div>
                ))}
            </details>
          )}
        </>
      )}
    </div>
  );
}
