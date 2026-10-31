import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

test("teachers see classes and class teachers, without management controls", async ({ page }) => {
  await signIn(page, "teacher@example.test");
  await page.goto(SCHOOL.path);
  await page.getByRole("navigation", { name: "School" }).getByRole("link", { name: "Classes" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Classes" })).toBeVisible();
  const basic4 = page.getByRole("table", { name: "Classes in Basic 4" });
  await expect(basic4.getByRole("row", { name: /Basic 4A.*Yaw Boateng/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Add class/ })).toHaveCount(0);
});

test("a head teacher adds, edits and archives a class", async ({ page }) => {
  const name = `Basic 5 ${randomUUID().slice(0, 4).toUpperCase()}`;
  await signIn(page, "head@example.test");
  await page.goto(`${SCHOOL.path}/classes`);
  await page.getByRole("button", { name: "Add class to Basic 5" }).click();
  const dialog = page.getByRole("dialog", { name: "Add class" });
  await expect(dialog.getByLabel("Class name")).toHaveValue("Basic 5");
  await expect(dialog.getByLabel("Campus")).toBeVisible();
  await dialog.getByLabel("Class name").fill(name);
  await dialog.getByRole("button", { name: "Add class" }).click();
  await expect(dialog).toBeHidden();

  const table = page.getByRole("table", { name: "Classes in Basic 5" });
  const row = table.getByRole("row", { name: new RegExp(name) });
  await expect(row.getByRole("cell", { name: "Not assigned" })).toBeVisible();

  await row.getByRole("button", { name: `Edit ${name}` }).click();
  await page.getByRole("dialog").getByLabel("Class teacher").selectOption({ label: "Yaw Boateng" });
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(row.getByRole("cell", { name: "Yaw Boateng" })).toBeVisible();

  await row.getByRole("button", { name: `Archive ${name}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Archive class" }).click();
  await expect(row.getByText("Archived")).toBeVisible();

  // Duplicate names at the same campus are refused, with the typed values kept.
  await page.getByRole("button", { name: "Add class to Basic 5" }).click();
  await page.getByRole("dialog").getByLabel("Class name").fill(name.toLowerCase());
  await page.getByRole("dialog").getByRole("button", { name: "Add class" }).click();
  await expect(
    page.getByRole("dialog").getByText("A class with this name already exists at this campus."),
  ).toBeVisible();
});

test("a school without levels is offered the Ghanaian defaults", async ({ page }) => {
  await signIn(page, "owner@example.test");
  await page.goto("/s/adenta-hall/classes");
  await expect(page.getByText("No levels yet")).toBeVisible();
  await page.getByRole("button", { name: "Set up levels" }).click();
  await expect(page.getByRole("dialog").getByLabel("Junior High School")).toBeChecked();
});
