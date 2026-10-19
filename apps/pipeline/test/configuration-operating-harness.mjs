import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { harness, components, ago } from "./harness.mjs";
import { createPipeline } from "../src/index.mjs";
import { githubOAuthProvider } from "../../controls/src/github.mjs";

// This fixture/provider is independent of proposed configuration input. Only
// digest/revision bind its observation to the request; no proposed permission,
// schema, enabled flag or approval boolean is copied into an observation.
const sourceBytes = await readFile(
  new URL("../../../tests/fixtures/configuration-operating-source.json", import.meta.url),
);
export const operatingSource = JSON.parse(sourceBytes);
export const operatingSourceHash = createHash("sha256").update(sourceBytes).digest("hex");
const origin = "https://controls.synthetic.invalid";
const policy = operatingSource.policy;
const closeServer = (server) =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
const listen = async (server) => {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
};

export async function configurationOperatingHarness() {
  const cleanup = [];
  const h = await harness(
    { after: (fn) => cleanup.push(fn) },
    {
      source: undefined,
      probeRepository: undefined,
      configure(config) {
        config.repositories[0].families = ["issues", "pull_requests"];
        const second = { ...config.policies[0].policy, metricId: "pr_opened", roles: ["author"], rank: false };
        second.unit = components.metrics.getMetricDefinition("pr_opened").definition.unit;
        config.policies.push({
          policy: second,
          signature: components.metrics.stableJSON(second),
          approvalReceipt: "synthetic-metric-approval",
        });
      },
    },
  );
  try {
    h.add({
      ...operatingSource.pullRequests[0],
      html_url: "https://github.com/synthetic-org/synthetic-repo/pull/3",
      created_at: ago(2),
      updated_at: ago(1),
      user: { id: 102, node_id: "U_SYNTHETIC_B", login: "synthetic-bob", type: "User" },
    });
    let sourceAvailable = true;
    let observed = structuredClone(operatingSource);
    const sourceRequests = [];
    const sourceServer = createServer((req, res) => {
      sourceRequests.push(req.url);
      res.writeHead(sourceAvailable ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(sourceAvailable ? observed : { error: "synthetic_source_outage" }));
    });
    const sourceAddress = await listen(sourceServer);
    cleanup.push(() => closeServer(sourceServer));
    let sourceReads = 0;
    const receipts = [];
    const sourceVerifier = async ({ digest, baseRevision, phase }) => {
      sourceReads++;
      const response = await fetch(sourceAddress, { redirect: "error", signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200, "Synthetic source provider unavailable");
      const actual = await response.json();
      assert.equal(actual.schemaVersion, "synthetic-configuration-operating-source/v1");
      const repo = actual.repository,
        grant = actual.installation;
      const schema = (rows, pull) =>
        Array.isArray(rows) &&
        rows.length > 0 &&
        rows.every(
          (row) =>
            Number.isSafeInteger(row.id) &&
            row.id > 0 &&
            Number.isSafeInteger(row.number) &&
            typeof row.node_id === "string" &&
            typeof row.title === "string" &&
            Number.isSafeInteger(row.user?.id) &&
            ["open", "closed"].includes(row.state) &&
            (!pull || typeof row.draft === "boolean"),
        );
      const capabilities = [
        ["issues", actual.issues, false],
        ["pull_requests", actual.pullRequests, true],
      ].map(([id, rows, pull]) => ({
        id,
        permission: `${id}:read`,
        permissionVerified: grant.permissions[id] === "read",
        tested: schema(rows, pull),
        schemaVersion: actual.schemaVersion,
        evidenceId: `synthetic-canary:${operatingSourceHash}:${id}`,
      }));
      const sourceTested = capabilities.every((capability) => capability.permissionVerified && capability.tested);
      const now = Date.now();
      const result = {
        receiptId: `synthetic-observation:${operatingSourceHash}`,
        digest,
        baseRevision,
        verifiedAt: now,
        validUntil: now + 600000,
        repositories: [
          {
            id: String(repo.id),
            installationId: String(grant.id),
            slug: repo.full_name,
            approved: grant.repositoryIds.includes(repo.id),
            public: repo.private === false,
            capabilities,
          },
        ],
        projects: [
          {
            id: actual.project.id,
            approved: actual.project.id === operatingSource.project.id,
            public: actual.project.public === true,
            permissionVerified: grant.permissions.organization_projects === "read",
            fields: actual.project.fields.map((field) => ({ id: field.id, type: field.dataType })),
            evidenceId: `synthetic-project:${operatingSourceHash}`,
          },
        ],
        metrics: components.metrics.metricDefinitionsV1.map(({ id }) => ({
          id,
          policyVersion: actual.policy.version,
          policyLink: actual.policy.link,
          policyApproved: actual.policy.version === policy.version && actual.policy.link === policy.link,
          sourceTested: sourceTested && actual.policy.testedMetricIds.includes(id),
          evidenceId: `synthetic-policy:${operatingSourceHash}:${id}`,
        })),
      };
      receipts.push({ phase, ...structuredClone(result) });
      return result;
    };
    const document = {
      repositories: [
        {
          id: "2",
          installationId: "1",
          slug: "synthetic-org/synthetic-repo",
          capabilities: ["issues", "pull_requests"],
        },
      ],
      projects: [{ id: "PVT_synthetic", fields: [{ key: "status", id: "PVTSSF_synthetic", type: "SINGLE_SELECT" }] }],
      metrics: components.metrics.metricDefinitionsV1.map(({ id }) => ({
        id,
        enabled: policy.testedMetricIds.includes(id),
        ...(policy.testedMetricIds.includes(id) ? {} : { reason: "Outside this synthetic operating drill" }),
        policyVersion: policy.version,
        policyLink: policy.link,
      })),
    };
    let runtime = h.runtime;
    cleanup.push(() => runtime.stop());
    assert.equal((await runtime.runOnce()).state, "published");
    let publicAddress = await runtime.app.listen({ host: "127.0.0.1", port: 0 });
    const roster = new Map(
      Object.entries(operatingSource.roster).map(([id, roles]) => [id, { roles, version: "synthetic-roster-1" }]),
    );
    const rolesForActor = (id) => roster.get(id) ?? { roles: [], version: "synthetic-roster-1" };
    let hostSecret = "synthetic-oauth-secret-generation-one";
    let providerSecret = hostSecret;
    const identityEvents = [];
    const identityFetch = async (url, options) => {
      identityEvents.push({ path: new URL(url).pathname, method: options.method ?? "GET" });
      if (url === "https://github.com/login/oauth/access_token") {
        const body = JSON.parse(options.body);
        if (body.client_secret !== hostSecret || !/^synthetic-code-(201|202|303)$/.test(body.code))
          return new Response("{}", { status: 401 });
        assert.equal(body.redirect_uri, `${origin}/controls/auth/callback`);
        assert.match(body.code_verifier, /^[A-Za-z0-9_-]{43}$/);
        return Response.json({ access_token: body.code.replace("code", "identity"), scope: "" });
      }
      if (url === "https://api.github.com/user") {
        const id = Number(options.headers.authorization.split("-").at(-1));
        return Response.json({ id, login: "same-untrusted-login-for-all-three-identities" });
      }
      assert.equal(url, "https://api.github.com/applications/synthetic-browser/token");
      assert.equal(options.method, "DELETE");
      assert.equal(
        options.headers.authorization,
        `Basic ${Buffer.from(`synthetic-browser:${hostSecret}`).toString("base64")}`,
      );
      return new Response(null, { status: 204 });
    };
    const startControls = async () => {
      const provider = githubOAuthProvider({
        clientId: "synthetic-browser",
        clientSecret: providerSecret,
        fetcher: identityFetch,
      });
      const server = components.controls.createControlsServer({
        store: h.controlsStore,
        origin,
        provider,
        rolesForActor,
        knownMetricIds: components.metrics.metricDefinitionsV1.map((metric) => metric.id),
        approvedPolicyVersions: [policy.version],
        sourceVerifier,
        configurationAuthorityCurrent: (binding) =>
          [
            [binding.actorId, binding.roleVersion],
            [binding.approverId, binding.approverRoleVersion],
          ].every(
            ([id, version]) => rolesForActor(id).version === version && rolesForActor(id).roles.includes("operator"),
          ),
      });
      return { server, address: await listen(server) };
    };
    let controls = await startControls();
    cleanup.push(() => closeServer(controls.server));
    const controlRequests = [];
    const request = async (path, { user, input, csrf, requestOrigin = origin, cookie } = {}) => {
      const response = await fetch(controls.address + path, {
        method: input === undefined ? "GET" : "POST",
        redirect: "manual",
        headers: {
          ...((cookie ?? user?.cookie) ? { cookie: cookie ?? user.cookie } : {}),
          origin: requestOrigin,
          ...(input === undefined
            ? {}
            : { "content-type": "application/json", "x-csrf-token": csrf ?? user?.csrf ?? "" }),
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      const body = await response.text();
      controlRequests.push({
        method: input === undefined ? "GET" : "POST",
        path: new URL(path, origin).pathname,
        status: response.status,
      });
      return {
        status: response.status,
        headers: response.headers,
        body,
        data: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(body) : null,
      };
    };
    const login = async (id, prior) => {
      const begin = await request("/controls/auth/login");
      assert.equal(begin.status, 302);
      const authorization = new URL(begin.headers.get("location"));
      assert.equal(authorization.searchParams.get("scope"), "");
      const loginCookie = begin.headers.getSetCookie()[0].split(";")[0];
      const path = `/controls/auth/callback?state=${authorization.searchParams.get("state")}&code=synthetic-code-${id}`;
      const callback = await request(path, { cookie: [loginCookie, prior?.cookie].filter(Boolean).join("; ") });
      if (callback.status !== 303) return { status: callback.status };
      const cookie = callback.headers
        .getSetCookie()
        .find((value) => value.startsWith("__Host-controls_session="))
        .split(";")[0];
      assert.match(
        callback.headers.getSetCookie().find((value) => value.startsWith("__Host-controls_session=")),
        /; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=900$/,
      );
      const session = await request("/controls/session", { cookie });
      assert.equal(session.status, 200);
      assert.equal(session.data.actorId, id);
      assert.equal((await request(path, { cookie: loginCookie })).status, 400, "OAuth state is consumed exactly once");
      return { ...session.data, cookie, status: 303 };
    };
    return {
      h,
      document,
      sourceVerifier,
      request,
      login,
      sourceRequests,
      receipts,
      identityEvents,
      controlRequests,
      operatingSourceHash,
      get sourceReads() {
        return sourceReads;
      },
      get publicAddress() {
        return publicAddress;
      },
      get controlsAddress() {
        return controls.address;
      },
      setSourceAvailable(value) {
        sourceAvailable = value;
      },
      alterSource(change) {
        observed = structuredClone(operatingSource);
        change(observed);
      },
      revoke(id) {
        roster.set(id, { roles: [], version: "synthetic-roster-2" });
      },
      configuration() {
        return h.controlsStore.read().configuration;
      },
      async rotateHostSecret(reload) {
        hostSecret = "synthetic-oauth-secret-generation-two";
        if (reload) {
          providerSecret = hostSecret;
          await closeServer(controls.server);
          controls = await startControls();
        }
      },
      async restart() {
        await closeServer(controls.server);
        await runtime.stop();
        h.controlsStore.close();
        // Reopen the actual SQLite file using its normal constructor. The original
        // harness cleanup owns this handle; no state is seeded or copied in memory.
        h.controlsStore.db = new components.controls.ControlStore(join(h.directory, "controls.sqlite")).db;
        await h.reopenDatabase();
        runtime = await createPipeline(h.options);
        publicAddress = await runtime.app.listen({ host: "127.0.0.1", port: 0 });
        controls = await startControls();
      },
      async close() {
        for (const fn of cleanup.reverse()) await fn();
      },
    };
  } catch (error) {
    for (const fn of cleanup.reverse()) await fn();
    throw error;
  }
}
