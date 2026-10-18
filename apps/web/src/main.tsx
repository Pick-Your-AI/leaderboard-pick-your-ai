import React from "react";
import { createRoot } from "react-dom/client";
import { RemoteApp } from "./remote/App.tsx";
import { applyThemePreference, readThemePreference } from "./lib/theme.ts";
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
} else if (mode === "prototype") {
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
} else {
  root.render(
    <React.StrictMode>
      <RemoteApp />
    </React.StrictMode>,
  );
}
