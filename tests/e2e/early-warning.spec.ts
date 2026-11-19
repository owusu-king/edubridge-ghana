import { expect, test } from "@playwright/test";
import { ACCOUNTANT_AUTH, SCHOOL, signIn } from "./helpers";

// The seed gives Esi Quaye (Basic 4A) two days absent with permission in her last ten registers: 80%, below the
// suggested 85%. The class teacher reviews it; the Head teacher sees the rules and the Command Center count.

test("the class teacher reviews an indicator, with a reason that is kept", async ({ page }) => {
  await signIn(page, "teacher@example.test", SCHOOL.path);
  await page.goto(SCHOOL.path);
  await page.getByRole("navigation", { name: "School" }).getByRole("link", { name: "Early warning" }).click();
  await expect(page.getByRole("heading", { name: "Early warning", level: 1 })).toBeVisible();
  const esi = page
    .getByRole("listitem")
    .filter({ hasText: "Esi Quaye" })
    .filter({ hasText: "Attendance below" });
  await expect(esi).toContainText(/Attended \d+ of \d+ registers/);
  await expect(esi).toContainText("absent with permission");
  await esi.getByRole("button", { name: /^Review/ }).click();
  const dialog = page.getByRole("dialog", { name: "Review this indicator" });
  await dialog.getByLabel("Reason").fill("Her mother called both days: Esi had malaria. Back and well.");
  await dialog.getByRole("button", { name: "Save review" }).click();
  await expect(dialog).toBeHidden();
  const reviewed = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Reviewed this term" }) });
  await expect(reviewed.getByRole("listitem").filter({ hasText: "Esi Quaye" })).toContainText(
    "No action needed, by Yaw Boateng",
  );
  // Teachers read the rules; they do not change them.
  await page.getByRole("navigation", { name: "Early warning" }).getByRole("link", { name: "Rules" }).click();
  await expect(page.getByText("Below 85% over the last 28 days")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save rules" })).toHaveCount(0);
});

test("the Head teacher sets the rules and sees the reviews waiting on the Command Center", async ({
  page,
}) => {
  await signIn(page, "head@example.test", SCHOOL.path);
  await page.goto(SCHOOL.path);
  await expect(page.getByText("Early-warning reviews waiting")).toBeVisible();
  await page.goto(`${SCHOOL.path}/early-warning/rules`);
  await expect(page.getByRole("button", { name: "Save rules" })).toBeVisible();
  await expect(page.getByLabel("Below (%)")).toHaveValue("85");
  await page.goto(`${SCHOOL.path}/early-warning/plans`);
  await expect(page.getByRole("heading", { name: "Support plans" })).toBeVisible();
});

test.describe("as the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("has no early warning", async ({ page }) => {
    await page.goto(SCHOOL.path);
    await expect(
      page.getByRole("navigation", { name: "School" }).getByRole("link", { name: "Early warning" }),
    ).toHaveCount(0);
    await page.goto(`${SCHOOL.path}/early-warning`);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });
});
