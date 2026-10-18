import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface Envelope {
  version: "github-delivery/v1";
  deliveryId: string;
  event: "issues" | "pull_request";
  action: string;
  installationId: number;
  repositoryId: number;
  subjectId: string;
  sourceUrl: string;
  actorId: string | null;
  occurredAt: string | null;
}

export interface Delivery {
  deliveryId: string;
  bodyHash: string;
  envelope: Envelope;
}

export interface IntakeStore {
  insert(delivery: Delivery): Promise<"accepted" | "duplicate" | "conflict">;
}

export interface WebhookOptions {
  secrets: readonly string[];
  /** Explicit installation -> repository database-ID allowlist; empty means deny all. */
  scope: ReadonlyMap<number, ReadonlySet<number>>;
  store: IntakeStore;
  lifecycle?: {
    suppress(
      deliveryId: string,
      bodyHash: string,
      installationId: number,
      repositoryIds: number[],
      reason: "private" | "removed" | "revoked",
    ): Promise<"accepted" | "duplicate" | "conflict">;
  };
  maxBodyBytes?: number;
}

export function verifySignature(body: Uint8Array, signature: string | null, secrets: readonly string[]): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const actual = Buffer.from(signature.slice(7), "hex");
  // Evaluate every active key, including during rotation.
  let valid = 0;
  for (const secret of secrets) {
    valid |= Number(timingSafeEqual(createHmac("sha256", secret).update(body).digest(), actual));
  }
  return valid !== 0;
}

class IntakeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function boundedBody(request: Request, max: number): Promise<Buffer> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) {
    throw new IntakeError(413, "body_too_large");
  }
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new IntakeError(413, "body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IntakeError(400, "invalid_payload");
  return value as Record<string, unknown>;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new IntakeError(400, "invalid_payload");
  return value;
}

function stableId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_=-]{1,200}$/.test(value))
    throw new IntakeError(400, "invalid_payload");
  return value;
}

const actions = new Set(["opened", "closed", "reopened", "edited"]);

function minimize(
  payload: unknown,
  event: string | null,
  deliveryId: string,
  scope: WebhookOptions["scope"],
): Envelope {
  if (event !== "issues" && event !== "pull_request") throw new IntakeError(422, "unsupported_event");
  const data = object(payload);
  const installationId = integer(object(data.installation).id);
  const repository = object(data.repository);
  const repositoryId = integer(repository.id);
  if (!scope.get(installationId)?.has(repositoryId)) throw new IntakeError(403, "outside_scope");
  if (repository.private !== false || repository.visibility !== "public")
    throw new IntakeError(403, "not_explicitly_public");
  if (typeof data.action !== "string" || !actions.has(data.action)) throw new IntakeError(422, "unsupported_action");
  if (
    typeof repository.full_name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository.full_name) ||
    [".", ".."].includes(repository.full_name.split("/")[1] ?? "")
  ) {
    throw new IntakeError(400, "invalid_payload");
  }
  const subject = object(event === "issues" ? data.issue : data.pull_request);
  if (event === "issues" && subject.pull_request) throw new IntakeError(422, "pull_request_issue_overlap");
  const number = integer(subject.number);
  let occurredAt: string | null = null;
  // updated_at is not the occurrence time of a reopen/edit action. Leave unknown.
  const clock = data.action === "opened" ? subject.created_at : data.action === "closed" ? subject.closed_at : null;
  if (typeof clock === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(clock)) {
    const date = new Date(clock);
    if (Number.isFinite(date.getTime()) && date.toISOString().replace(".000Z", "Z") === clock)
      occurredAt = date.toISOString();
  }
  return {
    version: "github-delivery/v1",
    deliveryId,
    event,
    action: data.action,
    installationId,
    repositoryId,
    subjectId: stableId(subject.node_id),
    sourceUrl: `https://github.com/${repository.full_name}/${event === "issues" ? "issues" : "pull"}/${number}`,
    actorId: data.sender == null ? null : stableId(object(data.sender).node_id),
    occurredAt,
  };
}

/** Transport-neutral handler: the host must route only its webhook endpoint here. */
export function createWebhookHandler(options: WebhookOptions): (request: Request) => Promise<Response> {
  if (options.secrets.length < 1 || options.secrets.length > 2 || options.secrets.some((key) => key.length < 32)) {
    throw new Error("Configure one or two webhook secrets of at least 32 characters");
  }
  const max = options.maxBodyBytes ?? 1_048_576;
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError("maxBodyBytes must be positive");
  // Snapshot configuration so mutation by a caller cannot silently widen source scope.
  const secrets = [...options.secrets];
  const scope = new Map([...options.scope].map(([id, repos]) => [id, new Set(repos)]));
  return async (request) => {
    try {
      if (request.method !== "POST") throw new IntakeError(405, "method_not_allowed");
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "") ||
        request.headers.has("content-encoding")
      )
        throw new IntakeError(415, "unsupported_encoding");
      const deliveryId = request.headers.get("x-github-delivery");
      if (!deliveryId || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(deliveryId)) {
        throw new IntakeError(400, "invalid_delivery_id");
      }
      const body = await boundedBody(request, max);
      if (!verifySignature(body, request.headers.get("x-hub-signature-256"), secrets))
        throw new IntakeError(401, "invalid_signature");
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      } catch {
        throw new IntakeError(400, "invalid_json");
      }
      const event = request.headers.get("x-github-event");
      const bodyHash = createHash("sha256").update(body).digest("hex");
      if (["installation", "installation_repositories", "repository"].includes(event ?? "")) {
        if (!options.lifecycle) throw new IntakeError(422, "unsupported_event");
        const data = object(payload);
        const installationId = integer(object(data.installation).id);
        if (!scope.has(installationId)) throw new IntakeError(403, "outside_scope");
        let ids: number[];
        let reason: "private" | "removed" | "revoked";
        if (event === "installation" && ["deleted", "suspend"].includes(String(data.action))) {
          // HMAC authenticates bytes, not the event header. Require the signed
          // full-installation shape before applying an installation-wide change.
          const installation = object(data.installation);
          if (
            !["all", "selected"].includes(String(installation.repository_selection)) ||
            typeof installation.target_type !== "string" ||
            installation.target_type.length === 0
          )
            throw new IntakeError(400, "invalid_payload");
          integer(installation.app_id);
          integer(installation.target_id);
          ids = [...scope.get(installationId)!];
          reason = "revoked";
        } else if (event === "installation_repositories" && data.action === "removed") {
          if (!Array.isArray(data.repositories_removed) || data.repositories_removed.length > 1000)
            throw new IntakeError(400, "invalid_payload");
          ids = data.repositories_removed
            .map((value) => integer(object(value).id))
            .filter((value) => scope.get(installationId)!.has(value));
          reason = "removed";
        } else if (event === "repository" && ["privatized", "deleted", "transferred"].includes(String(data.action))) {
          // Signed child-object deletions cannot become repository-wide changes.
          const keys = new Set([
            "action",
            "repository",
            "sender",
            "installation",
            "organization",
            "enterprise",
            "changes",
          ]);
          if (Object.keys(data).some((key) => !keys.has(key))) throw new IntakeError(400, "invalid_payload");
          ids = [integer(object(data.repository).id)];
          reason = data.action === "privatized" ? "private" : "removed";
          if (!scope.get(installationId)!.has(ids[0]!)) throw new IntakeError(403, "outside_scope");
        } else throw new IntakeError(422, "unsupported_action");
        const result = await options.lifecycle.suppress(
          deliveryId.toLowerCase(),
          bodyHash,
          installationId,
          ids,
          reason,
        );
        if (result === "conflict") throw new IntakeError(409, "delivery_conflict");
        return Response.json({ status: result }, { status: result === "accepted" ? 202 : 200 });
      }
      const envelope = minimize(payload, request.headers.get("x-github-event"), deliveryId.toLowerCase(), scope);
      // Only a successful durable insert can produce an acknowledgement.
      const result = await options.store.insert({ deliveryId: envelope.deliveryId, bodyHash, envelope });
      if (result === "conflict") throw new IntakeError(409, "delivery_conflict");
      return Response.json({ status: result }, { status: result === "accepted" ? 202 : 200 });
    } catch (error) {
      // Never reflect a source payload, secret, database message or SQL in the response.
      return Response.json(
        { error: error instanceof IntakeError ? error.code : "intake_unavailable" },
        { status: error instanceof IntakeError ? error.status : 503 },
      );
    }
  };
}
