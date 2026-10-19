import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { EvidenceInvitation, Receipt } from "../src/controls/client.ts";
import { syntheticBrowserIntake, syntheticEvidenceTerms } from "./controls-intake-fixtures.ts";

const id = "11111111-1111-1111-1111-111111111111";
const consentLabel =
  "I consent to public attribution of this claim under the displayed evidence terms if independently accepted";
const source = "https://github.com/synthetic/example/issues/55";
function receipt(patch: Partial<Receipt> = {}): Receipt {
  return {
    id,
    owner: "2",
    kind: "evidence",
    status: "pending",
    version: 3,
    locator: source,
    category: "mentorship",
    scope: "Synthetic public mentoring claim",
    detail: "Protected synthetic review detail",
    collaborators: {},
    intake: syntheticBrowserIntake("2"),
    intakeEligibility: { state: "awaiting_review" },
    history: [],
    ...patch,
  };
}
function invitation(patch: Partial<EvidenceInvitation> = {}): EvidenceInvitation {
  return {
    id,
    version: 3,
    locator: source,
    category: "mentorship",
    scope: "Synthetic public mentoring claim",
    consent: "pending",
    claimRevision: 1,
    claimDigest: "c".repeat(64),
    participantIds: ["2", "1"],
    role: "Synthetic learner",
    period: { kind: "date", date: "2026-10-17" },
    sourceUseState: "unresolved",
    terms: syntheticEvidenceTerms,
    intakeEligibility: { state: "participant_consent_required" },
    ...patch,
  };
}

// These intercepted transport journeys verify UI bindings. Backend tests separately exercise real HTTP/SQLite authority.
async function controls(
  page: Page,
  options: {
    roles?: string[];
    requests?: Receipt[];
    invitations?: EvidenceInvitation[];
    termsStatus?: number;
    conflict?: boolean;
  } = {},
) {
  const requests = structuredClone(options.requests ?? []);
  const invitations = structuredClone(options.invitations ?? []);
  const writes: Array<{ path: string; body: Record<string, any>; csrf: string | undefined }> = [];
  await page.route("**/controls/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      writes.push({ path, body, csrf: request.headers()["x-csrf-token"] });
      if (options.conflict) return route.fulfill({ status: 409, json: { error: "Synthetic receipt conflict" } });
      if (path === "/controls/requests" && body.kind === "evidence") {
        requests.push(
          receipt({
            ...body,
            id,
            owner: "1",
            status: "pending",
            version: 1,
            collaborators: Object.fromEntries(
              body.collaborators.map((participant: string) => [participant, "pending"]),
            ),
            intake: { ...syntheticBrowserIntake("1", body.collaborators), ...body.intake },
            intakeEligibility: {
              state: body.collaborators.length ? "participant_consent_required" : "awaiting_review",
            },
          }),
        );
      }
      if (path.endsWith("/consent")) {
        const current = invitations.find((item) => path.includes(item.id));
        if (current) {
          current.version++;
          current.consent = body.consent ? "accepted" : "declined";
        }
      }
      if (path.endsWith("/amend")) {
        const current = requests.find((item) => path.includes(item.id));
        if (current) {
          Object.assign(current, body, { version: current.version + 1, status: "pending" });
          current.collaborators = Object.fromEntries(
            body.collaborators.map((participant: string) => [participant, "pending"]),
          );
          current.intake = { ...syntheticBrowserIntake(current.owner, body.collaborators), ...body.intake };
          current.intakeEligibility = {
            state: body.collaborators.length ? "participant_consent_required" : "awaiting_review",
          };
        }
      }
      if (path.endsWith("/review") || path.endsWith("/withdraw")) {
        const current = requests.find((item) => path.includes(item.id));
        if (current) {
          current.version++;
          current.status = path.endsWith("/withdraw")
            ? "withdrawn"
            : body.decision === "accept"
              ? "accepted"
              : "rejected";
          if (body.decision === "accept") current.intakeEligibility = { state: "eligible" };
        }
      }
      return route.fulfill({ json: { id, status: "pending", version: 1 } });
    }
    if (path === "/controls/evidence-terms" && options.termsStatus)
      return route.fulfill({ status: options.termsStatus, json: { error: "Synthetic terms failure" } });
    const responses: Record<string, unknown> = {
      "/controls/session": {
        actorId: "1",
        csrf: "a".repeat(43),
        roles: options.roles ?? [],
        expires: Date.now() + 600000,
      },
      "/controls/evidence-terms": { terms: syntheticEvidenceTerms },
      "/controls/profile": { bio: "Synthetic private bio", highlights: [], public: false, suppressed: false },
      "/controls/requests": { requests },
      "/controls/invitations": { invitations },
      "/controls/spotlights/queue": { nominations: [] },
    };
    return route.fulfill({ json: responses[path] ?? {} });
  });
  return writes;
}
async function fillEvidence(page: Page) {
  await page.getByLabel("Request kind").selectOption("evidence");
  await page.getByLabel("Public GitHub source URL", { exact: true }).fill(source);
  await page.getByLabel("Category", { exact: true }).selectOption("mentorship");
  await page
    .getByLabel("Contribution scope (public claim summary)", { exact: true })
    .fill("Synthetic public mentoring claim");
  await page.getByLabel("Private review details", { exact: true }).fill("Protected synthetic review detail");
}

test("versioned submission keeps unknowns explicit and records only the submitter's affirmative choice", async ({
  page,
}) => {
  const writes = await controls(page);
  const external: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "github.com") external.push(request.url());
  });
  await page.goto("/account");
  await fillEvidence(page);
  await page.getByLabel("Collaborator GitHub numeric IDs, comma separated", { exact: true }).fill("9007199254740993");
  await expect(page.getByLabel("Your proposed role knowledge")).toHaveValue("unknown");
  await expect(page.getByLabel("Proposed role for GitHub ID 9007199254740993 knowledge")).toHaveValue("unknown");
  await expect(page.getByLabel("Date knowledge")).toHaveValue("unknown");
  await expect(page.getByLabel("Source-use basis", { exact: true })).toHaveValue("unresolved");
  for (const paragraph of syntheticEvidenceTerms.paragraphs)
    await expect(page.getByText(paragraph, { exact: true })).toBeVisible();
  await expect(page.getByLabel(consentLabel)).not.toBeChecked();
  await page.getByLabel(consentLabel).check();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Submit request", exact: true }).click();
  await expect(page.getByText("evidence · pending · version 1")).toBeVisible();
  expect(writes).toEqual([
    {
      path: "/controls/requests",
      csrf: "a".repeat(43),
      body: {
        kind: "evidence",
        locator: source,
        category: "mentorship",
        scope: "Synthetic public mentoring claim",
        detail: "Protected synthetic review detail",
        collaborators: ["9007199254740993"],
        consent: true,
        intake: {
          schemaVersion: "evidence-intake/v1",
          termsVersion: syntheticEvidenceTerms.version,
          termsDigest: syntheticEvidenceTerms.digest,
          sourceUseBasis: { state: "unresolved" },
          roles: { submitter: null, collaborators: { "9007199254740993": null } },
          period: { kind: "unknown" },
        },
      },
    },
  ]);
  await expect(page.getByRole("button", { name: "Nominate for spotlight" })).toHaveCount(0);
  expect(external).toEqual([]);
});

test("local intake errors focus the actual invalid field and preserve the draft without any write", async ({
  page,
}) => {
  const writes = await controls(page);
  await page.goto("/account");
  await fillEvidence(page);
  const submit = page.getByRole("button", { name: "Submit request", exact: true });
  const locator = page.getByLabel("Public GitHub source URL", { exact: true });
  await locator.fill("https://internal.invalid/private");
  await submit.click();
  await expect(locator).toBeFocused();
  await expect(locator).toHaveAttribute("aria-invalid", "true");
  await expect(locator).toHaveAccessibleDescription(/public HTTPS GitHub artifact URL/);
  await locator.fill(source);
  const participants = page.getByLabel("Collaborator GitHub numeric IDs, comma separated", { exact: true });
  await participants.fill("1, 2, 2");
  await submit.click();
  await expect(participants).toBeFocused();
  await participants.fill("2");
  await page.getByLabel("Your proposed role knowledge").selectOption("described");
  await page.getByLabel("Your proposed role", { exact: true }).fill("Synthetic mentor");
  await page.getByLabel("Date knowledge").selectOption("interval");
  await page.getByLabel("Contribution start date").fill("2026-10-19");
  await page.getByLabel("Contribution end date").fill("2026-10-18");
  await submit.click();
  await expect(page.getByLabel("Contribution end date")).toBeFocused();
  await page.getByLabel("Contribution end date").fill("2026-10-20");
  await page.getByLabel("Source-use basis", { exact: true }).selectOption("declared");
  await submit.click();
  await expect(page.getByLabel("Private source-use statement")).toBeFocused();
  await page.getByLabel("Private source-use statement").fill("Synthetic basis for qualified review");
  await submit.click();
  await expect(page.getByLabel(consentLabel)).toBeFocused();
  expect(writes).toEqual([]);
  await expect(page.getByLabel("Private review details", { exact: true })).toHaveValue(
    "Protected synthetic review detail",
  );
  await page.getByLabel(consentLabel).check();
  await submit.click();
  await expect(page.getByText("evidence · pending · version 1")).toBeVisible();
  expect(writes[0]!.body.intake).toMatchObject({
    roles: { submitter: "Synthetic mentor", collaborators: { "2": null } },
    period: { kind: "interval", start: "2026-10-19", end: "2026-10-20" },
    sourceUseBasis: { state: "declared", statement: "Synthetic basis for qualified review" },
  });
});

test("missing terms block new evidence consent while private requests, decline and withdrawal still work", async ({
  page,
}) => {
  const writes = await controls(page, {
    termsStatus: 503,
    requests: [receipt({ owner: "1", intake: null, intakeEligibility: { state: "updated_intake_required" } })],
    invitations: [
      invitation({
        terms: null,
        claimRevision: null,
        claimDigest: null,
        role: null,
        period: null,
        sourceUseState: "unknown",
        intakeEligibility: { state: "updated_intake_required" },
      }),
    ],
  });
  await page.goto("/account");
  await expect(page.getByLabel("Bio (up to 500 characters)")).toHaveValue("Synthetic private bio");
  await page.getByLabel("Request kind").selectOption("privacy");
  await page.getByLabel("Details", { exact: true }).fill("Synthetic privacy request");
  await page.getByRole("button", { name: "Submit request", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Service confirmed");
  await page.getByLabel("Request kind").selectOption("evidence");
  await expect(page.getByRole("button", { name: "Submit request", exact: true })).toBeDisabled();
  const newConsents = page.getByLabel(consentLabel);
  await expect(newConsents).toHaveCount(2);
  await expect(newConsents.nth(0)).toBeDisabled();
  await expect(newConsents.nth(1)).toBeDisabled();
  await page.getByLabel("Attribution consent", { exact: true }).selectOption("decline");
  await page.getByLabel(`Confirm my choice for ${id}`, { exact: true }).check();
  await page.getByRole("button", { name: "Save consent" }).click();
  await expect(page.getByText(/Your saved choice: declined/)).toBeVisible();
  await page.getByLabel(`Withdraw receipt ${id}`).check();
  await page.getByRole("button", { name: "Withdraw request" }).click();
  await expect(page.getByText("evidence · withdrawn · version 4")).toBeVisible();
  expect(writes.map(({ body }) => body)).toEqual([
    { kind: "privacy", detail: "Synthetic privacy request" },
    { version: 3, consent: false },
    { version: 3 },
  ]);
});

test("invitation acceptance displays only the bounded claim and binds the chosen revision and terms", async ({
  page,
}) => {
  const bounded = {
    ...invitation(),
    detail: "PROTECTED_OTHER_DETAIL",
    roles: { other: "PROTECTED_OTHER_ROLE" },
    sourceUseStatement: "PROTECTED_BASIS",
    participantConsents: { token: "PROTECTED_RECORD" },
  };
  const writes = await controls(page, { invitations: [bounded] });
  await page.goto("/account");
  await expect(page.getByText(/Your proposed role: Synthetic learner/)).toBeVisible();
  await expect(page.getByText(/Proposed participant GitHub IDs: 2, 1/)).toBeVisible();
  await expect(page.getByText(/PROTECTED_/)).toHaveCount(0);
  const choice = page.getByLabel("Attribution consent", { exact: true });
  await expect(choice).toHaveValue("");
  await choice.selectOption("decline");
  await page.getByLabel(`Confirm my choice for ${id}`, { exact: true }).check();
  await choice.selectOption("accept");
  const consent = page.getByLabel("I consent to my attribution in this exact claim under the displayed terms");
  await expect(consent).not.toBeChecked();
  await consent.check();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Save consent" }).click();
  await expect(page.getByText(/Your saved choice: accepted/)).toBeVisible();
  expect(writes).toEqual([
    {
      path: `/controls/requests/${id}/consent`,
      csrf: "a".repeat(43),
      body: {
        version: 3,
        consent: true,
        claimDigest: "c".repeat(64),
        termsVersion: syntheticEvidenceTerms.version,
        termsDigest: syntheticEvidenceTerms.digest,
      },
    },
  ]);
});

test("a changed invitation is not retried or reported as consented", async ({ page }) => {
  const writes = await controls(page, { invitations: [invitation()], conflict: true });
  await page.goto("/account");
  await page.getByLabel("Attribution consent", { exact: true }).selectOption("accept");
  await page.getByLabel("I consent to my attribution in this exact claim under the displayed terms").check();
  await page.getByRole("button", { name: "Save consent" }).click();
  await expect(page.getByRole("alert")).toContainText("Reload before trying again");
  await expect(page.getByText(/Your saved choice: pending/)).toBeVisible();
  await expect(page.getByText(/Service confirmed/)).toHaveCount(0);
  expect(writes).toHaveLength(1);
});

test("legacy intake, missing consent and already decided receipts prevent a fresh acceptance affordance", async ({
  page,
}) => {
  const writes = await controls(page, {
    roles: ["reviewer"],
    requests: [
      receipt({ intake: null, intakeEligibility: { state: "updated_intake_required" } }),
      receipt({
        id: "22222222-2222-2222-2222-222222222222",
        collaborators: { "3": "pending" },
        intake: syntheticBrowserIntake("2", ["3"]),
        intakeEligibility: { state: "participant_consent_required" },
      }),
      receipt({
        id: "33333333-3333-3333-3333-333333333333",
        status: "accepted",
        intakeEligibility: { state: "source_use_review_required" },
      }),
      receipt({
        id: "44444444-4444-4444-4444-444444444444",
        status: "accepted",
        intakeEligibility: { state: "eligible" },
      }),
      receipt({
        id: "55555555-5555-5555-5555-555555555555",
        status: "rejected",
        intakeEligibility: { state: "awaiting_review" },
      }),
    ],
  });
  await page.goto("/admin");
  const accepts = page.locator('option[value="accept"]');
  await expect(accepts).toHaveCount(5);
  const decisions = page.getByLabel("Review decision");
  await expect(decisions).toHaveCount(5);
  for (let index = 0; index < 5; index++) {
    await expect(accepts.nth(index)).toHaveJSProperty("disabled", true);
    await decisions.nth(index).focus();
    await decisions.nth(index).press("ArrowDown");
    await expect(decisions.nth(index)).toHaveValue("rollback");
  }
  await expect(page.getByText(/Earlier records do not establish consent/)).toBeVisible();
  await expect(page.getByText(/Participant consent is still required/)).toBeVisible();
  await expect(page.getByText(/This earlier accepted claim is withheld from public recognition/)).toBeVisible();
  await expect(page.getByText(/To return this receipt to review/)).toHaveCount(2);
  expect(writes).toEqual([]);
});

for (const status of ["pending", "appealed"] as const)
  test(`${status} evidence acceptance needs separate source-use evidence even when the source is public`, async ({
    page,
  }) => {
    const writes = await controls(page, {
      roles: ["reviewer"],
      requests: [
        receipt({
          status,
          history:
            status === "appealed"
              ? [
                  { actor: "3", action: "rejected" },
                  { actor: "2", action: "appealed" },
                ]
              : [],
        }),
      ],
    });
    await page.goto("/admin");
    await page.getByLabel("Review decision").selectOption("accept");
    await page.getByLabel("Decision reason").fill("Synthetic independent decision");
    await page.getByLabel("Approved policy version").fill("synthetic-metric-v1");
    await page.getByLabel("I reviewed the source and verified it is public").check();
    await page.getByLabel(/I have no conflict/).check();
    await page.getByRole("button", { name: "Record review decision" }).click();
    await expect(page.getByLabel("Source-use review rationale")).toBeFocused();
    expect(writes).toEqual([]);
    await page
      .getByLabel("Source-use review rationale")
      .fill("Synthetic independent basis resolves the earlier unknown declaration");
    await page
      .getByLabel("Reviewed source reference 1", { exact: true })
      .fill("https://github.com/synthetic/example/blob/reviewed/rights.md");
    await page.getByLabel("Reviewed source revision 1", { exact: true }).fill("synthetic-reviewed-revision");
    await page.getByLabel("My independent review establishes permitted source use for this exact claim").check();
    await page.getByRole("button", { name: "Record review decision" }).click();
    await expect(page.getByText("evidence · accepted · version 4")).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toMatchObject({
      version: 3,
      decision: "accept",
      sourceReviewedPublic: true,
      sourceUseReview: {
        disposition: "permitted",
        rationale: "Synthetic independent basis resolves the earlier unknown declaration",
        references: [
          {
            locator: "https://github.com/synthetic/example/blob/reviewed/rights.md",
            revision: "synthetic-reviewed-revision",
          },
        ],
      },
    });
  });

test("malformed historical intake stays recoverable through a fresh amendment and withdrawal", async ({ page }) => {
  const writes = await controls(page, {
    requests: [
      receipt({
        owner: "1",
        intake: { schemaVersion: "evidence-intake/v1" } as NonNullable<Receipt["intake"]>,
        intakeEligibility: { state: "updated_intake_required" },
      }),
    ],
  });
  await page.goto("/account");
  await expect(page.getByText(/Earlier records do not establish consent/)).toBeVisible();
  await page.getByText("Amend evidence", { exact: true }).click();
  await expect(page.getByLabel("Amended contribution scope (public claim summary)")).toHaveValue(
    "Synthetic public mentoring claim",
  );
  await expect(page.getByLabel("Your proposed role knowledge")).toHaveValue("unknown");
  await expect(page.getByLabel("Date knowledge")).toHaveValue("unknown");
  await expect(page.getByLabel(consentLabel)).not.toBeChecked();
  await page
    .getByLabel("Private amendment reason")
    .fill("Replace unsupported historical intake with an explicit current choice");
  await page.getByLabel(consentLabel).check();
  await page.getByLabel("Replace this evidence and return it to pending review").check();
  await page.getByRole("button", { name: "Submit evidence amendment" }).click();
  await expect(page.getByText("evidence · pending · version 4")).toBeVisible();
  expect(writes[0]!.body.intake).toEqual({
    schemaVersion: "evidence-intake/v1",
    termsVersion: syntheticEvidenceTerms.version,
    termsDigest: syntheticEvidenceTerms.digest,
    sourceUseBasis: { state: "unresolved" },
    roles: { submitter: null, collaborators: {} },
    period: { kind: "unknown" },
  });
  await page.getByLabel(`Withdraw receipt ${id}`).check();
  await page.getByRole("button", { name: "Withdraw request" }).click();
  await expect(page.getByText("evidence · withdrawn · version 5")).toBeVisible();
  expect(writes[1]!.body).toEqual({ version: 4 });
});

test("a terms authorization denial clears protected receipts rather than allowing partial authority", async ({
  page,
}) => {
  await controls(page, { termsStatus: 403, requests: [receipt({ owner: "1" })] });
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Sign in required" })).toBeVisible();
  await expect(page.getByText("Protected synthetic review detail", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Bio (up to 500 characters)")).toHaveCount(0);
});

test("late terms from a hidden session cannot overwrite the reopened session's displayed agreement", async ({
  page,
}) => {
  await controls(page);
  let started!: () => void, release!: () => void, completed!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fulfilled = new Promise<void>((resolve) => {
    completed = resolve;
  });
  let count = 0;
  await page.route("**/controls/evidence-terms", async (route) => {
    if (++count > 1) return route.fallback();
    started();
    await pending;
    await route.fulfill({
      json: { terms: { ...syntheticEvidenceTerms, paragraphs: ["STALE PRIVATE TERMS FROM HIDDEN SESSION"] } },
    });
    completed();
  });
  await page.goto("/account");
  await requested;
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByLabel("Request kind")).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await fillEvidence(page);
  release();
  await fulfilled;
  await expect(page.getByText("STALE PRIVATE TERMS FROM HIDDEN SESSION", { exact: true })).toHaveCount(0);
  await expect(page.getByText(syntheticEvidenceTerms.paragraphs[0]!, { exact: true })).toBeVisible();
  await expect(page.getByLabel(consentLabel)).not.toBeChecked();
});
