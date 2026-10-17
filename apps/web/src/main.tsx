import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

function App() {
  return (
    <main>
      <p className="eyebrow">PICK YOUR AI · LOCAL SCAFFOLD</p>
      <h1>Contributions,<br />with evidence.</h1>
      <p className="notice">The runtime workspace is running. No contributor data or public rankings have been loaded.</p>
      <a href="http://127.0.0.1:3001/healthz">Check local service health <span aria-hidden="true">↗</span></a>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>
);
