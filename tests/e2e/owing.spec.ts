import { expect, test } from "@playwright/test";
import { ACCOUNTANT_AUTH, linkPath, SCHOOL, signIn, waitForMessage } from "./helpers";

// Kojo Addo (Basic 4B) owes fees; his seeded guardian Adjoa Addo has the number +233 27 555 0133.
// Kwame Mensah's seeded payment is receipt R000002; his guardian Grace Mensah has +233 54 555 0122.

test("the head teacher sees who owes and downloads statements, but cannot send reminders", async ({
  page,
}) => {
  await signIn(page, "head@example.test");
  await page.goto(`${SCHOOL.path}/fees/owing`);
  await expect(page.getByText("Students owing")).toBeVisible();
  const table = page.getByRole("table", { name: "Students who owe fees" });
  const kojo = table.getByRole("row", { name: /Kojo Addo/ });
  await expect(kojo).toContainText("Adjoa Addo");
  await expect(page.getByRole("button", { name: /Send SMS reminder/ })).toHaveCount(0);
  await expect(kojo.getByRole("link", { name: /on WhatsApp/ })).toHaveCount(0);

  const statement = await page.request.get(
    (await kojo.getByRole("link", { name: "Download Kojo Addo's statement" }).getAttribute("href"))!,
  );
  expect(statement.status()).toBe(200);
  expect(statement.headers()["content-type"]).toBe("application/pdf");
  expect((await statement.body()).subarray(0, 5).toString()).toBe("%PDF-");
});

test.describe("as the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("filters the list and sends an SMS reminder, at most once a day", async ({ page }) => {
    await page.goto(`${SCHOOL.path}/fees/owing`);
    await page.getByLabel("Class").selectOption({ label: "Basic 4B" });
    await page.getByRole("button", { name: "Filter" }).click();
    const table = page.getByRole("table", { name: "Students who owe fees" });
    const kojo = table.getByRole("row", { name: /Kojo Addo/ });
    await expect(kojo).toBeVisible();
    await expect(table.getByRole("row", { name: /Akua Owusu/ })).toHaveCount(0);
    await expect(kojo.getByRole("link", { name: /on WhatsApp/ })).toHaveAttribute(
      "href",
      /^https:\/\/wa\.me\/233275550133\?text=Hello%2C%20this%20is%20Kpone%20Ridge/,
    );

    // Earlier runs on the same database may have reminded Kojo today already.
    const remindedToday = (await kojo.innerText()).includes("Today");
    await kojo.getByRole("checkbox", { name: "Select Kojo Addo" }).check();
    await page.getByRole("button", { name: "Send SMS reminder (1)" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(/Kojo's school fees balance is GHS [\d,]+\.\d\d\./);
    if (remindedToday) {
      await expect(dialog.getByRole("button", { name: "Send reminder" })).toBeDisabled();
    } else {
      await dialog.getByRole("button", { name: "Send reminder" }).click();
      await expect(page.getByText("Sent 1 reminder.")).toBeVisible();
      await expect(kojo).toContainText("Today");
    }
    const sms = await waitForMessage("+233275550133", /Kojo's school fees balance is GHS /);
    expect(sms.text).not.toContain("₵");
    expect(sms.text.length).toBeLessThanOrEqual(160);

    // The private balance link in the SMS works without signing in.
    await page.context().clearCookies();
    await page.goto(linkPath(sms.text));
    await expect(page.getByRole("heading", { name: "Kojo's school fees" })).toBeVisible();
    await expect(page.getByText("Owed")).toBeVisible();
    await page.goto("/b/AAAAAAAAAAAAAAAAAAAAAA");
    await expect(page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
  });

  test("downloads a receipt as PDF and shares it on WhatsApp", async ({ page }) => {
    await page.goto(`${SCHOOL.path}/fees/payments?date=2026-09-10`);
    await page.getByRole("link", { name: "R000002" }).click();
    await expect(page.getByRole("heading", { name: /Payment receipt R000002/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Share on WhatsApp" })).toHaveAttribute(
      "href",
      /^https:\/\/wa\.me\/233545550122\?text=Kpone%20Ridge%20International%20School%3A%20receipt%20R000002/,
    );
    const pdf = await page.request.get(
      (await page.getByRole("link", { name: "Download PDF" }).getAttribute("href"))!,
    );
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-disposition"]).toContain("receipt-R000002.pdf");
  });

  test("the student's page offers a statement and reminders", async ({ page }) => {
    await page.goto(`${SCHOOL.path}/students?q=Kojo%20Addo`);
    await page.getByRole("link", { name: "Kojo Addo" }).click();
    await expect(page.getByRole("link", { name: "Download statement" })).toBeVisible();
    await expect(page.getByRole("link", { name: "WhatsApp reminder" })).toHaveAttribute(
      "href",
      /^https:\/\/wa\.me\/233275550133/,
    );
    await expect(
      page.getByRole("button", { name: "Send SMS reminder" }).or(page.getByText("SMS reminder sent today")),
    ).toBeVisible();
  });
});
