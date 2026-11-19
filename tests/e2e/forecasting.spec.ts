import { expect, test } from "@playwright/test";
import { ACCOUNTANT_AUTH, SCHOOL, signIn } from "./helpers";

// Read-only: the seeded school has one term, so the forecast says there is not enough history (integration tests
// check the figures and reviews).

test("the head teacher opens the forecast, which says when there is not enough history; no checks", async ({
  page,
}) => {
  await signIn(page, "head@example.test", `${SCHOOL.path}/fees/forecast`);
  await page.goto(`${SCHOOL.path}/fees`);
  await page.getByRole("navigation", { name: "Fees" }).getByRole("link", { name: "Forecast" }).click();
  await expect(page).toHaveURL(/\/fees\/forecast$/);
  await expect(page.getByRole("heading", { name: "Collection forecast" })).toBeVisible();
  await expect(page.getByText("Not enough history to forecast yet")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Fees" }).getByRole("link", { name: "Checks" }),
  ).toHaveCount(0);
  await page.goto(`${SCHOOL.path}/fees/checks`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test.describe("as the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("runs every finance check over the term", async ({ page }) => {
    await page.goto(`${SCHOOL.path}/fees/checks`);
    await expect(page.getByRole("heading", { name: "Finance checks" })).toBeVisible();
    for (const name of [
      "The same reference on two receipts",
      "Many receipts voided by one person",
      "Receipts recorded out of hours",
      "Mobile Money differences open over a day",
      "Large refunds",
      "A closed period reopened",
    ])
      await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  });
});

test("teachers have no forecast", async ({ page }) => {
  await signIn(page, "teacher@example.test", SCHOOL.path);
  await page.goto(`${SCHOOL.path}/fees/forecast`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
