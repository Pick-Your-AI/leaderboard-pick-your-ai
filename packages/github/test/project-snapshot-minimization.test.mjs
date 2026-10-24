import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import {
  FileCheckpointStore,
  GithubClientError,
  GithubReadClient,
  createGithubEvidenceNormalizer,
  projectSnapshotRevision,
  projectSubjectSnapshotRevision,
  readPublicProjectSnapshot,
  readPublicSubjectProjectSnapshot,
} from "../dist/index.js";

const repository = {
  id: 2,
  slug: "synthetic-owner/project-minimization",
  allowedProjectIds: ["PVT_synthetic_public"],
};
const source = "synthetic-project-minimization";
const itemId = "PVTI_synthetic_public";
const subjectId = "I_synthetic_public";
const sourceUrl = "https://github.com/synthetic-owner/project-minimization/issues/20";
const updatedAt = "2026-10-17T10:00:00Z";
const observedAt = "2026-10-18T10:00:00Z";
const privateProjectId = "PVT_synthetic_restricted_project";
const privateItemId = "PVTI_synthetic_restricted_item";
const restrictedText = "synthetic restricted Project field text: never retain";
const excluded = new RegExp(privateProjectId + "|" + privateItemId + "|" + restrictedText);

function minimalFields() {
  return [
    {
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      id: "PVTF_synthetic+select/==",
      field: { id: "PVTSSF_synthetic+field/==" },
    },
    {
      field: { id: "PVTF_" + "f".repeat(123) },
      id: "PVTF_" + "n".repeat(123),
      __typename: "ProjectV2ItemFieldNumberValue",
    },
    {
      id: "PVTF_synthetic_date",
      __typename: "ProjectV2ItemFieldDateValue",
      field: { id: "PVTF_synthetic_date_field" },
    },
    { __typename: "ProjectV2ItemFieldTextValue" },
  ];
}

const expectedSnapshot = () => ({
  id: itemId,
  projectId: "PVT_synthetic_public",
  sourceUrl,
  updatedAt,
  archived: false,
  fields: minimalFields(),
});

function excessiveFields() {
  // Extra response keys are deliberately adversarial. The actual native query
  // does not request this text, private Project identity or nested field name.
  return minimalFields().map((value) => ({
    ...value,
    ...(value.field ? { field: { ...value.field, name: restrictedText } } : {}),
    text: restrictedText,
    linkedProject: { id: privateProjectId, itemId: privateItemId },
  }));
}

async function files(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const result = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else {
      assert.equal(entry.isFile(), true);
      const text = await readFile(path, "utf8");
      result.push({ path, text, document: JSON.parse(text) });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "project-field-minimization-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = join(directory, "cache");
  const state = { fields: excessiveFields(), public: true, failAt: null };
  const calls = [];
  const delivered = { extraFields: 0, privateMemberships: 0 };
  const binding = () => ({
    __typename: "Issue",
    id: subjectId,
    url: sourceUrl,
    repository: { databaseId: 2, isPrivate: false },
  });
  const member = () => ({
    id: itemId,
    updatedAt,
    isArchived: false,
    project: { id: "PVT_synthetic_public", public: state.public },
  });
  const createClient = () =>
    new GithubReadClient({
      apiOrigin: "https://api.synthetic.invalid",
      token: async () => "synthetic-token",
      checkpoints: new FileCheckpointStore(cache),
      maxRetries: 0,
      fetch: async (url, request) => {
        assert.equal(url, "https://api.synthetic.invalid/graphql");
        assert.equal(request.method, "POST");
        assert.equal(request.redirect, "manual");
        const { query, variables } = JSON.parse(request.body);
        const call = { query, variables, kind: "" };
        calls.push(call);
        const connection = (nodes) => {
          const start = variables.after === null ? 0 : Number(variables.after.slice("field:".length));
          assert.ok(Number.isSafeInteger(start) && start >= 0);
          const end = Math.min(start + 2, nodes.length);
          return {
            nodes: structuredClone(nodes.slice(start, end)),
            totalCount: nodes.length,
            pageInfo: { hasNextPage: end < nodes.length, endCursor: end < nodes.length ? "field:" + end : null },
          };
        };
        let data;
        if (query.includes("PublicProjectContextScope")) {
          call.kind = "subject-scope";
          assert.deepEqual(variables.ids, ["PVT_synthetic_public"]);
          data = { nodes: [{ id: "PVT_synthetic_public", public: state.public }] };
        } else if (query.includes("PublicSubjectProjectMembership")) {
          call.kind = "subject-membership";
          assert.equal(variables.id, subjectId);
          delivered.privateMemberships++;
          data = {
            node: {
              ...binding(),
              projectItems: connection([
                member(),
                {
                  id: privateItemId,
                  updatedAt,
                  isArchived: false,
                  project: { id: privateProjectId, public: false },
                },
              ]),
            },
          };
        } else if (query.includes("PublicSubjectProjectFields")) {
          call.kind = "subject-fields";
          assert.equal(variables.id, itemId, "an unapproved Project item must never be hydrated");
          assert.doesNotMatch(query, /\b(text|name|body|number|date|email|members)\b/);
          data = {
            node: {
              ...member(),
              content: binding(),
              fieldValues: connection([
                {
                  __typename: "ProjectV2ItemFieldSingleSelectValue",
                  field: { id: "PVTSSF_synthetic", name: restrictedText },
                  optionId: "option_synthetic",
                  text: restrictedText,
                  linkedProject: { id: privateProjectId },
                },
                { __typename: "ProjectV2ItemFieldTextValue", text: restrictedText },
              ]),
            },
          };
        } else if (query.includes("fieldValues(")) {
          call.kind = "legacy-fields";
          assert.equal(variables.id, itemId);
          assert.doesNotMatch(query, /\b(text|name|body|number|date|email|members)\b/);
          const offset = variables.after === null ? 0 : Number(variables.after.slice("field:".length));
          if (state.failAt === offset)
            return new Response(JSON.stringify({ message: restrictedText, project: privateProjectId }), {
              status: 503,
              headers: { "content-type": "application/json" },
            });
          data = {
            node: { ...member(), content: binding(), fieldValues: connection(state.fields) },
          };
        } else {
          call.kind = "legacy-scope";
          assert.match(query, /\.\.\. on ProjectV2Item \{ project \{ id public \} \}/);
          assert.equal(variables.id, itemId);
          data = { node: { project: { id: "PVT_synthetic_public", public: state.public } } };
        }
        if (JSON.stringify(data).includes(restrictedText)) delivered.extraFields++;
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
  let client = createClient();
  const normalizer = () =>
    createGithubEvidenceNormalizer({
      client,
      source,
      allowedRepositoryIds: [repository.id],
      isSynthetic: true,
    });
  const input = (fact, factKey) => ({
    repository,
    family: "project_current",
    factKey,
    observedAt,
    policyVersion: "synthetic-project-minimization/v1",
    selectedCurrentState: true,
    fact,
  });
  const fact = (snapshot, revision) => ({
    subjectId: snapshot.id,
    sourceRevision: revision,
    sourceUrl: snapshot.sourceUrl,
    evidence: "current_state",
    actorId: null,
    occurredAt: null,
    state: "present",
  });
  return {
    state,
    calls,
    delivered,
    cache,
    reopen() {
      client = createClient();
    },
    read: (scanId = "synthetic-legacy-scan") =>
      readPublicProjectSnapshot({
        client: client.forRepository(repository.id),
        source,
        repository,
        itemId,
        allowedProjectIds: repository.allowedProjectIds,
        scanId,
      }),
    normalize: (revision = projectSnapshotRevision(expectedSnapshot()), factKey = "synthetic-legacy-normalization") =>
      normalizer()(input(fact(expectedSnapshot(), revision), factKey)),
    readSubject: () =>
      readPublicSubjectProjectSnapshot({
        client: client.forRepository(repository.id),
        source,
        repository,
        subjectId,
        sourceUrl,
        allowedProjectIds: repository.allowedProjectIds,
        scanId: "synthetic-subject-scan",
      }),
    normalizeSubject: (snapshot) =>
      normalizer()(
        input(
          {
            ...fact(
              { id: snapshot.subjectId, sourceUrl: snapshot.sourceUrl },
              projectSubjectSnapshotRevision(snapshot),
            ),
            projectSubjectId: snapshot.subjectId,
          },
          "synthetic-subject-normalization",
        ),
      ),
    files: () => files(cache),
    scans: async () =>
      (await files(cache)).filter(
        ({ document }) =>
          document.version === 1 && Array.isArray(document.items) && typeof document.complete === "boolean",
      ),
  };
}

async function assertClean(h) {
  const retained = await h.files();
  for (const file of retained) assert.doesNotMatch(file.text, excluded, relative(h.cache, file.path));
  return retained;
}

test("legacy Project fields retain requested identities in real checkpoints and normalization", async (t) => {
  const h = await fixture(t);
  h.state.fields = minimalFields();
  const minimal = await h.read();
  assert.equal(JSON.stringify(minimal), JSON.stringify(expectedSnapshot()));
  assert.equal(projectSnapshotRevision(minimal), projectSnapshotRevision(expectedSnapshot()));
  h.state.fields = excessiveFields();
  const snapshot = await h.read();
  await assertClean(h);
  assert.equal(JSON.stringify(snapshot), JSON.stringify(expectedSnapshot()));
  assert.equal(projectSnapshotRevision(snapshot), projectSnapshotRevision(minimal));
  assert.ok(h.delivered.extraFields > 0);
  const scans = await h.scans();
  assert.equal(scans.length, 1);
  assert.equal(scans[0].document.complete, true);
  assert.deepEqual(scans[0].document.items, minimalFields());

  const output = await h.normalize();
  assert.equal(output.observations.length, 1);
  assert.equal(output.observations[0].artifactId, itemId);
  assert.equal(output.observations[0].sourceUrl, sourceUrl);
  assert.equal(output.observations[0].actorId, null);
  assert.equal(output.observations[0].occurredAt, null);
  assert.deepEqual(output.facts, []);
  assert.deepEqual(output.reasons, ["current_project_context_does_not_prove_editor_or_time"]);
  assert.doesNotMatch(JSON.stringify(output), excluded);
  assert.equal((await h.scans()).length, 2);
  await assertClean(h);
});

test("a rejected legacy source revision cannot leave extra Project field content in its checkpoint", async (t) => {
  const h = await fixture(t);
  const output = await h.normalize("0".repeat(64));
  assert.deepEqual(output.reasons, ["project_snapshot_revision_or_subject_unverified"]);
  assert.deepEqual(output.observations, []);
  assert.deepEqual(output.facts, []);
  assert.ok(h.delivered.extraFields > 0);
  const scans = await h.scans();
  assert.equal(scans.length, 1, "the real native scan commits before the normalizer rejects the revision");
  assert.equal(scans[0].document.complete, true);
  assert.deepEqual(scans[0].document.items, minimalFields());
  await assertClean(h);
});

test("malformed supported Project identities fail before any selected page is checkpointed", async (t) => {
  for (const typename of [
    "ProjectV2ItemFieldSingleSelectValue",
    "ProjectV2ItemFieldNumberValue",
    "ProjectV2ItemFieldDateValue",
  ]) {
    for (const target of ["id", "field"]) {
      const h = await fixture(t);
      const malformed = { __typename: typename, id: "PVTF_synthetic", field: { id: "PVTF_synthetic_field" } };
      if (target === "id") malformed.id = { text: restrictedText, project: privateProjectId };
      else malformed.field.id = restrictedText;
      h.state.fields = [malformed];
      await assert.rejects(h.normalize(), (error) => {
        assert.equal(error.message, "project_field_identity_unverified");
        assert.doesNotMatch(error.message + JSON.stringify(error), excluded);
        return true;
      });
      assert.ok(h.delivered.extraFields > 0);
      assert.equal((await h.scans()).length, 0);
      await assertClean(h);
    }
  }
});

test("Project field identities reject line terminators and out-of-bound lengths before checkpointing", async (t) => {
  const invalid = [
    "",
    "A".repeat(129),
    ...["\n", "\r", "\r\n", "\u2028", "\u2029"].map((suffix) => "PVTF_synthetic" + suffix),
  ];
  for (const id of invalid) {
    for (const target of ["id", "field"]) {
      const h = await fixture(t);
      const value = {
        __typename: "ProjectV2ItemFieldSingleSelectValue",
        id: "PVTF_synthetic",
        field: { id: "PVTF_synthetic_field" },
        text: restrictedText,
      };
      if (target === "id") value.id = id;
      else value.field.id = id;
      h.state.fields = [value];
      await assert.rejects(h.normalize(), { message: "project_field_identity_unverified" });
      assert.ok(h.delivered.extraFields > 0);
      assert.equal((await h.scans()).length, 0);
      await assertClean(h);
    }
  }
});

test("unverified Project field type markers fail with a fixed non-content error", async (t) => {
  const invalid = [
    null,
    restrictedText,
    "ProjectV2ItemField" + "A".repeat(128) + "Value",
    ...["\n", "\r", "\r\n", "\u2028", "\u2029"].map((suffix) => "ProjectV2ItemFieldTextValue" + suffix),
  ];
  for (const typename of invalid) {
    const h = await fixture(t);
    h.state.fields = [{ __typename: typename, text: restrictedText, linkedProject: { id: privateProjectId } }];
    await assert.rejects(h.read(), { message: "project_field_identity_unverified" });
    assert.equal((await h.scans()).length, 0);
    await assertClean(h);
  }
});

test("a fresh legacy read replaces completed old checkpoint bytes without trusting them after reopen", async (t) => {
  const h = await fixture(t);
  await h.read();
  const [record] = await h.scans();
  assert.ok(record);
  const legacy = JSON.stringify({ ...record.document, items: excessiveFields() });
  await writeFile(record.path, legacy, "utf8");
  h.reopen();

  h.state.public = false;
  const before = h.calls.length;
  await assert.rejects(h.read(), { message: "project_not_authorized" });
  assert.deepEqual(
    h.calls.slice(before).map((call) => call.kind),
    ["legacy-scope"],
  );
  assert.equal(
    await readFile(record.path, "utf8"),
    legacy,
    "failure before an accepted page does not claim to erase already retained historical bytes",
  );

  h.state.public = true;
  const fresh = h.calls.length;
  assert.deepEqual(await h.read(), expectedSnapshot());
  assert.deepEqual(
    h.calls
      .slice(fresh)
      .filter((call) => call.kind === "legacy-fields")
      .map((call) => call.variables.after),
    [null, "field:2"],
  );
  const [replaced] = await h.scans();
  assert.equal(replaced.path, record.path);
  assert.equal(replaced.document.fingerprint, record.document.fingerprint);
  assert.equal(replaced.document.complete, true);
  assert.deepEqual(replaced.document.items, minimalFields());
  await assertClean(h);
});

test("an interrupted legacy refresh restarts its real scan and never resumes nonminimal saved items", async (t) => {
  const h = await fixture(t);
  h.state.failAt = 2;
  await assert.rejects(h.read(), (error) => {
    assert.ok(error instanceof GithubClientError);
    assert.equal(error.outcome.status, 503);
    assert.doesNotMatch(error.message + JSON.stringify(error), excluded);
    return true;
  });
  const [partial] = await h.scans();
  assert.ok(partial);
  assert.equal(partial.document.complete, false);
  assert.equal(partial.document.next, "field:2");
  assert.deepEqual(partial.document.items, minimalFields().slice(0, 2));
  await assertClean(h);

  // This models a partial checkpoint written by the former, nonminimal reader.
  await writeFile(partial.path, JSON.stringify({ ...partial.document, items: excessiveFields().slice(0, 2) }), "utf8");
  h.reopen();
  h.state.failAt = null;
  const before = h.calls.length;
  assert.deepEqual(await h.read(), expectedSnapshot());
  assert.deepEqual(
    h.calls
      .slice(before)
      .filter((call) => call.kind === "legacy-fields")
      .map((call) => call.variables.after),
    [null, "field:2"],
  );
  const [complete] = await h.scans();
  assert.equal(complete.path, partial.path);
  assert.equal(complete.document.fingerprint, partial.document.fingerprint);
  assert.equal(complete.document.complete, true);
  assert.deepEqual(complete.document.items, minimalFields());
  await assertClean(h);
});

test("the native subject reader still excludes private linked Projects and unsupported field text", async (t) => {
  const h = await fixture(t);
  const snapshot = await h.readSubject();
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].projectId, "PVT_synthetic_public");
  assert.deepEqual(snapshot.items[0].fields, [{ fieldId: "PVTSSF_synthetic", optionId: "option_synthetic" }]);
  assert.ok(h.delivered.privateMemberships > 0);
  assert.ok(h.delivered.extraFields > 0);
  assert.ok(h.calls.some((call) => call.kind === "subject-fields"));
  assert.ok(h.calls.filter((call) => call.kind === "subject-fields").every((call) => call.variables.id === itemId));
  assert.doesNotMatch(JSON.stringify(snapshot), excluded);
  const output = await h.normalizeSubject(snapshot);
  assert.deepEqual(output.projectContext.context.projects, ["PVT_synthetic_public"]);
  assert.deepEqual(output.facts, []);
  assert.deepEqual(output.actors, []);
  assert.doesNotMatch(JSON.stringify(output), excluded);
  assert.ok((await h.scans()).length >= 3);
  await assertClean(h);
});
