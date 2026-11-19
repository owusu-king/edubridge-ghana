import { expect, test } from "@playwright/test";
import { ACCOUNTANT_AUTH, mailboxCount, SCHOOL, signIn, waitForMessage } from "./helpers";

/**
 * The R1 completion features, end to end in a production build: finance controls and reports, statements
 * for a period, payment evidence, the daily reconciliation screen, school identity, starter templates,
 * teaching by class or by subject, and the parent view's message choice and offline copy.
 */

// Kofi Agyeman (+233 20 555 0111) is the seeded father of Nana Agyeman (KG 1); no other spec signs him in.
const KOFI = "+233205550111";

test.describe("the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("reads reports by campus, and the daily reconciliation", async ({ page }) => {
    await page.goto(`${SCHOOL.path}/fees/reports`);
    await expect(page.getByRole("heading", { name: /Owed today by class/ })).toBeVisible();
    // The label holds its options too, so the select is found by its field name.
    const campus = page.locator('select[name="campus"]');
    await expect(campus).toBeVisible();
    await campus.selectOption({ label: "Sakumono" });
    await page.getByRole("button", { name: "Show" }).click();
    await expect(page).toHaveURL(/campus=/);
    await expect(page.locator('select[name="campus"]')).toHaveValue(/[0-9a-f-]{36}/);
    // The CSV starts with exactly one byte-order mark (two left a stray character in Excel's first cell).
    const csv = Buffer.from(
      await (await page.request.get(`${SCHOOL.path}/fees/reports/export?by=class`)).body(),
    );
    expect(csv.subarray(0, 3).toString("hex")).toBe("efbbbf");
    expect(csv.subarray(3, 6).toString("hex")).not.toBe("efbbbf");

    await page.goto(`${SCHOOL.path}/fees/mobile-money`);
    await page.getByRole("link", { name: "Daily reconciliation" }).click();
    await expect(page.getByRole("heading", { name: "Daily checks" })).toBeVisible();
    await expect(page.getByText(/previous day.s Mobile Money prompts are checked again/)).toBeVisible();
  });

  test("downloads a statement for a period and sees where payment evidence goes", async ({ page }) => {
    await page.goto(`${SCHOOL.path}/students`);
    await page.getByRole("link", { name: "Kwame Mensah" }).click();
    await page.getByText("Statement for a period").click();
    await expect(page.getByLabel("From")).toBeVisible();
    const statement = page.locator('form[method="get"]').filter({ has: page.getByLabel("From") });
    const href = await statement.getAttribute("action");
    const pdf = await page.request.get(`${href}?from=2026-09-01&to=2026-09-30`);
    expect(pdf.status()).toBe(200);
    expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await page.request.get(`${href}?from=2026-10-01&to=2026-09-01`)).status()).toBe(400);

    await page.goto(`${SCHOOL.path}/fees/payments?date=2026-09-10`);
    await page.getByRole("link", { name: "R000002" }).click();
    await expect(page.getByRole("heading", { name: "Evidence" })).toBeVisible();
    await expect(page.getByLabel(/Attach evidence/)).toBeVisible();
  });
});

test("the Proprietor sets the school's identity, starting template and teaching model", async ({ page }) => {
  await signIn(page, "owner@example.test", "/s/adenta-hall/settings");
  await page.goto("/s/adenta-hall/settings");
  await expect(page.getByRole("heading", { name: "School identity" })).toBeVisible();
  await expect(page.getByLabel("Hex code")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Admission numbers" })).toBeVisible();

  await page.goto("/s/adenta-hall/classes/teaching");
  await expect(page.getByRole("heading", { name: "Teaching", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: /^Class teachers/ })).toBeChecked();
  await page.getByRole("radio", { name: /^Subject teachers/ }).check();
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("radio", { name: /^Subject teachers/ })).toBeChecked();
  // Back to the default, so other runs start from class teachers.
  await page.getByRole("radio", { name: /^Class teachers/ }).check();
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Saved.")).toBeVisible();
});

test("the head teacher sees the starting template behind subjects and grades", async ({ page }) => {
  await signIn(page, "head@example.test", `${SCHOOL.path}/assessment/setup`);
  await page.goto(`${SCHOOL.path}/assessment/setup`);
  await expect(page.getByRole("heading", { name: "Starting point" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Ghana \(GES basic school\)/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /Kenya \(Competency-Based Education\)/ })).toBeVisible();
});

test.describe("a parent on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("chooses announcement SMS, keeps an offline copy, and leaves nothing behind on sign-out", async ({
    page,
    context,
  }) => {
    await page.goto("/p/login");
    const before = mailboxCount(KOFI, /EduBridge code: \d{6}/);
    await page.getByLabel("Mobile number").fill("020 555 0111");
    await page.getByRole("button", { name: "Text me a code" }).click();
    const sms = await waitForMessage(KOFI, /EduBridge code: \d{6}/, before);
    await page.getByLabel("Code").fill(sms.text.match(/\d{6}/)![0]);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Your children" })).toBeVisible();

    // Announcements by SMS: off, then back on. Receipts and fee notices always come.
    await page.goto("/p/kpone-ridge/news");
    await expect(page.getByRole("heading", { name: "Announcements by SMS" })).toBeVisible();
    await page.getByRole("button", { name: "Stop announcement SMS" }).click();
    await expect(page.getByRole("button", { name: "Get announcements by SMS" })).toBeVisible();
    await page.getByRole("button", { name: "Get announcements by SMS" }).click();
    await expect(page.getByRole("button", { name: "Stop announcement SMS" })).toBeVisible();

    // The child's page, opened once online, opens again offline with the time it is from.
    await page.goto("/p");
    await page.getByRole("link", { name: /Nana Agyeman/ }).click();
    await expect(page.getByRole("heading", { name: "Nana Agyeman" })).toBeVisible();
    const childUrl = page.url();
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.reload(); // now controlled by the service worker, which keeps a copy
    await expect(page.getByRole("heading", { name: "Nana Agyeman" })).toBeVisible();
    await context.setOffline(true);
    await page.goto(childUrl);
    await expect(page.getByRole("heading", { name: "Nana Agyeman" })).toBeVisible();
    await expect(page.getByText("You are offline.")).toBeVisible();
    await context.setOffline(false);

    // Signing out deletes the family's saved copies.
    await page.goto("/p");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/p\/login/);
    await expect
      .poll(() => page.evaluate(async () => (await caches.keys()).includes("edubridge-parent-v1")))
      .toBe(false);
  });
});
