import { readFileSync } from "node:fs";
import { expect, test, type Browser } from "@playwright/test";
import { ACCOUNTANT_AUTH, PLATFORM_AUTH, SCHOOL, signIn } from "./helpers";

// Runs in order: the plan change on Adenta Hall is undone at the end of the same test.
test.describe.configure({ mode: "serial" });

const asPlatform = async (browser: Browser) =>
  (await browser.newContext({ storageState: PLATFORM_AUTH })).newPage();

test("EduBridge staff issue an invoice, record its payment, and the school sees it", async ({
  browser,
  page,
}) => {
  const admin = await asPlatform(browser);
  await admin.goto("/admin");
  await admin.getByRole("link", { name: SCHOOL.name }).click();
  await expect(admin.getByRole("heading", { name: "Subscription" })).toBeVisible();

  await admin.getByRole("button", { name: "Issue invoice" }).click();
  const dialog = admin.getByRole("dialog", { name: "Issue an invoice" });
  // A line of its own, whatever was suggested: the last row is always blank.
  const last = await dialog.getByLabel(/^Line \d+: description$/).count();
  await dialog.getByLabel(`Line ${last}: description`).fill("Setup and training");
  await dialog.getByLabel(`Line ${last}: quantity`).fill("1");
  await dialog.getByLabel(`Line ${last}: unit price`).fill("250");
  // Suggested lines without a price (SMS) are cleared so the invoice is just this line.
  for (let i = 1; i < last; i++) {
    await dialog.getByLabel(`Line ${i}: description`).fill("");
    await dialog.getByLabel(`Line ${i}: quantity`).fill("");
    await dialog.getByLabel(`Line ${i}: unit price`).fill("");
  }
  await dialog.getByRole("button", { name: "Issue invoice" }).click();
  await expect(dialog).toBeHidden();

  const invoices = admin.getByRole("table", { name: `Invoices to ${SCHOOL.name}` });
  const newest = invoices.getByRole("row").nth(1);
  await expect(newest).toContainText("GH₵250.00");
  await expect(newest).toContainText("Due");
  const number = (await newest.locator(".font-mono").innerText()).trim();
  await newest.getByRole("button", { name: `Record payment of ${number}` }).click();
  const paid = admin.getByRole("dialog", { name: `Record payment of ${number}` });
  await paid.getByLabel("Reference").fill("GCB-E2E");
  await paid.getByRole("button", { name: "Record payment" }).click();
  await expect(paid).toBeHidden();
  await expect(invoices.getByRole("row").filter({ hasText: number })).toContainText("Paid");

  // The school's administrator sees the invoice under Settings, Plan.
  await signIn(page, "admin@example.test", `${SCHOOL.path}/settings/plan`);
  await page.goto(`${SCHOOL.path}/settings/plan`);
  await expect(page.getByRole("heading", { name: "What your plan includes" })).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Invoices from EduBridge" }).getByRole("row").filter({ hasText: number }),
  ).toContainText("Paid");
});

test("a module left out of a school's plan disappears for its staff, and comes back", async ({
  browser,
  page,
}) => {
  const admin = await asPlatform(browser);
  const openAdenta = async () => {
    await admin.goto("/admin");
    await admin.getByRole("link", { name: "Adenta Hall Academy" }).click();
    await expect(admin.getByRole("heading", { name: "Plan", exact: true })).toBeVisible();
  };
  const setAttendance = async (on: boolean) => {
    await openAdenta();
    const box = admin.getByRole("checkbox", { name: /^Attendance/ });
    if (on) await box.check();
    else await box.uncheck();
    await admin.getByRole("button", { name: "Save plan" }).click();
    await expect(admin.getByText("Plan updated.")).toBeVisible();
  };

  await setAttendance(false);
  try {
    await signIn(page, "owner@example.test", "/s/adenta-hall");
    await page.goto("/s/adenta-hall");
    const nav = page.getByRole("navigation", { name: "School" });
    await expect(nav.getByRole("link", { name: "Assessment" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Attendance" })).toHaveCount(0);
    await page.goto("/s/adenta-hall/attendance");
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await page.goto("/s/adenta-hall/settings/plan");
    await expect(page.getByText("Attendance: not included")).toBeAttached();
  } finally {
    await setAttendance(true);
  }
  await page.goto("/s/adenta-hall");
  await expect(
    page.getByRole("navigation", { name: "School" }).getByRole("link", { name: "Attendance" }),
  ).toBeVisible();
});

test("the proprietor downloads the school's records as CSV", async ({ page }) => {
  await signIn(page, "owner@example.test", "/s/adenta-hall/settings/export");
  await page.goto("/s/adenta-hall/settings/export");
  await expect(page.getByRole("heading", { name: "Data export" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download Students as CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^adenta-hall-students-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = readFileSync((await file.path())!, "utf8");
  expect(text.replace(/^﻿/, "").split("\r\n")[0]).toBe(
    "Admission number,First name,Other names,Surname,Sex,Date of birth,Admitted on,Status,Class this term,Campus",
  );
});

test.describe("the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("exports fee records only", async ({ page }) => {
    await page.goto(`${SCHOOL.path}/settings/export`);
    await expect(page.getByRole("link", { name: "Download Balances as CSV" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download Students as CSV" })).toHaveCount(0);
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download Balances as CSV" }).click();
    const text = readFileSync((await (await download).path())!, "utf8");
    expect(text).toContain("Admission number,Student,Status,Class this term,Balance (GHS)");
  });
});
