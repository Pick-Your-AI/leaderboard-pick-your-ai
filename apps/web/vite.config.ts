import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { documentPolicy, documentPolicyForApiBase, documentHeaders } from "./security-policy.ts";

export default defineConfig(() => {
  let policy = documentPolicy;
  return {
    plugins: [
      react(),
      {
        name: "bounded-preview-requests",
        configurePreviewServer(server) {
          // The preview command gives Node room for the 48 KiB request target
          // plus ordinary headers. Keep each application budget independent.
          // Capture one overflow header instead of silently truncating at 1,000.
          if ("maxHeadersCount" in server.httpServer) server.httpServer.maxHeadersCount = 1001;
          server.middlewares.use((request, response, next) => {
            let status = 0;
            let code = "";
            if (Buffer.byteLength(request.url ?? "", "latin1") > 48 * 1024) {
              status = 414;
              code = "query_too_large";
            } else {
              const fields = request.rawHeaders;
              let bytes = 2;
              // As in the public service, count parsed Latin-1 fields and normal
              // framing. Node omits leading OWS; this is not an exact wire cap.
              for (let index = 0; index < fields.length; index += 2)
                bytes +=
                  Buffer.byteLength(fields[index]!, "latin1") + Buffer.byteLength(fields[index + 1]!, "latin1") + 4;
              if (fields.length > 2000 || bytes > 16 * 1024) {
                status = 431;
                code = "headers_too_large";
              }
            }
            if (!status) return next();
            response.writeHead(status, {
              "Cache-Control": "no-store",
              "Content-Type": "text/plain; charset=utf-8",
              Connection: "close",
            });
            response.end(code);
          });
        },
      },
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
