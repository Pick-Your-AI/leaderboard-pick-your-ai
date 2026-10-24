import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type {
  EvidenceIntakeInput,
  EvidenceInvitation,
  EvidenceTerms,
  ExternalTutorialDeclaration,
  Receipt,
  StoredEvidenceIntake,
} from "../src/controls/client.ts";
import { syntheticBrowserIntake, syntheticEvidenceTerms } from "./controls-intake-fixtures.ts";

const id = "33333333-3333-3333-3333-333333333333";
const carrier = "https://github.com/synthetic/tutorials/blob/" + "a".repeat(40) + "/manifest.json";
const toggle = "Declare an external tutorial using a pinned GitHub manifest";
const consent =
  "I consent to recording this exact tutorial declaration and proposed attribution under the displayed terms";
const tutorialTerms: EvidenceTerms = {
  ...syntheticEvidenceTerms,
  version: "evidence-terms/external-tutorial/2026-10-20",
  paragraphs: [
    "Synthetic tutorial terms: record this exact declaration and all proposed attribution; qualification is unavailable.",
    "The GitHub manifest is the carrier, not proof of tutorial authorship or permission. No external URL is fetched.",
    "Amendment requires fresh participant consent. Decline and withdrawal remain available.",
  ],
  digest: "d".repeat(64),
};
function declaration(owner = "1", peer = "3"): ExternalTutorialDeclaration {
  return {
    schemaVersion: "external-tutorial-declaration/v1",
    canonicalUrl: "https://tutorial.example.invalid/lesson",
    revision: { id: "revision-one", contentSha256: "b".repeat(64) },
    manifest: { locator: carrier, contentSha256: "c".repeat(64) },
    publishedAt: null,
    attribution: [
      { actorId: owner, role: "Declared author" },
      { actorId: peer, role: null },
    ].sort((a, b) => a.actorId.localeCompare(b.actorId)),
  };
}
function intake(owner = "1", peer = "3"): StoredEvidenceIntake {
  return {
    ...syntheticBrowserIntake(owner, [peer]),
    schemaVersion: "evidence-intake/external-tutorial/v1",
    termsVersion: tutorialTerms.version,
    termsDigest: tutorialTerms.digest,
    roles: { submitter: "Declared author", collaborators: { [peer]: null } },
    externalTutorial: declaration(owner, peer),
    participantConsents: {},
  };
}
function receipt(owner = "1"): Receipt {
  return {
    id,
    owner,
    kind: "evidence",
    status: "pending",
    version: 3,
    locator: carrier,
    category: "other",
    scope: "Synthetic tutorial attribution",
    detail: "PRIVATE_TUTORIAL_REVIEW",
    collaborators: { 3: "pending" },
    intake: intake(owner),
    intakeEligibility: { state: "participant_consent_required" },
    history: [],
  };
}
function invitation(enabled = true): EvidenceInvitation {
  return {
    id,
    version: 3,
    locator: carrier,
    category: "other",
    scope: "Synthetic tutorial attribution",
    consent: "pending",
    claimRevision: 1,
    claimDigest: "c".repeat(64),
    participantIds: ["1", "2"],
    role: null,
    period: { kind: "unknown" },
    sourceUseState: "unresolved",
    terms: tutorialTerms,
    externalTutorial: declaration("2", "1"),
    externalTutorialConsentEnabled: enabled,
    intakeEligibility: { state: "participant_consent_required" },
  };
}

// UI transport fixtures only. The companion Controls suite uses real authenticated HTTP and SQLite transactions.
async function controls(
  page: Page,
  options: {
    enabled?: boolean;
    requests?: Receipt[];
    invitations?: EvidenceInvitation[];
    roles?: string[];
  } = {},
) {
  const requests = structuredClone(options.requests ?? []);
  const invitations = structuredClone(options.invitations ?? []);
  const writes: Array<{ path: string; body: Record<string, any>; csrf: string | undefined }> = [];
  const storedInput = (owner: string, input: EvidenceIntakeInput, peers: string[]): StoredEvidenceIntake => ({
    ...syntheticBrowserIntake(owner, peers),
    ...input,
    participantConsents: {},
  });
  await page.route("**/controls/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      writes.push({ path, body, csrf: request.headers()["x-csrf-token"] });
      if (path === "/controls/requests") {
        requests.push({
          ...receipt(),
          ...body,
          id,
          owner: "1",
          version: 1,
          collaborators: Object.fromEntries(body.collaborators.map((actor: string) => [actor, "pending"])),
          intake: storedInput("1", body.intake, body.collaborators),
        });
      } else if (path.endsWith("/amend")) {
        const current = requests.find((item) => path.includes(item.id));
        if (current) {
          Object.assign(current, body, {
            version: current.version + 1,
            status: "pending",
            collaborators: Object.fromEntries(body.collaborators.map((actor: string) => [actor, "pending"])),
            intake: storedInput(current.owner, body.intake, body.collaborators),
          });
        }
      } else if (path.endsWith("/consent")) {
        const current = invitations.find((item) => path.includes(item.id));
        if (current) {
          current.version++;
          current.consent = body.consent ? "accepted" : "declined";
        }
      }
      return route.fulfill({ json: { id, status: "pending", version: 1 } });
    }
    const responses: Record<string, unknown> = {
      "/controls/session": {
        actorId: "1",
        csrf: "a".repeat(43),
        roles: options.roles ?? [],
        expires: Date.now() + 600000,
      },
      "/controls/evidence-terms": {
        terms: syntheticEvidenceTerms,
        ...(options.enabled ? { externalTutorialTerms: tutorialTerms } : {}),
      },
      "/controls/profile": { bio: "", highlights: [], public: false, suppressed: false },
      "/controls/requests": { requests },
      "/controls/invitations": { invitations },
      "/controls/spotlights/queue": { nominations: [] },
      "/controls/spotlight-rotation/queue": { schemaVersion: "editorial-dimensions/v1", records: [] },
    };
    return route.fulfill({ json: responses[path] ?? {} });
  });
  return writes;
}
async function fillTutorial(page: Page) {
  await page.getByLabel("Request kind").selectOption("evidence");
  await page.getByLabel(toggle).check();
  await page.getByLabel("Pinned GitHub manifest URL", { exact: true }).fill(carrier);
  await page.getByLabel("Canonical tutorial HTTPS URL").fill("https://tutorial.example.invalid/lesson");
  await page.getByLabel("Declared tutorial revision", { exact: true }).fill("revision-one");
  await page.getByLabel("Tutorial content SHA-256", { exact: true }).fill("b".repeat(64));
  await page.getByLabel("Pinned manifest content SHA-256", { exact: true }).fill("c".repeat(64));
  await page
    .getByLabel("Contribution scope (public claim summary)", { exact: true })
    .fill("Synthetic tutorial attribution");
  await page.getByLabel("Private review details", { exact: true }).fill("PRIVATE_TUTORIAL_REVIEW");
  await page.getByLabel("Your proposed role knowledge").selectOption("described");
  await page.getByLabel("Your proposed role", { exact: true }).fill("Declared author");
  await page.getByLabel("Collaborator GitHub numeric IDs, comma separated", { exact: true }).fill("3");
}

test("tutorial profile stays absent when the capability is disabled", async ({ page }) => {
  const writes = await controls(page);
  await page.goto("/account");
  await page.getByLabel("Request kind").selectOption("evidence");
  await expect(page.getByLabel(toggle)).toHaveCount(0);
  await expect(page.getByLabel("Public GitHub source URL", { exact: true })).toBeVisible();
  for (const paragraph of syntheticEvidenceTerms.paragraphs)
    await expect(page.getByText(paragraph, { exact: true })).toBeVisible();
  await expect(page.getByText(tutorialTerms.paragraphs[0]!, { exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("tutorial submission is keyboard accessible at 320 pixels and binds the displayed declaration without fetching it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const writes = await controls(page, { enabled: true });
  const external: string[] = [];
  page.on("request", (request) => {
    if (["github.com", "tutorial.example.invalid"].includes(new URL(request.url()).hostname))
      external.push(request.url());
  });
  await page.goto("/account");
  await fillTutorial(page);
  await expect(page.getByLabel("Category", { exact: true })).toHaveValue("other");
  await expect(page.getByLabel("Declared publication time in UTC (empty means unknown)")).toHaveValue("");
  for (const paragraph of tutorialTerms.paragraphs)
    await expect(page.getByText(paragraph, { exact: true })).toBeVisible();
  const choice = page.getByLabel(consent, { exact: true });
  await expect(choice).not.toBeChecked();
  await choice.focus();
  await page.keyboard.press("Space");
  await expect(choice).toBeChecked();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Submit request", exact: true }).click();
  await expect(page.getByText("evidence · pending · version 1")).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]!.csrf).toBe("a".repeat(43));
  expect(writes[0]!.body.intake).toEqual({
    schemaVersion: "evidence-intake/external-tutorial/v1",
    termsVersion: tutorialTerms.version,
    termsDigest: tutorialTerms.digest,
    sourceUseBasis: { state: "unresolved" },
    roles: { submitter: "Declared author", collaborators: { 3: null } },
    period: { kind: "unknown" },
    externalTutorial: declaration(),
  });
  await expect(page.getByRole("button", { name: "Nominate for spotlight" })).toHaveCount(0);
  expect(external).toEqual([]);
});

test("tutorial invalid pins focus the actual field and switching profiles clears affirmative consent", async ({
  page,
}) => {
  const writes = await controls(page, { enabled: true });
  await page.goto("/account");
  await fillTutorial(page);
  await page.getByLabel(consent, { exact: true }).check();
  const hash = page.getByLabel("Tutorial content SHA-256", { exact: true });
  await hash.fill("not-a-hash");
  await page.getByRole("button", { name: "Submit request", exact: true }).click();
  await expect(hash).toBeFocused();
  await expect(hash).toHaveAttribute("aria-invalid", "true");
  await expect(hash).toHaveAccessibleDescription(/64-character lowercase SHA-256/);
  await page.getByLabel(toggle).uncheck();
  await page.getByLabel(toggle).check();
  await expect(page.getByLabel(consent, { exact: true })).not.toBeChecked();
  expect(writes).toEqual([]);
});

test("tutorial participant sees every declared identity and role while private rationale is absent", async ({
  page,
}) => {
  const invite = invitation();
  const writes = await controls(page, { enabled: true, invitations: [invite] });
  await page.goto("/account");
  const article = page.getByRole("article").filter({ has: page.getByText("Attribution invitation " + id) });
  await expect(article.getByRole("region", { name: "Tutorial declaration shared with participants" })).toBeVisible();
  await expect(article.getByText("Canonical tutorial identity: https://tutorial.example.invalid/lesson")).toBeVisible();
  await expect(article.getByText("GitHub ID 2: Declared author.")).toBeVisible();
  await expect(article.getByText("GitHub ID 1: Unknown role.")).toBeVisible();
  await expect(article.getByText("Declared publication time: Unknown")).toBeVisible();
  await expect(page.getByText(/PRIVATE_TUTORIAL/)).toHaveCount(0);
  await article.getByLabel("Attribution consent", { exact: true }).selectOption("accept");
  await article.getByLabel("I consent to my attribution in this exact claim under the displayed terms").check();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await article.getByRole("button", { name: "Save consent" }).click();
  await expect(page.getByText(/Your saved choice: accepted/)).toBeVisible();
  expect(writes).toEqual([
    {
      path: "/controls/requests/" + id + "/consent",
      csrf: "a".repeat(43),
      body: {
        version: 3,
        consent: true,
        claimDigest: invite.claimDigest,
        termsVersion: tutorialTerms.version,
        termsDigest: tutorialTerms.digest,
      },
    },
  ]);
});

test("disabled tutorial invitations still display the saved declaration and permit decline", async ({ page }) => {
  const writes = await controls(page, { invitations: [invitation(false)] });
  await page.goto("/account");
  await expect(page.getByText("Declared revision: revision-one")).toBeVisible();
  await expect(page.getByRole("option", { name: "Accept under the displayed terms" })).toBeDisabled();
  await page.getByLabel("Attribution consent", { exact: true }).selectOption("decline");
  await page.getByLabel("Confirm my choice for " + id, { exact: true }).check();
  await page.getByRole("button", { name: "Save consent" }).click();
  await expect(page.getByText(/Your saved choice: declined/)).toBeVisible();
  expect(writes[0]!.body).toEqual({ version: 3, consent: false });
});

test("tutorial amendment starts without consent and sends changed attribution and revision for a fresh claim", async ({
  page,
}) => {
  const writes = await controls(page, { enabled: true, requests: [receipt()] });
  await page.goto("/account");
  await page.getByText("Amend evidence", { exact: true }).click();
  const amendment = page.locator("details").filter({ has: page.getByText("Amend evidence", { exact: true }) });
  await expect(amendment.getByLabel(consent, { exact: true })).not.toBeChecked();
  await amendment.getByLabel("Declared tutorial revision", { exact: true }).fill("revision-two");
  await amendment.getByLabel("Your proposed role", { exact: true }).fill("Declared coauthor");
  await amendment.getByLabel("Private amendment reason").fill("PRIVATE_AMENDMENT_REASON");
  await amendment.getByLabel(consent, { exact: true }).check();
  await amendment.getByLabel("Replace this evidence and return it to pending review").check();
  await amendment.getByRole("button", { name: "Submit evidence amendment" }).click();
  await expect(page.getByText("evidence · pending · version 4")).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]!.body.intake.externalTutorial).toEqual({
    ...declaration(),
    revision: { id: "revision-two", contentSha256: "b".repeat(64) },
    attribution: [
      { actorId: "1", role: "Declared coauthor" },
      { actorId: "3", role: null },
    ],
  });
});

test("tutorial reviewer can inspect the declaration but cannot select ordinary evidence acceptance", async ({
  page,
}) => {
  const current = receipt("2");
  current.intakeEligibility = { state: "external_tutorial_qualification_unavailable" };
  const writes = await controls(page, { enabled: true, roles: ["reviewer"], requests: [current] });
  await page.goto("/admin");
  await expect(page.getByRole("option", { name: "Accept evidence", exact: true })).toHaveJSProperty("disabled", true);
  await expect(
    page.getByText(/Tutorial consent is recorded, but independent qualification is unavailable/),
  ).toBeVisible();
  await expect(page.getByText("Declared revision: revision-one")).toBeVisible();
  expect(writes).toEqual([]);
});
