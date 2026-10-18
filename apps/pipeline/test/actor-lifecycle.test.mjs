import assert from "node:assert/strict";
import test from "node:test";
import { createPipeline } from "../src/index.mjs";
import { harness, getBoard, boardUrl, clock } from "./harness.mjs";

// Parse the actual quoted CSV response, including escaped quotes and embedded commas.
function csvRecords(body) {
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let index = 0; index < body.length; index++) {
    const character = body[index];
    if (character === '"') {
      if (quoted && body[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if (character === "\r" && body[index + 1] === "\n" && !quoted) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index++;
    } else cell += character;
  }
  assert.equal(quoted, false);
  assert.deepEqual(row, []);
  assert.equal(cell, "");
  const [columns, ...records] = rows;
  for (const record of records) assert.equal(record.length, columns.length);
  return records.map((record) => Object.fromEntries(columns.map((column, index) => [column, record[index]])));
}

for (const reverse of [false, true]) {
  for (const remainingEvidence of [false, true]) {
    for (const missingIdentity of ["absent", "labels_only"]) {
      test(`later ${missingIdentity} actor attribution stays unknown; other evidence=${remainingEvidence}, reverse=${reverse}`, async (t) => {
        let payloads;
        const h = await harness(t, {
          reverseNormalizationRows: reverse,
          transformPayloads(value) {
            payloads = value;
            if (remainingEvidence)
              value.push({
                ...structuredClone(value[1]),
                id: 1003,
                node_id: "SYNTHETIC_ISSUE_3",
                number: 3,
                html_url: "https://github.com/synthetic-org/synthetic-repo/issues/3",
              });
            return value;
          },
        });
        await h.runtime.runOnce();
        const first = await getBoard(h.runtime);
        const beforeBob = first.rows.find((row) => row.actorId === "102");
        assert.equal(beforeBob.result.value, remainingEvidence ? 2 : 1);
        let lostProof;
        for (const id of beforeBob.evidenceIds) {
          const response = await h.runtime.app.inject(`/api/v1/evidence/${id}`);
          assert.equal(response.statusCode, 200);
          if (response.json().artifact.stableId === "SYNTHETIC_ISSUE_2") lostProof = id;
        }
        assert.equal(typeof lostProof, "string");
        const oldSource = (
          await h.db.query("SELECT fact_key,document FROM leaderboard_ingestion.source_facts ORDER BY fact_key")
        ).rows;
        const original = structuredClone(payloads[1]);
        // Replace the actual hydrated subject in place, not a duplicate hidden behind .find().
        // Neither null nor matching labels establish a deleted/suspended account diagnosis.
        payloads[1].user =
          missingIdentity === "absent"
            ? null
            : {
                login: original.user.login,
                name: "Synthetic Bob",
                type: "User",
                email: "synthetic-contact@example.invalid",
              };
        payloads[1].updated_at = clock();
        assert.notEqual(payloads[1].updated_at, original.updated_at);
        assert.equal((await h.runtime.runOnce()).state, "published");
        const afterSource = (
          await h.db.query("SELECT fact_key,document FROM leaderboard_ingestion.source_facts ORDER BY fact_key")
        ).rows;
        for (const row of oldSource)
          assert.deepEqual(
            afterSource.find((candidate) => candidate.fact_key === row.fact_key),
            row,
          );
        const saved = (
          await h.db.query("SELECT document FROM leaderboard_pipeline.normalizations ORDER BY fact_key")
        ).rows.map((row) => row.document);
        const unknown = saved.filter((document) =>
          document.facts.some((fact) => fact.artifactId === "SYNTHETIC_ISSUE_2" && fact.actorId === null),
        );
        assert.equal(unknown.length, 1, "the changed subject was actually hydrated and persisted");
        assert.deepEqual(unknown[0].actors, []);
        assert.ok(unknown[0].reasons.includes("unknown_actor"));
        assert.ok(
          unknown[0].facts.every(
            (fact) => fact.actorId === null && fact.subjectActorId === null && fact.state === "unknown",
          ),
        );
        assert.ok(unknown[0].evidence.every((entry) => entry.contribution.actorId === null));
        assert.doesNotMatch(JSON.stringify(saved), /synthetic-contact@example\.invalid/);
        const second = await getBoard(h.runtime);
        const afterBob = second.rows.find((row) => row.actorId === "102");
        if (remainingEvidence) {
          assert.equal(afterBob.result.value, 1, "a separate verified subject remains eligible");
          assert.deepEqual(
            afterBob.evidenceIds,
            beforeBob.evidenceIds.filter((id) => id !== lostProof),
          );
        } else assert.equal(afterBob, undefined, "the unavailable subject supplies no current named credit");
        const directory = await h.runtime.app.inject("/api/v1/contributors");
        assert.equal(directory.statusCode, 200);
        assert.equal(
          directory.json().contributors.some((entry) => entry.actorId === "102"),
          remainingEvidence,
        );
        assert.deepEqual((await getBoard(h.runtime, `&snapshot=${first.snapshotId}`)).rows, first.rows);

        // Protected account-wide suppression is separate from a missing source observation.
        h.controlsStore.transaction((state) => {
          state.profiles["102"] = { suppressed: true };
        });
        const checkSuppression = async (runtime) => {
          for (const pin of [null, first.snapshotId, second.snapshotId]) {
            const read = async (path) => {
              const url = pin === null ? path : `${path}${path.includes("?") ? "&" : "?"}snapshot=${pin}`;
              const response = await runtime.app.inject(url);
              assert.doesNotMatch(response.body, /synthetic-bob|U_SYNTHETIC_B|synthetic-contact@example\.invalid/, url);
              return response;
            };
            const board = await read(boardUrl);
            assert.equal(board.statusCode, 200, board.body);
            assert.deepEqual(
              board.json().rows.map((row) => [row.actorId, row.result.value]),
              [["101", 1]],
            );
            const people = await read("/api/v1/contributors");
            assert.equal(people.statusCode, 200, people.body);
            assert.deepEqual(
              people.json().contributors.map((entry) => entry.actorId),
              ["101"],
            );
            const json = await read("/api/v1/exports?metric=issues_opened&format=json");
            assert.equal(json.statusCode, 200, json.body);
            assert.deepEqual(
              json.json().rows.map((row) => [row.actorId, row.result.value]),
              [["101", 1]],
            );
            const csv = await read("/api/v1/exports?metric=issues_opened&format=csv");
            assert.equal(csv.statusCode, 200, csv.body);
            const records = csvRecords(csv.body);
            assert.equal(records[0].record_type, "metadata");
            assert.deepEqual(
              records.slice(1).map((row) => [row.record_type, row.actor_id, row.value]),
              [["row", "101", "1"]],
            );
            const profile = await read("/api/v1/contributors/102");
            assert.ok([404, 410].includes(profile.statusCode), profile.body);
            for (const id of beforeBob.evidenceIds) {
              const proof = await read(`/api/v1/evidence/${id}`);
              assert.ok([404, 410].includes(proof.statusCode), proof.body);
            }
          }
        };
        await checkSuppression(h.runtime);
        await h.runtime.stop();
        await h.reopenDatabase();
        const restarted = await createPipeline(h.options);
        t.after(() => restarted.stop());
        await checkSuppression(restarted);
      });
    }
  }
}
