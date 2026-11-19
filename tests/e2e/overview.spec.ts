import { expect, test } from "@playwright/test";
import { ACCOUNTANT_AUTH, SCHOOL, signIn } from "./helpers";

// Read-only: other specs record payments and registers in the seeded school at the same time, so these
// check what is shown and where it leads, not exact amounts (integration tests check the figures).

test("the head teacher's Command Center shows fees, arrears, attendance, students and operations, each linked to its report", async ({
  page,
}) => {
  await signIn(page, "head@example.test", SCHOOL.path);
  await page.goto(SCHOOL.path);
  await expect(page).toHaveTitle(/Command Center/);
  for (const name of ["Fees", "Owed today", "Attendance", "Students", "Operations now"])
    await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
  for (const name of ["People", "School details"])
    await expect(page.getByRole("heading", { level: 2, name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Students in classes by level" })).toBeVisible();

  // The button downloads the board summary of the term, as a PDF.
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Board summary" }).click();
  expect((await download).suggestedFilename()).toMatch(/board-summary-Term-1.*\.pdf$/);
  await expect(page.getByRole("heading", { level: 3, name: "Collected each week" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Owed today by how long it has been owed" })).toBeVisible();

  // "Collected" opens the payments report for the same days.
  await page.locator('p:text-is("Collected") + a').click();
  await expect(page).toHaveURL(/\/fees\/payments\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
  await expect(page.getByRole("form", { name: "Choose period" })).toBeVisible();
});

test("the setup guide shows what is left, and who can do each step", async ({ page }) => {
  await signIn(page, "head@example.test", SCHOOL.path);
  await page.goto(SCHOOL.path);
  await page.getByRole("link", { name: "Continue setup" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Setup guide" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Set up the academic calendar \(done\)/ })).toBeVisible();
  // The head teacher cannot invite staff or set fees: the guide says who does.
  await expect(page.getByText("The Proprietor or Administrator does this.")).toBeVisible();
  await expect(page.getByText("The Proprietor or Accountant does this.")).toBeVisible();
});

test("a new school is guided from its first step", async ({ page }) => {
  await signIn(page, "owner@example.test", "/s/adenta-hall");
  await page.goto("/s/adenta-hall");
  await expect(page.getByRole("heading", { name: /^Finish setting up: \d of 7 steps done$/ })).toBeVisible();
  await page.getByRole("link", { name: "Continue setup" }).click();
  const calendar = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: /academic calendar/ }) });
  await expect(calendar).toHaveAttribute("aria-current", "step");
  await calendar.getByRole("link", { name: "Open the calendar" }).click();
  await expect(page).toHaveURL("/s/adenta-hall/settings/calendar");
});

test("a class teacher's Command Center is their classes today", async ({ page }) => {
  await signIn(page, "teacher@example.test", SCHOOL.path);
  await page.goto(SCHOOL.path);
  const classes = page.getByRole("table", { name: "Your classes today" });
  await expect(classes).toBeVisible();
  const row = classes.getByRole("row").filter({ hasText: "Basic 4A" });
  await expect(row.getByRole("link", { name: /Take the register|marked|Taken/ })).toHaveAttribute(
    "href",
    new RegExp(`${SCHOOL.path}/attendance/[0-9a-f-]{36}\\?date=`),
  );
  // No school-wide figures for teachers.
  await expect(page.getByRole("heading", { level: 2, name: "Fees", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Continue setup" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Board summary" })).toHaveCount(0);
  const denied = await page.request.get(`${SCHOOL.path}/board-summary`);
  expect(denied.status()).toBe(404);
});

test.describe("the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("sees the money, not attendance or setup, and can print the board summary", async ({ page }) => {
    await page.goto(SCHOOL.path);
    await expect(page.getByRole("heading", { level: 2, name: "Fees", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Owed today" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Attendance", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Continue setup" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Board summary" })).toBeVisible();
  });
});
