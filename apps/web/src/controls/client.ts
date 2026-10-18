export interface Session {
  actorId: string;
  csrf: string;
  roles: string[];
  expires: number;
}
export interface Receipt {
  id: string;
  owner: string;
  kind: string;
  status: string;
  version: number;
  detail: string;
  locator?: string;
  category?: string;
  scope?: string;
  policyVersion?: string;
  collaborators?: Record<string, string>;
  history: Array<{ actor: string; action: string; [key: string]: unknown }>;
}
export class ControlsFailure extends Error {
  readonly status: number;
  constructor(status: number) {
    super(
      status === 401
        ? "Your session ended. Sign in again."
        : status === 403
          ? "Access denied. Your authority or session may have changed."
          : status === 409
            ? "The receipt or policy changed. Reload before trying again."
            : "The controls service could not complete this request. No success has been confirmed.",
    );
    this.status = status;
  }
}
/** Same-origin controls only. Never reuse the public API base URL or persist CSRF tokens. */
export async function control<T>(path: string, session?: Session, input?: unknown): Promise<T> {
  if (
    !/^\/controls\/(spotlights(?:\/(?:queue|[a-f0-9-]{36}))?|session|logout|sessions\/revoke|profile(?:\/suppression)?|requests(?:\/[a-f0-9-]{36}(?:\/(review|appeal|withdraw|consent|amend))?)?|invitations|configuration)$/.test(
      path,
    )
  )
    throw new Error("Unsupported controls route");
  if (input !== undefined && (!session || session.expires <= Date.now())) throw new ControlsFailure(401);
  const response = await fetch(path, {
    method: input === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
    headers:
      input === undefined
        ? { Accept: "application/json" }
        : { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": session!.csrf },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  if (!response.ok) throw new ControlsFailure(response.status);
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error("Controls service unavailable.");
  if (!response.body) throw new Error("Missing controls response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0,
    body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) throw new Error("Controls response exceeds the supported size.");
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body) as T;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
export function verifiedSession(value: Session): Session {
  if (
    !value ||
    !/^[1-9][0-9]{0,19}$/.test(value.actorId) ||
    typeof value.csrf !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.csrf) ||
    !Array.isArray(value.roles) ||
    !value.roles.every((r) => ["operator", "reviewer", "privacy"].includes(r)) ||
    !Number.isSafeInteger(value.expires) ||
    value.expires <= Date.now()
  )
    throw new Error("Invalid or expired controls session.");
  return value;
}
export function canReview(receipt: Receipt, session: Session): boolean {
  return (
    receipt.owner !== session.actorId &&
    !Object.hasOwn(receipt.collaborators ?? {}, session.actorId) &&
    session.roles.includes(["privacy", "identity"].includes(receipt.kind) ? "privacy" : "reviewer") &&
    !["withdrawn", "merged", "applied"].includes(receipt.status)
  );
}
