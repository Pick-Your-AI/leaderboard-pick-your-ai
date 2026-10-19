import React, { useEffect, useId, useRef, useState } from "react";
import { uiHref, type Selection } from "./client.ts";
import type { spotlights } from "./recognition-client.ts";

export function FirstContributionsEntry({ selected }: { selected: Selection }) {
  const scope = { ...selected, search: null, category: null, catalogQuery: null, department: null, cursor: null };
  return (
    <section className="section" aria-labelledby="overview-first-contributions-title">
      <h2 id="overview-first-contributions-title">First contributions</h2>
      <p>
        Explore the unranked contributor directory, then open a profile's Reviewed organization history to check its
        first qualifying contribution when reviewed history is available.
      </p>
      <p>
        Missing history does not establish zero activity or newcomer status. Recent accepted work alone does not
        identify newcomers, and this entry does not certify a newcomer cohort.
      </p>
      <p>
        <a data-api-nav href={uiHref("/contributors", scope)}>
          Find contributors and inspect their history
        </a>
      </p>
    </section>
  );
}

/** Display only current approved items, in the authoritative response order. */
export function EditorialRotation({ items }: { items: ReturnType<typeof spotlights> }) {
  const [activeId, setActiveId] = useState<string | null>(() => items[0]?.id ?? null);
  const found = items.findIndex((item) => item.id === activeId);
  const index = found < 0 ? 0 : found;
  const item = items[index];
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const focusedCard = useRef(false);
  const previousId = useRef(item?.id);
  useEffect(() => {
    // Same-item refreshes preserve proof focus. A removed selection cannot leave
    // a focused proof silently pointing at another contributor's evidence.
    if (previousId.current !== item?.id && focusedCard.current) heading.current?.focus();
    previousId.current = item?.id;
    if (found < 0) setActiveId(item?.id ?? null);
  }, [found, item?.id]);
  if (!item) return null;
  const move = (direction: number) => setActiveId(items[(index + direction + items.length) % items.length]!.id);
  return (
    <div style={{ overflowWrap: "anywhere", minWidth: 0 }}>
      <p id={`${id}-position`}>
        Spotlight {index + 1} of {items.length}.
      </p>
      <p>
        Browse the approved server order: categories rotate in turn, with the oldest reviewed selection first within
        each category. Change selections with the controls; there is no automatic rotation or ranking.
      </p>
      <div role="group" aria-label="Editorial spotlight controls">
        <button type="button" aria-controls={`${id}-item`} disabled={items.length < 2} onClick={() => move(-1)}>
          Previous spotlight
        </button>{" "}
        <button type="button" aria-controls={`${id}-item`} disabled={items.length < 2} onClick={() => move(1)}>
          Next spotlight
        </button>
      </div>
      <article
        id={`${id}-item`}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-position`}
        onFocusCapture={() => {
          focusedCard.current = true;
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) focusedCard.current = false;
        }}
      >
        <h3 id={`${id}-title`} ref={heading} tabIndex={-1}>
          {item.category}
        </h3>
        {item.bio && <p>{item.bio}</p>}
        <p style={{ whiteSpace: "pre-wrap" }}>{item.selectionExplanation}</p>
        <p>
          Selected <time dateTime={item.selectedAt}>{item.selectedAt}</time>.
        </p>
        <a href={item.sourceUrl} rel="noreferrer nofollow">
          Reviewed public evidence
        </a>
      </article>
    </div>
  );
}
