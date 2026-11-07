import { expect, test, type Page } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

// Seeded: teacher@ is class teacher of Basic 4A; past registers exist, today's is left for these tests.
// They run in order: the second builds on the register the first saves.
test.describe.configure({ mode: "serial" });

/** Taps a status button (the visible label of a visually hidden radio), as a teacher would. */
const mark = async (page: Page, name: string, status: string) => {
  await page
    .getByRole("radiogroup", { name: `${name} attendance` })
    .getByText(status, { exact: true })
    .click();
  await expect(page.getByRole("radio", { name: `${name}: ${status}` })).toBeChecked();
};

async function openTodaysRegister(page: Page) {
  await page.goto(`${SCHOOL.path}/attendance`);
  await page.getByRole("link", { name: "Basic 4A" }).click();
  await expect(page.getByRole("heading", { name: "Basic 4A" })).toBeVisible();
}

test("a teacher takes the register, loses the connection, keeps working, and it syncs when back", async ({
  page,
  context,
}) => {
  await signIn(page, "teacher@example.test", `${SCHOOL.path}/attendance`);
  await page.goto(`${SCHOOL.path}/attendance`);
  await expect(page.getByRole("link", { name: "Basic 4B" })).toHaveCount(0);
  // Today's registers are saved on the device for offline use.
  await expect(page.getByText("Today's registers are saved on this device")).toBeVisible({ timeout: 15_000 });

  await openTodaysRegister(page);
  for (const name of ["Akua Owusu", "Kwame Mensah", "Yaw Darko", "Abena Asante"])
    await mark(page, name, "Present");
  await mark(page, "Esi Quaye", "Absent");
  await page.getByLabel("Esi Quaye: reason").fill("Sick");
  await page.getByRole("button", { name: "Save register" }).click();
  await expect(page.getByText("Register saved.")).toBeVisible();
  // The copy that opens offline is brought up to date after saving.
  await expect(page.getByText(/^Saved on this device at/)).toBeVisible({ timeout: 15_000 });

  // No connection: the page still opens (from the service worker) and marks are kept on the device.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Basic 4A" })).toBeVisible();
  await expect(page.getByText("No connection.")).toBeVisible();
  await mark(page, "Abena Asante", "Late");
  await page.getByRole("button", { name: "Save register" }).click();
  await expect(page.getByText("1 mark is kept on this device, not sent yet")).toBeVisible();
  await expect(page.getByText("Not sent yet", { exact: true })).toBeVisible();

  // Back online: it is sent without anyone doing anything.
  await context.setOffline(false);
  await expect(page.getByText("1 register kept on this device was sent.")).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByRole("radio", { name: "Abena Asante: Late" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Esi Quaye: Absent" })).toBeChecked();
});

test("a change made offline that clashes with someone else's is shown for the teacher to decide", async ({
  page,
  context,
  browser,
}) => {
  await signIn(page, "teacher@example.test", `${SCHOOL.path}/attendance`);
  await openTodaysRegister(page);

  // The teacher's phone goes offline and marks Kwame absent.
  await context.setOffline(true);
  await mark(page, "Kwame Mensah", "Absent");
  await page.getByRole("button", { name: "Save register" }).click();
  await expect(page.getByText("1 mark is kept on this device, not sent yet")).toBeVisible();

  // Meanwhile the head teacher, at the office, marks Kwame late.
  const office = await browser.newContext();
  const head = await office.newPage();
  await signIn(head, "head@example.test", `${SCHOOL.path}/attendance`);
  await openTodaysRegister(head);
  await mark(head, "Kwame Mensah", "Late");
  await head.getByRole("button", { name: "Save register" }).click();
  await expect(head.getByText("Register saved.")).toBeVisible();
  await office.close();

  // When the phone reconnects, nothing is overwritten: the teacher chooses.
  await context.setOffline(false);
  const conflicts = page.getByRole("region", { name: "Changed by someone else" });
  await expect(conflicts).toBeVisible({ timeout: 15_000 });
  await expect(conflicts).toContainText("You marked Absent. Comfort Adjei marked Late");
  await conflicts.getByRole("button", { name: "Keep Late" }).click();
  await expect(conflicts).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("radio", { name: "Kwame Mensah: Late" })).toBeChecked();
});
