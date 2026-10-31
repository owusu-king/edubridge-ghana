import { expect, test } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

test("navigates with the mobile drawer", async ({ page }) => {
  await signIn(page, "admin@example.test");
  await page.goto(`${SCHOOL.path}`);
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await drawer.getByRole("link", { name: "Members" }).click();
  await expect(drawer).toBeHidden();
  await expect(page).toHaveURL(`${SCHOOL.path}/members`);
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
});
