import { expect, test } from "@playwright/test";
import { ACCOUNTANT_AUTH, mailboxCount, SCHOOL, signIn, waitForMessage } from "./helpers";

// Seeded: GES subjects for every level and this term's marks for Basic 4A (teacher@ is its class teacher).
// Only Kwame Mensah's report card is published here; other specs do not read Basic 4A's marks.
const GRACE = "+233545550122";

test("the class teacher enters marks and sees totals and grades as they type", async ({ page }) => {
  await signIn(page, "teacher@example.test", `${SCHOOL.path}/assessment`);
  await page.goto(`${SCHOOL.path}/assessment`);
  // A teacher sees only the classes they are class teacher of.
  await expect(page.getByRole("link", { name: "Basic 4A" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Basic 4B" })).toHaveCount(0);
  await page.getByRole("link", { name: "Basic 4A" }).click();
  await page.getByRole("link", { name: "Enter English Language scores" }).click();

  const classScore = page.getByLabel("Akua Owusu, Class score (out of 50)");
  const exam = page.getByLabel("Akua Owusu, Exam (out of 100)");
  await classScore.fill("42");
  await exam.fill("75");
  // 42 of 50 for 50% + 75 of 100 for 50% = 79.5, rounded to 80: grade A.
  const row = page.getByRole("row", { name: /Akua Owusu/ });
  await expect(row.getByRole("cell").nth(2)).toHaveText("80");
  await expect(row).toContainText("Advanced");
  await classScore.fill("60");
  await expect(row).toContainText("Check marks");
  await classScore.fill("42");
  await page.getByRole("button", { name: "Save scores" }).click();
  await expect(page.getByRole("status")).toContainText(/marks? saved|No changes/);
  await page.reload();
  await expect(page.getByLabel("Akua Owusu, Class score (out of 50)")).toHaveValue("42");
});

test("the head teacher approves a report card, prints it, and the family reads it on a phone", async ({
  page,
  browser,
}) => {
  await signIn(page, "head@example.test", `${SCHOOL.path}/assessment`);
  await page.goto(`${SCHOOL.path}/assessment`);
  await page.getByRole("link", { name: "Basic 4A" }).click();
  await page.getByRole("link", { name: "Kwame Mensah" }).click();
  await expect(page.getByRole("heading", { name: /Kwame Mensah/ })).toBeVisible();
  // On a re-run against the same database it is already published: withdraw it (with a reason) first.
  if (await page.getByRole("button", { name: "Withdraw" }).isVisible()) {
    await page.getByRole("button", { name: "Withdraw" }).click();
    await page.getByRole("dialog").getByLabel("Reason").fill("Checking the remarks again");
    await page.getByRole("dialog").getByRole("button", { name: "Withdraw" }).click();
    await expect(page.getByRole("button", { name: "Publish this report card" })).toBeVisible();
  }
  await page.getByLabel("Conduct").fill("Respectful");
  await page.getByLabel("Class teacher's remark").fill("Kwame has worked steadily this term.");
  await page.getByLabel("Head teacher's remark").fill("A good term. Keep it up.");
  await page.getByRole("button", { name: "Save report card" }).click();
  await expect(page.getByText("Report card saved.")).toBeVisible();

  await page.getByRole("button", { name: "Publish this report card" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("Published", { exact: true })).toBeVisible();
  await expect(page.getByText("Approved by Comfort Adjei")).toBeVisible();
  await expect(page.getByRole("button", { name: "Withdraw" })).toBeVisible();

  // Print the class: the PDF is prepared in the background and appears under Print runs.
  await page.getByRole("link", { name: "Basic 4A" }).click();
  await page.getByRole("button", { name: "Print report cards" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Prepare PDF" }).click();
  await expect(page).toHaveURL(/\/assessment\/prints$/);
  const download = page.getByRole("link", { name: "Download Basic 4A report cards (PDF)" }).first();
  await expect(download).toBeVisible({ timeout: 20_000 });
  const pdf = await page.request.get((await download.getAttribute("href"))!);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");

  // Grace Mensah, Kwame's guardian, signs in on her phone and reads it.
  const phone = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const parent = await phone.newPage();
  await parent.goto("/p/login");
  const before = mailboxCount(GRACE, /EduBridge code: \d{6}/);
  await parent.getByLabel("Mobile number").fill("054 555 0122");
  await parent.getByRole("button", { name: "Text me a code" }).click();
  const sms = await waitForMessage(GRACE, /EduBridge code: \d{6}/, before);
  await parent.getByLabel("Code").fill(sms.text.match(/\d{6}/)![0]);
  await parent.getByRole("button", { name: "Sign in" }).click();
  await parent.getByRole("link", { name: /Kwame Mensah/ }).click();
  await parent.getByRole("link", { name: /Term 1, 2026\/2027/ }).click();
  await expect(parent.getByRole("heading", { name: "Report card" })).toBeVisible();
  await expect(parent.getByText("A good term. Keep it up.")).toBeVisible();
  const parentPdf = await parent.request.get(
    (await parent.getByRole("link", { name: "Download report card (PDF)" }).getAttribute("href"))!,
  );
  expect((await parentPdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  expect(await parent.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await phone.close();
});

test.describe("finance staff", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("do not see marks or report cards", async ({ page }) => {
    await page.goto(SCHOOL.path);
    await expect(page.getByRole("link", { name: "Assessment" })).toHaveCount(0);
    // Checked inside a streaming boundary, so the status may already be 200; the content must be the 404.
    await page.goto(`${SCHOOL.path}/assessment`);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });
});
