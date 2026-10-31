import { expect, test } from "@playwright/test";
import { ACCOUNTANT_AUTH, SCHOOL } from "./helpers";

test.describe("as the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("imports opening balances from a spreadsheet", async ({ page }) => {
    await page.goto(`${SCHOOL.path}/fees/accounts`);
    await page.getByRole("link", { name: "Import opening balances" }).click();
    await expect(page.getByRole("heading", { name: "Import opening balances" })).toBeVisible();
    await page.getByLabel("Spreadsheet (.xlsx or .csv)").setInputFiles({
      name: "balances.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("Adm No,Name,Arrears\nS0010,Nana Agyeman,320.00\nX9999,Nobody,10\n"),
    });
    await page.getByRole("button", { name: "Check file" }).click();
    await expect(page.getByRole("heading", { name: "balances.csv" })).toBeVisible();
    await expect(
      page
        .getByRole("table", { name: "Rows with problems" })
        .getByRole("row", { name: /3.*No student with admission number X9999/ }),
    ).toBeVisible();

    // A fresh database imports Nana's balance; on later runs it is already there and left alone.
    const record = page.getByRole("button", { name: "Record 1 balance" });
    if (await record.isVisible()) {
      await record.click();
      await expect(page.getByText("1 opening balance recorded.")).toBeVisible();
    } else {
      await expect(page.getByText("1 students already have an opening balance")).toBeVisible();
    }

    await page.goto(`${SCHOOL.path}/students?q=Nana`);
    await page.getByRole("link", { name: "Nana Agyeman" }).click();
    await expect(
      page.getByRole("table", { name: "Fee statement for Nana Agyeman" }).getByRole("row", {
        name: /Balance brought forward from previous records.*GH₵320\.00/,
      }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Set opening balance" })).toHaveCount(0);
  });

  test("adds a one-off charge to a statement and reverses it", async ({ page }) => {
    await page.goto(`${SCHOOL.path}/students?q=Adwoa`);
    await page.getByRole("link", { name: "Adwoa Boateng" }).click();
    const statement = page.getByRole("table", { name: "Fee statement for Adwoa Boateng" });
    const owed = page.getByText(/^GH₵[\d,]+\.\d{2} owed$/);
    const before = await owed.innerText();

    await page.getByRole("button", { name: "Add charge or credit" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a charge or credit" });
    await dialog.getByLabel("Amount (GH₵)").fill("45");
    await dialog.getByLabel("What it is for").fill("Lost reader (E2E)");
    await dialog.getByRole("button", { name: "Add to account" }).click();
    await expect(dialog).toBeHidden();
    await expect(owed).not.toHaveText(before);

    await statement.getByRole("button", { name: "Reverse Lost reader (E2E)" }).last().click();
    const reverse = page.getByRole("dialog", { name: "Reverse this entry?" });
    await reverse.getByLabel("Reason").fill("Book was found");
    await reverse.getByRole("button", { name: "Reverse entry" }).click();
    await expect(reverse).toBeHidden();
    await expect(owed).toHaveText(before);
  });
});
