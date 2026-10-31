import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { completeTwoStep, PLATFORM_AUTH, totp } from "./helpers";

test("an owner secures their account: password change and two-step verification", async ({ browser }) => {
  const id = randomUUID().slice(0, 8);
  const email = `secure-${id}@example.test`;
  const slug = `secure-${id}`;

  // A platform admin creates a school whose owner is a brand-new user.
  const admin = await (await browser.newContext({ storageState: PLATFORM_AUTH })).newPage();
  await admin.goto("/admin/schools/new");
  await admin.getByLabel("School name").fill(`Secure School ${id}`);
  await admin.getByLabel("Address").fill(slug);
  await admin.getByLabel("Owner's email").fill(email);
  await admin.getByRole("button", { name: "Create school" }).click();
  const invitePath = new URL(await admin.getByLabel("Invitation link").inputValue()).pathname;

  const page = await (await browser.newContext()).newPage();
  await page.goto(invitePath);
  await page.getByLabel("Full name").fill("Owner Secure");
  await page.getByLabel("Password").fill("first-strong-password");
  await page.getByRole("button", { name: "Create account and join" }).click();
  await expect(page).toHaveURL(`/s/${slug}`);

  // Owners are prompted to set up two-step verification.
  await expect(page.getByText("Owners and bursars must use two-step verification.")).toBeVisible();

  // Change password.
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("menuitem", { name: "Your account" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your account" })).toBeVisible();
  await page.getByLabel("Current password").fill("wrong-password");
  await page.getByLabel("New password").fill("second-strong-password");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Your current password is incorrect.").first()).toBeVisible();
  await page.getByLabel("Current password").fill("first-strong-password");
  await page.getByLabel("New password").fill("second-strong-password");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Password changed.")).toBeVisible();

  // Turn on two-step verification.
  await page.getByRole("link", { name: "Security" }).click();
  await page.getByRole("button", { name: "Set up two-step verification" }).click();
  await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  const secret = (await page.getByTestId("mfa-secret").innerText()).replace(/\s+/g, "");
  await page.getByLabel("Code from your app").fill("000000");
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByText("That code is not valid.")).toBeVisible();
  await page.getByLabel("Code from your app").fill(await totp(secret));
  await page.getByRole("button", { name: "Turn on" }).click();
  const codeItems = page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem");
  await expect(codeItems).toHaveCount(10);
  const codes = await codeItems.allInnerTexts();
  await page.getByRole("button", { name: "I have saved them" }).click();
  await page.reload();
  await expect(page.getByText("10 of 10 recovery codes left.")).toBeVisible();

  // The prompt disappears in the school.
  await page.goto(`/s/${slug}`);
  await expect(page.getByText("Owners and bursars must use two-step verification.")).toHaveCount(0);

  // Sign out, then sign in: the new password and a code are required; a recovery code also works.
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("second-strong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Two-step verification" })).toBeVisible();
  await page.getByLabel("Verification code").fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("That code is not valid.")).toBeVisible();
  await page.getByLabel("Verification code").fill(codes[0]!);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(`/s/${slug}`);

  await page.goto("/account/security");
  await expect(page.getByText("9 of 10 recovery codes left.")).toBeVisible();

  // And the authenticator app path.
  await page.getByRole("button", { name: /Sign out/ }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("second-strong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await completeTwoStep(page, secret);
  await expect(page).toHaveURL(`/s/${slug}`);
});

test("the two-step page cannot be used without a pending sign-in", async ({ page }) => {
  await page.goto("/login/verify");
  await expect(page).toHaveURL("/login");
});
