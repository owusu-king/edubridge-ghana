import { test as setup } from "@playwright/test";
import { completeTwoStep, PASSWORD, PLATFORM_AUTH, PLATFORM_TOTP_SECRET } from "./helpers";

setup("sign in the platform administrator", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("platform@example.test");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await completeTwoStep(page, PLATFORM_TOTP_SECRET);
  await page.context().storageState({ path: PLATFORM_AUTH });
});
