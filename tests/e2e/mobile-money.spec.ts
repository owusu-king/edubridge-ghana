import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTANT_AUTH, SCHOOL, signIn } from "./helpers";

// The mock provider runs in test mode (see src/server/mobile-money/mock.ts): numbers ending 1111 decline,
// and others approve. Kojo Addo's seeded guardian, Adjoa Addo, has an AT number.

async function openKojo(page: Page) {
  await page.goto(`${SCHOOL.path}/students?q=Kojo%20Addo`);
  await page.getByRole("link", { name: "Kojo Addo" }).click();
  await expect(page.getByRole("heading", { name: "Kojo Addo" })).toBeVisible();
}

test("the head teacher cannot send Mobile Money prompts", async ({ page }) => {
  await signIn(page, "head@example.test");
  await openKojo(page);
  await expect(page.getByRole("heading", { name: "Fees" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Request Mobile Money" })).toHaveCount(0);
});

test.describe("as the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("a declined prompt records nothing; an approved one issues a receipt", async ({ page }) => {
    await openKojo(page);
    const requests = page
      .getByRole("list")
      .filter({ has: page.getByText("Waiting for the payer to approve") });

    await page.getByRole("button", { name: "Request Mobile Money" }).click();
    const dialog = page.getByRole("dialog", { name: "Request Mobile Money" });
    await expect(dialog.getByText(/Test mode: no prompt is sent and no money moves/)).toBeVisible();
    await expect(dialog.getByLabel("Payer's Mobile Money number")).toHaveValue("+233 27 555 0133");
    await expect(dialog.getByLabel("Network")).toHaveValue("at");
    await dialog.getByLabel("Amount (GH₵)").fill("15");
    await dialog.getByLabel("Payer's Mobile Money number").fill("024 555 1111");
    await expect(dialog.getByLabel("Network")).toHaveValue("mtn");
    await dialog.getByRole("button", { name: "Send prompt" }).click();
    await expect(dialog).toBeHidden();

    const declined = requests.getByRole("listitem").filter({ hasText: "GH₵15.00" }).first();
    await expect(declined).toContainText("MTN MoMo +233 24 555 1111");
    await declined.getByRole("button", { name: /Check status/ }).click();
    await expect(
      page.getByRole("listitem").filter({ hasText: "Not paid: The payer declined the prompt." }).first(),
    ).toBeVisible();

    await page.getByRole("button", { name: "Request Mobile Money" }).click();
    await dialog.getByLabel("Amount (GH₵)").fill("20");
    await dialog.getByRole("button", { name: "Send prompt" }).click();
    await expect(dialog).toBeHidden();
    const approved = page
      .getByRole("listitem")
      .filter({ hasText: "GH₵20.00" })
      .filter({ hasText: "Waiting for the payer to approve" })
      .first();
    await expect(approved).toContainText("AT Money +233 27 555 0133");
    await approved.getByRole("button", { name: /Check status/ }).click();

    await expect(page.getByRole("heading", { name: /Payment receipt R\d{6}/ })).toBeVisible();
    const receipt = page.getByRole("article");
    await expect(receipt).toContainText("GH₵20.00");
    await expect(receipt).toContainText("Mobile Money");
    await expect(receipt).toContainText(/MOCK\.[0-9A-F]{12}/);
    const number = (await page.getByRole("heading", { name: /Payment receipt/ }).innerText()).match(
      /R\d{6}/,
    )![0];

    await page.getByRole("link", { name: "Kojo Addo" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: `Paid, receipt ${number}` })).toBeVisible();
  });
});
