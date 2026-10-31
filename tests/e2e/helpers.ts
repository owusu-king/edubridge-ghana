import { expect, type Page } from "@playwright/test";

/** Matches scripts/seed.ts (synthetic accounts). */
export const PASSWORD = "edubridge-dev-only";
export const SCHOOL = { path: "/s/kpone-ridge", name: "Kpone Ridge International School" };

export async function signIn(page: Page, email: string, next?: string) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
