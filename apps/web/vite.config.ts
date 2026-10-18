import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { documentPolicy, documentPolicyForApiBase, documentHeaders } from "./security-policy.ts";

export default defineConfig(() => {
  let policy = documentPolicy;
  return {
    plugins: [
      react(),
      {
        name: "production-document-csp",
        apply: "build",
        configResolved(config) {
          // Vite has resolved envDir, mode-specific files and process overrides.
          // This is the same value used by import.meta.env in the compiled client.
          policy = documentPolicyForApiBase(config.env.VITE_PUBLIC_API_BASE);
        },
        transformIndexHtml: {
          order: "pre",
          handler() {
            return [
              {
                tag: "meta",
                attrs: { "http-equiv": "Content-Security-Policy", content: policy },
                injectTo: "head-prepend",
              },
            ];
          },
        },
      },
    ],
    preview: { headers: documentHeaders },
    server: { proxy: { "/api/v1": "http://127.0.0.1:3001" } },
  };
});
