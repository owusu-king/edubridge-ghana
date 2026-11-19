import { randomInt, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

test("siblings are linked through their guardian's phone number", async ({ page }) => {
  const surname = `Sibling${randomUUID().slice(0, 6)}`;
  const local = `054${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
  await signIn(page, "admin@example.test");
  await page.goto(`${SCHOOL.path}/students`);

  // First child, with the guardian entered while adding the student.
  await page.getByRole("button", { name: "Add student" }).click();
  let form = page.getByRole("dialog", { name: "Add a student" });
  await form.getByLabel("First name").fill("Kwesi");
  await form.getByLabel("Surname").fill(surname);
  await form.getByLabel("Sex").selectOption("male");
  await form.getByText("Add a guardian").click();
  await form.getByLabel("Full name").fill("Maame Synthetic");
  await form.getByLabel("Phone number").fill("0341234567");
  await form.getByRole("button", { name: "Add student" }).click();
  // The number is checked before anything is saved: the reason shows on the field.
  await expect(form.getByText("Enter a valid phone number, e.g. 024 123 4567.")).toBeVisible();
  await form.getByLabel("Phone number").fill(local);
  await form.getByRole("button", { name: "Add student" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `Kwesi ${surname}` })).toBeVisible();

  // Second child: the same phone number links the existing guardian.
  await page.goto(`${SCHOOL.path}/students`);
  await page.getByRole("button", { name: "Add student" }).click();
  form = page.getByRole("dialog", { name: "Add a student" });
  await form.getByLabel("First name").fill("Esi");
  await form.getByLabel("Surname").fill(surname);
  await form.getByLabel("Sex").selectOption("female");
  await form.getByText("Add a guardian").click();
  await form.getByLabel("Full name").fill("Maame S.");
  await form.getByLabel("Phone number").fill(`+233${local.slice(1)}`);
  await form.getByRole("button", { name: "Add student" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `Esi ${surname}` })).toBeVisible();
  await page.goto(`${SCHOOL.path}/students`);

  await page.getByRole("searchbox", { name: "Search by name or admission number" }).fill(`Esi ${surname}`);
  await page.getByRole("button", { name: "Search" }).click();
  // "Esi" also matches "Kwesi"; both siblings share the same primary contact.
  await expect(page.getByRole("row", { name: /Maame Synthetic/ })).toHaveCount(2);
  await page.getByRole("link", { name: `Esi ${surname}`, exact: true }).click();
  await expect(page.getByText("Primary contact")).toBeVisible();
  await expect(page.getByText(`Also guardian of Kwesi ${surname}`)).toBeVisible();

  // A second guardian, made primary, then removed again.
  await page.getByRole("button", { name: "Add guardian" }).click();
  const add = page.getByRole("dialog", { name: "Add guardian" });
  await add.getByLabel("Full name").fill("Papa Synthetic");
  await add.getByLabel("Phone number").fill(`020${String(randomInt(0, 10_000_000)).padStart(7, "0")}`);
  await add.getByLabel("Relationship").selectOption("father");
  await add.getByRole("button", { name: "Add guardian" }).click();
  await expect(add).toBeHidden();
  await page.getByRole("button", { name: "Make Papa Synthetic the primary contact" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Make primary" }).click();
  await expect(
    page.getByRole("listitem").filter({ hasText: "Papa Synthetic" }).getByText("Primary contact"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Remove Papa Synthetic" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect(
    page.getByRole("listitem").filter({ hasText: "Maame Synthetic" }).getByText("Primary contact"),
  ).toBeVisible();
});

test("teachers can see the guardians of students in their class, without changing them", async ({ page }) => {
  await signIn(page, "teacher@example.test");
  await page.goto(`${SCHOOL.path}/students`);
  await page.getByRole("link", { name: "Akua Owusu" }).click();
  await expect(page.getByText("Akosua Owusu")).toBeVisible();
  await expect(page.getByRole("link", { name: "+233 24 555 0101" })).toHaveAttribute(
    "href",
    "tel:+233245550101",
  );
  await expect(page.getByRole("button", { name: "Add guardian" })).toHaveCount(0);
});
