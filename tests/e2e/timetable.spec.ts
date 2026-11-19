import { expect, test, type Page } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

/**
 * Timetables and lesson registers (R2 completion). Uses JHS 1, which no other spec changes, so the lesson
 * it plans cannot disturb parallel specs. Kpone Ridge is in Accra (UTC), so today's weekday is UTC's.
 */
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const today = WEEKDAYS[new Date().getUTCDay()]!;
const weekend = today === "Saturday" || today === "Sunday";

test.describe.configure({ mode: "serial" });

/** Taps a status button (the visible label of a visually hidden radio), as a teacher would. */
const mark = async (page: Page, name: string, status: string) => {
  await page
    .getByRole("radiogroup", { name: `${name} attendance` })
    .getByText(status, { exact: true })
    .click();
  await expect(page.getByRole("radio", { name: `${name}: ${status}` })).toBeChecked();
};

test("the head teacher sets up the school day and plans a JHS 1 lesson", async ({ page }) => {
  await signIn(page, "head@example.test", `${SCHOOL.path}/timetable`);
  await page.goto(`${SCHOOL.path}/timetable`);
  await expect(page.getByRole("heading", { level: 1, name: "Timetable" })).toBeVisible();

  const day = page.getByRole("table", { name: "The school day" });
  if ((await day.getByRole("row").filter({ hasText: "Period 1" }).count()) === 0) {
    await page.getByRole("button", { name: "Add period" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a period" });
    await dialog.getByLabel("Name").fill("Period 1");
    await dialog.getByLabel("Starts").fill("07:00");
    await dialog.getByLabel("Ends").fill("07:40");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
  }
  await expect(day.getByRole("row").filter({ hasText: "Period 1" })).toContainText("07:00–07:40");

  // Overlapping periods are refused with the reason.
  await page.getByRole("button", { name: "Add period" }).click();
  const overlap = page.getByRole("dialog", { name: "Add a period" });
  await overlap.getByLabel("Name").fill("Assembly");
  await overlap.getByLabel("Starts").fill("07:20");
  await overlap.getByLabel("Ends").fill("07:30");
  await overlap.getByRole("button", { name: "Save" }).click();
  await expect(overlap.getByText(/This overlaps Period 1/)).toBeVisible();
  await overlap.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("link", { name: "JHS 1", exact: true }).click();
  await expect(page.getByRole("heading", { name: "JHS 1 timetable" })).toBeVisible();
  const slotDay = weekend ? "Monday" : today;
  await page.getByRole("button", { name: new RegExp(`^${slotDay}, Period 1: `) }).click();
  const dialog = page.getByRole("dialog", { name: `${slotDay}, Period 1` });
  await dialog.getByLabel("Subject").selectOption({ label: "Mathematics" });
  await dialog.getByLabel("Teacher").selectOption({ label: "Yaw Boateng" });
  await dialog.getByRole("button", { name: "Save lesson" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: `${slotDay}, Period 1: Mathematics, change` })).toBeVisible();

  // Lesson registers are a school's choice (Settings, Attendance).
  await page.goto(`${SCHOOL.path}/settings/attendance`);
  const choice = page.locator("form").filter({ has: page.getByRole("group", { name: "Lesson registers" }) });
  await choice.getByRole("radio", { name: /Also a register in every timetabled lesson/ }).check();
  await choice.getByRole("button", { name: "Save" }).click();
  // Confirmed by a short message at the bottom of the page.
  await expect(page.getByRole("status").getByText("Saved.")).toBeVisible();
});

test("the teacher sees the lesson and takes its register", async ({ page }) => {
  test.skip(weekend, "No lessons at weekends.");
  await signIn(page, "teacher@example.test", SCHOOL.path);
  await page.goto(SCHOOL.path);
  const lessons = page.getByRole("table", { name: "Your lessons today" });
  await expect(lessons.getByRole("row").filter({ hasText: "JHS 1" })).toContainText("Mathematics");

  await page.goto(`${SCHOOL.path}/attendance`);
  await page.getByRole("link", { name: "Mathematics, JHS 1" }).click();
  await expect(page.getByRole("heading", { name: "Mathematics, JHS 1" })).toBeVisible();
  await mark(page, "Fiifi Annan", "Present");
  await mark(page, "Efua Ofori", "Absent");
  const save = page.getByRole("button", { name: "Save register" });
  if (await save.isEnabled()) {
    await save.click();
    await expect(page.getByText(/Register saved\.|No changes to save\./)).toBeVisible();
  }
  await page.reload();
  await expect(page.getByRole("radio", { name: "Fiifi Annan: Present" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Efua Ofori: Absent" })).toBeChecked();
  await expect(page.getByRole("heading", { name: "Mathematics this term" })).toBeVisible();

  await page.goto(`${SCHOOL.path}/timetable`);
  await expect(page.getByRole("table", { name: /Yaw Boateng's lessons/ }).getByText("JHS 1")).toBeVisible();
});
