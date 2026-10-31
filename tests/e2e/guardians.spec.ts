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
  let dialog = page.getByRole("dialog", { name: "Add student" });
  await dialog.getByLabel("First name").fill("Kwesi");
  await dialog.getByLabel("Surname").fill(surname);
  await dialog.getByLabel("Sex").selectOption("male");
  const contact = dialog.getByRole("group", { name: "Primary contact (optional)" });
  await contact.getByLabel("Full name").fill("Maame Synthetic");
  await contact.getByLabel("Phone number").fill("0341234567");
  await dialog.getByRole("button", { name: "Add student" }).click();
  await expect(contact.getByText("Enter a valid phone number")).toBeVisible();
  await expect(dialog.getByLabel("First name")).toHaveValue("Kwesi");
  await contact.getByLabel("Phone number").fill(local);
  await dialog.getByRole("button", { name: "Add student" }).click();
  await expect(dialog).toBeHidden();

  // Second child: the same phone number links the existing guardian.
  await page.getByRole("button", { name: "Add student" }).click();
  dialog = page.getByRole("dialog", { name: "Add student" });
  await dialog.getByLabel("First name").fill("Esi");
  await dialog.getByLabel("Surname").fill(surname);
  await dialog.getByLabel("Sex").selectOption("female");
  await dialog
    .getByRole("group", { name: "Primary contact (optional)" })
    .getByLabel("Full name")
    .fill("Maame S.");
  await dialog
    .getByRole("group", { name: "Primary contact (optional)" })
    .getByLabel("Phone number")
    .fill(`+233${local.slice(1)}`);
  await dialog.getByRole("button", { name: "Add student" }).click();
  await expect(dialog).toBeHidden();

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
