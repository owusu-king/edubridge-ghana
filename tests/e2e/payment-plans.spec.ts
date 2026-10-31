import { expect, test } from "@playwright/test";
import { ACCOUNTANT_AUTH, SCHOOL } from "./helpers";

test.describe("as the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("agrees a payment plan for what a family owes, then cancels it", async ({ page }) => {
    // Seeded: Abena Asante owes GH₵840.00 (GH₵1,140 billed, GH₵300 paid).
    await page.goto(`${SCHOOL.path}/students?q=Abena%20Asante`);
    await page.getByRole("link", { name: "Abena Asante" }).click();
    await page.getByRole("button", { name: "Agree a payment plan" }).click();
    const dialog = page.getByRole("dialog", { name: "Agree a payment plan" });
    await expect(dialog.getByLabel("Amount to spread (GH₵)")).toHaveValue("840");
    await dialog.getByLabel("Instalments").selectOption("3");
    await dialog.getByRole("button", { name: "Agree plan" }).click();
    await expect(dialog).toBeHidden();

    const instalments = page.getByRole("table", { name: "Payment plan instalments" });
    await expect(instalments.getByRole("row")).toHaveCount(4);
    await expect(instalments.getByRole("row", { name: /GH₵280\.00.*Upcoming/ })).toHaveCount(3);
    await expect(page.getByText("GH₵0.00 paid towards it, GH₵840.00 to go.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Agree a payment plan" })).toHaveCount(0);

    await page.getByRole("button", { name: "Cancel plan" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel plan" }).click();
    await expect(instalments).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Agree a payment plan" })).toBeVisible();
  });
});
