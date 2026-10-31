import { randomInt } from "node:crypto";
import { expect, test } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

test("the current term shows on the overview", async ({ page }) => {
  await signIn(page, "teacher@example.test");
  await page.goto(SCHOOL.path);
  await expect(page.getByText("Term 1, 2026/2027 · 8 Sept 2026 – 18 Dec 2026")).toBeVisible();
});

test("a head teacher manages the academic calendar", async ({ page }) => {
  // A random far-future year keeps repeated runs from overlapping each other.
  const y = 2100 + randomInt(0, 7800);
  await signIn(page, "head@example.test");
  await page.goto(SCHOOL.path);
  await page.getByRole("navigation", { name: "School" }).getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(`${SCHOOL.path}/settings/calendar`);
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link")).toHaveText(["Calendar"]);

  await page.getByRole("button", { name: "Add academic year" }).click();
  const dialog = page.getByRole("dialog", { name: "Add academic year" });
  await dialog.getByLabel("Academic year").fill(`${y}/${y + 1}`);
  const starts = dialog.getByLabel("Starts");
  const ends = dialog.getByLabel("Ends");
  // Wrong order is refused.
  await starts.nth(0).fill(`${y}-09-07`);
  await ends.nth(0).fill(`${y}-12-18`);
  await starts.nth(1).fill(`${y}-12-01`);
  await ends.nth(1).fill(`${y + 1}-04-09`);
  await dialog.getByRole("button", { name: "Add year" }).click();
  await expect(dialog.getByText("Each term must start after the previous one ends.")).toBeVisible();

  await starts.nth(0).fill(`${y}-09-07`);
  await ends.nth(0).fill(`${y}-12-18`);
  await starts.nth(1).fill(`${y + 1}-01-11`);
  await ends.nth(1).fill(`${y + 1}-04-09`);
  await starts.nth(2).fill(`${y + 1}-05-03`);
  await ends.nth(2).fill(`${y + 1}-07-30`);
  await dialog.getByRole("button", { name: "Add year" }).click();
  await expect(dialog).toBeHidden();
  const heading = page.getByRole("heading", { name: new RegExp(`^${y}/${y + 1}`) });
  await expect(heading).toBeVisible();

  const table = page.getByRole("table", { name: `Terms in ${y}/${y + 1}` });
  await table.getByRole("button", { name: "Edit Term 3" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Ends")
    .fill(`${y + 1}-08-06`);
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(table.getByRole("cell", { name: `6 Aug ${y + 1}` })).toBeVisible();
});
