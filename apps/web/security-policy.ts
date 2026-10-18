/** Bind public reads to the same non-secret API configuration baked into the app. */
export function documentPolicyForApiBase(raw = "/api/v1"): string {
  const value = raw || "/api/v1";
  let connection = "'self'";
  // Relative paths resolve against the document origin in the public API client.
  if (!/^(?:\/(?!\/))?[A-Za-z0-9_-][A-Za-z0-9/_-]*$/.test(value)) {
    const invalid = () =>
      new Error(
        "Invalid VITE_PUBLIC_API_BASE: use an API path or an explicit HTTPS URL with a DNS/IPv4 host, " +
          "a plain API path, and no credentials, query, fragment or backslashes. Use a relative path for same-origin HTTP development.",
      );
    if (!/^https:\/\/[^/]/i.test(value) || /[\u0000-\u0020\u007f\\?#]/.test(value)) throw invalid();
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw invalid();
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^[a-z0-9.-]+$/i.test(url.hostname) ||
      !/^\/(?!\/)[A-Za-z0-9/_-]+$/.test(url.pathname)
    ) {
      throw invalid();
    }
    // Only the parsed origin is a policy source. Paths and arbitrary env text never are.
    connection += ` ${url.origin}`;
  }
  // Development HMR is deliberately outside this production policy.
  return [
    "default-src 'none'",
    "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self'",
    "img-src 'none'",
    "font-src 'self'",
    `connect-src ${connection}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-src 'none'",
    "worker-src 'none'",
  ].join("; ");
}

export const documentPolicy = documentPolicyForApiBase();

// The full policy is baked into index.html. A later preview/host environment must
// not replace its connect-src with a different build configuration. These header-
// only restrictions compose with that meta policy; frame-ancestors cannot be meta.
export const documentHeaders = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
