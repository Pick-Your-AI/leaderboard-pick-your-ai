import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as contracts from "../../../packages/contracts/dist/index.js";
import { retainPhysicalContext } from "../src/physical-context.mjs";
import { physicalSource } from "./fixtures/physical-context.mjs";

const retain = (input, mode = "synthetic") =>
  retainPhysicalContext(input.output, input.source, input.repository, contracts, mode);

test("retained physical context binds actual emitted units, source/proof identities and synthetic provenance", () => {
  const input = physicalSource(),
    original = structuredClone(input.output);
  const retained = retain(input);
  assert.deepEqual(retained.physicalContext, original.physicalContext);
  assert.deepEqual(input.output, original);
  assert.deepEqual(retain({ ...input, output: { ...input.output, ...retained } }), retained);
  input.output.physicalContext.summary.eligible.additions = 1000;
  assert.equal(retained.physicalContext.summary.eligible.additions, 17);
  assert.equal(original.isSynthetic, true);
  assert.throws(() => retain(physicalSource(), "public"), /invalid_retained_physical_context/);
});

test("legacy receipt absence and complete examined zero have different retained meanings", () => {
  const legacy = physicalSource();
  delete legacy.output.physicalContext;
  assert.deepEqual(retain(legacy), {}, "the surviving classifier totals cannot synthesize an absent receipt");
  const zero = retain(physicalSource({ files: [] })).physicalContext;
  assert.deepEqual(zero.summary.raw, { files: 0, additions: 0, deletions: 0 });
  assert.equal(zero.facts.length, 3);
  assert.ok(zero.facts.every((fact) => fact.quantity === 0));
});

test("well-formed receipt substitutions cannot replace actual retained fact or source bindings", async (t) => {
  for (const [name, mutate] of [
    [
      "valid foreign fact ID",
      (input) => {
        input.output.physicalContext.facts[0].factId = `gh:${"a".repeat(64)}`;
      },
    ],
    [
      "valid foreign canonical key",
      (input) => {
        input.output.physicalContext.facts[0].canonicalKey = `gh:${"a".repeat(64)}`;
      },
    ],
    [
      "foreign canonical integration",
      (input) => {
        input.output.physicalContext.canonicalIntegrationId = "synthetic-other-integration";
      },
    ],
    [
      "foreign source repository",
      (input) => {
        input.source.repository_id = 3;
      },
    ],
    [
      "foreign source artifact",
      (input) => {
        input.source.subject_id = "PR_SYNTHETIC_OTHER";
      },
    ],
    [
      "foreign source URL",
      (input) => {
        input.source.document.sourceUrl += "9";
      },
    ],
    [
      "non-PR source family",
      (input) => {
        input.source.family = "issues";
      },
    ],
    [
      "receipt role actor substitution",
      (input) => {
        input.output.physicalContext.actorId = "202";
      },
    ],
    [
      "unbound source observation",
      (input) => {
        input.source.observed_at = "2026-10-09T10:00:00.000Z";
      },
    ],
    [
      "receipt after actual observation",
      (input) => {
        input.source.observed_at = "2026-10-06T10:00:00.000Z";
      },
    ],
    [
      "foreign merged revision",
      (input) => {
        input.output.physicalContext.after = "d".repeat(40);
      },
    ],
    [
      "foreign target branch",
      (input) => {
        input.output.physicalContext.targetBranch = "release";
      },
    ],
    [
      "invalid optional receipt",
      (input) => {
        input.output.physicalContext = null;
      },
    ],
  ])
    await t.test(name, () => {
      const input = physicalSource();
      mutate(input);
      if (input.output.physicalContext !== null)
        assert.equal(
          contracts.githubPhysicalContextReceiptSchema.safeParse(input.output.physicalContext).success,
          true,
        );
      assert.throws(() => retain(input), /invalid_retained_physical_context/);
    });
});

test("matching rewritten receipt strings do not override original units or public proof agreement", async (t) => {
  const selected = (input) => input.output.facts.find((fact) => fact.metricId === "pr_lines_added");
  for (const [name, mutate] of [
    [
      "aligned foreign unit hashes",
      (input) => {
        const fact = selected(input),
          oldId = fact.id;
        const canonical = `gh:${"a".repeat(64)}`;
        const id = `gh:${createHash("sha256")
          .update(JSON.stringify(["fact", canonical]))
          .digest("hex")}`;
        const binding = input.output.physicalContext.facts.find((entry) => entry.factId === oldId);
        const proof = input.output.evidence.find((entry) => entry.contribution.contributionId === oldId);
        fact.id = binding.factId = proof.contribution.contributionId = id;
        fact.canonicalKey = binding.canonicalKey = proof.contribution.canonicalEventId = canonical;
      },
    ],
    [
      "proof canonical key",
      (input) => {
        input.output.evidence.find(
          (entry) => entry.contribution.contributionId === selected(input).id,
        ).contribution.canonicalEventId = `gh:${"a".repeat(64)}`;
      },
    ],
    [
      "proof actor",
      (input) => {
        input.output.evidence.find(
          (entry) => entry.contribution.contributionId === selected(input).id,
        ).contribution.actorId = "202";
      },
    ],
    [
      "nonpublic source",
      (input) => {
        const entry = input.output.evidence.find((entry) => entry.contribution.contributionId === selected(input).id);
        entry.artifact.visibility = "private";
        delete entry.artifact.publicUrl;
      },
    ],
    [
      "fact quantity",
      (input) => {
        selected(input).quantity++;
      },
    ],
    [
      "fact correction",
      (input) => {
        selected(input).correctionReceipt = "synthetic-correction";
      },
    ],
    [
      "fact recognition",
      (input) => {
        selected(input).acceptanceReceipt = "synthetic-recognition";
      },
    ],
    [
      "changed original role",
      (input) => {
        selected(input).role = "coauthor";
      },
    ],
    [
      "changed original observation",
      (input) => {
        selected(input).observedAt = "2026-10-09T10:00:00.000Z";
      },
    ],
    [
      "missing other class unit",
      (input) => {
        input.output.facts = input.output.facts.filter((fact) => fact.metricId !== "pr_lines_removed");
      },
    ],
    [
      "duplicate retained fact",
      (input) => {
        input.output.facts.push(structuredClone(selected(input)));
      },
    ],
    [
      "duplicate retained proof",
      (input) => {
        input.output.evidence.push(structuredClone(input.output.evidence[0]));
      },
    ],
    [
      "missing merged proof",
      (input) => {
        input.output.evidence = input.output.evidence.filter(
          (entry) => !entry.contribution.metricIds.includes("pr_merged"),
        );
      },
    ],
    [
      "foreign immutable source link",
      (input) => {
        input.output.evidence.find((entry) => entry.contribution.metricIds.includes("pr_merged")).sourceRevisionUrl =
          "https://github.com/synthetic-other/repo/commit/" + "c".repeat(40);
      },
    ],
  ])
    await t.test(name, () => {
      const input = physicalSource();
      mutate(input);
      assert.equal(contracts.githubPhysicalContextReceiptSchema.safeParse(input.output.physicalContext).success, true);
      assert.throws(() => retain(input), /invalid_retained_physical_context/);
    });
});
