import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  capturePullRequestDecisionHistory as capture,
  validatePullRequestDecisionHistory as validate,
  selectPullRequestDecisionAsOf as select,
  GithubClientError,
} from "../dist/index.js";
import {
  decisionFixture,
  decisionEvent as event,
  closedAnchor,
  mergedAnchor,
} from "../../../tests/fixtures/pull-request-decision-history.mjs";

const t2 = "2026-01-02T00:00:00Z";
const t3 = "2026-01-03T00:00:00Z";
const t4 = "2026-01-04T00:00:00Z";
const t5 = "2026-01-05T00:00:00Z";
const t6 = "2026-01-06T00:00:00Z";
async function captured(fixture) {
  const result = await capture(fixture.options);
  assert.equal(result.status, "captured", JSON.stringify(result));
  return result.receipt;
}
const expected = (receipt) => ({ binding: receipt.binding, generation: receipt.generation });
const resign = (receipt) => {
  const { digest: _digest, ...payload } = receipt;
  return {
    ...payload,
    digest: createHash("sha256")
      .update("github-pr-decision-history/v1\n")
      .update(JSON.stringify(payload))
      .digest("hex"),
  };
};

test("a complete empty native history yields private pending with a strict source binding", async () => {
  const h = decisionFixture();
  const receipt = await captured(h);
  const selected = select(receipt);
  assert.equal(selected.status, "selected");
  assert.equal(selected.outcome, "pending");
  assert.equal(selected.decisionAt, null);
  assert.deepEqual(selected.sourceEventIds, []);
  assert.equal(selected.authorId, "U_SYNTHETIC_AUTHOR");
  assert.equal(selected.unitKey, "github:2:pull_request:PR_SYNTHETIC_DECISION");
  assert.equal(validate(receipt, expected(receipt)).status, "validated");
  assert.deepEqual(
    h.state.calls.map((call) => call.operation),
    ["PullRequestDecisionAnchor", "PullRequestDecisionHistory", "PullRequestDecisionAnchor"],
  );
  assert.ok(
    h.state.calls.every(
      (call) => !/\bsince\b|\bmutation\b|\btitle\b|\bbody\b|\bemail\b|\bbaseRefName\b/.test(call.query),
    ),
  );
  assert.equal(h.writes.filter((write) => /scan:|response:/.test(write.key)).length, 0);
});

test("native close and merge each produce one terminal decision", async (t) => {
  for (const [kind, anchor, outcome] of [
    ["closed", closedAnchor(t2), "closed_unmerged"],
    ["merged", mergedAnchor(t2), "merged"],
  ])
    await t.test(kind, async () => {
      const result = select(await captured(decisionFixture([event(kind, t2)], anchor)));
      assert.equal(result.outcome, outcome);
      assert.equal(result.decisionAt, t2);
      assert.deepEqual(result.sourceEventIds, ["E_SYNTHETIC_" + kind]);
    });
});

test("close/reopen/reclose selects only the final state before any reporting-window filter", async () => {
  const h = decisionFixture(
    [event("closed", t2, "C1"), event("reopened", t3), event("closed", t4, "C2")],
    closedAnchor(t4),
  );
  const receipt = await captured(h);
  assert.deepEqual(
    { outcome: select(receipt).outcome, at: select(receipt).decisionAt, ids: select(receipt).sourceEventIds },
    { outcome: "closed_unmerged", at: t4, ids: ["C2"] },
  );
  h.options.asOf = t4;
  const atBoundary = select(await captured(h));
  assert.equal(atBoundary.outcome, "pending");
  assert.equal(atBoundary.decisionAt, null);
  assert.deepEqual(atBoundary.sourceEventIds, ["E_SYNTHETIC_reopened"]);
});

test("historical state can differ from today's stable native state", async (t) => {
  await t.test("closed before cutoff and reopened afterward", async () => {
    const result = select(await captured(decisionFixture([event("closed", t2), event("reopened", t6)])));
    assert.equal(result.outcome, "closed_unmerged");
    assert.equal(result.decisionAt, t2);
  });
  await t.test("pending before cutoff and closed afterward", async () => {
    const result = select(
      await captured(
        decisionFixture(
          [event("closed", t2, "C1"), event("reopened", t3), event("closed", t6, "C2")],
          closedAnchor(t6),
        ),
      ),
    );
    assert.equal(result.outcome, "pending");
    assert.equal(result.decisionAt, null);
  });
});

test("creation at or after the exclusive cutoff is outside the cohort", async (t) => {
  for (const createdAt of [t5, t6])
    await t.test(createdAt, async () => {
      const result = select(await captured(decisionFixture([], { createdAt })));
      assert.equal(result.status, "not_yet_created");
    });
});

test("events immediately before, exactly at, and after cutoff preserve submillisecond order", async () => {
  const before = "2026-01-05T00:00:00.000000001Z";
  const cutoff = "2026-01-05T00:00:00.000000002Z";
  const after = "2026-01-05T00:00:00.000000003Z";
  const h = decisionFixture(
    [event("closed", before, "C1"), event("reopened", cutoff), event("closed", after, "C2")],
    closedAnchor(after),
  );
  h.options.asOf = cutoff;
  const receipt = await captured(h);
  assert.equal(select(receipt).decisionAt, before);
  assert.equal(receipt.history[0].createdAt, before);
  h.options.asOf = after;
  assert.equal(select(await captured(h)).outcome, "pending");
  h.options.asOf = "2026-01-05T00:00:00.000000004Z";
  assert.equal(select(await captured(h)).decisionAt, after);
});

test("compatible same-instant close and merge retain both source IDs", async () => {
  const merged = event("merged", "2026-01-02T00:00:00.000Z", "M1");
  merged.commit = null;
  const h = decisionFixture([merged, event("closed", t2, "C1")], mergedAnchor(t2));
  const receipt = await captured(h);
  assert.equal(receipt.history[0].commitOid, null);
  const result = select(receipt);
  assert.equal(result.outcome, "merged");
  assert.equal(result.decisionAt, merged.createdAt);
  assert.deepEqual(result.sourceEventIds, ["C1", "M1"]);
});

test("conflicting simultaneous events have no invented event-ID or arrival-order precedence", async (t) => {
  for (const pair of [
    ["closed", "reopened"],
    ["reopened", "merged"],
    ["closed", "closed"],
  ]) {
    await t.test(pair.join("/"), async () => {
      const h = decisionFixture(pair.map((kind, index) => event(kind, t2, "E" + index)));
      assert.deepEqual(await capture(h.options), { status: "unavailable", reason: "history_ambiguous" });
    });
  }
});

test("impossible lifecycle histories cannot become a decision", async (t) => {
  const cases = [
    ["orphan reopen", [event("reopened", t2)]],
    ["reopen after merge", [event("merged", t2), event("reopened", t3)]],
    ["repeated merge", [event("merged", t2, "M1"), event("merged", t3, "M2")]],
    ["merge of closed without reopen", [event("closed", t2), event("merged", t3)]],
    ["repeated close", [event("closed", t2, "C1"), event("closed", t3, "C2")]],
  ];
  for (const [name, events] of cases)
    await t.test(name, async () => {
      assert.deepEqual(await capture(decisionFixture(events).options), {
        status: "unavailable",
        reason: "history_inconsistent",
      });
    });
});

test("full replay must agree with the stable current anchor", async (t) => {
  for (const [name, events, anchor] of [
    ["missing closed history", [], closedAnchor(t2)],
    ["missing merged history", [], mergedAnchor(t2)],
    ["wrong final state", [event("closed", t2)], {}],
    ["wrong final timestamp", [event("closed", t2)], closedAnchor(t3)],
  ])
    await t.test(name, async () => {
      assert.equal((await capture(decisionFixture(events, anchor).options)).reason, "history_inconsistent");
    });
});

test("pagination consumes all native pages and does not reuse a finished scan cache", async () => {
  const h = decisionFixture([event("closed", t2), event("reopened", t3), event("merged", t4)], mergedAnchor(t4));
  h.state.pageSize = 1;
  const receipt = await captured(h);
  assert.equal(receipt.pagination.pages.length, 3);
  assert.deepEqual(
    receipt.pagination.pages.map((page) => page.after),
    [null, "C_1", "C_2"],
  );
  await captured(h);
  assert.equal(h.state.calls.filter((call) => call.operation === "PullRequestDecisionHistory").length, 6);
});

test("null nodes, count contradictions, cursor loops and missing terminal pages remain unavailable", async (t) => {
  const changes = [
    [
      "null node",
      (c) => {
        c.edges[0].node = null;
      },
    ],
    [
      "page count",
      (c) => {
        c.pageCount++;
      },
    ],
    [
      "filtered count",
      (c) => {
        c.filteredCount++;
      },
    ],
    [
      "premature terminal",
      (c) => {
        c.pageInfo.hasNextPage = false;
      },
    ],
    [
      "missing end cursor",
      (c) => {
        c.pageInfo.endCursor = null;
      },
    ],
    [
      "cursor mismatch",
      (c) => {
        c.pageInfo.endCursor = "C_OTHER";
      },
    ],
    [
      "duplicate cursor",
      (c) => {
        c.edges[0].cursor = "C_1";
        c.pageInfo.endCursor = "C_1";
      },
    ],
    [
      "empty partial page",
      (c) => {
        c.edges = [];
        c.pageCount = 0;
        c.pageInfo.endCursor = null;
      },
    ],
  ];
  for (const [name, change] of changes)
    await t.test(name, async () => {
      const h = decisionFixture([event("closed", t2), event("reopened", t3)]);
      h.state.pageSize = 1;
      h.state.transform = (call, response) => {
        if (call.operation === "PullRequestDecisionHistory" && (name !== "duplicate cursor" || call.variables.after))
          change(response.data.repository.pullRequest.timelineItems);
      };
      assert.equal((await capture(h.options)).status, "unavailable");
    });
});

test("a finite page budget cannot label a partial history complete", async () => {
  const h = decisionFixture([event("closed", t2), event("reopened", t3)]);
  h.state.pageSize = 1;
  h.options.maxPages = 1;
  assert.deepEqual(await capture(h.options), { status: "unavailable", reason: "budget_exceeded" });
  assert.equal(h.state.calls.filter((call) => call.operation === "PullRequestDecisionAnchor").length, 1);
});

test("source and timeline changes during or after pagination reject the capture", async (t) => {
  for (const stage of ["page", "final"])
    for (const field of ["state", "updatedAt", "timelineUpdatedAt", "totalCount"]) {
      await t.test(stage + "/" + field, async () => {
        const h = decisionFixture();
        h.state.transform = (call, response) => {
          if (
            (stage === "page" && call.operation === "PullRequestDecisionHistory") ||
            (stage === "final" && h.state.calls.length === 3)
          ) {
            const subject = response.data.repository.pullRequest;
            if (field === "state") subject.state = "CLOSED";
            if (field === "updatedAt") subject.updatedAt = "2026-01-07T00:00:01Z";
            if (field === "timelineUpdatedAt") subject.timelineItems.updatedAt = "2026-01-07T00:00:01Z";
            if (field === "totalCount") subject.timelineItems.totalCount++;
          }
        };
        assert.equal((await capture(h.options)).reason, "history_changed");
      });
    }
});

test("native repository, PR, author and every event endpoint are bound exactly", async (t) => {
  const mutations = [
    [
      "private repo",
      (r) => {
        r.isPrivate = true;
      },
    ],
    [
      "repo ID",
      (r) => {
        r.databaseId++;
      },
    ],
    [
      "repo slug",
      (r) => {
        r.nameWithOwner = "synthetic-other/repository";
      },
    ],
    [
      "PR ID",
      (r) => {
        r.pullRequest.id = "PR_OTHER";
      },
    ],
    [
      "PR database ID",
      (r) => {
        r.pullRequest.databaseId++;
      },
    ],
    [
      "PR number",
      (r) => {
        r.pullRequest.number++;
      },
    ],
    [
      "PR URL",
      (r) => {
        r.pullRequest.url += "?other=1";
      },
    ],
    [
      "author",
      (r) => {
        r.pullRequest.author.id = "U_OTHER";
      },
    ],
    [
      "creation",
      (r) => {
        r.pullRequest.createdAt = t2;
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    await t.test(name, async () => {
      const h = decisionFixture();
      h.state.transform = (_call, response) => mutate(response.data.repository);
      assert.equal((await capture(h.options)).reason, "subject_unavailable");
    });
  for (const field of ["id", "databaseId", "number", "url", "__typename", "repository"])
    await t.test("event parent/" + field, async () => {
      const e = event("closed", t2);
      e.closable[field] =
        field === "repository"
          ? { databaseId: 999, isPrivate: false, nameWithOwner: "synthetic-owner/repository" }
          : "WRONG";
      assert.equal((await capture(decisionFixture([e], closedAnchor(t2)).options)).reason, "subject_unavailable");
    });
});

test("unknown authors remain explicit and never become merge operators", async () => {
  const h = decisionFixture([event("merged", t2)], { ...mergedAnchor(t2), author: null });
  const receipt = await captured(h);
  assert.equal(select(receipt).authorId, null);
  assert.equal(receipt.binding.subject.author, null);
});

test("unexpected event kinds and duplicate native identities cannot inflate totals", async (t) => {
  await t.test("type", async () => {
    const e = event("closed", t2);
    e.__typename = "IssueComment";
    assert.equal((await capture(decisionFixture([e], closedAnchor(t2)).options)).reason, "invalid_response");
  });
  await t.test("duplicate", async () => {
    const h = decisionFixture([event("closed", t2, "SAME"), event("reopened", t3, "SAME")]);
    assert.equal((await capture(h.options)).reason, "history_inconsistent");
  });
});

test("original clocks cannot be backdated or rounded into a valid capture", async (t) => {
  for (const [name, mutate] of [
    [
      "future cutoff",
      (h) => {
        h.options.asOf = "2026-01-09T00:00:00Z";
      },
    ],
    [
      "backward clock",
      (h) => {
        let n = 0;
        h.options.now = () => (n++ ? t6 : "2026-01-08T00:00:00Z");
      },
    ],
    [
      "invalid date",
      (h) => {
        h.options.now = () => "2026-02-30T00:00:00Z";
      },
    ],
    [
      "event before creation",
      (h) => {
        h.state.events[0].createdAt = "2025-12-31T00:00:00Z";
      },
    ],
    [
      "event after timeline anchor",
      (h) => {
        h.state.events[0].createdAt = "2026-01-07T00:00:01Z";
      },
    ],
  ])
    await t.test(name, async () => {
      const h = decisionFixture([event("closed", t2)], closedAnchor(t2));
      mutate(h);
      assert.equal((await capture(h.options)).reason, "clock_inconsistent");
    });
});

test("authorization revoked across actual awaited transport boundaries rejects delivery", async (t) => {
  for (const stage of [0, 1, 2, 3])
    await t.test("stage " + stage, async () => {
      const h = decisionFixture();
      if (stage === 0) h.state.authorized = false;
      h.state.transform = () => {
        if (h.state.calls.length === stage) h.state.authorized = false;
      };
      await assert.rejects(
        capture(h.options),
        (error) => error instanceof GithubClientError && error.outcome.kind === "unsafe_request",
      );
    });
});

test("captured inputs and callback identities cannot be changed during transport", async () => {
  const h = decisionFixture();
  const original = structuredClone({ repository: h.options.repository, subject: h.options.expectedSubject });
  h.state.transform = () => {
    h.options.repository.id = 999;
    h.options.expectedSubject.id = "PR_WRONG";
    h.options.scanId = "MUTATED";
    h.options.now = () => "2099-01-01T00:00:00Z";
    h.options.assertAuthorized = () => {};
  };
  const receipt = await captured(h);
  assert.deepEqual(receipt.binding.repository, original.repository);
  assert.deepEqual(receipt.binding.subject, original.subject);
  assert.equal(receipt.generation.scanId, "synthetic-scan:1");
  assert.equal(receipt.capture.completedAt, "2026-01-08T00:00:00Z");
  h.state.authorized = false;
  assert.equal(select(receipt).status, "selected"); // Pure integrity is explicitly not current source authorization.
});

test("accessor-backed options and retained JSON are rejected without invoking accessors", async () => {
  const h = decisionFixture();
  let invoked = 0;
  Object.defineProperty(h.options.repository, "id", {
    enumerable: true,
    get() {
      invoked++;
      return 2;
    },
  });
  assert.equal((await capture(h.options)).status, "unavailable");
  assert.equal(invoked, 0);
  assert.equal(h.state.calls.length, 0);
  const receipt = await captured(decisionFixture());
  Object.defineProperty(receipt, "digest", {
    enumerable: true,
    get() {
      invoked++;
      return "a".repeat(64);
    },
  });
  assert.equal(select(receipt).status, "unavailable");
  assert.equal(invoked, 0);
});

test("GraphQL partial errors retain real client failure semantics", async () => {
  const h = decisionFixture();
  h.state.wire = (_call, response) => ({ ...response, errors: [{ message: "Synthetic partial response" }] });
  await assert.rejects(capture(h.options), (error) => error instanceof GithubClientError);
});

test("strict retained receipt rejects tampering, unknown fields, versions and binding reuse", async (t) => {
  const receipt = await captured(decisionFixture());
  for (const [name, mutate, reason] of [
    [
      "digest",
      (r) => {
        r.digest = "a".repeat(64);
      },
      "digest_mismatch",
    ],
    [
      "clock",
      (r) => {
        r.capture.completedAt = "2026-01-09T00:00:00Z";
      },
      "digest_mismatch",
    ],
    [
      "extra",
      (r) => {
        r.verified = true;
      },
      "invalid_receipt",
    ],
    [
      "version",
      (r) => {
        r.schemaVersion = "github-pr-decision-history/v2";
      },
      "invalid_receipt",
    ],
  ])
    await t.test(name, () => {
      const changed = structuredClone(receipt);
      mutate(changed);
      assert.equal(validate(changed, expected(receipt)).reason, reason);
    });
  for (const key of ["scanId", "asOf"])
    await t.test("generation/" + key, () => {
      const binding = structuredClone(expected(receipt));
      binding.generation[key] = key === "asOf" ? t4 : "DIFFERENT";
      assert.equal(validate(receipt, binding).reason, "binding_mismatch");
    });
  await t.test("semantic revision", () => {
    const binding = structuredClone(expected(receipt));
    binding.binding.semanticRevision = "DIFFERENT";
    assert.equal(validate(receipt, binding).reason, "binding_mismatch");
  });
});

test("fresh generations and cutoffs change proof identity even for the same current REST revision", async () => {
  const h = decisionFixture();
  const first = await captured(h);
  h.options.scanId = "synthetic-scan:2";
  const second = await captured(h);
  h.options.asOf = t4;
  const third = await captured(h);
  assert.equal(new Set([first.digest, second.digest, third.digest]).size, 3);
  assert.equal(first.binding.semanticRevision, third.binding.semanticRevision);
});

test("recomputed digests cannot conceal incomplete or contradictory retained histories", async (t) => {
  const receipt = await captured(decisionFixture([event("closed", t2)], closedAnchor(t2)));
  for (const [name, mutate, reason] of [
    [
      "wrong subject",
      (r) => {
        r.history[0].subjectId = "PR_OTHER";
      },
      "binding_mismatch",
    ],
    [
      "empty history",
      (r) => {
        r.history = [];
      },
      "history_incomplete",
    ],
    [
      "terminal",
      (r) => {
        r.pagination.pages[0].hasNextPage = true;
      },
      "history_incomplete",
    ],
    [
      "invalid anchor",
      (r) => {
        r.capture.before.state = "OPEN";
        r.capture.after.state = "OPEN";
      },
      "history_inconsistent",
    ],
    [
      "future event",
      (r) => {
        r.history[0].createdAt = "2026-01-09T00:00:00Z";
      },
      "clock_inconsistent",
    ],
  ])
    await t.test(name, () => {
      const changed = structuredClone(receipt);
      mutate(changed);
      assert.equal(select(resign(changed)).reason, reason);
    });
});

test("arbitrary structurally valid receipts confer no protected-host or public metric authority", async () => {
  const receipt = await captured(decisionFixture());
  assert.equal(validate(resign(receipt), expected(receipt)).status, "validated");
  assert.deepEqual(Object.keys(select(receipt)).sort(), [
    "asOf",
    "authorId",
    "cutoffMode",
    "decisionAt",
    "outcome",
    "proofDigest",
    "sourceEventIds",
    "status",
    "unitKey",
  ]);
  assert.doesNotMatch(JSON.stringify(receipt), /verified|metricId|actorLogin|rank|title|email|SYNTHETIC_TOKEN/);
});

test("replacing an authorization callback during a request cannot hide revocation", async () => {
  const h = decisionFixture();
  h.state.transform = () => {
    h.options.assertAuthorized = () => {};
    h.state.authorized = false;
  };
  await assert.rejects(
    capture(h.options),
    (error) => error instanceof GithubClientError && error.outcome.kind === "unsafe_request",
  );
});

test("authorization remains live after the final trusted-clock callback", async () => {
  const h = decisionFixture();
  let calls = 0;
  h.options.now = () => {
    if (++calls === 2) h.state.authorized = false;
    return "2026-01-08T00:00:00Z";
  };
  await assert.rejects(
    capture(h.options),
    (error) => error instanceof GithubClientError && error.outcome.kind === "unsafe_request",
  );
});

test("unsupported timestamp profiles, unsafe identifiers and non-JSON retained data fail closed", async (t) => {
  for (const [name, mutate] of [
    [
      "offset timestamp",
      (h) => {
        h.options.asOf = "2026-01-05T00:00:00+00:00";
      },
    ],
    [
      "excess precision",
      (h) => {
        h.options.asOf = "2026-01-05T00:00:00.0000000001Z";
      },
    ],
    [
      "invalid calendar",
      (h) => {
        h.options.asOf = "2026-02-30T00:00:00Z";
      },
    ],
    [
      "unsafe integer",
      (h) => {
        h.options.repository.id = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "invalid path",
      (h) => {
        h.options.repository.slug = "../repository";
      },
    ],
  ])
    await t.test(name, async () => {
      const h = decisionFixture();
      mutate(h);
      assert.equal((await capture(h.options)).status, "unavailable");
      assert.equal(h.state.calls.length, 0);
    });
  const receipt = await captured(decisionFixture());
  const cyclic = structuredClone(receipt);
  cyclic.history = [cyclic];
  assert.equal(select(cyclic).status, "unavailable");
  const huge = structuredClone(receipt);
  huge.digest = "a".repeat(2_000_001);
  assert.equal(select(huge).reason, "budget_exceeded");
});

function hostileDecisionProxy(target, mode) {
  let calls = 0;
  const trap = () => {
    calls++;
    throw new Error("Decision data proxy must not be inspected");
  };
  const wrapped = Proxy.revocable(target, {
    get: trap,
    getPrototypeOf: trap,
    ownKeys: trap,
    getOwnPropertyDescriptor: trap,
  });
  if (mode === "revoked") wrapped.revoke();
  return { value: wrapped.proxy, calls: () => calls };
}

test("proxy-backed decision request data is rejected before inspection or transport", async (t) => {
  for (const mode of ["trapping", "revoked"])
    for (const boundary of ["options", "repository", "expectedSubject"])
      await t.test(mode + "/" + boundary, async () => {
        const h = decisionFixture();
        const wrapped = hostileDecisionProxy(boundary === "options" ? h.options : h.options[boundary], mode);
        const options = boundary === "options" ? wrapped.value : { ...h.options, [boundary]: wrapped.value };
        assert.deepEqual(await capture(options), {
          status: "unavailable",
          reason: boundary === "options" ? "invalid_request" : "invalid_receipt",
        });
        assert.equal(wrapped.calls(), 0);
        assert.equal(h.state.calls.length, 0);
        assert.equal((await captured(decisionFixture())).schemaVersion, "github-pr-decision-history/v1");
      });
});

test("proxy-backed retained decision data is rejected before selection or validation inspection", async (t) => {
  const original = await captured(decisionFixture([event("closed", t2)], closedAnchor(t2)));
  for (const mode of ["trapping", "revoked"])
    for (const boundary of ["receipt", "history", "event"])
      await t.test(mode + "/" + boundary, () => {
        const receipt = structuredClone(original);
        const target = boundary === "receipt" ? receipt : boundary === "history" ? receipt.history : receipt.history[0];
        const wrapped = hostileDecisionProxy(target, mode);
        if (boundary === "history") receipt.history = wrapped.value;
        if (boundary === "event") receipt.history[0] = wrapped.value;
        const input = boundary === "receipt" ? wrapped.value : receipt;
        assert.deepEqual(select(input), { status: "unavailable", reason: "invalid_receipt" });
        assert.deepEqual(validate(input, expected(original)), { status: "unavailable", reason: "invalid_receipt" });
        assert.equal(wrapped.calls(), 0);
        assert.equal(select(original).outcome, "closed_unmerged");
        assert.equal(validate(original, expected(original)).status, "validated");
      });
});

test("proxy-backed expected decision bindings are rejected before inspection", async (t) => {
  const receipt = await captured(decisionFixture());
  for (const mode of ["trapping", "revoked"])
    for (const boundary of ["expected", "binding", "generation"])
      await t.test(mode + "/" + boundary, () => {
        const binding = structuredClone(expected(receipt));
        const wrapped = hostileDecisionProxy(boundary === "expected" ? binding : binding[boundary], mode);
        if (boundary !== "expected") binding[boundary] = wrapped.value;
        assert.deepEqual(validate(receipt, boundary === "expected" ? wrapped.value : binding), {
          status: "unavailable",
          reason: "invalid_receipt",
        });
        assert.equal(wrapped.calls(), 0);
        assert.equal(validate(receipt, expected(receipt)).status, "validated");
      });
});

test("one captured generation selects earlier exclusive ends without rewriting its receipt", async () => {
  const h = decisionFixture(
    [event("closed", t2, "EARLY_CLOSE"), event("reopened", t3), event("closed", t4, "FINAL_CLOSE")],
    closedAnchor(t4),
  );
  const receipt = await captured(h);
  const original = structuredClone(receipt);
  const reads = h.state.calls.length;
  assert.equal(select(receipt, t2).outcome, "pending");
  assert.equal(select(receipt, t3).outcome, "closed_unmerged");
  assert.equal(select(receipt, t4).outcome, "pending");
  assert.equal(select(receipt, t5).outcome, "closed_unmerged");
  assert.equal(select(receipt, t5).decisionAt, t4);
  assert.equal(select(receipt, receipt.binding.subject.createdAt).status, "not_yet_created");
  assert.deepEqual(select(receipt), select(receipt, receipt.generation.asOf));
  assert.deepEqual(receipt, original);
  assert.equal(h.state.calls.length, reads, "window selection never recollects or re-signs history");
});

test("a reporting end cannot extend a capture or supply a malformed time", async () => {
  const receipt = await captured(decisionFixture([event("merged", t4)], mergedAnchor(t4)));
  for (const target of [t6, "", "2026-02-30T00:00:00Z", t4 + "\n", null, 0])
    assert.equal(select(receipt, target).status, "unavailable");
  assert.equal(select(receipt, "2026-01-04T00:00:00.000000000Z").outcome, "pending");
  assert.equal(select(receipt, "2026-01-04T00:00:00.000000001Z").outcome, "merged");
});
