import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { ACCOUNTANT_AUTH, SCHOOL } from "./helpers";

test.describe("as the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("gives a sibling a discount that billing applies, then ends it", async ({ page }) => {
    const label = `Sibling discount ${randomUUID().slice(0, 4)}`;
    // Seeded: Grace Mensah is guardian of Kwame Mensah and Efua Ofori.
    await page.goto(`${SCHOOL.path}/fees/families`);
    const family = page.getByRole("table", { name: "Children of Grace Mensah" });
    await expect(family.getByRole("row", { name: /Kwame Mensah/ })).toBeVisible();
    await family.getByRole("link", { name: "Kwame Mensah" }).click();

    await page.getByRole("button", { name: "Add scholarship or discount" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a scholarship or discount" });
    await dialog.getByLabel("Name").fill(label);
    await dialog.getByLabel("A fixed amount each term").check();
    await dialog.getByLabel("Amount (GH₵)").fill("25");
    await dialog.getByLabel("Applies to").selectOption({ label: "Tuition" });
    await dialog.getByRole("button", { name: "Add" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("listitem").filter({ hasText: label })).toContainText("GH₵25.00 off Tuition");

    // Billing applies it (another test may already have billed everything outstanding).
    await page.goto(`${SCHOOL.path}/fees`);
    await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
    const bill = page.getByRole("button", { name: /^Bill \d+ students?$/ });
    if (await bill.isVisible()) {
      await bill.click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /^Bill / })
        .click();
      await expect(page.getByRole("dialog")).toBeHidden();
    }

    await page.goto(`${SCHOOL.path}/students?q=Kwame`);
    await page.getByRole("link", { name: "Kwame Mensah" }).click();
    const statement = page.getByRole("table", { name: "Fee statement for Kwame Mensah" });
    const discount = statement.getByRole("row", { name: new RegExp(`${label} on Tuition`) });
    await expect(discount).toContainText("-GH₵25.00");

    // End it and take back the billed discount, leaving the account as it was.
    await page.getByRole("button", { name: `End ${label}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "End discount" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: label })).toHaveCount(0);
    await statement.getByRole("button", { name: new RegExp(`Reverse ${label}`) }).click();
    await page.getByRole("dialog").getByLabel("Reason").fill("Test run");
    await page.getByRole("dialog").getByRole("button", { name: "Reverse entry" }).click();
    await expect(page.getByText("Nothing owed")).toBeVisible();
  });
});
