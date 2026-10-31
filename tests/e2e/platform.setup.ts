import { test as setup } from "@playwright/test";
import {
  ACCOUNTANT_AUTH,
  ACCOUNTANT_TOTP_SECRET,
  completeTwoStep,
  PASSWORD,
  PLATFORM_AUTH,
  PLATFORM_TOTP_SECRET,
} from "./helpers";

// Accounts that need a two-step code sign in once here; tests reuse the saved sessions.
for (const [name, email, secret, path] of [
  ["platform administrator", "platform@example.test", PLATFORM_TOTP_SECRET, PLATFORM_AUTH],
  ["accountant", "bursar@example.test", ACCOUNTANT_TOTP_SECRET, ACCOUNTANT_AUTH],
] as const) {
  setup(`sign in the ${name}`, async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await completeTwoStep(page, secret);
    await page.context().storageState({ path });
  });
}
