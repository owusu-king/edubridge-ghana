import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTANT_AUTH, SCHOOL, signIn } from "./helpers";

/** Bills whatever is outstanding this term (other specs add students; earlier runs may leave reversals). */
async function billOutstanding(page: Page) {
  await page.goto(`${SCHOOL.path}/fees`);
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  const bill = page.getByRole("button", { name: /^Bill \d+ students?$/ });
  if (!(await bill.isVisible())) return;
  await bill.click();
  const confirm = page.getByRole("dialog", { name: /^Bill \d+ students? for Term 1, 2026\/2027\?$/ });
  await confirm.getByRole("button", { name: /^Bill / }).click();
  await expect(confirm).toBeHidden();
}

async function openStudent(page: Page, name: string) {
  await page.goto(`${SCHOOL.path}/students?q=${encodeURIComponent(name)}`);
  await page.getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

test("the head teacher sees billing progress and a student's statement, read-only", async ({ page }) => {
  await signIn(page, "head@example.test");
  await page.goto(`${SCHOOL.path}/fees`);
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  // Other specs add students, so counts vary between runs.
  await expect(page.getByText(/\d+ of \d+ students billed for Term 1, 2026\/2027\./)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Bill / })).toHaveCount(0);

  // Esi is not touched by other specs; Basic 4 pays GH₵1,140.00.
  await openStudent(page, "Esi Quaye");
  const statement = page.getByRole("table", { name: "Fee statement for Esi Quaye" });
  await expect(statement.getByRole("row", { name: /Tuition, Term 1 2026\/2027/ })).toBeVisible();
  await expect(page.getByText("GH₵1,140.00 owed")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Reverse / })).toHaveCount(0);
});

test.describe("as the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("an accountant reverses a charge, then bills it again from the fee structure", async ({ page }) => {
    await billOutstanding(page);
    await openStudent(page, "Akua Owusu");
    // Measured from the current balance, so the test also holds after earlier runs.
    const owed = page.getByText(/^GH₵[\d,]+\.\d{2} owed$/);
    const before = await owed.innerText();
    const cedis = (text: string) => Number(text.replace(/[^\d.]/g, ""));
    const formatOwed = (value: number) =>
      `GH₵${value.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} owed`;

    await page.getByRole("button", { name: "Reverse PTA dues, Term 1 2026/2027" }).click();
    const dialog = page.getByRole("dialog", { name: "Reverse this entry?" });
    await dialog.getByRole("button", { name: "Reverse entry" }).click();
    await expect(dialog.getByText("Say why this is being reversed.")).toBeVisible();
    await dialog.getByLabel("Reason").fill("Charged in error");
    await dialog.getByRole("button", { name: "Reverse entry" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(formatOwed(cedis(before) - 50))).toBeVisible();
    const statement = page.getByRole("table", { name: "Fee statement for Akua Owusu" });
    await expect(
      statement
        .getByRole("row", { name: /Reversed: PTA dues, Term 1 2026\/2027 \(Charged in error\)/ })
        .last(),
    ).toBeVisible();

    // Billing again charges Akua's PTA dues afresh.
    await billOutstanding(page);

    await openStudent(page, "Akua Owusu");
    await expect(page.getByText(before)).toBeVisible();
  });
});
