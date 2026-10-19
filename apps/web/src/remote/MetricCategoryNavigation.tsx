import React, { useEffect, useRef, useState } from "react";
import type { getRegistryDepartments } from "@pick-your-ai/metrics";
import { uiHref, type Selection } from "./client.ts";

const categoriesPerPage = 12;

/** Definition navigation only. A category never grants source availability. */
export function MetricCategoryNavigation({
  departments,
  selected,
  path,
}: {
  departments: ReturnType<typeof getRegistryDepartments>;
  selected: Selection;
  path: string;
}) {
  const identity = JSON.stringify(departments.map((department) => department.id));
  const selectedIndex = departments.findIndex((department) => department.id === selected.department);
  const initialPage = Math.floor(Math.max(selectedIndex, 0) / categoriesPerPage);
  const [stored, setStored] = useState({ identity, page: initialPage });
  const lastPage = Math.max(0, Math.ceil(departments.length / categoriesPerPage) - 1);
  const page = stored.identity === identity ? Math.min(stored.page, lastPage) : initialPage;
  const status = useRef<HTMLParagraphElement>(null);
  const focusAfterPage = useRef(false);
  useEffect(() => {
    if (!focusAfterPage.current) return;
    status.current?.focus();
    focusAfterPage.current = false;
  }, [identity, page]);
  if (!departments.length)
    return <p>Category navigation is unavailable in this registry. The complete metric catalog remains below.</p>;
  const move = (next: number) => {
    focusAfterPage.current = true;
    setStored({ identity, page: next });
  };
  return (
    <nav aria-label="Metric categories">
      <p>Browse the registry's departments. Category selection filters definitions, not contribution evidence.</p>
      <ul className="inline-list">
        <li>
          <a
            className="button button-ghost"
            data-api-nav
            aria-current={selected.department == null ? "page" : undefined}
            href={uiHref(path, { ...selected, department: null }, { cursor: null })}
          >
            All departments
          </a>
        </li>
        {departments.slice(page * categoriesPerPage, (page + 1) * categoriesPerPage).map((department) => (
          <li key={department.id} style={{ minWidth: 0, maxWidth: "100%" }}>
            <a
              className="button button-ghost"
              data-api-nav
              aria-current={selected.department === department.id ? "page" : undefined}
              href={uiHref(path, { ...selected, department: department.id }, { cursor: null })}
              style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}
            >
              {department.label}
            </a>
          </li>
        ))}
      </ul>
      {lastPage > 0 && (
        <>
          <p ref={status} role="status" tabIndex={-1}>
            Category page {page + 1} of {lastPage + 1}; at most {categoriesPerPage} departments per page. This pages
            definitions, not contributor ranks.
          </p>
          <div className="inline-list">
            {page > 0 && (
              <button type="button" onClick={() => move(page - 1)}>
                Previous categories
              </button>
            )}
            {page < lastPage && (
              <button type="button" onClick={() => move(page + 1)}>
                Next categories
              </button>
            )}
          </div>
        </>
      )}
    </nav>
  );
}
