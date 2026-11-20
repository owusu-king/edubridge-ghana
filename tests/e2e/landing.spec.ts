import { expect, test } from "@playwright/test";

/** The public landing page (2026-11-19): what a visitor who is not signed in sees at the site's address. */

test("a visitor sees the landing page, and can reach sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "The complete operating system for schools",
  );
  await page.getByRole("link", { name: "Sign in" }).first().click();
  await expect(page).toHaveURL("/login");
});

test("book a demo says which details are missing", async ({ page }) => {
  await page.goto("/#visit");
  const form = page.getByRole("form", { name: "Book a demo" });
  await form.getByRole("button", { name: "Request a demo" }).click();
  await expect(form.getByText("Enter your school's name.")).toBeVisible();
  await expect(form.getByText("Enter a mobile number, like 024 123 4567.")).toBeVisible();
});
