import React from "react";
import { Link } from "../lib/router.tsx";

/** A displayed contribution value is itself a keyboard and touch route to its proof. */
export function CountLink({ to, label, children }: { to: string; label: string; children: React.ReactNode }) {
  return (
    <Link to={to} className="count-link" aria-label={`${label}. Open fixture explanation`}>
      {children}
    </Link>
  );
}
