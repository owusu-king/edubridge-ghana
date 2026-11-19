import { expect, test } from "@playwright/test";
import { ACCOUNTANT_AUTH, SCHOOL, signIn } from "./helpers";

// Runs in order: the head teacher (Kpone Ridge's seeded safeguarding lead) handles the teacher's report.
test.describe.configure({ mode: "serial" });

const marker = `Seen at break ${Date.now().toString(36)}`;

test("a teacher reports a concern and is told only that it was received", async ({ page }) => {
  await signIn(page, "teacher@example.test", `${SCHOOL.path}/safeguarding`);
  await page.goto(`${SCHOOL.path}/safeguarding`);
  await expect(
    page.getByText(/Only the school's safeguarding lead, Comfort Adjei, will see it/),
  ).toBeVisible();
  // Teachers report; they never see the cases.
  await expect(page.getByRole("table", { name: "Safeguarding cases" })).toHaveCount(0);
  await page.getByLabel("Child").selectOption({ label: "Kwame Mensah" });
  await page.getByLabel("What it is about").selectOption({ label: "Neglect" });
  await page
    .getByLabel("What you saw or were told")
    .fill(`${marker}: came to school hungry and tired again.`);
  await page.getByRole("button", { name: "Send to the safeguarding leads" }).click();
  await expect(
    page.getByText(/Your report SG\d{4} has gone to the school's safeguarding leads/),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your reports" })).toBeVisible();
});

test("the lead opens the case, records follow-up, sees the opening recorded, and closes it", async ({
  page,
}) => {
  await signIn(page, "head@example.test", `${SCHOOL.path}/safeguarding`);
  await page.goto(`${SCHOOL.path}/safeguarding`);
  const cases = page.getByRole("table", { name: "Safeguarding cases" });
  await cases
    .getByRole("link", { name: /Kwame Mensah/ })
    .first()
    .click();
  await expect(page.getByText(marker)).toBeVisible();

  await page.getByRole("button", { name: "Record" }).click();
  const record = page.getByRole("dialog", { name: "Record on this case" });
  await record.getByLabel("What").selectOption({ label: "Contact with the family" });
  await record.getByLabel("Details").fill("Called his mother; she will come in on Friday.");
  await record.getByRole("button", { name: "Record" }).click();
  await expect(record).toBeHidden();
  await expect(page.getByText("Called his mother; she will come in on Friday.")).toBeVisible();
  await expect(page.getByText("Comfort Adjei opened the case").first()).toBeVisible();

  await page.getByRole("button", { name: "Close case" }).click();
  const close = page.getByRole("dialog", { name: "Close this case" });
  await close.getByLabel("Why it is closed").fill("Family supported; school meals arranged.");
  await close.getByRole("button", { name: "Close case" }).click();
  await expect(close).toBeHidden();
  await expect(page.getByText("Closed: Family supported; school meals arranged.")).toBeVisible();
});

test.describe("the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("can report but never open a case", async ({ page }) => {
    await page.goto(`${SCHOOL.path}/safeguarding`);
    await expect(page.getByRole("heading", { name: "Report a concern" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Safeguarding cases" })).toHaveCount(0);
  });
});
