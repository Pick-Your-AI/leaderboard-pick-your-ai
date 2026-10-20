import assert from "node:assert/strict";
import test from "node:test";
import { harness, ago, clock, boardUrl, fiveAuthorIssuePayloads } from "./harness.mjs";

// The existing synthetic source creates real persisted
// PGlite snapshots and a SQLite controls store. The hook awaits the actual SQL
// transaction before withdrawing the actor; it never replaces SQL result rows.
for (const image of [false, true]) {
  for (const pinned of [false, true]) {
    for (const conditional of [false, true]) {
      test(`card return rechecks opt-out after SQL commit: ${image ? "SVG" : "HTML"}, ${pinned ? "pinned" : "current"}, ${conditional ? "prior ETag" : "ordinary"}`, async (t) => {
        const h = await harness(t);
        const publication = await h.runtime.runOnce();
        assert.equal(publication.state, "published");
        const pin = publication.publications[0].snapshotId;
        const path = `/api/v1/cards/101${image ? "/image" : ""}?metric=issues_opened${pinned ? `&snapshot=${pin}` : ""}`;
        const before = await h.runtime.app.inject(path);
        assert.equal(before.statusCode, 200, before.body);
        assert.match(before.body, /synthetic-alice/);
        assert.equal(before.headers["cache-control"], "no-store");
        assert.ok(before.headers.etag);
        const originalSnapshots = (
          await h.db.query(
            "SELECT snapshot_id,revision,document_hash FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id",
          )
        ).rows;
        const sourceReads = { ...h.githubReads };
        const transaction = h.db.transaction;
        let changed = 0;
        h.db.transaction = async (work) => {
          const result = await transaction(work);
          // This is the production PublicRead returned by the real transaction.
          // The currentness change occurs after its real COMMIT has completed.
          if (changed === 0 && result?.selected?.snapshot?.snapshotId === pin) {
            assert.equal(result.controls.suppressedActorIds.includes("101"), false);
            h.controlsStore.transaction(
              (state) => {
                state.profiles["101"] = { suppressed: true, public: false, bio: "", highlights: [] };
              },
              { publish: true },
            );
            changed++;
          }
          return result;
        };
        let response;
        try {
          response = await h.runtime.app.inject({
            url: path,
            headers: conditional ? { "if-none-match": before.headers.etag } : {},
          });
        } finally {
          h.db.transaction = transaction;
        }
        assert.equal(changed, 1, "the actual read transaction must reach the final COMMIT hook");
        const next = await h.runtime.app.inject(path);
        assert.equal(next.statusCode, 404, "the unchanged source already enforces this opt-out on the next read");
        assert.deepEqual(h.githubReads, sourceReads, "a served card read must not collect new source evidence");
        assert.deepEqual(
          (
            await h.db.query(
              "SELECT snapshot_id,revision,document_hash FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id",
            )
          ).rows,
          originalSnapshots,
          "privacy projection must not rewrite historical snapshot content",
        );
        // A 304 also authorizes reuse of the formerly visible card. Returning an
        // unavailable response is required; an old 200 or 304 is not a withdrawal.
        assert.ok(response.statusCode >= 400, `card returned stale ${response.statusCode} after actor opt-out`);
        assert.doesNotMatch(response.body, /synthetic-alice|synthetic-org\/synthetic-repo\/issues\/1/);
      });
    }
  }
}

for (const conditional of [false, true]) {
  test(
    "unchanged final COMMIT preserves a pinned SVG " + (conditional ? "conditional response" : "ordinary response"),
    async (t) => {
      const h = await harness(t);
      const pin = (await h.runtime.runOnce()).publications[0].snapshotId;
      const path = `/api/v1/cards/101/image?metric=issues_opened&snapshot=${pin}`;
      const before = await h.runtime.app.inject(path);
      assert.equal(before.statusCode, 200, before.body);
      const transaction = h.db.transaction;
      const controls = h.controlsStore.read();
      let completed = 0;
      h.db.transaction = async (work) => {
        const result = await transaction(work);
        if (result?.selected?.snapshot?.snapshotId === pin) completed++;
        return result;
      };
      let response;
      try {
        response = await h.runtime.app.inject({
          url: path,
          headers: conditional ? { "if-none-match": before.headers.etag } : {},
        });
      } finally {
        h.db.transaction = transaction;
      }
      assert.equal(completed, 1);
      assert.equal(response.statusCode, conditional ? 304 : 200);
      assert.equal(response.body, conditional ? "" : before.body);
      assert.equal(response.headers.etag, before.headers.etag);
      assert.deepEqual(h.controlsStore.read(), controls);
    },
  );
}

// The shared source also serves a direct board and an outer comparison
// transaction. These two controls prevent a card-only workaround or a fix that
// fences nested reads but still returns stale data after the comparison COMMIT.
for (const comparison of [false, true]) {
  test(
    "public " + (comparison ? "comparison" : "board") + " return rechecks opt-out after its owning SQL commit",
    async (t) => {
      const scope = {
        organization: "Pick-Your-AI",
        repository: null,
        workstream: null,
        start: ago(60).replace(/\.\d{3}Z$/, ".000Z"),
        end: ago(1).replace(/\.\d{3}Z$/, ".000Z"),
      };
      const h = await harness(t, {
        ...(comparison ? { transformPayloads: fiveAuthorIssuePayloads } : {}),
        configure(config) {
          config.scopes = [scope];
        },
      });
      const first = (await h.runtime.runOnce({ cutoff: ago(0.01) })).publications[0].snapshotId;
      const second = comparison ? (await h.runtime.runOnce({ cutoff: clock() })).publications[0].snapshotId : first;
      if (comparison) assert.notEqual(first, second);
      const path =
        `${boardUrl}&${new URLSearchParams({ start: scope.start, end: scope.end })}` +
        (comparison ? `&snapshot=${second}&compare=${first}` : "");
      const before = await h.runtime.app.inject(path);
      assert.equal(before.statusCode, 200, before.body);
      assert.ok(before.json().rows.some((row) => row.actorId === "101"));
      if (comparison) assert.equal(before.json().comparison.snapshotId, first);
      const transaction = h.db.transaction;
      const sourceReads = { ...h.githubReads };
      let changed = 0;
      h.db.transaction = async (work) => {
        const result = await transaction(work);
        const captured = comparison ? result?.current : result;
        if (changed === 0 && captured?.selected?.snapshot?.snapshotId === second) {
          h.controlsStore.transaction(
            (state) => {
              state.profiles["101"] = { suppressed: true, public: false, bio: "", highlights: [] };
            },
            { publish: true },
          );
          changed++;
        }
        return result;
      };
      let response;
      try {
        response = await h.runtime.app.inject(path);
      } finally {
        h.db.transaction = transaction;
      }
      assert.equal(changed, 1, "the actual owning transaction must reach the COMMIT hook");
      const next = await h.runtime.app.inject(path);
      assert.equal(next.statusCode, 200, next.body);
      assert.equal(
        next.json().rows.some((row) => row.actorId === "101"),
        false,
      );
      assert.deepEqual(h.githubReads, sourceReads);
      if (response.statusCode === 200) {
        assert.equal(
          response.json().rows.some((row) => row.actorId === "101"),
          false,
          "the raced response retained the opted-out actor",
        );
      } else assert.ok(response.statusCode >= 400, "stale data must not receive a conditional-success response");
      assert.doesNotMatch(response.body, /synthetic-alice/);
    },
  );
}
