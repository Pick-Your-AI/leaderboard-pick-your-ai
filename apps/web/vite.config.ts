import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { documentPolicy, documentHeaders } from "./security-policy.ts";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "production-document-csp",
      apply: "build",
      transformIndexHtml: {
        order: "pre",
        handler() {
          return [
            {
              tag: "meta",
              attrs: { "http-equiv": "Content-Security-Policy", content: documentPolicy },
              injectTo: "head-prepend",
            },
          ];
        },
      },
    },
  ],
  preview: { headers: documentHeaders },
  server: { proxy: { "/api/v1": "http://127.0.0.1:3001" } },
});
