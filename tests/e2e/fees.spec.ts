import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { ACCOUNTANT_AUTH, SCHOOL, signIn } from "./helpers";

test("the head teacher sees fees per level but cannot change them", async ({ page }) => {
  await signIn(page, "head@example.test");
  await page.goto(SCHOOL.path);
  await page.getByRole("navigation", { name: "School" }).getByRole("link", { name: "Fees" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Fees" })).toBeVisible();
  const table = page.getByRole("table", { name: /Fees per level for Term 1, 2026\/2027/ });
  // Seeded Basic 4: tuition 850 + PTA 50 + books 180 + ICT 60.
  await expect(table.getByRole("row", { name: /^Basic 4\b.*GH₵1,140\.00/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /fees for Basic 4/ })).toHaveCount(0);
  await page.getByRole("link", { name: "Fee items" }).click();
  await expect(page.getByRole("row", { name: /Tuition/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Add fee item/ })).toHaveCount(0);
});

test("teachers have no access to fees", async ({ page }) => {
  await signIn(page, "teacher@example.test");
  await page.goto(SCHOOL.path);
  await expect(
    page.getByRole("navigation", { name: "School" }).getByRole("link", { name: "Fees" }),
  ).toHaveCount(0);
  await page.goto(`${SCHOOL.path}/fees`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test.describe("as the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("an accountant adds a fee item and sets a class's own amount", async ({ page }) => {
    // Other specs bill the term while this one runs, and billing charges any item a student has not been
    // billed yet. So the new item goes on Basic 5, which has no students: a billing run in between charges
    // nobody. (On Basic 4 it once charged every seeded Basic 4 student the levy, breaking balance checks.)
    const item = `Sports levy ${randomUUID().slice(0, 4)}`;
    await page.goto(`${SCHOOL.path}/fees/items`);
    await page.getByRole("button", { name: "Add fee item" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill(item);
    await page.getByRole("dialog").getByRole("button", { name: "Add item" }).click();
    await expect(page.getByRole("row", { name: new RegExp(item) })).toBeVisible();

    await page.getByRole("link", { name: "Fee structure" }).click();
    await page.getByRole("button", { name: "Edit fees for Basic 5" }).click();
    const basic5 = page.getByRole("dialog", { name: "Basic 5 fees" });
    await basic5.getByLabel(`${item}, whole level`).fill("25");
    // Live total: the level's GH₵1,140.00 plus the levy.
    await expect(basic5.getByRole("row", { name: /Total per term/ })).toContainText("GH₵1,165.00");
    await basic5.getByRole("button", { name: "Save fees" }).click();
    await expect(basic5).toBeHidden();
    const basic5Row = page
      .getByRole("row")
      .filter({ has: page.getByRole("button", { name: "Edit fees for Basic 5" }) });
    await expect(basic5Row).toContainText("GH₵1,165.00");

    // A class's own amount: Basic 4B tuition. The seeded Basic 4B students were billed their tuition
    // already, and billing never charges an item twice, so this changes no one's balance meanwhile.
    await page.getByRole("button", { name: "Edit fees for Basic 4" }).click();
    const dialog = page.getByRole("dialog", { name: "Basic 4 fees" });
    await dialog.getByLabel("Tuition, Basic 4B").fill("abc");
    await dialog.getByRole("button", { name: "Save fees" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Enter an amount, like 450 or 450.50.");
    // Typed values survive the failed save.
    await expect(dialog.getByLabel("Tuition, Basic 4B")).toHaveValue("abc");
    await dialog.getByLabel("Tuition, Basic 4B").fill("900");
    // Live totals: the whole level (1,140) and Basic 4B with its own tuition (900 instead of 850).
    const totals = dialog.getByRole("row", { name: /Total per term/ });
    await expect(totals).toContainText("GH₵1,140.00");
    await expect(totals).toContainText("GH₵1,190.00");
    await dialog.getByRole("button", { name: "Save fees" }).click();
    await expect(dialog).toBeHidden();
    const row = page
      .getByRole("row")
      .filter({ has: page.getByRole("button", { name: "Edit fees for Basic 4" }) });
    await expect(row).toContainText("Basic 4B: GH₵1,190.00");

    // Put things back for later runs: clear the override and the levy, and archive the item.
    await page.getByRole("button", { name: "Edit fees for Basic 4" }).click();
    await dialog.getByLabel("Tuition, Basic 4B").fill("");
    await dialog.getByRole("button", { name: "Save fees" }).click();
    await expect(dialog).toBeHidden();
    await expect(row).not.toContainText("Basic 4B:");
    await page.getByRole("button", { name: "Edit fees for Basic 5" }).click();
    await basic5.getByLabel(`${item}, whole level`).fill("");
    await basic5.getByRole("button", { name: "Save fees" }).click();
    await expect(basic5).toBeHidden();
    await expect(basic5Row).not.toContainText("GH₵1,165.00");
    await page.getByRole("link", { name: "Fee items" }).click();
    await page.getByRole("button", { name: `Archive ${item}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Archive item" }).click();
    await expect(page.getByRole("row", { name: new RegExp(item) })).toContainText("Archived");
  });
});
