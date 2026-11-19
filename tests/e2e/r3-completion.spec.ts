import { randomInt } from "node:crypto";
import { expect, test, type Browser } from "@playwright/test";
import { PLATFORM_AUTH, SCHOOL, signIn } from "./helpers";

/**
 * Finishing R3: a scheduled announcement (NOT-06) and an EduBridge invoice paid online in test mode (SUB-04).
 */
test.describe.configure({ mode: "serial" });

const asPlatform = async (browser: Browser) =>
  (await browser.newContext({ storageState: PLATFORM_AUTH })).newPage();
const tag = String(randomInt(1000, 9999));

test("the head teacher schedules an announcement and cancels it", async ({ page }) => {
  await signIn(page, "head@example.test", `${SCHOOL.path}/announcements`);
  await page.goto(`${SCHOOL.path}/announcements`);
  await page.getByRole("button", { name: "New announcement" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New announcement" });
  await dialog.getByLabel("Title", { exact: true }).fill(`Open day ${tag}`);
  await dialog.getByLabel("Message", { exact: true }).fill("Families are welcome from 9:00.");
  await dialog.getByRole("radio", { name: "Schedule it" }).check();
  const when = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  await dialog.getByLabel("Post on").fill(`${when}T08:00`);
  await dialog.getByRole("button", { name: "Post announcement" }).click();
  await expect(dialog).toBeHidden();
  const scheduled = page.getByRole("list", { name: "Scheduled announcements" });
  const item = scheduled.getByRole("listitem").filter({ hasText: `Open day ${tag}` });
  await expect(item).toBeVisible();
  await item.getByRole("button", { name: `Cancel the scheduled announcement Open day ${tag}` }).click();
  await expect(page.getByRole("listitem").filter({ hasText: `Open day ${tag}` })).toHaveCount(0);
});

test("a Proprietor pays an EduBridge invoice online", async ({ browser, page }) => {
  const admin = await asPlatform(browser);
  await admin.goto("/admin");
  await admin.getByRole("link", { name: "Adenta Hall" }).first().click();
  await admin.getByRole("button", { name: "Issue invoice" }).click();
  const dialog = admin.getByRole("dialog", { name: "Issue an invoice" });
  const last = await dialog.getByLabel(/^Line \d+: description$/).count();
  await dialog.getByLabel(`Line ${last}: description`).fill(`Training ${tag}`);
  await dialog.getByLabel(`Line ${last}: quantity`).fill("1");
  await dialog.getByLabel(`Line ${last}: unit price`).fill("120");
  for (let i = 1; i < last; i++) {
    await dialog.getByLabel(`Line ${i}: description`).fill("");
    await dialog.getByLabel(`Line ${i}: quantity`).fill("");
    await dialog.getByLabel(`Line ${i}: unit price`).fill("");
  }
  await dialog.getByRole("button", { name: "Issue invoice" }).click();
  await expect(dialog).toBeHidden();
  const newest = admin
    .getByRole("table", { name: /Invoices to Adenta Hall/ })
    .getByRole("row")
    .nth(1);
  const number = (await newest.locator(".font-mono").innerText()).trim();

  await signIn(page, "owner@example.test", "/s/adenta-hall/settings/plan");
  await page.goto("/s/adenta-hall/settings/plan");
  await page.getByRole("button", { name: `Pay ${number} online` }).click();
  await expect(page).toHaveURL(/\/settings\/plan\/paid\?reference=EBI\./);
  await expect(page.getByText(`Invoice ${number} is paid`)).toBeVisible();
  await page.getByRole("link", { name: "Back to your plan" }).click();
  await expect(
    page.getByRole("table", { name: "Invoices from EduBridge" }).getByRole("row").filter({ hasText: number }),
  ).toContainText("Paid");
});
