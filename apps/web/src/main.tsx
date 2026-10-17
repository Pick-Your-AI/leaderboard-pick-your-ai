import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { RouterProvider } from "./lib/router.tsx";
import { applyThemePreference, readThemePreference } from "./lib/theme.ts";
import "./styles/tokens.css";
import "./styles/app.css";

applyThemePreference(readThemePreference());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider>
      <App />
    </RouterProvider>
  </React.StrictMode>,
);
