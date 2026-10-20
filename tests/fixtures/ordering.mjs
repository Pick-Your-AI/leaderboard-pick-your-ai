// Fictional reviewed-ordering records and a real localhost protected HTTP host.
// No GitHub service, permission, contributor or ordering action is asserted.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeGithubObservation } from "@pick-your-ai/github";
import { ControlStore } from "../../apps/controls/src/store.mjs";
import { record } from "../../apps/controls/src/store.mjs";
import { createEvidenceIntake, createSourceUseReview } from "../../apps/controls/src/evidence-intake.mjs";
import { createControlsServer } from "../../apps/controls/src/server.mjs";
import { syntheticEvidenceIntakeInput } from "./evidence-intake.mjs";

// A marker-free fictional policy exercises the ordinary public-runtime gates.
// Synthetic-source rejection is covered separately; no actual source is enabled.
export const orderingPolicyVersion = "ordering-policy-v1";
export const orderingAt = "2026-10-19T03:00:00.000Z";
export function orderingEnvelope(slug = "example-org/example-repo") {
  return {
    repository: { id: 2, slug, visibility: "public" },
    proof: { verified: true, source: "github_rest", revision: "plan-revision-1", isSynthetic: false },
    family: "issue",
    action: "opened",
    occurredAt: "2026-10-18T00:00:00.000Z",
    observedAt: orderingAt,
    payload: {
      id: 1001,
      node_id: "ORDERING_PLAN_1",
      number: 1,
      html_url: `https://github.com/${slug}/issues/1`,
      created_at: "2026-10-18T00:00:00.000Z",
      updated_at: "2026-10-18T01:00:00.000Z",
      title: "Fictional ordering plan",
      user: { id: 101, node_id: "ORDERING_ACTOR_101", login: "fixture-author", type: "User" },
    },
  };
}
export const orderingSource = (slug) => normalizeGithubObservation(orderingEnvelope(slug));
export function orderingScope() {
  return {
    kind: "subissues",
    repositoryId: "2",
    repositorySlug: "example-org/example-repo",
    id: "PARENT_1",
    url: "https://github.com/example-org/example-repo/issues/20",
  };
}
export function orderingAuthority(scope = orderingScope()) {
  return { version: "ordering-source-authority/v1", scopes: [structuredClone(scope)] };
}
export function orderingDescriptor(request, source = orderingSource()) {
  const target = source.facts.find((fact) => fact.metricId === "issues_opened");
  const proof = source.evidence.find((entry) => entry.contribution.contributionId === target.id);
  const first = "a".repeat(40),
    last = "b".repeat(40);
  const items = Array.from({ length: 10 }, (_, index) => `CHILD_${index + 1}`);
  return {
    version: "ordering-review/v1",
    requestId: request.id,
    claimDigest: request.intake.claimDigest,
    actorId: request.owner,
    contributorRole: "ordering_contributor",
    method: "manual",
    scope: orderingScope(),
    source: {
      factId: target.id,
      artifactId: target.artifactId,
      locator: proof.artifact.publicUrl,
      revision: proof.sourceRevision,
    },
    aliases: [target.artifactId],
    before: { locator: `https://github.com/example-org/example-repo/blob/${first}/order.json`, revision: first, items },
    after: {
      locator: `https://github.com/example-org/example-repo/blob/${last}/order.json`,
      revision: last,
      items: [...items].reverse(),
    },
  };
}
export function orderingReview(request, source) {
  const ordering = orderingDescriptor(request, source);
  return {
    version: request.version,
    decision: "accept",
    reason: "Fictional independent review of manual plan and exact public snapshots",
    conflict: false,
    policyVersion: orderingPolicyVersion,
    sourceReviewedPublic: true,
    ordering,
    sourceUseReview: {
      disposition: "permitted",
      rationale: "Fictional permission review, never a real grant",
      references: [ordering.before, ordering.after].map(({ locator, revision }) => ({ locator, revision })),
    },
  };
}
export function orderingState({
  id = "synthetic-ordering-request",
  source = orderingSource(),
  scope = "reviewed-parent-plan",
} = {}) {
  const state = { requests: {}, profiles: {}, audit: [] },
    at = Date.parse(orderingAt);
  const request = {
    id,
    kind: "evidence",
    owner: "101",
    locator: source.evidence.find((entry) => entry.contribution.metricIds.includes("issues_opened")).artifact.publicUrl,
    category: "ordering",
    scope,
    detail: "PRIVATE_ORDERING_DETAIL",
    collaborators: {},
    status: "pending",
    version: 0,
    createdAt: at,
    updatedAt: at,
    history: [],
  };
  const input = syntheticEvidenceIntakeInput([]);
  input.roles.submitter = "ordering_contributor";
  request.intake = createEvidenceIntake(request, input, at);
  record(state, request, "101", "submitted", at, { submitterConsent: true });
  state.requests[id] = request;
  const review = orderingReview(request, source);
  request.policyVersion = orderingPolicyVersion;
  request.status = "accepted";
  record(state, request, "202", "accepted", at, {
    reason: review.reason,
    policyVersion: orderingPolicyVersion,
    sourceReviewedPublic: true,
    conflict: false,
    sourceUseReview: createSourceUseReview(request, review.sourceUseReview, {
      actorId: "202",
      roleVersion: "fixture-role-1",
      at,
      policyVersion: orderingPolicyVersion,
    }),
    ordering: review.ordering,
  });
  return state;
}
export function orderingBinding() {
  return {
    category: "ordering",
    scope: "reviewed-parent-plan",
    policyVersion: orderingPolicyVersion,
    metricId: "issue_ordering",
    sourceMetricId: "issues_opened",
    repositoryId: "2",
    reviewerIds: ["202"],
    orderingAuthority: orderingAuthority(),
  };
}
export async function orderingControls(t, { store: suppliedStore, now = () => Date.parse(orderingAt) } = {}) {
  const directory = suppliedStore ? null : mkdtempSync(join(tmpdir(), "leaderboard-ordering-controls-"));
  const store = suppliedStore ?? new ControlStore(join(directory, "private.sqlite"));
  const origin = "https://ordering.example.test",
    challenges = new Set();
  const server = createControlsServer({
    store,
    origin,
    now,
    approvedPolicyVersions: [orderingPolicyVersion],
    rolesForActor: (id) => ({ roles: id === "202" ? ["reviewer"] : [], version: "fixture-role-1" }),
    provider: {
      authorizationURL({ state, challenge }) {
        challenges.add(challenge);
        return "https://github.com/login/oauth/authorize?" + new URLSearchParams({ state });
      },
      async exchange({ code, verifier }) {
        assert.ok(challenges.delete(createHash("sha256").update(verifier).digest("base64url")));
        return { actorId: code };
      },
    },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (!suppliedStore) {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  async function call(path, { user, input, headers = {}, method = input === undefined ? "GET" : "POST" } = {}) {
    const response = await fetch(base + path, {
      method,
      redirect: "manual",
      headers: {
        connection: "close",
        ...(user ? { cookie: user.cookie, origin, "x-csrf-token": user.csrf } : {}),
        ...(input === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return {
      status: response.status,
      headers: response.headers,
      data: response.headers.get("content-type")?.includes("application/json") ? await response.json() : null,
    };
  }
  async function login(id) {
    const start = await call("/controls/auth/login");
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const callback = await call("/controls/auth/callback?" + new URLSearchParams({ state, code: id }), {
      headers: { cookie: start.headers.getSetCookie()[0].split(";")[0] },
    });
    assert.equal(callback.status, 303);
    const cookie = callback.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-controls_session="))
      .split(";")[0];
    const session = await call("/controls/session", { headers: { cookie } });
    assert.equal(session.status, 200);
    return { actorId: id, cookie, csrf: session.data.csrf };
  }
  async function submit(
    user,
    {
      collaborators = [],
      category = "ordering",
      scope = "reviewed-parent-plan",
      locator = "https://github.com/example-org/example-repo/issues/1",
    } = {},
  ) {
    const intake = syntheticEvidenceIntakeInput(collaborators);
    intake.roles.submitter = "ordering_contributor";
    const response = await call("/controls/requests", {
      user,
      input: {
        kind: "evidence",
        locator,
        category,
        collaborators,
        consent: true,
        scope,
        detail: "PRIVATE_ORDERING_DETAIL",
        intake,
      },
    });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return store.read().requests[response.data.id];
  }
  return { store, call, login, submit };
}
