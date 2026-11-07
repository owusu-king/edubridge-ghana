import { expect, test } from "@playwright/test";
import { ACCOUNTANT_AUTH, SCHOOL, signIn } from "./helpers";

// Adenta Hall (no two-step requirement) for the Proprietor's settings; saves leave the defaults in place.
test("the Proprietor decides who voids receipts and how overview figures are worked out", async ({
  page,
}) => {
  await signIn(page, "owner@example.test", "/s/adenta-hall/settings/security");
  await page.goto("/s/adenta-hall/settings/security");
  await expect(page.getByRole("heading", { name: "Voiding receipts" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /^Only the Proprietor/ })).toBeChecked();
  await page.getByRole("radio", { name: /^Only the Proprietor/ }).check();
  await page.getByRole("button", { name: "Save" }).last().click();
  await expect(page.getByText("Saved. It applies from each person's next page.")).toBeVisible();

  await page.goto("/s/adenta-hall/settings");
  await expect(page.getByRole("heading", { name: "Overview figures" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /^Collected ÷ \(owed when the term began/ })).toBeChecked();
  await expect(page.getByLabel("Follow up attendance below (%)")).toHaveValue("80");
});

test.describe("the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("sets the sibling discount rule on the families page", async ({ page }) => {
    await page.goto(`${SCHOOL.path}/fees/families`);
    await expect(page.getByRole("heading", { name: "Sibling discount" })).toBeVisible();
    await expect(page.getByLabel("Pays in full")).toHaveValue("eldest");
    await expect(page.getByLabel("Second child's discount (%)")).toBeVisible();
  });
});
