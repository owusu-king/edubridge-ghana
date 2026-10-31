import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { completeTwoStep, enrollTwoStep, linkPath, PLATFORM_AUTH, waitForMessage } from "./helpers";

test("an owner's account security journey", async ({ browser }) => {
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

  // The default policy requires owners to set up two-step verification before entering the school.
  await expect(page).toHaveURL("/account/security?required=school");
  await page.goto(`/s/${slug}`);
  await expect(page).toHaveURL("/account/security?required=school");
  const { secret, recoveryCodes } = await enrollTwoStep(page);
  await page.reload();
  await expect(page.getByText("10 of 10 recovery codes left.")).toBeVisible();
  await page.goto(`/s/${slug}`);
  await expect(page.getByRole("heading", { level: 1, name: `Secure School ${id}` })).toBeVisible();

  // Change password from the account page.
  await page.goto("/account");
  await page.getByLabel("Current password").fill("wrong-password");
  await page.getByLabel("New password").fill("second-strong-password");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Your current password is incorrect.").first()).toBeVisible();
  await page.getByLabel("Current password").fill("first-strong-password");
  await page.getByLabel("New password").fill("second-strong-password");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Password changed.")).toBeVisible();

  // Sign in again: new password, then a recovery code.
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("second-strong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Two-step verification" })).toBeVisible();
  await page.getByLabel("Verification code").fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("That code is not valid.")).toBeVisible();
  await page.getByLabel("Verification code").fill(recoveryCodes[0]!);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/account/security");
  await expect(page.getByText("9 of 10 recovery codes left.")).toBeVisible();

  // Forgotten password: the reset link arrives by email and works once.
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("link", { name: "Forgotten your password?" }).click();
  // Wait for the new page so the sign-in form's Email field is not filled by mistake.
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText("If an account exists for that email")).toBeVisible();
  const resetPath = linkPath((await waitForMessage(email, /reset-password/)).text);
  await page.goto(resetPath);
  await page.getByLabel("New password").fill("third-strong-password");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByText("Your password has been changed.")).toBeVisible();
  await page.goto(resetPath);
  await expect(page.getByRole("heading", { name: "Link expired" })).toBeVisible();

  // Two-step verification still applies after a reset.
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("third-strong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await completeTwoStep(page, secret);

  // The owner can change the school's policy; the change is audited.
  await page.goto(`/s/${slug}/settings/security`);
  await page.getByRole("checkbox", { name: "Owner" }).uncheck();
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByText("Security policy saved.")).toBeVisible();
  await page.goto(`/s/${slug}/settings/audit`);
  await expect(page.getByRole("cell", { name: "Two-step verification policy changed" })).toBeVisible();
});

test("the two-step page cannot be used without a pending sign-in", async ({ page }) => {
  await page.goto("/login/verify");
  await expect(page).toHaveURL("/login");
});

test("password reset does not reveal whether an account exists", async ({ page }) => {
  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill(`unknown-${randomUUID().slice(0, 8)}@example.test`);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText("If an account exists for that email")).toBeVisible();
});
