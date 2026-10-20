import React, { useEffect, useRef, useState } from "react";
import { workstreamHelpUnit } from "@pick-your-ai/contracts";
import { request, uiHref, type Selection } from "./client.ts";
import { workstreamHelpPage, workstreamHelpParameters } from "./workstream-help-client.ts";

type HelpPage = ReturnType<typeof workstreamHelpPage>;
export function WorkstreamHelp({
  base,
  selected,
  snapshotId,
  actorId,
}: {
  base: string;
  selected: Selection;
  snapshotId: string;
  actorId: string;
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<{ key: string; value?: HelpPage; error?: boolean }>({ key: "" });
  const focusPage = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const error = useRef<HTMLParagraphElement>(null);
  const pinned = { ...selected, snapshot: snapshotId, limit: "20", cursor: null };
  const params = workstreamHelpParameters(selected, snapshotId, cursors.at(-1) ?? null);
  const key = JSON.stringify([base, actorId, params.toString()]);
  const state: typeof loaded = loaded.key === key ? loaded : { key };
  useEffect(() => {
    let stopped = false;
    let current: AbortController | undefined;
    const refresh = async () => {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      if (document.hidden) {
        setLoaded({ key });
        return;
      }
      setLoaded((prior) => (prior.key === key && prior.value ? prior : { key }));
      try {
        const value = workstreamHelpPage(
          await request(
            base,
            "contributors/" + encodeURIComponent(actorId) + "/workstream-help",
            params,
            controller.signal,
          ),
          pinned,
          actorId,
        );
        if (!stopped && !controller.signal.aborted) setLoaded({ key, value });
      } catch {
        if (!stopped && !controller.signal.aborted) setLoaded({ key, error: true });
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    const visible = () => void refresh();
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      current?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
    // Every request input is captured in key; ordinary renders must not restart reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (focusPage.current && (state.value || state.error)) {
      (state.error ? error.current : heading.current)?.focus();
      focusPage.current = false;
    }
  }, [key, state.value, state.error]);
  const move = (next: string[]) => {
    focusPage.current = true;
    setCursors(next);
  };
  const value = state.value;
  return (
    <section aria-labelledby="workstream-help-title" aria-live="polite" style={{ overflowWrap: "anywhere" }}>
      <h3 id="workstream-help-title" ref={heading} tabIndex={-1}>
        Reviewed cross-workstream help
      </h3>
      {state.error ? (
        <p ref={error} tabIndex={-1}>
          Reviewed help is unavailable for this selection. Recheck the current evidence.
        </p>
      ) : !value ? (
        <p>Checking reviewed help…</p>
      ) : (
        <>
          <p>{value.meaning}</p>
          <p>
            Rule: {value.ruleVersion}. {value.totalRecognitions} recorded events in this selection. Page{" "}
            {cursors.length + 1}.
          </p>
          {value.recognitions.length === 0 ? (
            <p>No qualifying reviewed help is available on this page. Other help may be unrecorded.</p>
          ) : (
            <ul>
              {value.recognitions.map(({ help, proof }) => (
                <li key={workstreamHelpUnit(help)}>
                  <h4>
                    From {help.statement.from.label} to {help.statement.to.label}
                  </h4>
                  <p>
                    Accepted authored change. Source occurrence:{" "}
                    <time dateTime={proof.occurredAt}>{proof.occurredAt}</time>. Accepted:{" "}
                    <time dateTime={help.acceptedAt}>{help.acceptedAt}</time>. Help reviewed:{" "}
                    <time dateTime={help.reviewedAt}>{help.reviewedAt}</time>.
                  </p>
                  <p>Workstream definitions: {help.statement.definitionVersion}.</p>
                  <p>
                    <a
                      data-api-nav
                      href={uiHref("/contributions/" + encodeURIComponent(proof.contributionId), pinned, {
                        cursor: null,
                      })}
                    >
                      Inspect qualifying contribution
                    </a>
                  </p>
                  <p>
                    <a href={help.statementUrl} rel="noreferrer nofollow">
                      Read the immutable reviewed help statement
                    </a>
                  </p>
                  <a href={proof.sourceUrl} rel="noreferrer nofollow">
                    Qualifying public artifact
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {(value?.nextCursor || cursors.length > 0) && (
        <nav aria-label="Reviewed help pages">
          {cursors.length > 0 && (
            <button type="button" onClick={() => move(cursors.slice(0, -1))}>
              Previous help page
            </button>
          )}
          {value?.nextCursor && (
            <button type="button" onClick={() => move([...cursors, value.nextCursor!])}>
              Next help page
            </button>
          )}
          {cursors.length > 0 && (
            <button type="button" onClick={() => move([])}>
              Restart help list
            </button>
          )}
        </nav>
      )}
    </section>
  );
}
