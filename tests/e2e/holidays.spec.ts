import { expect, test } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

test("the head teacher adds a school holiday from the suggestions and removes it", async ({ page }) => {
  await signIn(page, "head@example.test", `${SCHOOL.path}/settings/calendar`);
  await page.goto(`${SCHOOL.path}/settings/calendar`);
  await expect(page.getByRole("heading", { name: "School holidays" })).toBeVisible();

  // Republic Day falls in Term 3 of the seeded year, so no other test's registers are affected.
  await page.getByRole("button", { name: "Public holidays 2026/2027" }).click();
  const dialog = page.getByRole("dialog", { name: "Ghana's public holidays, 2026/2027" });
  for (const box of await dialog.getByRole("checkbox").all())
    if (!(await box.isDisabled())) await box.uncheck();
  await dialog.getByRole("checkbox", { name: /^Republic Day/ }).check();
  await dialog.getByRole("button", { name: "Add ticked holidays" }).click();
  await expect(dialog).toBeHidden();

  const holidays = page.getByRole("table", { name: "School holidays" });
  const row = holidays.getByRole("row").filter({ hasText: "Republic Day" });
  await expect(row).toContainText("1 Jul 2027");
  await row.getByRole("button", { name: "Remove Republic Day" }).click();
  await page
    .getByRole("dialog", { name: "Remove Republic Day?" })
    .getByRole("button", { name: "Remove holiday" })
    .click();
  await expect(holidays.getByRole("row").filter({ hasText: "Republic Day" })).toHaveCount(0);
});

test("absence SMS are off until the school turns them on", async ({ page }) => {
  await signIn(page, "head@example.test", `${SCHOOL.path}/settings/attendance`);
  await page.goto(`${SCHOOL.path}/settings/attendance`);
  await expect(page.getByRole("heading", { name: "Absence SMS" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Send families an SMS about absences/ })).not.toBeChecked();
  await expect(
    page.getByText(/has been absent for 3 school days in a row\. Please contact the school\./),
  ).toBeVisible();
});
