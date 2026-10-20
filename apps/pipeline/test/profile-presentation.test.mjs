import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { harness, publicScope, components } from "./harness.mjs";
import { createPipeline } from "../src/index.mjs";

const bio = "Synthetic opted-in cafe\u0301 日本語 profile";
const savedProfile = {
  bio,
  highlights: ["https://github.com/synthetic/repo/issues/1"],
  public: true,
  suppressed: false,
};
const expected = {
  schemaVersion: "public-profile-presentation/v1",
  actorId: "101",
  bio,
  highlights: savedProfile.highlights,
};
const signal = () => new AbortController().signal;
const snapshots = async (h) =>
  (
    await h.db.query(
      "SELECT snapshot_id,revision,document_hash FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id",
    )
  ).rows;
const save = (h, value) =>
  h.controlsStore.transaction(
    (state) => {
      state.profiles["101"] = structuredClone(value);
    },
    { publish: true },
  );

test("one selected numeric profile survives a real publication and reopen without joining a shared login", async (t) => {
  const h = await harness(t, {
    transformPayloads: (payloads) =>
      payloads.map((payload) => ({ ...payload, user: { ...payload.user, login: "same-synthetic-login" } })),
  });
  save(h, savedProfile);
  h.controlsStore.transaction(
    (state) => {
      state.profiles["102"] = { ...savedProfile, bio: "PRIVATE second owner", public: false };
      state.profiles["999"] = { ...savedProfile, bio: "Unpublished account" };
    },
    { publish: true },
  );
  const publication = await h.runtime.runOnce();
  assert.equal(publication.state, "published");
  const pin = publication.publications[0].snapshotId;
  const beforeRows = await snapshots(h);
  const reads = { ...h.githubReads };
  const value = await h.runtime.source.readProfile(publicScope, pin, "101", signal());
  assert.deepEqual(value.presentation, expected);
  assert.equal(value.selected.actors.find((entry) => entry.actorId === "101").actor.githubDatabaseId, 101);
  assert.equal(value.selected.actors.find((entry) => entry.actorId === "102").actor.login, "same-synthetic-login");
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE second owner|Unpublished account/);
  assert.doesNotMatch(JSON.stringify(value.selected), /Synthetic opted-in/);
  assert.equal(Object.hasOwn(await h.runtime.source.read(publicScope, pin, signal()), "presentation"), false);
  await h.runtime.stop();
  await h.reopenDatabase();
  const controlsStore = new components.controls.ControlStore(join(h.directory, "controls.sqlite"));
  const reopened = await createPipeline({ ...h.options, controlsStore });
  try {
    const state = controlsStore.read();
    assert.deepEqual((await reopened.source.readProfile(publicScope, pin, "101", signal())).presentation, expected);
    for (const actorId of ["102", "999", "0101"])
      assert.equal((await reopened.source.readProfile(publicScope, pin, actorId, signal())).presentation, null);
    assert.deepEqual(controlsStore.read(), state);
    assert.deepEqual(await snapshots(h), beforeRows);
    assert.deepEqual(h.githubReads, reads);
  } finally {
    await reopened.stop();
    controlsStore.close();
  }
});

test("private, suppressed and unsafe legacy optional text stays stored but is withheld as a whole", async (t) => {
  const h = await harness(t);
  save(h, savedProfile);
  const pin = (await h.runtime.runOnce()).publications[0].snapshotId;
  const beforeRows = await snapshots(h);
  for (const value of [
    { ...savedProfile, public: false },
    { ...savedProfile, suppressed: true },
    { ...savedProfile, highlights: [...savedProfile.highlights, "https://github.com/synthetic/repo?legacy=private"] },
    { ...savedProfile, bio: "Legacy text\n" },
  ]) {
    save(h, value);
    const state = h.controlsStore.read();
    const read = await h.runtime.source.readProfile(publicScope, pin, "101", signal());
    assert.equal(read.presentation, null);
    assert.deepEqual(h.controlsStore.read(), state);
    assert.deepEqual(await snapshots(h), beforeRows);
  }
  save(h, savedProfile);
  assert.deepEqual((await h.runtime.source.readProfile(publicScope, pin, "101", signal())).presentation, expected);
});

for (const action of ["unchanged", "private", "suppressed"]) {
  test(`profile response uses the final real COMMIT controls for ${action}, including a historical pin and old ETag`, async (t) => {
    const h = await harness(t);
    save(h, savedProfile);
    const pin = (await h.runtime.runOnce()).publications[0].snapshotId;
    const path = `/api/v1/contributors/101?snapshot=${pin}`;
    const before = await h.runtime.app.inject(path);
    assert.equal(before.statusCode, 200, before.body);
    assert.deepEqual(before.json().presentation, expected);
    const beforeRows = await snapshots(h);
    const reads = { ...h.githubReads };
    const transaction = h.db.transaction;
    let committed = 0;
    h.db.transaction = async (work) => {
      const result = await transaction(work);
      if (result?.selected?.snapshot?.snapshotId === pin && committed === 0) {
        assert.deepEqual(result.presentation, expected, "the real transaction captured the original optional text");
        if (action !== "unchanged")
          save(h, { ...savedProfile, ...(action === "private" ? { public: false } : { suppressed: true }) });
        committed++;
      }
      return result;
    };
    let response;
    try {
      response = await h.runtime.app.inject({ url: path, headers: { "if-none-match": before.headers.etag } });
    } finally {
      h.db.transaction = transaction;
    }
    assert.equal(committed, 1);
    if (action === "unchanged") {
      assert.equal(response.statusCode, 304);
      assert.equal(response.headers.etag, before.headers.etag);
      assert.equal(response.body, "");
    } else {
      assert.equal(response.statusCode, action === "private" ? 200 : 404, response.body);
      if (action === "private") assert.equal(response.json().presentation, null);
      assert.doesNotMatch(response.body, /Synthetic opted-in|https:\/\/github.com\/synthetic\/repo\/issues\/1/);
      assert.notEqual(response.headers.etag, before.headers.etag);
    }
    assert.deepEqual(h.githubReads, reads);
    assert.deepEqual(await snapshots(h), beforeRows);
  });
}
