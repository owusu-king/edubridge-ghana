import { expect, test } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

/** The latest weekday on or before today, as YYYY-MM-DD (leave counts working days only). */
function lastWeekday(): string {
  const d = new Date();
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

test("the head teacher keeps a staff record, records leave, and sees it on staff attendance", async ({
  page,
}) => {
  const name = `Efua ${Date.now().toString(36)}`;
  const day = lastWeekday();
  await signIn(page, "head@example.test", `${SCHOOL.path}/staff/settings`);

  // Leave types: the suggested Ghana ones (adding them again changes nothing).
  await page.goto(`${SCHOOL.path}/staff/settings`);
  await page.getByRole("button", { name: "Add suggested types" }).click();
  await expect(page.getByRole("cell", { name: "Sick leave", exact: true })).toBeVisible();

  // A staff member without an EduBridge account (a cook, say).
  await page.getByRole("navigation", { name: "Staff" }).getByRole("link", { name: "People" }).click();
  await page.getByRole("button", { name: "Add staff" }).click();
  const add = page.getByRole("dialog", { name: "Add a staff member" });
  await add.getByLabel("First name").fill(name);
  await add.getByLabel("Surname").fill("Asante");
  await add.getByLabel("Employment").selectOption("casual");
  await add.getByRole("button", { name: "Add staff member" }).click();
  await expect(page.getByRole("heading", { name: `${name} Asante` })).toBeVisible();
  await expect(page.getByText(/^S\d{4}/)).toBeVisible();

  // Sick leave recorded by the head teacher is approved as recorded.
  await page.getByRole("button", { name: "Record leave" }).click();
  const leave = page.getByRole("dialog", { name: "Record leave" });
  await leave.getByLabel("Leave").selectOption({ label: "Sick leave" });
  await leave.getByLabel("First day").fill(day);
  await leave.getByLabel("Last day").fill(day);
  await leave.getByRole("button", { name: "Record leave" }).click();
  await expect(leave).toBeHidden();
  await expect(page.getByRole("table", { name: `Leave of ${name} Asante` })).toContainText("Approved");

  // Staff attendance shows the leave and does not offer marks for that person.
  await page.goto(`${SCHOOL.path}/staff/attendance?date=${day}`);
  const row = page.getByRole("listitem").filter({ hasText: `${name} Asante` });
  await expect(row).toContainText("On leave: Sick leave");
  await expect(row.getByRole("radio")).toHaveCount(0);
});

test("a teacher asks for leave from the Leave page, and cannot open staff records", async ({ page }) => {
  await signIn(page, "teacher@example.test", SCHOOL.path);
  await page.goto(SCHOOL.path);
  const nav = page.getByRole("navigation", { name: "School" });
  await expect(nav.getByRole("link", { name: "Leave" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Staff" })).toHaveCount(0);
  await page.goto(`${SCHOOL.path}/staff`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.goto(`${SCHOOL.path}/leave`);
  await expect(page.getByRole("heading", { name: "Leave", exact: true })).toBeVisible();
  // The seeded teacher has no staff record, so the page says what to do.
  await expect(page.getByText(/no staff record/)).toBeVisible();
});
