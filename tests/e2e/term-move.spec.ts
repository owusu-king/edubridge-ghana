import { expect, test } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

// Moves the seeded school's students into Term 2 and undoes it, leaving Term 2 empty for other specs.
test("the head teacher moves students into the next term, sees where they went, and undoes it", async ({
  page,
}) => {
  await signIn(page, "head@example.test", `${SCHOOL.path}/classes`);
  await page.goto(`${SCHOOL.path}/classes`);
  await page.getByRole("link", { name: "Move to another term" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Move students to another term" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Term 1, 2026/2027 to Term 2, 2026/2027" })).toBeVisible();
  // Within a year, each class carries over as it is.
  await expect(page.getByLabel("Where Basic 4A goes").locator("option:checked")).toHaveText(/^Basic 4A/);

  // Keep one student back, for placing by hand.
  const basic4a = page.getByRole("listitem").filter({ has: page.getByLabel("Where Basic 4A goes") });
  await basic4a.getByText("Keep students back").click();
  const kept = basic4a.getByRole("checkbox").first();
  await kept.check();

  await page.getByRole("button", { name: "Move students" }).click();
  await expect(page.getByText(/students? placed in classes; 1 kept back to place by hand\./)).toBeVisible();

  await page.reload();
  const moves = page.getByRole("table", { name: "Recent moves" });
  const latest = moves.getByRole("row").nth(1);
  await expect(latest).toContainText("Term 1, 2026/2027 to Term 2, 2026/2027");
  await latest.getByRole("button", { name: /^Undo the move/ }).click();
  await page
    .getByRole("dialog", { name: "Undo this move?" })
    .getByRole("button", { name: "Undo move" })
    .click();
  await expect(moves.getByRole("row").nth(1)).toContainText("Undone");
});
