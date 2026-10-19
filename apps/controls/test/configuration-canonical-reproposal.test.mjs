import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfiguration } from "../src/configuration.mjs";

const input = () => ({
  repositories: [
    { id: "2", installationId: "1", slug: "synthetic-org/synthetic-repo", capabilities: ["issues", "pull_requests"] },
  ],
  projects: [{ id: "PVT_synthetic", fields: [{ key: "status", id: "PVTSSF_synthetic", type: "SINGLE_SELECT" }] }],
  metrics: ["issues_opened", "pr_opened"].map((id) => ({
    id,
    enabled: true,
    policyVersion: "synthetic-policy-v1",
    policyLink: "https://github.com/synthetic-org/synthetic-repo/issues/100",
  })),
});

test("a stored canonical configuration can be submitted as a new proposal without losing its fields", () => {
  const stored = normalizeConfiguration(input());
  assert.equal(stored.metrics[0].reason, "");
  assert.deepEqual(normalizeConfiguration(JSON.parse(JSON.stringify(stored))), stored);
});

test("the mounted disable form's stored-document transformation preserves the other enabled metric and historical policy", () => {
  const stored = normalizeConfiguration(input());
  const proposal = {
    ...stored,
    metrics: stored.metrics.map((metric) =>
      metric.id === "issues_opened" ? { ...metric, enabled: false, reason: "Synthetic source outage" } : metric,
    ),
  };
  const accepted = normalizeConfiguration(proposal);
  assert.deepEqual(accepted.repositories, stored.repositories);
  assert.deepEqual(accepted.projects, stored.projects);
  assert.deepEqual(
    accepted.metrics.find((metric) => metric.id === "pr_opened"),
    stored.metrics.find((metric) => metric.id === "pr_opened"),
  );
  assert.deepEqual(
    accepted.metrics.find((metric) => metric.id === "issues_opened"),
    {
      ...stored.metrics.find((metric) => metric.id === "issues_opened"),
      enabled: false,
      reason: "Synthetic source outage",
    },
  );
});

test("canonical enabled empty reasons do not permit missing disable explanations or unsafe supplied text", () => {
  for (const reason of [undefined, "", "   ", "bad\u0000reason", "x".repeat(501)]) {
    const value = input();
    value.metrics[0] = { ...value.metrics[0], enabled: false, reason };
    assert.throws(() => normalizeConfiguration(value));
  }
  const value = input();
  value.metrics[0].reason = "bad\u0000reason";
  assert.throws(() => normalizeConfiguration(value));
});
