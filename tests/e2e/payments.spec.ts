import { expect, test } from "@playwright/test";
import { ACCOUNTANT_AUTH, SCHOOL, signIn } from "./helpers";

const cedis = (text: string) => Number(text.replace(/[^\d.]/g, ""));

test("the head teacher sees balances but cannot record payments", async ({ page }) => {
  await signIn(page, "head@example.test");
  await page.goto(`${SCHOOL.path}/fees/accounts`);
  await expect(page.getByText("Owed to the school")).toBeVisible();
  const balances = page.getByRole("table", { name: "Student balances" });
  // Seeded: Kwame paid the full term by Mobile Money. Search, as other tests add students to the list.
  const search = page.getByLabel("Search by name or admission number");
  await search.fill("Kwame Mensah");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(balances.getByRole("row", { name: /Kwame Mensah.*Paid up/ })).toBeVisible();
  await search.fill("Fiifi");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(balances.getByRole("row")).toHaveCount(2);

  await page.goto(`${SCHOOL.path}/fees/payments?date=2026-09-10`);
  await expect(page.getByRole("heading", { name: "Received 10 Sept 2026: GH₵1,140.00" })).toBeVisible();
  await page.getByRole("link", { name: "R000002" }).click();
  await expect(page.getByRole("heading", { name: /Payment receipt R000002/ })).toBeVisible();
  await expect(page.getByText("MM260910.0931.C11427")).toBeVisible();
  await expect(page.getByRole("button", { name: "Void receipt" })).toHaveCount(0);

  await page.getByRole("link", { name: "Kwame Mensah" }).click();
  await expect(page.getByRole("button", { name: "Record payment" })).toHaveCount(0);
});

test.describe("as the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("an accountant records a Mobile Money payment and gets a receipt", async ({ page }) => {
    await page.goto(`${SCHOOL.path}/students?q=Yaw%20Darko`);
    await page.getByRole("link", { name: "Yaw Darko" }).click();
    const owed = page.getByText(/^GH₵[\d,]+\.\d{2} owed$|^Nothing owed$|in credit$/);
    const before = (await owed.innerText()).includes("credit")
      ? -cedis(await owed.innerText())
      : cedis(await owed.innerText());

    await page.getByRole("button", { name: "Record payment" }).click();
    const dialog = page.getByRole("dialog", { name: "Record payment" });
    await dialog.getByLabel("Amount (GH₵)").fill("200");
    await dialog.getByLabel("Paid by").selectOption({ label: "Mobile Money" });
    await dialog.getByRole("button", { name: "Record and issue receipt" }).click();
    await expect(dialog.getByText("Enter the transaction, slip or cheque number.")).toBeVisible();
    await expect(dialog.getByLabel("Amount (GH₵)")).toHaveValue("200");
    await dialog.getByLabel("Transaction ID").fill("MM261031.1200.E2E");
    await dialog.getByLabel("Received from").fill("Ama Darko");
    await dialog.getByRole("button", { name: "Record and issue receipt" }).click();

    await expect(page.getByRole("heading", { name: /Payment receipt R\d{6}/ })).toBeVisible();
    const receipt = page.getByRole("article");
    await expect(receipt).toContainText("GH₵200.00");
    await expect(receipt).toContainText("Mobile Money");
    await expect(receipt).toContainText("Ama Darko");
    await expect(receipt).toContainText("Akosua Darko");
    const number = (await page.getByRole("heading", { name: /Payment receipt/ }).innerText()).match(
      /R\d{6}/,
    )![0];

    await page.getByRole("link", { name: "Yaw Darko" }).click();
    const after = before - 200;
    const expected =
      after > 0
        ? `GH₵${after.toLocaleString("en-GH", { minimumFractionDigits: 2 })} owed`
        : after < 0
          ? `GH₵${(-after).toLocaleString("en-GH", { minimumFractionDigits: 2 })} in credit`
          : "Nothing owed";
    await expect(page.getByText(expected)).toBeVisible();
    await expect(
      page
        .getByRole("table", { name: "Fee statement for Yaw Darko" })
        .getByRole("link", { name: new RegExp(number) }),
    ).toBeVisible();

    await page.goto(`${SCHOOL.path}/fees/payments`);
    await expect(page.getByRole("row", { name: new RegExp(`${number}.*Yaw Darko`) })).toBeVisible();
  });
});
