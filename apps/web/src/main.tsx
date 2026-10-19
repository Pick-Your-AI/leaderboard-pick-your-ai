import React from "react";
import { createRoot } from "react-dom/client";
import { applyThemePreference, readThemePreference } from "./lib/theme.ts";
import { prototypeNavigation } from "./lib/prototype-url.ts";
import "./styles/tokens.css";
import "./styles/app.css";

applyThemePreference(readThemePreference());

const root = createRoot(document.getElementById("root")!);
let mode = new URLSearchParams(location.search).get("ui");
try {
  if (mode === "prototype" || mode === "api") localStorage.setItem("pyai.ui.mode", mode);
  else mode = localStorage.getItem("pyai.ui.mode") ?? import.meta.env.VITE_UI_MODE;
} catch {
  mode ??= import.meta.env.VITE_UI_MODE;
}
if (["/account", "/admin"].includes(location.pathname.replace(/\/+$/, ""))) {
  void import("./controls/App.tsx").then(({ ControlsApp }) => root.render(<ControlsApp />));
} else if (location.pathname === "/start") {
  // New-entry discovery runs before any snapshot reader or persisted prototype mode.
  void import("./remote/PublishedWindows.tsx").then(({ PublishedWindowStart }) =>
    root.render(
      <React.StrictMode>
        <PublishedWindowStart base={import.meta.env.VITE_PUBLIC_API_BASE || "/api/v1"} search={location.search} />
      </React.StrictMode>,
    ),
  );
} else if (mode === "prototype") {
  const path = `${location.pathname}${location.search}${location.hash}`;
  const { href } = prototypeNavigation(path);
  if (href !== path) history.replaceState(history.state, "", href);
  // Fixture modules are loaded only after the reader explicitly selects them.
  void Promise.all([import("./App.tsx"), import("./lib/router.tsx")]).then(([{ App }, { RouterProvider }]) =>
    root.render(
      <React.StrictMode>
        <RouterProvider>
          <App />
        </RouterProvider>
      </React.StrictMode>,
    ),
  );
} else if (location.pathname === "/live") {
  void import("./remote/Wall.tsx").then(({ RemoteWall }) =>
    root.render(
      <React.StrictMode>
        <RemoteWall />
      </React.StrictMode>,
    ),
  );
} else {
  // Keep the static fallback until the selected application's module is ready.
  void import("./remote/App.tsx").then(({ RemoteApp }) =>
    root.render(
      <React.StrictMode>
        <RemoteApp />
      </React.StrictMode>,
    ),
  );
}
