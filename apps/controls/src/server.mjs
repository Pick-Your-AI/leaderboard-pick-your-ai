import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { actorId, ControlError, exactKeys, locator, record, requireThat, text } from "./store.mjs";
import { nominateSpotlight, decideSpotlight, projectSpotlights } from "./editorial.mjs";
import { createConfigurationManager } from "./configuration.mjs";

const random = () => randomBytes(32).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("base64url");
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const sessionCookie = "__Host-controls_session";
const loginCookie = "__Host-controls_login";
const cookie = (name, value, seconds) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;

function cookies(req) {
  const parsed = {};
  for (const pair of (req.headers.cookie || "").split(";")) {
    if (!pair.trim()) continue;
    const separator = pair.indexOf("=");
    requireThat(separator > 0);
    const key = pair.slice(0, separator).trim();
    requireThat(!(key in parsed), 400, "Duplicate cookie");
    parsed[key] = pair.slice(separator + 1).trim();
  }
  return parsed;
}
async function body(req, maximum = 16_384) {
  requireThat(req.headers["content-type"] === "application/json", 415, "JSON required");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    requireThat(size <= maximum, 413, "Request too large");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    exactKeys(value, Object.keys(value));
    return value;
  } catch (error) {
    if (error instanceof ControlError) throw error;
    throw new ControlError(400, "Invalid JSON");
  }
}
const roleNeeded = (request) => (["privacy", "identity"].includes(request.kind) ? "privacy" : "reviewer");
const canSee = (request, session) => request.owner === session.actorId || session.roles.includes(roleNeeded(request));
const kinds = ["evidence", "correction", "privacy", "identity"];
const categories = [
  "governance",
  "deployment_work",
  "mentorship",
  "reliability",
  "project_configuration",
  "ordering",
  "public_moderation",
  "other",
];

export function createControlsServer({
  store,
  provider,
  origin,
  rolesForActor = () => ({ roles: [], version: "0" }),
  approvedPolicyVersions = [],
  knownMetricIds = [],
  sourceVerifier,
  now = Date.now,
  sessionSeconds = 900,
  loginSuccessPath = "/controls/session",
  spotlightEligibility = () => false,
}) {
  requireThat(["/controls/session", "/account"].includes(loginSuccessPath), 500, "Unsupported login landing path");
  const base = new URL(origin);
  requireThat(
    base.protocol === "https:" && base.origin === origin && !base.username && !base.password,
    500,
    "Exact HTTPS public origin required",
  );
  requireThat(
    Number.isInteger(sessionSeconds) && sessionSeconds >= 60 && sessionSeconds <= 900,
    500,
    "Session lifetime must be 60-900 seconds",
  );
  requireThat(
    provider && typeof provider.exchange === "function" && typeof provider.authorizationURL === "function",
    500,
    "Identity provider required",
  );
  requireThat(
    Array.isArray(approvedPolicyVersions) && approvedPolicyVersions.every((v) => typeof v === "string" && v.length > 0),
    500,
    "Invalid approved policies",
  );
  const policyVersions = new Set(approvedPolicyVersions);
  requireThat(
    Array.isArray(knownMetricIds) && knownMetricIds.every((v) => typeof v === "string" && v.length > 0),
    500,
    "Invalid metric registry identities",
  );
  const redirectURI = `${origin}/controls/auth/callback`;

  async function roleState(id) {
    const value = await rolesForActor(id);
    requireThat(
      Array.isArray(value?.roles) &&
        value.roles.every((r) => ["reviewer", "privacy", "operator"].includes(r)) &&
        typeof value.version === "string",
      500,
      "Invalid role authority",
    );
    return { roles: [...new Set(value.roles)].sort(), version: value.version };
  }
  const manageConfiguration = createConfigurationManager({
    store,
    sourceVerifier,
    approvedPolicyVersions,
    knownMetricIds,
    now,
    rolesForActor: roleState,
  });
  async function authenticate(req, parsed) {
    const token = parsed[sessionCookie];
    requireThat(typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token), 401, "Authentication required");
    const sid = hash(token);
    const session = store.read().sessions[sid];
    requireThat(session && session.expires > now(), 401, "Authentication required");
    const current = await roleState(session.actorId);
    if (current.version !== session.roleVersion || JSON.stringify(current.roles) !== JSON.stringify(session.roles)) {
      store.transaction((s) => {
        delete s.sessions[sid];
      });
      throw new ControlError(401, "Session revoked");
    }
    requireThat(store.read().sessions[sid]?.expires > now(), 401, "Session revoked");
    if (req.method !== "GET") {
      requireThat(req.headers.origin === origin, 403, "Origin rejected");
      requireThat(equal(req.headers["x-csrf-token"], session.csrf), 403, "CSRF rejected");
      // Role lookup is asynchronous. A concurrent logout/revocation must not
      // leave this request holding a formerly valid session.
      requireThat(store.read().sessions[sid]?.expires > now(), 401, "Session revoked");
    }
    return { ...session, sid };
  }
  function reviseProfile(state, session, input) {
    exactKeys(input, ["bio", "highlights", "public"]);
    requireThat(typeof input.public === "boolean" && typeof input.bio === "string" && input.bio.length <= 500);
    requireThat(!/[<>\u0000-\u001f\u007f]/.test(input.bio));
    requireThat(Array.isArray(input.highlights) && input.highlights.length <= 6);
    const previous = state.profiles[session.actorId] || {};
    state.profiles[session.actorId] = {
      ...previous,
      bio: input.bio,
      highlights: input.highlights.map(locator),
      public: input.public,
    };
  }
  async function handle(req, res) {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    function send(status, value) {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(value));
    }
    try {
      requireThat(typeof req.url === "string" && req.url.startsWith("/") && !req.url.startsWith("//"));
      const url = new URL(req.url, origin);
      requireThat(url.origin === origin);
      const path = url.pathname;
      const parsed = cookies(req);
      if (req.method === "GET" && path === "/controls/spotlights") {
        send(200, projectSpotlights(store.read(), spotlightEligibility));
        return;
      }
      if (req.method === "GET" && path === "/controls/public") {
        send(200, store.publicSnapshot());
        return;
      }
      if (req.method === "GET" && path === "/controls/auth/login") {
        requireThat([...url.searchParams].length === 0);
        const state = random();
        const binding = random();
        const verifier = random();
        const timestamp = now();
        store.transaction((s) => {
          for (const [key, value] of Object.entries(s.oauth)) if (value.expires <= timestamp) delete s.oauth[key];
          for (const [key, value] of Object.entries(s.sessions)) if (value.expires <= timestamp) delete s.sessions[key];
          requireThat(Object.keys(s.oauth).length < 10_000, 503, "Login capacity reached");
          s.oauth[hash(state)] = { binding: hash(binding), verifier, expires: timestamp + 600_000 };
        });
        const destination = new URL(provider.authorizationURL({ state, challenge: hash(verifier), redirectURI }));
        requireThat(
          destination.origin === "https://github.com" && destination.pathname === "/login/oauth/authorize",
          500,
          "Invalid authorization endpoint",
        );
        res.setHeader("set-cookie", cookie(loginCookie, binding, 600));
        res.writeHead(302, { location: destination.href });
        res.end();
        return;
      }
      if (req.method === "GET" && path === "/controls/auth/callback") {
        requireThat(
          url.searchParams.getAll("state").length === 1 &&
            url.searchParams.getAll("code").length === 1 &&
            [...url.searchParams.keys()].every((k) => ["state", "code"].includes(k)),
          400,
          "Invalid callback",
        );
        const state = text(url.searchParams.get("state"), 100);
        const code = text(url.searchParams.get("code"), 1024);
        const verifier = store.transaction((s) => {
          const pending = s.oauth[hash(state)];
          requireThat(
            pending &&
              pending.expires > now() &&
              typeof parsed[loginCookie] === "string" &&
              equal(pending.binding, hash(parsed[loginCookie])),
            400,
            "Invalid login state",
          );
          delete s.oauth[hash(state)];
          return pending.verifier;
        });
        const identity = await provider.exchange({ code, verifier, redirectURI });
        const id = actorId(identity.actorId);
        const currentRoles = await roleState(id);
        const token = random();
        const csrf = random();
        store.transaction((s) => {
          if (parsed[sessionCookie]) delete s.sessions[hash(parsed[sessionCookie])];
          s.sessions[hash(token)] = {
            actorId: id,
            csrf,
            roles: currentRoles.roles,
            roleVersion: currentRoles.version,
            expires: now() + sessionSeconds * 1000,
          };
        });
        res.setHeader("set-cookie", [cookie(sessionCookie, token, sessionSeconds), cookie(loginCookie, "", 0)]);
        res.writeHead(303, { location: `${origin}${loginSuccessPath}` });
        res.end();
        return;
      }
      let session = await authenticate(req, parsed);
      const inputBody = async (maximum) => {
        const input = await body(req, maximum);
        session = await authenticate(req, parsed);
        return input;
      };
      if (path.startsWith("/controls/configuration")) {
        requireThat(session.roles.includes("operator"), 403, "Operator role required");
        const input = req.method === "GET" ? undefined : await inputBody(131_072);
        const result = await manageConfiguration({
          path,
          method: req.method,
          input,
          session,
          refreshSession: () => authenticate(req, parsed),
        });
        send(result.status, result.data);
        return;
      }
      if (req.method === "GET" && path === "/controls/spotlights/queue") {
        send(200, {
          nominations: Object.values(store.read().spotlights || {}).filter(
            (entry) => entry.owner === session.actorId || session.roles.includes("reviewer"),
          ),
        });
        return;
      }
      if (req.method === "POST" && path === "/controls/spotlights") {
        const input = await inputBody();
        let nomination;
        store.transaction((state) => {
          nomination = nominateSpotlight(state, session, input, now());
        });
        send(201, { nomination });
        return;
      }
      const spotlightAction = path.match(/^\/controls\/spotlights\/([a-f0-9-]{36})$/);
      if (req.method === "POST" && spotlightAction) {
        const input = await inputBody();
        let nomination;
        store.transaction((state) => {
          nomination = decideSpotlight(state, session, spotlightAction[1], input, now());
        });
        send(200, { nomination });
        return;
      }
      if (req.method === "GET" && path === "/controls/session") {
        send(200, { actorId: session.actorId, csrf: session.csrf, roles: session.roles, expires: session.expires });
        return;
      }
      if (req.method === "POST" && path === "/controls/logout") {
        exactKeys(await inputBody(), []);
        store.transaction((s) => {
          delete s.sessions[session.sid];
        });
        res.setHeader("set-cookie", cookie(sessionCookie, "", 0));
        send(200, { revoked: true });
        return;
      }
      if (req.method === "POST" && path === "/controls/sessions/revoke") {
        exactKeys(await inputBody(), []);
        store.transaction((s) => {
          for (const [key, value] of Object.entries(s.sessions))
            if (value.actorId === session.actorId) delete s.sessions[key];
        });
        res.setHeader("set-cookie", cookie(sessionCookie, "", 0));
        send(200, { revoked: true });
        return;
      }
      if (req.method === "GET" && path === "/controls/profile") {
        const profile = store.read().profiles[session.actorId] || {};
        send(200, {
          public: profile.public === true,
          bio: profile.bio || "",
          highlights: profile.highlights || [],
          suppressed: profile.suppressed === true,
        });
        return;
      }
      if (req.method === "POST" && path === "/controls/profile") {
        const input = await inputBody();
        store.transaction((s) => reviseProfile(s, session, input), { publish: true });
        send(200, { saved: true });
        return;
      }
      if (req.method === "POST" && path === "/controls/profile/suppression") {
        const input = await inputBody();
        exactKeys(input, ["suppressed"]);
        requireThat(typeof input.suppressed === "boolean");
        const receipt = store.transaction(
          (s) => {
            s.profiles[session.actorId] = {
              bio: "",
              highlights: [],
              public: false,
              ...s.profiles[session.actorId],
              suppressed: input.suppressed,
            };
            const id = randomUUID();
            const timestamp = now();
            const request = {
              id,
              owner: session.actorId,
              kind: "privacy",
              status: "applied",
              detail: "Self-service display preference",
              version: 0,
              createdAt: timestamp,
              updatedAt: timestamp,
              history: [],
            };
            record(s, request, session.actorId, "display-preference", timestamp);
            s.requests[id] = request;
            return { id, status: request.status, version: request.version };
          },
          { publish: true },
        );
        send(201, receipt);
        return;
      }
      if (req.method === "POST" && path === "/controls/requests") {
        const input = await inputBody();
        exactKeys(input, ["kind", "locator", "category", "collaborators", "consent", "detail", "scope"]);
        requireThat(kinds.includes(input.kind));
        const detail = text(input.detail);
        const receipt = store.transaction((s) => {
          requireThat(
            Object.values(s.requests).filter(
              (r) => r.owner === session.actorId && ["pending", "appealed"].includes(r.status),
            ).length < 100,
            429,
            "Open request limit reached",
          );
          const id = randomUUID();
          const timestamp = now();
          const request = {
            id,
            kind: input.kind,
            owner: session.actorId,
            detail,
            status: "pending",
            version: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
            history: [],
          };
          if (input.kind === "evidence") {
            requireThat(input.consent === true && categories.includes(input.category));
            requireThat(Array.isArray(input.collaborators) && input.collaborators.length <= 20);
            const ids = [...new Set(input.collaborators.map(actorId))];
            requireThat(!ids.includes(session.actorId));
            Object.assign(request, {
              locator: locator(input.locator),
              category: input.category,
              scope: text(input.scope, 300),
              collaborators: Object.fromEntries(ids.map((id) => [id, "pending"])),
            });
          } else {
            requireThat(
              input.collaborators === undefined &&
                input.consent === undefined &&
                input.category === undefined &&
                input.scope === undefined,
            );
            if (input.locator !== undefined) request.locator = locator(input.locator);
          }
          record(s, request, session.actorId, "submitted", timestamp);
          s.requests[id] = request;
          return { id, status: "pending", version: 1 };
        });
        send(201, receipt);
        return;
      }
      if (req.method === "GET" && path === "/controls/requests") {
        send(200, { requests: Object.values(store.read().requests).filter((r) => canSee(r, session)) });
        return;
      }
      if (req.method === "GET" && path === "/controls/invitations") {
        send(200, {
          invitations: Object.values(store.read().requests)
            .filter(
              (r) =>
                r.kind === "evidence" &&
                Object.hasOwn(r.collaborators, session.actorId) &&
                !["withdrawn", "merged"].includes(r.status),
            )
            .map((r) => ({
              id: r.id,
              version: r.version,
              locator: r.locator,
              category: r.category,
              scope: r.scope,
              consent: r.collaborators[session.actorId],
            })),
        });
        return;
      }
      const match = /^\/controls\/requests\/([a-f0-9-]{36})(?:\/(review|appeal|withdraw|consent|amend))?$/.exec(path);
      if (match) {
        const [, id, action] = match;
        const existing = store.read().requests[id];
        if (req.method === "GET" && !action) {
          requireThat(existing && canSee(existing, session), 404, "Not found");
          send(200, existing);
          return;
        }
        requireThat(req.method === "POST" && action, 405, "Method not allowed");
        const input = await inputBody();
        const output = store.transaction(
          (s) => {
            const request = s.requests[id];
            requireThat(request, 404, "Not found");
            // Authorize visibility before checking version/state so another
            // person's known receipt cannot become a private-state oracle.
            if (action === "consent")
              requireThat(
                request.kind === "evidence" && Object.hasOwn(request.collaborators || {}, session.actorId),
                404,
                "Not found",
              );
            else if (action === "review") requireThat(canSee(request, session), 404, "Not found");
            else requireThat(request.owner === session.actorId, 404, "Not found");
            requireThat(
              Number.isSafeInteger(input.version) && input.version === request.version,
              409,
              "Receipt changed; reload before retry",
            );
            const timestamp = now();
            if (action === "amend") {
              exactKeys(input, ["version", "reason", "locator", "category", "scope", "detail", "collaborators"]);
              requireThat(request.owner === session.actorId, 404, "Not found");
              requireThat(
                request.kind === "evidence" && !["withdrawn", "merged"].includes(request.status),
                409,
                "Evidence amendment unavailable",
              );
              requireThat(
                categories.includes(input.category) &&
                  Array.isArray(input.collaborators) &&
                  input.collaborators.length <= 20,
              );
              const ids = [...new Set(input.collaborators.map(actorId))];
              requireThat(!ids.includes(session.actorId));
              const previous = {
                locator: request.locator,
                category: request.category,
                scope: request.scope,
                detail: request.detail,
                collaborators: request.collaborators,
              };
              request.locator = locator(input.locator);
              request.category = input.category;
              request.scope = text(input.scope, 300);
              request.detail = text(input.detail);
              request.collaborators = Object.fromEntries(
                ids.map((id) => [id, previous.collaborators[id] === "declined" ? "declined" : "pending"]),
              );
              request.status = "pending";
              delete request.policyVersion;
              record(s, request, session.actorId, "amended", timestamp, { reason: text(input.reason), previous });
            } else if (action === "consent") {
              exactKeys(input, ["version", "consent"]);
              requireThat(
                request.kind === "evidence" && Object.hasOwn(request.collaborators, session.actorId),
                404,
                "Not found",
              );
              requireThat(typeof input.consent === "boolean" && !["withdrawn", "merged"].includes(request.status));
              request.collaborators[session.actorId] = input.consent ? "accepted" : "declined";
              record(
                s,
                request,
                session.actorId,
                input.consent ? "attribution-accepted" : "attribution-declined",
                timestamp,
              );
            } else if (action === "withdraw") {
              exactKeys(input, ["version"]);
              requireThat(request.owner === session.actorId, 404, "Not found");
              requireThat(!["withdrawn", "merged"].includes(request.status), 409, "Request is terminal");
              request.status = "withdrawn";
              record(s, request, session.actorId, "withdrawn", timestamp);
            } else if (action === "appeal") {
              exactKeys(input, ["version", "reason"]);
              requireThat(request.owner === session.actorId, 404, "Not found");
              requireThat(["accepted", "rejected"].includes(request.status), 409, "No decision to appeal");
              request.status = "appealed";
              record(s, request, session.actorId, "appealed", timestamp, { reason: text(input.reason) });
            } else {
              exactKeys(input, [
                "version",
                "decision",
                "reason",
                "conflict",
                "policyVersion",
                "sourceReviewedPublic",
                "duplicateOf",
              ]);
              requireThat(session.roles.includes(roleNeeded(request)), 403, "Reviewer role required");
              requireThat(
                request.owner !== session.actorId && !Object.hasOwn(request.collaborators || {}, session.actorId),
                403,
                "Independent review required",
              );
              requireThat(input.conflict === false, 403, "Declare conflicts and route to an independent reviewer");
              requireThat(["accept", "reject", "rollback", "merge"].includes(input.decision));
              requireThat(!["withdrawn", "merged", "applied"].includes(request.status), 409, "Request is terminal");
              if (request.status === "appealed" || input.decision === "rollback") {
                requireThat(
                  !request.history.some(
                    (h) => h.actor === session.actorId && ["accepted", "rejected", "rolled-back"].includes(h.action),
                  ),
                  403,
                  "Another reviewer must resolve appeal or rollback",
                );
              }
              const reason = text(input.reason);
              if (input.decision === "accept") {
                requireThat(["pending", "appealed"].includes(request.status), 409, "Already reviewed");
                // Privacy/identity/correction acceptance cannot claim an actual
                // downstream correction without a dedicated capability handler.
                requireThat(
                  request.kind === "evidence",
                  409,
                  "Specialist request requires verified downstream handling",
                );
                requireThat(input.sourceReviewedPublic === true, 400, "Public source review required");
                requireThat(
                  !Object.values(s.requests).some(
                    (other) =>
                      other.id !== id &&
                      other.kind === "evidence" &&
                      other.status === "accepted" &&
                      other.owner === request.owner &&
                      other.locator === request.locator &&
                      other.category === request.category &&
                      other.scope === request.scope,
                  ),
                  409,
                  "Merge duplicate evidence instead of awarding it twice",
                );
                const policyVersion = text(input.policyVersion, 100);
                requireThat(policyVersions.has(policyVersion), 409, "Policy has not been approved for this service");
                request.policyVersion = policyVersion;
                request.status = "accepted";
                record(s, request, session.actorId, "accepted", timestamp, {
                  reason,
                  policyVersion: request.policyVersion,
                });
              } else if (input.decision === "reject") {
                requireThat(["pending", "appealed"].includes(request.status), 409, "Already reviewed");
                request.status = "rejected";
                record(s, request, session.actorId, "rejected", timestamp, { reason });
              } else if (input.decision === "rollback") {
                requireThat(
                  ["accepted", "rejected", "appealed"].includes(request.status),
                  409,
                  "No decision to roll back",
                );
                request.status = "pending";
                record(s, request, session.actorId, "rolled-back", timestamp, { reason });
              } else {
                const canonical = s.requests[input.duplicateOf];
                requireThat(
                  request.kind === "evidence" &&
                    canonical &&
                    canonical.kind === "evidence" &&
                    canonical.id !== id &&
                    canonical.status === "accepted",
                );
                requireThat(
                  canonical.owner === request.owner &&
                    canonical.locator === request.locator &&
                    canonical.category === request.category &&
                    canonical.scope === request.scope,
                  409,
                  "Not the same reviewed contribution",
                );
                request.status = "merged";
                request.duplicateOf = canonical.id;
                record(s, request, session.actorId, "merged", timestamp, { reason, duplicateOf: canonical.id });
              }
            }
            return { id: request.id, status: request.status, version: request.version };
          },
          { publish: true },
        );
        send(200, output);
        return;
      }
      throw new ControlError(404, "Not found");
    } catch (error) {
      send(error instanceof ControlError ? error.status : 500, {
        error: error instanceof ControlError ? error.message : "Request failed",
      });
    }
  }
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;
  server.keepAliveTimeout = 5_000;
  return server;
}
