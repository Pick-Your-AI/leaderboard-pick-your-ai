import React from "react";
import { Layout } from "./components/Layout.tsx";
import { getMetric } from "./data/registry.ts";
import { matchPath, useRouter } from "./lib/router.tsx";
import { BoardPage } from "./routes/Board.tsx";
import { ActivityPage, ContributionPage, CorrectionsPage } from "./routes/Evidence.tsx";
import { LivePage } from "./routes/Live.tsx";
import { LeaderboardsPage, OverviewPage } from "./routes/Overview.tsx";
import { ContributorsPage, ProfilePage } from "./routes/People.tsx";
import {
  CoveragePage,
  MethodologyChangesPage,
  MethodologyPage,
  MethodSheetPage,
  NotFoundPage,
  ProjectPage,
  PrototypeGuidePage,
} from "./routes/Reference.tsx";

interface Route {
  pattern: string;
  title: (params: Record<string, string>) => string;
  render: (params: Record<string, string>) => React.ReactNode;
}

/** Canonical public routes (docs/UI.md). /account and /admin are later, authenticated work. */
const routes: Route[] = [
  { pattern: "/", title: () => "Overview", render: () => <OverviewPage /> },
  { pattern: "/leaderboards", title: () => "Leaderboards", render: () => <LeaderboardsPage /> },
  {
    pattern: "/leaderboards/:metric",
    title: ({ metric }) => getMetric(metric!)?.name ?? "Leaderboard",
    render: ({ metric }) => (getMetric(metric!) ? <BoardPage key={metric} metricId={metric!} /> : <NotFoundPage />),
  },
  { pattern: "/contributors", title: () => "Contributors", render: () => <ContributorsPage /> },
  { pattern: "/contributors/:login", title: () => "Contributor", render: ({ login }) => <ProfilePage key={login} login={login!} /> },
  { pattern: "/contributions/:id", title: ({ id }) => `Contribution ${id}`, render: ({ id }) => <ContributionPage key={id} id={id!} /> },
  { pattern: "/activity", title: () => "Activity", render: () => <ActivityPage /> },
  { pattern: "/projects/:id", title: () => "Program", render: ({ id }) => <ProjectPage id={id!} /> },
  { pattern: "/methodology", title: () => "Methodology", render: () => <MethodologyPage /> },
  { pattern: "/methodology/changes", title: () => "Policy changes", render: () => <MethodologyChangesPage /> },
  { pattern: "/methodology/:metric", title: ({ metric }) => `${getMetric(metric!)?.name ?? "Method"} method`, render: ({ metric }) => <MethodSheetPage metricId={metric!} /> },
  { pattern: "/coverage", title: () => "Coverage", render: () => <CoveragePage /> },
  { pattern: "/corrections", title: () => "Corrections", render: () => <CorrectionsPage /> },
  { pattern: "/prototype", title: () => "Prototype guide", render: () => <PrototypeGuidePage /> },
];

export function App() {
  const { pathname, search } = useRouter();

  // A configured wall is a full-screen display without site chrome.
  if (matchPath("/live", pathname) && new URLSearchParams(search).has("mode")) return <LivePage />;

  for (const route of routes) {
    const params = matchPath(route.pattern, pathname);
    if (params) return <Layout title={route.title(params)}>{route.render(params)}</Layout>;
  }
  if (matchPath("/live", pathname)) {
    return (
      <Layout title="Live wall">
        <LivePage />
      </Layout>
    );
  }
  return (
    <Layout title="Not found">
      <NotFoundPage />
    </Layout>
  );
}
