import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

test("an admin invites, scopes, edits and suspends a member", async ({ page, browser }) => {
  const id = randomUUID().slice(0, 8);
  const email = `staff-${id}@example.test`;
  const name = `Kwame Synthetic ${id}`;
  await signIn(page, "admin@example.test");
  await page.goto(`${SCHOOL.path}/members`);

  // Invite a teacher limited to one campus.
  await page.getByRole("button", { name: "Invite member" }).click();
  const invite = page.getByRole("dialog", { name: "Invite a member" });
  await invite.getByLabel("Email").fill(email);
  await invite.getByRole("checkbox", { name: "Teacher", exact: true }).check();
  await invite.getByLabel("Only selected campuses").check();
  await invite.getByLabel("Sakumono").check();
  await invite.getByRole("button", { name: "Create invitation" }).click();
  const link = await invite.getByLabel("Invitation link").inputValue();
  await invite.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("row", { name: new RegExp(email) })).toBeVisible();

  // The invitee accepts in their own browser.
  const context = await browser.newContext();
  const member = await context.newPage();
  await member.goto(new URL(link).pathname);
  await member.getByLabel("Full name").fill(name);
  await member.getByLabel("Password").fill("a-long-synthetic-password");
  await member.getByRole("button", { name: "Create account and join" }).click();
  await expect(member).toHaveURL(SCHOOL.path);

  // The admin sees the new member with their campus and changes their access.
  await page.reload();
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row.getByText("Sakumono")).toBeVisible();
  await row.getByRole("button", { name: `Edit access for ${name}` }).click();
  const edit = page.getByRole("dialog", { name: `Edit access for ${name}` });
  await edit.getByRole("checkbox", { name: "Teacher", exact: true }).uncheck();
  await edit.getByRole("button", { name: "Save access" }).click();
  await expect(edit.getByText("Choose at least one role.")).toBeVisible();
  await edit.getByLabel("Administrator").check();
  await edit.getByLabel("All campuses").check();
  await edit.getByRole("button", { name: "Save access" }).click();
  await expect(edit).toBeHidden();
  await expect(row.getByText("Administrator")).toBeVisible();
  await expect(row.getByText("All campuses")).toBeVisible();

  // Suspension locks them out on their next request.
  await row.getByRole("button", { name: `Suspend ${name}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Suspend member" }).click();
  await expect(row.getByText("Suspended")).toBeVisible();
  await member.reload();
  await expect(member.getByRole("heading", { name: "Page not found" })).toBeVisible();

  await row.getByRole("button", { name: `Reactivate ${name}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reactivate member" }).click();
  await expect(row.getByText("Active")).toBeVisible();
  await member.reload();
  await expect(member.getByRole("heading", { level: 1, name: SCHOOL.name })).toBeVisible();
  await context.close();

  // Every change is in the audit log.
  await page.goto(`${SCHOOL.path}/settings/audit`);
  await expect(page.getByRole("cell", { name: "Member reactivated" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "Member access changed" }).first()).toBeVisible();
});

test("admins cannot change owners or invite owners; invitations can be revoked", async ({ page }) => {
  await signIn(page, "admin@example.test");
  await page.goto(`${SCHOOL.path}/members`);
  const ownerRow = page.getByRole("row", { name: /Efua Mensah-Larbi/ });
  await expect(ownerRow.getByRole("button")).toHaveCount(0);
  const selfRow = page.getByRole("row", { name: /Kwabena Ofori/ });
  await expect(selfRow.getByRole("button", { name: /Suspend/ })).toHaveCount(0);
  const parentRow = page.getByRole("row", { name: /Abena Owusu/ });
  await expect(parentRow.getByRole("button", { name: /Edit access/ })).toHaveCount(0);
  await expect(parentRow.getByRole("button", { name: /Suspend/ })).toBeVisible();

  const email = `revoke-${randomUUID().slice(0, 8)}@example.test`;
  await page.getByRole("button", { name: "Invite member" }).click();
  const invite = page.getByRole("dialog", { name: "Invite a member" });
  await expect(invite.getByRole("checkbox", { name: "Proprietor" })).toHaveCount(0);
  await expect(invite.getByRole("checkbox", { name: "Head teacher" })).toBeVisible();
  await invite.getByLabel("Email").fill(email);
  await invite.getByRole("button", { name: "Create invitation" }).click();
  await invite.getByRole("button", { name: "Done" }).click();

  await page.getByRole("button", { name: `Revoke invitation for ${email}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke invitation" }).click();
  await expect(page.getByRole("row", { name: new RegExp(email) })).toHaveCount(0);
});
