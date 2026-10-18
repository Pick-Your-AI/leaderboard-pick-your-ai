import { parseScope, scopedHref } from "./scope.ts";
import { prototypeHref } from "./prototype-url.ts";
import { scopeContext } from "../data/source.ts";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * A minimal History API router. The URL is the source of truth for both the
 * route and its scope, so back/forward restore exactly what was shown.
 */
interface LocationState {
  pathname: string;
  search: string;
}

interface RouterValue extends LocationState {
  navigate: (to: string, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

function current(): LocationState {
  return { pathname: window.location.pathname, search: window.location.search };
}

export function RouterProvider({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useState<LocationState>(current);

  useEffect(() => {
    const onPop = () => setLocation(current());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string, options: { replace?: boolean } = {}) => {
    const url = new URL(prototypeHref(to), window.location.href);
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
    if (options.replace) window.history.replaceState(null, "", next);
    else window.history.pushState(null, "", next);
    setLocation(current());
  }, []);

  const value = useMemo(() => ({ ...location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error("useRouter must be used inside RouterProvider");
  return value;
}

type LinkProps = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { to: string };

export function Link({ to, onClick, ...rest }: LinkProps) {
  const { navigate } = useRouter();
  const href = prototypeHref(to);
  return (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          rest.target === "_blank"
        ) {
          return;
        }
        event.preventDefault();
        navigate(href);
      }}
    />
  );
}

/** Match "/contributors/:login" style patterns; returns decoded params or null. */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index]!;
    const actual = pathParts[index]!;
    if (expected.startsWith(":")) {
      try {
        params[expected.slice(1)] = decodeURIComponent(actual);
      } catch {
        return null;
      }
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

/** Ordinary cross-route links preserve filters and an immutable snapshot pin. */
export function ScopedLink({ to, ...rest }: LinkProps) {
  const { search } = useRouter();
  const { scope } = parseScope(search, scopeContext);
  return <Link {...rest} to={scopedHref(to, scope)} />;
}
