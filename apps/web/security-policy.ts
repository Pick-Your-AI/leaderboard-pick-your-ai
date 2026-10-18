// Production document policy. Development HMR is deliberately outside this policy.
export const documentPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self'",
  "img-src 'none'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-src 'none'",
  "worker-src 'none'",
].join("; ");

// frame-ancestors is header-only; it is intentionally absent from the meta policy.
export const documentHeaders = {
  "Content-Security-Policy": `${documentPolicy}; frame-ancestors 'none'`,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
