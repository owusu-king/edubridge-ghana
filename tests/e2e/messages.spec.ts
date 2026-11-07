import { expect, test } from "@playwright/test";
import { ACCOUNTANT_AUTH, SCHOOL, signIn } from "./helpers";

test("the head teacher posts an announcement for the whole school, without SMS", async ({ page }) => {
  await signIn(page, "head@example.test");
  await page.goto(`${SCHOOL.path}/announcements`);
  await expect(page.getByRole("heading", { name: "Announcements", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "New announcement" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title", { exact: true }).fill("Speech day rehearsal");
  await dialog
    .getByLabel("Message", { exact: true })
    .fill("Rehearsals run after school on Wednesday and Thursday.");
  await expect(dialog.getByLabel("For")).toHaveValue("school:");
  await expect(dialog.getByText(/One SMS to each of \d+ famil/)).toBeVisible();
  await dialog.getByRole("button", { name: "Post announcement" }).click();
  // The dialog closes and the announcement heads the list.
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "Speech day rehearsal" })).toBeVisible();
  await expect(page.getByText(/The whole school · by .+ · read by \d+ famil/).first()).toBeVisible();

  // The family's message history is on the student page.
  await page.goto(`${SCHOOL.path}/students?q=Kwame%20Mensah`);
  await page.getByRole("link", { name: "Kwame Mensah" }).click();
  await expect(page.getByRole("heading", { name: "Messages to the family" })).toBeVisible();
});

test.describe("the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("sees the SMS the school sends on its own, off until turned on", async ({ page }) => {
    await page.goto(`${SCHOOL.path}/settings/messages`);
    await expect(page.getByRole("heading", { name: "Messages to families" })).toBeVisible();
    await expect(page.getByLabel(/Text the family when a payment is recorded/)).not.toBeChecked();
    await expect(page.getByLabel(/Remind families who owe, automatically/)).not.toBeChecked();
    await expect(page.getByText(/received for Ama, receipt R000123/)).toBeVisible();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Message settings saved.")).toBeVisible();
    // Announcements are for the head teacher and administrators. Checked inside a streaming boundary, so
    // the status may already be 200; the content must be the 404.
    await page.goto(`${SCHOOL.path}/announcements`);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });
});
