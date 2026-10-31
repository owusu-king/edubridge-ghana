import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTANT_AUTH, SCHOOL } from "./helpers";

/** Bills whatever is outstanding (other tests may have billed it already). */
async function billOutstanding(page: Page) {
  await page.goto(`${SCHOOL.path}/fees`);
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  const bill = page.getByRole("button", { name: /^Bill \d+ students?$/ });
  if (!(await bill.isVisible())) return;
  await bill.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Bill / })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
}

async function openEfua(page: Page) {
  await page.goto(`${SCHOOL.path}/students?q=Efua%20Ofori`);
  await page.getByRole("link", { name: "Efua Ofori" }).click();
}

test.describe("as the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("gives a sibling a discount that billing applies, then ends it", async ({ page }) => {
    const label = `Sibling discount ${randomUUID().slice(0, 4)}`;
    // Seeded: Grace Mensah is guardian of Kwame Mensah and Efua Ofori (who has a pending sibling discount).
    await page.goto(`${SCHOOL.path}/fees/families`);
    const family = page.getByRole("table", { name: "Children of Grace Mensah" });
    await expect(family.getByRole("row", { name: /Kwame Mensah/ })).toBeVisible();
    await expect(family.getByRole("row", { name: /Efua Ofori.*Sibling discount/ })).toBeVisible();

    await billOutstanding(page);
    await openEfua(page);
    const owed = page.getByText(/^GH₵[\d,]+\.\d{2} owed$/);
    const before = await owed.innerText();

    await page.getByRole("button", { name: "Add scholarship or discount" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a scholarship or discount" });
    await dialog.getByLabel("Name").fill(label);
    await dialog.getByLabel("A fixed amount each term").check();
    await dialog.getByLabel("Amount (GH₵)").fill("25");
    await dialog.getByLabel("Applies to").selectOption({ label: "Tuition" });
    await dialog.getByRole("button", { name: "Add" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("listitem").filter({ hasText: label })).toContainText("GH₵25.00 off Tuition");

    await billOutstanding(page);
    await openEfua(page);
    const statement = page.getByRole("table", { name: "Fee statement for Efua Ofori" });
    await expect(statement.getByRole("row", { name: new RegExp(`${label} on Tuition`) })).toContainText(
      "-GH₵25.00",
    );

    // End it and take back the billed discount, leaving the account as it was.
    await page.getByRole("button", { name: `End ${label}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "End discount" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: label })).toHaveCount(0);
    await statement.getByRole("button", { name: new RegExp(`Reverse ${label}`) }).click();
    await page.getByRole("dialog").getByLabel("Reason").fill("Test run");
    await page.getByRole("dialog").getByRole("button", { name: "Reverse entry" }).click();
    await expect(owed).toHaveText(before);
  });
});
