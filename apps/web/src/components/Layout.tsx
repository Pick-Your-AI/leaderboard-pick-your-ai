import React, { useEffect, useRef, useState } from "react";
import { useRouter, ScopedLink } from "../lib/router.tsx";
import { applyThemePreference, readThemePreference, type ThemePreference } from "../lib/theme.ts";
import { SYNTHETIC_DATASET_ID } from "../data/synthetic.ts";

const navigation = [
  { to: "/", label: "Overview", match: (path: string) => path === "/" },
  { to: "/leaderboards", label: "Leaderboards", match: (path: string) => path.startsWith("/leaderboards") },
  { to: "/contributors", label: "Contributors", match: (path: string) => path.startsWith("/contributors") },
  { to: "/activity", label: "Activity", match: (path: string) => path.startsWith("/activity") || path.startsWith("/contributions") },
  { to: "/methodology", label: "Methodology", match: (path: string) => path.startsWith("/methodology") },
  { to: "/coverage", label: "Coverage", match: (path: string) => path.startsWith("/coverage") },
  { to: "/live", label: "Live wall", match: (path: string) => path.startsWith("/live") },
];

/** Persistent on every route: the prototype must never be mistaken for real rankings. */
export function SyntheticDataBanner() {
  return (
    <aside className="synthetic-banner" aria-label="Synthetic data notice">
      <strong>Synthetic prototype data.</strong> Every person, repository, count and rank here is invented for design
      evaluation ({SYNTHETIC_DATASET_ID}). <ScopedLink to="/prototype">What this prototype shows</ScopedLink>
    </aside>
  );
}

function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);
  useEffect(() => applyThemePreference(preference), [preference]);
  return (
    <label className="theme-toggle">
      <span>Theme</span>
      <select value={preference} onChange={(event) => setPreference(event.target.value as ThemePreference)}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}

export function Layout({ children, title }: { children: React.ReactNode; title: string }) {
  const { pathname } = useRouter();
  const mainRef = useRef<HTMLElement>(null);
  const previousPath = useRef(pathname);

  useEffect(() => {
    document.title = `${title} · PickYour.AI Credits (prototype)`;
  }, [title]);

  // Move focus to the page heading on route change, not on scope changes.
  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    const heading = mainRef.current?.querySelector<HTMLElement>("h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: false });
    }
    window.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SyntheticDataBanner />
      <header className="app-header">
        <div className="header-inner">
          <ScopedLink to="/" className="wordmark">
            <span aria-hidden="true" className="wordmark-mark">
              ▚
            </span>{" "}
            PickYour.AI <span className="wordmark-product">Credits</span>
          </ScopedLink>
          <nav aria-label="Primary">
            <ul>
              {navigation.map((item) => (
                <li key={item.to}>
                  <ScopedLink to={item.to} aria-current={item.match(pathname) ? "page" : undefined}>
                    {item.label}
                  </ScopedLink>
                </li>
              ))}
            </ul>
          </nav>
          <ThemeToggle />
        </div>
      </header>
      <main id="main" ref={mainRef} className="page">
        {children}
      </main>
      <footer className="app-footer">
        <div className="footer-inner">
          <p>
            Contributions, with evidence. No overall score, no streaks. <ScopedLink to="/methodology">How counting works</ScopedLink> ·{" "}
            <ScopedLink to="/corrections">Corrections</ScopedLink> · <ScopedLink to="/prototype">Prototype guide</ScopedLink>
          </p>
          <p className="muted">
            Browsing is anonymous. A user-account event does not establish manual authorship or the absence of AI assistance.
          </p>
        </div>
      </footer>
    </>
  );
}

export function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="page-header">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {children && <div className="lede">{children}</div>}
    </div>
  );
}
