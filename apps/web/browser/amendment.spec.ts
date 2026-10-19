import { test, expect } from "@playwright/test";
import { syntheticBrowserIntake, syntheticEvidenceTerms } from "./controls-intake-fixtures.ts";
const id = "11111111-1111-1111-1111-111111111111";
for (const conflict of [false, true]) {
  test(`evidence amendment ${conflict ? "preserves conflict without retry" : "binds current receipt and reloads pending state"}`, async ({
    page,
  }) => {
    let version = 4;
    const writes: unknown[] = [];
    const intake = syntheticBrowserIntake("1", ["2", "3"]);
    intake.roles.submitter = "Synthetic mentor";
    intake.roles.collaborators["2"] = "Synthetic learner";
    intake.period = { kind: "interval", start: "2026-10-01", end: "2026-10-17" };
    intake.sourceUseBasis = { state: "declared", statement: "Synthetic source-use statement for review" };
    intake.participantConsents["3"]!.choice = "declined";
    await page.route("**/controls/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST") {
        writes.push({ path, body: request.postDataJSON(), csrf: request.headers()["x-csrf-token"] });
        if (conflict) return route.fulfill({ status: 409, json: { error: "Receipt changed" } });
        version++;
        return route.fulfill({ json: { id, version, status: "pending" } });
      }
      const responses: Record<string, unknown> = {
        "/controls/session": { actorId: "1", csrf: "a".repeat(43), roles: [], expires: Date.now() + 600000 },
        "/controls/evidence-terms": { terms: syntheticEvidenceTerms },
        "/controls/profile": { bio: "", highlights: [], public: false, suppressed: false },
        "/controls/invitations": { invitations: [] },
        "/controls/spotlights/queue": { nominations: [] },
        "/controls/requests": {
          requests: [
            {
              id,
              owner: "1",
              kind: "evidence",
              status: version === 4 ? "accepted" : "pending",
              version,
              locator: "https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/55",
              category: "mentorship",
              scope: "Original scope",
              detail: "Evidence",
              collaborators: { "2": "accepted", "3": "declined" },
              history: [],
              intake,
              intakeEligibility: { state: "participant_consent_required" },
            },
          ],
        },
      };
      await route.fulfill({ json: responses[path] ?? {} });
    });
    await page.goto("/account");
    await page.getByText("Amend evidence", { exact: true }).click();
    await expect(page.getByLabel("Amended contribution scope")).toHaveValue("Original scope");
    await expect(page.getByLabel("Amended collaborator GitHub numeric IDs, comma separated")).toHaveValue("2, 3");
    await expect(page.getByText(/a previous decline remains declined/)).toBeVisible();
    const amendment = page.locator("details").filter({ has: page.getByText("Amend evidence", { exact: true }) });
    await expect(amendment.getByLabel("Your proposed role", { exact: true })).toHaveValue("Synthetic mentor");
    await expect(amendment.getByLabel("Contribution start date")).toHaveValue("2026-10-01");
    await expect(amendment.getByLabel("Private source-use statement")).toHaveValue(
      "Synthetic source-use statement for review",
    );
    const consent = amendment.getByLabel(
      "I consent to public attribution of this claim under the displayed evidence terms if independently accepted",
    );
    await expect(consent).not.toBeChecked();
    await page.getByLabel("Amended contribution scope").fill("Revised scope");
    await page.getByLabel("Private amendment reason").fill("Correct the contribution scope");
    await page.getByLabel("Replace this evidence and return it to pending review").check();
    await consent.check();
    await page.getByRole("button", { name: "Submit evidence amendment" }).click();
    if (conflict) {
      await expect(page.getByRole("alert")).toContainText("Reload before trying again");
      await expect(page.getByText(/Service confirmed/)).toHaveCount(0);
      await expect(page.getByLabel("Amended contribution scope")).toHaveValue("Revised scope");
    } else {
      await expect(page.getByRole("status")).toContainText("Service confirmed");
      await expect(page.getByText("evidence · pending · version 5")).toBeVisible();
      await expect(page.getByRole("button", { name: "Nominate for spotlight" })).toHaveCount(0);
    }
    expect(writes).toEqual([
      {
        path: `/controls/requests/${id}/amend`,
        csrf: "a".repeat(43),
        body: {
          version: 4,
          reason: "Correct the contribution scope",
          locator: "https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/55",
          category: "mentorship",
          scope: "Revised scope",
          detail: "Evidence",
          collaborators: ["2", "3"],
          consent: true,
          intake: {
            schemaVersion: "evidence-intake/v1",
            termsVersion: syntheticEvidenceTerms.version,
            termsDigest: syntheticEvidenceTerms.digest,
            sourceUseBasis: { state: "declared", statement: "Synthetic source-use statement for review" },
            roles: { submitter: "Synthetic mentor", collaborators: { "2": "Synthetic learner", "3": null } },
            period: { kind: "interval", start: "2026-10-01", end: "2026-10-17" },
          },
        },
      },
    ]);
  });
}

test("foreign and terminal evidence never offers an amendment", async ({ page }) => {
  await page.route("**/controls/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/controls/session": { actorId: "1", csrf: "a".repeat(43), roles: ["reviewer"], expires: Date.now() + 600000 },
      "/controls/evidence-terms": { terms: syntheticEvidenceTerms },
      "/controls/profile": { bio: "", highlights: [], public: false, suppressed: false },
      "/controls/requests": {
        requests: [
          { id, owner: "2", kind: "evidence", status: "pending", version: 1, detail: "Other owner", history: [] },
          {
            id: "22222222-2222-2222-2222-222222222222",
            owner: "1",
            kind: "evidence",
            status: "withdrawn",
            version: 2,
            detail: "Withdrawn evidence",
            history: [],
          },
          {
            id: "33333333-3333-3333-3333-333333333333",
            owner: "1",
            kind: "evidence",
            status: "merged",
            version: 2,
            detail: "Merged evidence",
            history: [],
          },
        ],
      },
      "/controls/invitations": { invitations: [] },
      "/controls/spotlights/queue": { nominations: [] },
      "/controls/configuration": { revision: 0, proposals: {} },
    };
    await route.fulfill({ json: responses[path] ?? {} });
  });
  await page.goto("/admin");
  await expect(page.getByText("Other owner", { exact: true })).toBeVisible();
  await expect(page.getByText("Withdrawn evidence", { exact: true })).toBeVisible();
  await expect(page.getByText("Merged evidence", { exact: true })).toBeVisible();
  await expect(page.getByText("Amend evidence", { exact: true })).toHaveCount(0);
});
