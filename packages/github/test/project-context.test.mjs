import assert from "node:assert/strict";
import test from "node:test";
import {
  GithubReadClient,
  projectContextFromSnapshot,
  projectSubjectSnapshotRevision,
  readPublicSubjectProjectSnapshot,
  validateProjectWorkstreamMapping,
} from "../dist/index.js";

const repository = { id: 37, slug: "synthetic-owner/context-repository" };
const approved = ["PVT_alpha", "PVT_beta", "PVT_gamma"];
const identity = (kind = "issue") => ({
  __typename: kind === "issue" ? "Issue" : "PullRequest",
  id: kind === "issue" ? "I_synthetic" : "PR_synthetic",
  url: `https://github.com/${repository.slug}/${kind === "issue" ? "issues" : "pull"}/37`,
  repository: { databaseId: repository.id, isPrivate: false },
});
const member = (suffix, archived = false) => ({
  id: `PVTI_${suffix}`,
  updatedAt: "2026-10-18T09:00:00Z",
  isArchived: archived,
  project: { id: `PVT_${suffix}`, public: true },
});
const single = (suffix, optionId = "option_blue") => ({
  __typename: "ProjectV2ItemFieldSingleSelectValue",
  field: { id: `PVTSSF_${suffix}` },
  optionId,
});
const mapping = () => ({
  version: "synthetic-workstreams/v1",
  projects: approved.map((projectId) => ({
    projectId,
    fields: [
      {
        fieldId: projectId.replace("PVT_", "PVTSSF_"),
        options: [
          { optionId: "option_blue", workstreamId: "engineering" },
          { optionId: "option_green", workstreamId: "research" },
        ],
      },
    ],
  })),
});

class MemoryStore {
  values = new Map();
  async load(key) {
    return structuredClone(this.values.get(key));
  }
  async save(key, value) {
    this.values.set(key, structuredClone(value));
  }
}

/** Synthetic transport beneath the real paginating/authorization/checkpoint client. */
function source({ kind = "issue", members = [member("alpha")], fields = {}, transform, pageSize = 2 } = {}) {
  const state = { members: structuredClone(members), fields: structuredClone(fields) };
  const calls = [];
  const checkpoints = new MemoryStore();
  let membershipRead = -1;
  let scopeReads = 0;
  const client = new GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => "synthetic-token",
    checkpoints,
    maxRetries: 0,
    fetch: async (url, request) => {
      assert.equal(url, "https://api.synthetic.invalid/graphql");
      assert.equal(request.method, "POST");
      assert.equal(request.redirect, "manual");
      const { query, variables } = JSON.parse(request.body);
      const call = { query, variables };
      let data;
      const page = (nodes) => {
        const offset = variables.after === null ? 0 : Number(variables.after);
        const end = Math.min(offset + pageSize, nodes.length);
        return {
          nodes: structuredClone(nodes.slice(offset, end)),
          totalCount: nodes.length,
          pageInfo: { hasNextPage: end < nodes.length, endCursor: end < nodes.length ? String(end) : null },
        };
      };
      if (query.includes("PublicProjectContextScope")) {
        call.type = "scope";
        call.scopeRead = ++scopeReads;
        data = { nodes: variables.ids.map((id) => ({ id, public: true })) };
      } else if (query.includes("PublicSubjectProjectMembership")) {
        assert.match(query, /includeArchived\s*:\s*true/);
        assert.match(query, new RegExp(`\\.\\.\\. on ${identity(kind).__typename}`));
        if (variables.after === null) membershipRead++;
        call.type = "membership";
        call.phase = membershipRead % 2 === 0 ? "before" : "after";
        call.read = membershipRead;
        data = { node: { ...identity(kind), projectItems: page(state.members) } };
      } else if (query.includes("PublicSubjectProjectFields")) {
        call.type = "fields";
        assert.match(query, /optionId/);
        assert.doesNotMatch(query, /\b(name|nameHTML|text|number|date|creator|actor|email)\b/);
        const item = state.members.find((entry) => entry.id === variables.id);
        assert.ok(item, "Only an observed approved membership may be hydrated");
        const values = state.fields[variables.id] ?? [single(item.project.id.slice("PVT_".length))];
        data = { node: { ...structuredClone(item), content: identity(kind), fieldValues: page(values) } };
      } else {
        assert.fail("Unexpected source query");
      }
      calls.push(call);
      const body = transform?.(data, call, state) ?? data;
      return new Response(JSON.stringify({ data: body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const options = {
    client,
    source: "synthetic-installation",
    repository,
    subjectId: identity(kind).id,
    sourceUrl: identity(kind).url,
    allowedProjectIds: approved,
    scanId: "synthetic-scan",
  };
  return {
    state,
    calls,
    checkpoints,
    options,
    read: (extra = {}) => readPublicSubjectProjectSnapshot({ ...options, ...extra }),
  };
}

for (const kind of ["issue", "pull_request"]) {
  test(`complete ${kind} snapshot retains multiple Projects, archived membership, and only option IDs`, async () => {
    const fixture = source({
      kind,
      members: [member("gamma", true), member("alpha"), member("beta")],
      fields: {
        PVTI_alpha: [
          single("alpha"),
          { __typename: "ProjectV2ItemFieldTextValue", text: "must not be retained" },
          single("unmapped", "another_option"),
        ],
      },
    });
    const snapshot = await fixture.read();
    assert.equal(snapshot.subjectKind, kind);
    assert.equal(snapshot.subjectId, identity(kind).id);
    assert.equal(snapshot.repositoryId, repository.id);
    assert.deepEqual(
      snapshot.items.map((item) => item.projectId),
      approved,
    );
    assert.equal(snapshot.items[2].archived, true);
    assert.deepEqual(snapshot.items[0].fields, [
      { fieldId: "PVTSSF_alpha", optionId: "option_blue" },
      { fieldId: "PVTSSF_unmapped", optionId: "another_option" },
    ]);
    assert.equal(JSON.stringify(snapshot).includes("must not be retained"), false);
    assert.equal(JSON.stringify(snapshot).includes("occurredAt"), false);
    assert.equal(JSON.stringify(snapshot).includes("actorId"), false);
    assert.equal(fixture.calls.filter((call) => call.type === "membership").length, 4);
    assert.equal(
      fixture.calls.filter((call) => call.type === "fields" && call.variables.id === "PVTI_alpha").length,
      2,
    );
    assert.deepEqual(projectContextFromSnapshot(snapshot, mapping()), {
      projects: approved,
      workstreams: ["engineering"],
      workstreamsKnown: true,
    });
  });
}

test("complete empty membership is explicit, with both public-scope proofs and no field reads", async () => {
  const fixture = source({ members: [] });
  const snapshot = await fixture.read();
  assert.deepEqual(snapshot.items, []);
  assert.deepEqual(projectContextFromSnapshot(snapshot), { projects: [], workstreams: [], workstreamsKnown: true });
  assert.equal(fixture.calls.filter((call) => call.type === "scope").length, 2);
  assert.equal(fixture.calls.filter((call) => call.type === "membership").length, 2);
  assert.equal(fixture.calls.filter((call) => call.type === "fields").length, 0);
});

test("unapproved private membership is never hydrated or included in the scoped snapshot", async () => {
  const outsider = { ...member("outside"), project: { id: "PVT_outside", public: false } };
  const fixture = source({ members: [outsider, member("alpha")] });
  const snapshot = await fixture.read();
  assert.deepEqual(
    snapshot.items.map((item) => item.projectId),
    ["PVT_alpha"],
  );
  assert.equal(
    fixture.calls.some((call) => call.type === "fields" && call.variables.id === outsider.id),
    false,
  );
  const scanDocuments = [...fixture.checkpoints.values].filter(([key]) => key.startsWith("scan:"));
  assert.equal(JSON.stringify(scanDocuments).includes("PVT_outside"), false);
});

test("a completed checkpoint cannot preserve removed membership or prevent A to B to A recollection", async () => {
  const fixture = source();
  const first = await fixture.read();
  fixture.state.members = [];
  const empty = await fixture.read();
  fixture.state.members = [member("alpha")];
  const restored = await fixture.read();
  assert.deepEqual(empty.items, []);
  assert.notEqual(projectSubjectSnapshotRevision(first), projectSubjectSnapshotRevision(empty));
  assert.equal(projectSubjectSnapshotRevision(first), projectSubjectSnapshotRevision(restored));
  assert.equal(fixture.calls.filter((call) => call.type === "membership").length, 6);
});

test("snapshot fingerprints ignore connection ordering and bind scope, selected IDs and item revisions", async () => {
  const fixture = source({ members: [member("beta"), member("alpha")] });
  const snapshot = await fixture.read();
  const reversed = structuredClone(snapshot);
  reversed.allowedProjectIds.reverse();
  reversed.items.reverse();
  for (const item of reversed.items) item.fields.reverse();
  const fingerprint = projectSubjectSnapshotRevision(snapshot);
  assert.equal(projectSubjectSnapshotRevision(reversed), fingerprint);
  for (const change of [
    (value) => {
      value.allowedProjectIds.push("PVT_extra");
    },
    (value) => {
      value.items[0].fields[0].optionId = "option_green";
    },
    (value) => {
      value.items[0].fields[0].fieldId = "PVTSSF_other";
    },
    (value) => {
      value.items[0].updatedAt = "2026-10-18T09:01:00Z";
    },
    (value) => {
      value.items[0].archived = true;
    },
    (value) => {
      value.subjectId = "I_other";
    },
  ]) {
    const altered = structuredClone(snapshot);
    change(altered);
    assert.notEqual(projectSubjectSnapshotRevision(altered), fingerprint);
  }
});

const invalidProjectTimestamps = [
  "2026-02-30T00:00:00Z",
  "2026-02-29T12:00:00Z",
  "1900-02-29T12:00:00Z",
  "2100-02-29T12:00:00Z",
  "2026-04-31T12:00:00Z",
  "2026-13-01T00:00:00Z",
  "2026-10-18T24:00:00Z",
  "2026-10-18T09:00:60Z",
  "2026-10-18T09:00:00.0000Z",
  "2026-10-18T09:00:00.1234Z",
  "2026-10-18T09:00:00+00:00",
  "2026-10-18 09:00:00Z",
  "2026-10-18T09:00:00z",
];

test("Project timestamps reject impossible calendars and unsupported precision before field hydration", async () => {
  for (const updatedAt of invalidProjectTimestamps) {
    const fixture = source({ members: [{ ...member("alpha"), updatedAt }] });
    await assert.rejects(fixture.read(), /project_public_subject_unverified/, updatedAt);
    assert.equal(
      fixture.calls.some((call) => call.type === "fields"),
      false,
      updatedAt,
    );
  }
});

test("Project timestamps cannot enter frozen fingerprints or mapped context with malformed values", async () => {
  const snapshot = await source().read();
  for (const updatedAt of invalidProjectTimestamps) {
    const altered = structuredClone(snapshot);
    altered.items[0].updatedAt = updatedAt;
    assert.throws(
      () => projectSubjectSnapshotRevision(altered),
      /project_snapshot_unverified_or_budget_exceeded/,
      updatedAt,
    );
    assert.throws(
      () => projectContextFromSnapshot(altered, mapping()),
      /project_snapshot_unverified_or_budget_exceeded/,
      updatedAt,
    );
  }
});

test("Project timestamps preserve valid leap days and millisecond fraction spelling", async () => {
  for (const updatedAt of [
    "2024-02-29T23:59:59Z",
    "2000-02-29T12:34:56Z",
    "2026-10-18T09:00:00Z",
    "2026-10-18T09:00:00.1Z",
    "2026-10-18T09:00:00.12Z",
    "2026-10-18T09:00:00.123Z",
    "2026-10-18T09:00:00.000Z",
  ]) {
    const snapshot = await source({ members: [{ ...member("alpha"), updatedAt }] }).read();
    assert.equal(snapshot.items[0].updatedAt, updatedAt);
    assert.match(projectSubjectSnapshotRevision(snapshot), /^[a-f0-9]{64}$/);
    assert.deepEqual(projectContextFromSnapshot(snapshot, mapping()), {
      projects: ["PVT_alpha"],
      workstreams: ["engineering"],
      workstreamsKnown: true,
    });
  }
});

for (const mismatch of ["native ID", "native kind", "source URL", "repository ID", "private repository"]) {
  test(`${mismatch} cannot bind a current Project snapshot to another subject`, async () => {
    const fixture = source({
      transform(data, call) {
        if (call.type !== "membership") return;
        if (mismatch === "native ID") data.node.id = "I_other";
        if (mismatch === "native kind") data.node.__typename = "PullRequest";
        if (mismatch === "source URL") data.node.url = data.node.url.replace("/37", "/38");
        if (mismatch === "repository ID") data.node.repository.databaseId++;
        if (mismatch === "private repository") data.node.repository.isPrivate = true;
      },
    });
    await assert.rejects(fixture.read(), /project_subject_identity_unverified/);
    assert.equal(
      fixture.calls.some((call) => call.type === "fields"),
      false,
    );
  });
}

test("an item with the right URL but another native content ID fails exact parent binding", async () => {
  const fixture = source({
    transform(data, call) {
      if (call.type === "fields") data.node.content.id = "I_other";
    },
  });
  await assert.rejects(fixture.read(), /project_subject_identity_unverified/);
});

test("item revision changes between field pages invalidate the observed snapshot", async () => {
  const fixture = source({
    fields: { PVTI_alpha: [single("alpha"), single("second"), single("third")] },
    transform(data, call) {
      if (call.type === "fields" && call.variables.after !== null) data.node.updatedAt = "2026-10-18T10:00:00Z";
    },
  });
  await assert.rejects(fixture.read(), /project_snapshot_changed_during_scan/);
});

test("a label or malformed field configuration cannot replace a selected field/option ID", async () => {
  for (const value of [
    { __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Engineering", field: { id: "PVTSSF_alpha" } },
    { __typename: "ProjectV2ItemFieldSingleSelectValue", field: {}, optionId: "option_blue" },
    { __typename: "ProjectV2ItemFieldSingleSelectValue", field: { id: "PVTSSF_alpha" }, optionId: 1 },
  ]) {
    const fixture = source({ fields: { PVTI_alpha: [value] } });
    await assert.rejects(fixture.read(), /project_field_connection_unavailable/);
  }
});

test("public approval proves every exact allowed Project once before reading any membership", async () => {
  for (const alter of [
    (data) => {
      data.nodes.pop();
    },
    (data) => {
      data.nodes[0] = null;
    },
    (data) => {
      data.nodes[0].id = "PVT_outside";
    },
    (data) => {
      data.nodes[0] = structuredClone(data.nodes[1]);
    },
  ]) {
    const fixture = source({
      transform(data, call) {
        if (call.type === "scope") alter(data);
      },
    });
    await assert.rejects(fixture.read(), /project_not_authorized/);
    assert.equal(
      fixture.calls.some((call) => call.type === "membership"),
      false,
    );
  }
});

for (const phase of ["before", "after"]) {
  test(`a private approved Project ${phase} collection prevents even a known-empty result`, async () => {
    const fixture = source({
      members: [],
      transform(data, call) {
        if (call.type === "scope" && call.scopeRead === (phase === "before" ? 1 : 2)) data.nodes[0].public = false;
      },
    });
    await assert.rejects(fixture.read(), /project_not_authorized/);
  });
}

for (const change of ["removed", "added", "archived", "updated", "replaced"]) {
  test(`membership ${change} during hydration never yields a partial current context`, async () => {
    const fixture = source({
      transform(data, call) {
        if (call.type !== "membership" || call.phase !== "after") return;
        if (change === "removed") {
          data.node.projectItems.nodes = [];
          data.node.projectItems.totalCount = 0;
        }
        if (change === "added") {
          data.node.projectItems.nodes.push(member("beta"));
          data.node.projectItems.totalCount++;
        }
        if (change === "archived") data.node.projectItems.nodes[0].isArchived = true;
        if (change === "updated") data.node.projectItems.nodes[0].updatedAt = "2026-10-18T10:00:00Z";
        if (change === "replaced") data.node.projectItems.nodes[0] = member("beta");
      },
    });
    await assert.rejects(fixture.read(), /project_snapshot_changed_during_scan/);
  });
}

test("duplicate membership or selected field identities fail closed instead of silently deduplicating evidence", async () => {
  const duplicates = source({ members: [member("alpha"), member("alpha")] });
  await assert.rejects(duplicates.read(), /project_snapshot_changed_during_scan/);
  const duplicateProject = source({ members: [member("alpha"), { ...member("alpha"), id: "PVTI_second" }] });
  await assert.rejects(duplicateProject.read(), /project_snapshot_changed_during_scan/);
  const fields = source({ fields: { PVTI_alpha: [single("alpha"), single("alpha", "option_green")] } });
  await assert.rejects(fields.read(), /project_snapshot_changed_during_scan/);
});

for (const type of ["membership", "fields"]) {
  test(`${type} pagination must reach a stable complete total within its bound`, async () => {
    const incomplete = source({
      transform(data, call) {
        if (call.type === type) (type === "membership" ? data.node.projectItems : data.node.fieldValues).totalCount++;
      },
    });
    await assert.rejects(incomplete.read(), /project_snapshot_unverified_or_budget_exceeded/);
    const bounded = source({
      members: type === "membership" ? [member("alpha"), member("beta"), member("gamma")] : [member("alpha")],
      fields: { PVTI_alpha: [single("alpha"), single("second"), single("third")] },
    });
    await assert.rejects(bounded.read({ maxPages: 1 }), /maxPages/);
  });
}

test("invalid or changing page metadata cannot certify a complete membership", async () => {
  for (const alter of [
    (page) => {
      page.totalCount = -1;
    },
    (page) => {
      page.totalCount = 10001;
    },
    (page) => {
      page.pageInfo.hasNextPage = "false";
    },
    (page) => {
      page.nodes = [null];
    },
  ]) {
    const fixture = source({
      transform(data, call) {
        if (call.type === "membership") alter(data.node.projectItems);
      },
    });
    await assert.rejects(fixture.read(), /project_connection_unavailable_or_budget_exceeded/);
  }
  const changed = source({
    members: [member("alpha"), member("beta"), member("gamma")],
    transform(data, call) {
      if (call.type === "membership" && call.variables.after !== null) data.node.projectItems.totalCount++;
    },
  });
  await assert.rejects(changed.read(), /project_snapshot_changed_during_scan/);
});

test("authorization revoked after the last source response still prevents delivery", async () => {
  let authorized = true;
  const fixture = source({
    transform(data, call) {
      if (call.type === "scope" && call.scopeRead === 2) authorized = false;
    },
  });
  await assert.rejects(
    fixture.read({
      assertAuthorized() {
        if (!authorized) throw new Error("synthetic authorization revoked");
      },
    }),
    (error) => error.outcome?.kind === "unsafe_request",
  );
});

test("malformed scopes and noncanonical source URLs are rejected before HTTP", async () => {
  const fixture = source();
  for (const extra of [
    { allowedProjectIds: [] },
    { allowedProjectIds: "PVT_alpha" },
    { allowedProjectIds: ["PVT_alpha", "PVT_alpha"] },
    { repository: { id: repository.id } },
    { sourceUrl: `${identity().url}#issuecomment-1` },
    { sourceUrl: `${identity().url}?scope=other` },
    { sourceUrl: identity().url.replace("github.com", "github.com.invalid") },
    { sourceUrl: identity().url.replace(repository.slug, "synthetic-owner/other") },
  ])
    await assert.rejects(fixture.read(extra));
  assert.equal(fixture.calls.length, 0);
});

test("missing, null, unmapped and wrong-field options retain known Project association with unknown workstream", async () => {
  const original = await source().read();
  for (const [fields, configured] of [
    [original.items[0].fields, undefined],
    [[], mapping()],
    [[{ fieldId: "PVTSSF_alpha", optionId: null }], mapping()],
    [[{ fieldId: "PVTSSF_alpha", optionId: "unmapped" }], mapping()],
    [[{ fieldId: "PVTSSF_wrong", optionId: "option_blue" }], mapping()],
  ]) {
    const snapshot = structuredClone(original);
    snapshot.items[0].fields = fields;
    assert.deepEqual(projectContextFromSnapshot(snapshot, configured), {
      projects: ["PVT_alpha"],
      workstreams: [],
      workstreamsKnown: false,
    });
  }
});

test("one mapped membership does not turn another unmapped membership into known workstream absence", async () => {
  const snapshot = await source({ members: [member("alpha"), member("beta")] }).read();
  const configured = mapping();
  configured.projects = configured.projects.slice(0, 1);
  assert.deepEqual(projectContextFromSnapshot(snapshot, configured), {
    projects: ["PVT_alpha", "PVT_beta"],
    workstreams: ["engineering"],
    workstreamsKnown: false,
  });
});

test("mapping validation returns canonical detached ID bindings and permits many-to-one workstreams", () => {
  const configured = mapping();
  configured.projects.reverse();
  configured.projects[0].fields[0].options.reverse();
  const normalized = validateProjectWorkstreamMapping(configured, [...approved].reverse());
  assert.deepEqual(normalized, mapping());
  configured.projects[0].fields[0].options[0].workstreamId = "mutated";
  assert.equal(JSON.stringify(normalized).includes("mutated"), false);
});

test("out-of-scope, duplicate, ambiguous or name-based configuration cannot supply workstream identity", () => {
  for (const alter of [
    (value) => {
      value.version = "";
    },
    (value) => {
      value.repositoryId = repository.id;
    },
    (value) => {
      value.projects[0].projectId = "PVT_outside";
    },
    (value) => {
      value.projects.push(structuredClone(value.projects[0]));
    },
    (value) => {
      value.projects[0].fields = [];
    },
    (value) => {
      value.projects[1].fields[0].fieldId = value.projects[0].fields[0].fieldId;
    },
    (value) => {
      value.projects[0].fields[0].name = "Workstream";
    },
    (value) => {
      value.projects[0].fields[0].options.push({ optionId: "option_blue", workstreamId: "different" });
    },
    (value) => {
      value.projects[0].fields[0].options[0] = { optionName: "Engineering", workstreamId: "engineering" };
    },
    (value) => {
      value.projects[0].fields[0].options[0].workstreamId = "";
    },
  ]) {
    const altered = mapping();
    alter(altered);
    assert.throws(() => validateProjectWorkstreamMapping(altered, approved), /invalid_project_workstream_mapping/);
  }
});
