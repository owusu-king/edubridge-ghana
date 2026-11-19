import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

test("an administrator adds, finds, edits, moves and withdraws a student", async ({ page }) => {
  const surname = `Synthetic${randomUUID().slice(0, 6)}`;
  await signIn(page, "admin@example.test");
  await page.goto(SCHOOL.path);
  await page.getByRole("navigation", { name: "School" }).getByRole("link", { name: "Students" }).click();
  await expect(page.getByText(/active students · Classes for Term 1, 2026\/2027/)).toBeVisible();

  // "Add student" opens a dialog; a missing field is reported and what was typed is kept.
  await page.getByRole("button", { name: "Add student" }).click();
  const form = page.getByRole("dialog", { name: "Add a student" });
  await form.getByLabel("First name").fill("Serwaa");
  await form.getByLabel("Surname").fill(surname);
  await form.getByRole("button", { name: "Add student" }).click();
  await expect(form.getByText("Choose female or male.")).toBeVisible();
  await expect(form.getByLabel("First name")).toHaveValue("Serwaa");
  await form.getByLabel("Sex").selectOption("female");
  await form.getByLabel("Date of birth").fill("2017-04-09");
  await form.getByLabel("Class this term").selectOption({ label: "Basic 4B" });
  await form.getByRole("button", { name: "Add student" }).click();
  // Added: the new student's record opens.
  await expect(page.getByRole("heading", { level: 1, name: `Serwaa ${surname}` })).toBeVisible();
  await page.getByRole("navigation", { name: "School" }).getByRole("link", { name: "Students" }).click();

  // Find by surname.
  await page.getByRole("searchbox", { name: "Search by name or admission number" }).fill(surname);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("row", { name: new RegExp(`Serwaa ${surname}.*Basic 4B`) })).toBeVisible();
  await page.getByRole("link", { name: `Serwaa ${surname}` }).click();
  await expect(page.getByRole("heading", { level: 1, name: `Serwaa ${surname}` })).toBeVisible();
  await expect(page.getByText("9 Apr 2017")).toBeVisible();

  await page.getByRole("button", { name: "Edit details" }).click();
  await page.getByRole("dialog").getByLabel("Other names").fill("Adjoa");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `Serwaa Adjoa ${surname}` })).toBeVisible();

  await page.getByRole("button", { name: "Change class" }).click();
  await page.getByRole("dialog").getByLabel("Class this term").selectOption({ label: "Basic 4A" });
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("table", { name: "Class history" }).getByRole("cell", { name: "Basic 4A" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Change status" }).click();
  const status = page.getByRole("dialog");
  await status.getByLabel("New status").selectOption({ label: "Withdrawn" });
  await status.getByLabel("Reason").fill("Family moved away");
  await status.getByRole("button", { name: "Change status" }).click();
  await expect(status).toBeHidden();
  await expect(page.getByText("Withdrawn", { exact: true })).toBeVisible();
  await expect(page.getByText("Not in a class this term")).toBeVisible();
});

test("teachers only see students in the classes they teach", async ({ page }) => {
  await signIn(page, "teacher@example.test");
  await page.goto(`${SCHOOL.path}/students`);
  await expect(page.getByText("Students in the classes you teach.")).toBeVisible();
  await expect(page.getByRole("row", { name: /Akua Owusu.*Basic 4A/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Kojo Addo/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add student" })).toHaveCount(0);
});
