import { randomInt, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { linkPath, SCHOOL, signIn, waitForMessage } from "./helpers";

test("a member adds a phone number, signs in with it and recovers their password by SMS", async ({
  page,
  browser,
}) => {
  const id = randomUUID().slice(0, 8);
  const email = `phone-${id}@example.test`;
  const local = `024${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
  const e164 = `+233${local.slice(1)}`;

  // An admin invites a teacher (no two-step requirement at this school for teachers).
  await signIn(page, "admin@example.test");
  await page.goto(`${SCHOOL.path}/members`);
  await page.getByRole("button", { name: "Invite member" }).click();
  const invite = page.getByRole("dialog", { name: "Invite a member" });
  await invite.getByLabel("Email").fill(email);
  await invite.getByRole("button", { name: "Create invitation" }).click();
  const invitePath = new URL(await invite.getByLabel("Invitation link").inputValue()).pathname;

  const member = await (await browser.newContext()).newPage();
  await member.goto(invitePath);
  await member.getByLabel("Full name").fill(`Phone Teacher ${id}`);
  await member.getByLabel("Password").fill("a-long-synthetic-password");
  await member.getByRole("button", { name: "Create account and join" }).click();
  await expect(member).toHaveURL(SCHOOL.path);

  // Add and verify a phone number with the SMS code.
  await member.goto("/account");
  await member.getByLabel("Phone number").fill("0341234567");
  await member.getByRole("button", { name: "Send code" }).click();
  await expect(member.getByText("Enter a valid mobile number")).toBeVisible();
  await member.getByLabel("Phone number").fill(local);
  await member.getByRole("button", { name: "Send code" }).click();
  await expect(member.getByText(/We sent a 6-digit code to \+233/)).toBeVisible();
  const code = (await waitForMessage(e164, /EduBridge code/)).text.match(/\d{6}/)![0];
  await member.getByLabel("Code").fill(code);
  await member.getByRole("button", { name: "Verify" }).click();
  await expect(member.getByText("Phone number verified.")).toBeVisible();
  await member.reload();
  await expect(
    member.getByText(`+233 ${local.slice(1, 3)} ${local.slice(3, 6)} ${local.slice(6)}`),
  ).toBeVisible();

  // Sign in with the phone number in local format.
  await member.getByRole("button", { name: "Sign out", exact: true }).click();
  await member.getByLabel("Email or phone number").fill(local);
  await member.getByLabel("Password").fill("a-long-synthetic-password");
  await member.getByRole("button", { name: "Sign in" }).click();
  await expect(member).not.toHaveURL(/\/login/);

  // Forgotten password, requested with the phone number: the link arrives by SMS.
  await member.goto("/account");
  await member.getByRole("button", { name: "Sign out", exact: true }).click();
  await member.goto("/forgot-password");
  await member.getByLabel("Email or phone number").fill(local);
  await member.getByRole("button", { name: "Send reset link" }).click();
  await expect(member.getByText("If an account matches")).toBeVisible();
  const resetPath = linkPath((await waitForMessage(e164, /reset your password/)).text);
  await member.goto(resetPath);
  await member.getByLabel("New password").fill("another-synthetic-password");
  await member.getByRole("button", { name: "Set new password" }).click();
  await expect(member.getByText("Your password has been changed.")).toBeVisible();
  await member.getByLabel("Email or phone number").fill(e164);
  await member.getByLabel("Password").fill("another-synthetic-password");
  await member.getByRole("button", { name: "Sign in" }).click();
  await expect(member).not.toHaveURL(/\/login/);
});
