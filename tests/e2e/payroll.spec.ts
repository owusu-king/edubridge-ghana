import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

const SCHOOL = "/s/adenta-hall";

test("the Proprietor sets a salary, prepares and approves the month, and downloads a payslip", async ({
  page,
}) => {
  const name = `Yaa ${Date.now().toString(36)}`;
  await signIn(page, "owner@example.test", `${SCHOOL}/payroll`);

  // Earlier runs on the same database may have approved this month already: then salaries start later.
  await page.goto(`${SCHOOL}/payroll`);
  const thisMonth = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date());
  const approvedRow = page.getByRole("row").filter({ hasText: thisMonth }).filter({ hasText: "Approved" });
  test.skip((await approvedRow.count()) > 0, "This month is already approved on this database.");

  // A staff member to pay.
  await page.goto(`${SCHOOL}/staff`);
  await page.getByRole("button", { name: "Add staff" }).click();
  const add = page.getByRole("dialog", { name: "Add a staff member" });
  await add.getByLabel("First name").fill(name);
  await add.getByLabel("Surname").fill("Owusu");
  await add.getByRole("button", { name: "Add staff member" }).click();
  await expect(page.getByRole("heading", { name: `${name} Owusu` })).toBeVisible();

  // Components without rates; the salary sets this person's SSNIT percentage.
  await page.goto(`${SCHOOL}/payroll/components`);
  await page.getByRole("button", { name: "Add suggested names" }).click();
  await expect(page.getByRole("cell", { name: "SSNIT (employee)", exact: true })).toBeVisible();
  await page.goto(`${SCHOOL}/payroll/people`);
  await page.getByRole("link", { name: `${name} Owusu` }).click();
  await page.getByRole("button", { name: "Set salary" }).click();
  const salary = page.getByRole("dialog", { name: "Salary from a month" });
  await salary.getByLabel(/Basic salary a month/).fill("1500");
  await salary.getByLabel("SSNIT (employee) (%)").fill("5.5");
  await salary.getByRole("button", { name: "Save salary" }).click();
  await expect(salary).toBeHidden();
  await expect(page.getByText("SSNIT (employee) 5.5%")).toBeVisible();

  // Prepare the month, then approve it: 1,500.00 less 5.5% is 1,417.50.
  await page.goto(`${SCHOOL}/payroll`);
  await page.getByRole("button", { name: "Prepare payroll" }).click();
  await expect(page.getByRole("heading", { name: thisMonth })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: `${name} Owusu` });
  await expect(row).toContainText("1,417.50");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Recalculate" })).toHaveCount(0);

  // The payslip is a PDF.
  const href = await row.getByRole("link", { name: `Payslip for ${name} Owusu` }).getAttribute("href");
  const pdf = await page.request.get(href!);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
});

test("a teacher has Payslips, not Payroll, and cannot open the school's payroll", async ({ page }) => {
  await signIn(page, "teacher@example.test", SCHOOL);
  await page.goto(SCHOOL);
  const nav = page.getByRole("navigation", { name: "School" });
  await expect(nav.getByRole("link", { name: "Payslips" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Payroll" })).toHaveCount(0);
  await page.goto(`${SCHOOL}/payroll/people`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.goto(`${SCHOOL}/payroll`);
  await expect(page.getByRole("heading", { name: "Payslips", exact: true })).toBeVisible();
  await expect(page.getByText(/no staff record/)).toBeVisible();
});
