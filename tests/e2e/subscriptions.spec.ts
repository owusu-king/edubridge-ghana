import { randomInt } from "node:crypto";
import { expect, test, type Browser } from "@playwright/test";
import { PLATFORM_AUTH, signIn } from "./helpers";

/**
 * Subscription self-service (R3-6): EduBridge staff add a plan, a Proprietor asks to move to it, and staff
 * decline with a note (declining leaves the seeded school's plan as it is for the other specs).
 */
test.describe.configure({ mode: "serial" });

const asPlatform = async (browser: Browser) =>
  (await browser.newContext({ storageState: PLATFORM_AUTH })).newPage();
const planName = `Growth ${randomInt(1000, 9999)}`;

test("a Proprietor asks for another plan and EduBridge staff decide it", async ({ browser, page }) => {
  const admin = await asPlatform(browser);
  await admin.goto("/admin/plans");
  await expect(admin.getByRole("heading", { level: 1, name: "Plans" })).toBeVisible();
  await admin.getByRole("button", { name: "New plan" }).first().click();
  const add = admin.getByRole("dialog", { name: "New plan" });
  await add.getByLabel("Plan name").fill(planName);
  await add.getByLabel("Description (optional)").fill("For schools with two campuses");
  await add.getByLabel("Campus limit").fill("2");
  await add.getByLabel("Student limit").fill("600");
  await add.getByLabel("Usual price (optional)").fill("2500");
  await add.getByRole("button", { name: "Add plan" }).click();
  await expect(add).toBeHidden();
  await expect(admin.getByRole("row").filter({ hasText: planName })).toContainText("GH₵2,500.00");

  await signIn(page, "owner@example.test", "/s/adenta-hall/settings/plan");
  await page.goto("/s/adenta-hall/settings/plan");
  await expect(page.getByRole("heading", { name: "Change your plan" })).toBeVisible();
  await page.getByRole("radio", { name: new RegExp(planName) }).check();
  await page
    .getByLabel("Anything EduBridge should know (optional)")
    .fill("We open a second campus in January.");
  await page.getByRole("button", { name: "Ask EduBridge" }).click();
  // The form gives way to the request, waiting for EduBridge.
  await expect(page.getByText(`Move to ${planName}`)).toBeVisible();
  await expect(page.getByText("Waiting for EduBridge")).toBeVisible();

  await admin.reload();
  const requests = admin.getByRole("list", { name: "Requests waiting" });
  const request = requests.getByRole("listitem").filter({ hasText: planName });
  await expect(request).toContainText("We open a second campus in January.");
  await request.getByRole("button", { name: /^Decline/ }).click();
  const decline = admin.getByRole("dialog", { name: /^Decline the request/ });
  await decline.getByLabel("Why").fill("Let us talk first about the second campus.");
  await decline.getByRole("button", { name: "Decline" }).click();
  await expect(decline).toBeHidden();
  await expect(admin.getByText("No requests waiting.")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("list", { name: "Earlier requests" })).toContainText("Declined on");
  await expect(page.getByRole("list", { name: "Earlier requests" })).toContainText(
    "Let us talk first about the second campus.",
  );
});

test("an invoice is emailed and downloaded as PDF by staff and the school", async ({ browser, page }) => {
  const admin = await asPlatform(browser);
  await admin.goto("/admin");
  await admin.getByRole("link", { name: "Adenta Hall" }).first().click();
  await admin.getByRole("button", { name: "Issue invoice" }).click();
  const dialog = admin.getByRole("dialog", { name: "Issue an invoice" });
  const last = await dialog.getByLabel(/^Line \d+: description$/).count();
  await dialog.getByLabel(`Line ${last}: description`).fill("Training day");
  await dialog.getByLabel(`Line ${last}: quantity`).fill("1");
  await dialog.getByLabel(`Line ${last}: unit price`).fill("300");
  for (let i = 1; i < last; i++) {
    await dialog.getByLabel(`Line ${i}: description`).fill("");
    await dialog.getByLabel(`Line ${i}: quantity`).fill("");
    await dialog.getByLabel(`Line ${i}: unit price`).fill("");
  }
  await dialog.getByRole("button", { name: "Issue invoice" }).click();
  await expect(dialog).toBeHidden();
  const pdf = async (p: typeof page, href: string | null) => {
    const response = await p.request.get(href!);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/pdf");
    expect((await response.body()).subarray(0, 5).toString()).toBe("%PDF-");
  };
  await pdf(
    admin,
    await admin
      .getByRole("link", { name: /as PDF$/ })
      .first()
      .getAttribute("href"),
  );

  await signIn(page, "owner@example.test", "/s/adenta-hall/settings/plan");
  await page.goto("/s/adenta-hall/settings/plan");
  await pdf(
    page,
    await page
      .getByRole("link", { name: /as PDF$/ })
      .first()
      .getAttribute("href"),
  );
});
