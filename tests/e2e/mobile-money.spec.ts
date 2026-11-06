import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTANT_AUTH, SCHOOL, signIn } from "./helpers";

// The mock provider runs in test mode (see src/server/mobile-money/mock.ts) and posts a signed callback
// shortly after each answered prompt. Numbers ending 1111 decline, 2222 never answer, 3333 report a
// different amount; others approve. Kojo Addo's seeded guardian, Adjoa Addo, has an AT number.

async function openStudent(page: Page, name: string) {
  await page.goto(`${SCHOOL.path}/students?q=${encodeURIComponent(name)}`);
  await page.getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

/** Amounts unique to this run, so rows left by earlier runs on the same database never match. */
const run = String((Date.now() % 89) + 10);
const amount = (cedis: number) => ({ input: `${cedis}.${run}`, shown: `GH₵${cedis}.${run}` });

const newestRow = (page: Page) =>
  page.getByRole("list", { name: "Mobile Money requests" }).getByRole("listitem").first();

/** Sends a prompt and returns its row, once the page shows it as the newest request. */
async function sendPrompt(page: Page, cedis: number, phone?: string) {
  const { input, shown } = amount(cedis);
  await page.getByRole("button", { name: "Request Mobile Money" }).click();
  const dialog = page.getByRole("dialog", { name: "Request Mobile Money" });
  await dialog.getByLabel("Amount (GH₵)").fill(input);
  if (phone) await dialog.getByLabel("Payer's Mobile Money number").fill(phone);
  await dialog.getByRole("button", { name: "Send prompt" }).click();
  await expect(dialog).toBeHidden();
  const row = newestRow(page);
  await expect(row).toContainText(shown);
  return row;
}

test("the head teacher cannot send Mobile Money prompts", async ({ page }) => {
  await signIn(page, "head@example.test");
  await openStudent(page, "Kojo Addo");
  await expect(page.getByRole("heading", { name: "Fees" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Request Mobile Money" })).toHaveCount(0);
});

test("the callback endpoint refuses unsigned and unknown callbacks", async ({ request }) => {
  const school = "00000000-0000-4000-8000-000000000000";
  const unsigned = await request.post(`/api/v1/mobile-money/callbacks/mock/${school}`, {
    data: { reference: school },
  });
  expect(unsigned.status()).toBe(401);
  const unknown = await request.post(`/api/v1/mobile-money/callbacks/mtn/${school}`, { data: {} });
  expect(unknown.status()).toBe(404);
});

test.describe("as the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("outcomes arrive by themselves: a decline records nothing, an approval issues a receipt", async ({
    page,
  }) => {
    await openStudent(page, "Kojo Addo");
    await page.getByRole("button", { name: "Request Mobile Money" }).click();
    const dialog = page.getByRole("dialog", { name: "Request Mobile Money" });
    await expect(dialog.getByText(/Test mode: no prompt is sent and no money moves/)).toBeVisible();
    await expect(dialog.getByLabel("Payer's Mobile Money number")).toHaveValue("+233 27 555 0133");
    await expect(dialog.getByLabel("Network")).toHaveValue("at");
    await dialog.getByLabel("Payer's Mobile Money number").fill("024 555 1111");
    await expect(dialog.getByLabel("Network")).toHaveValue("mtn");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // No one clicks "Check status": the provider's callback settles it and the page refreshes.
    const declined = await sendPrompt(page, 15, "024 555 1111");
    await expect(declined).toContainText("MTN MoMo +233 24 555 1111");
    await expect(declined).toContainText("Not paid: The payer declined the prompt.", { timeout: 20_000 });

    const approved = await sendPrompt(page, 20);
    await expect(approved).toContainText("AT Money +233 27 555 0133");
    await expect(approved).toContainText(/Paid, receipt R\d{6}/, { timeout: 20_000 });
    const number = (await approved.innerText()).match(/R\d{6}/)![0];
    await approved.getByRole("link", { name: number }).click();

    await expect(page.getByRole("heading", { name: `Payment receipt ${number}` })).toBeVisible();
    const receipt = page.getByRole("article");
    await expect(receipt).toContainText(amount(20).shown);
    await expect(receipt).toContainText("Mobile Money");
    await expect(receipt).toContainText(/MOCK\.[0-9A-F]{12}/);
  });

  test("checking by hand, before the callback arrives, opens the receipt", async ({ page }) => {
    // The end-to-end server delays mock callbacks by 4 seconds, leaving time to check by hand.
    await openStudent(page, "Kweku Amponsah");
    const row = await sendPrompt(page, 12, "024 123 4567");
    await expect(row).toContainText("Waiting for the payer to approve");
    await row.getByRole("button", { name: /Check status/ }).click();
    await expect(page.getByRole("heading", { name: /Payment receipt R\d{6}/ })).toBeVisible();
    await expect(page.getByRole("article")).toContainText(amount(12).shown);
  });

  test("a payment reported for a different amount is held, then reviewed", async ({ page }) => {
    await openStudent(page, "Afia Sarpong");
    const held = await sendPrompt(page, 40, "024 555 3333");
    await expect(held).toContainText(
      `The network reported GH₵39.${run}, not the ${amount(40).shown} requested.`,
      { timeout: 20_000 },
    );

    await page.goto(`${SCHOOL.path}/fees/mobile-money`);
    await page.getByRole("link", { name: /^Needs review/ }).click();
    const table = page.getByRole("table", { name: "Mobile Money requests" });
    await table
      .getByRole("button", { name: `Mark ${amount(40).shown} for Afia Sarpong as reviewed` })
      .click();
    const dialog = page.getByRole("dialog", { name: "Mark as reviewed" });
    await dialog.getByRole("button", { name: "Mark reviewed" }).click();
    await expect(dialog.getByText("Say what you found")).toBeVisible();
    const note = `GH₵39.${run} arrived; recorded by hand`;
    await dialog.getByLabel("What you found").fill(note);
    await dialog.getByRole("button", { name: "Mark reviewed" }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("link", { name: "All", exact: true }).click();
    await expect(
      table
        .getByRole("row", { name: /Afia Sarpong/ })
        .filter({ hasText: note })
        .first(),
    ).toContainText("Reviewed by Akosua Darko");
  });
});
