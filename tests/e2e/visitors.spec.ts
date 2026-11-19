import { expect, test } from "@playwright/test";
import { ACCOUNTANT_AUTH, SCHOOL, signIn } from "./helpers";

// Runs in order: the office names a collector, then the teacher on gate duty refuses a stranger and releases
// the child to that collector. Names carry a marker so repeated runs on the same day do not collide.
test.describe.configure({ mode: "serial" });

const marker = Date.now().toString(36);
const visitor = `Yaw Boakye ${marker}`;
const collector = `Kofi Quaye ${marker}`;
const stranger = `Unknown Man ${marker}`;

test("the office signs a visitor in and out", async ({ page }) => {
  await signIn(page, "admin@example.test", `${SCHOOL.path}/visitors`);
  await page.goto(`${SCHOOL.path}/visitors`);
  await page.getByRole("button", { name: "Sign in a visitor" }).click();
  const dialog = page.getByRole("dialog", { name: "Sign in a visitor" });
  await dialog.getByLabel("Name").fill(visitor);
  await dialog.getByLabel("Phone (optional)").fill("024 123 4567");
  await dialog.getByLabel("Purpose").selectOption({ label: "Official visit" });
  await dialog.getByLabel("Visiting").selectOption({ label: "Comfort Adjei" });
  await dialog.getByLabel("Campus").selectOption({ label: "Main campus" });
  await dialog.getByRole("button", { name: "Sign in" }).click();
  await expect(dialog).toBeHidden();

  const onSite = page.getByRole("table", { name: "Visitors on site now" });
  await expect(onSite.getByText(visitor)).toBeVisible();
  await onSite.getByRole("button", { name: `Sign out ${visitor}` }).click();
  await expect(onSite.getByText(visitor)).toHaveCount(0);
  const log = page.getByRole("table", { name: /Visitor log/ });
  const row = log.getByRole("row").filter({ hasText: visitor });
  await expect(row).toBeVisible();
  await expect(row.getByText("Not yet")).toHaveCount(0);
});

test("the office names someone who may collect a child", async ({ page }) => {
  await signIn(page, "admin@example.test", `${SCHOOL.path}/pickup`);
  await page.goto(`${SCHOOL.path}/pickup`);
  await page.getByLabel("Class", { exact: true }).selectOption({ label: "Basic 4A" });
  await page.getByRole("button", { name: "Show" }).click();
  await page.getByRole("table").getByRole("link", { name: "Esi Quaye" }).click();
  await expect(page.getByRole("heading", { name: "Esi Quaye" })).toBeVisible();
  await page.getByRole("button", { name: "Add a collector" }).click();
  const dialog = page.getByRole("dialog", { name: "Add someone who may collect this child" });
  await dialog.getByLabel("Full name").fill(collector);
  await dialog.getByLabel("Who they are to the child").fill("Uncle");
  // Today only.
  await dialog
    .getByLabel("Last day (optional)")
    .fill((await dialog.getByLabel("Last day (optional)").getAttribute("min")) ?? "");
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(collector)).toBeVisible();
});

test("the teacher on gate duty refuses a stranger, releases the child, and cancels a mistake", async ({
  page,
}) => {
  await signIn(page, "teacher@example.test", `${SCHOOL.path}/pickup`);
  // Opens on the teacher's own class.
  await page.goto(`${SCHOOL.path}/pickup`);
  await expect(page.getByRole("heading", { name: /^Basic 4A · / })).toBeVisible();

  await page.getByRole("button", { name: "Record a refusal for Esi Quaye" }).click();
  const refuse = page.getByRole("dialog", { name: "Record a refusal for Esi Quaye" });
  await refuse.getByLabel("Their name").fill(stranger);
  await refuse.getByLabel("Who they said they are (optional)").fill("Neighbour");
  await refuse.getByRole("button", { name: "Record refusal" }).click();
  await expect(refuse).toBeHidden();
  await expect(page.getByText(stranger).first()).toBeVisible();

  await page.getByRole("button", { name: "Release Esi Quaye" }).click();
  const release = page.getByRole("dialog", { name: "Release Esi Quaye" });
  await release.getByRole("radio", { name: new RegExp(collector) }).check();
  await release.getByRole("button", { name: "Release" }).click();
  await expect(release).toBeHidden();
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "Esi Quaye" }) });
  await expect(row.getByText(`by ${collector}`)).toBeVisible();

  // Released by mistake: cancelled, and kept in her history.
  await row.getByRole("link", { name: "Esi Quaye" }).click();
  await page
    .getByRole("button", { name: /^Cancel the record of/ })
    .first()
    .click();
  const cancel = page.getByRole("dialog", { name: "Cancel this record" });
  await cancel.getByLabel("Why").fill("Recorded for the wrong child.");
  await cancel.getByRole("button", { name: "Cancel record" }).click();
  await expect(cancel).toBeHidden();
  await expect(page.getByText("Cancelled: Recorded for the wrong child.").first()).toBeVisible();
});

test.describe("the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("has neither visitors nor pickup", async ({ page }) => {
    for (const section of ["pickup", "visitors"]) {
      await page.goto(`${SCHOOL.path}/${section}`);
      await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    }
    await expect(page.getByRole("link", { name: "Pickup" })).toHaveCount(0);
  });
});
