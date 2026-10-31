import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

const suffix = () => randomUUID().slice(0, 8);

async function createSchool(
  page: Page,
  opts: { name: string; slug: string; ownerEmail: string; maxCampuses: number },
) {
  await page.goto("/admin/schools/new");
  await page.getByLabel("School name").fill(opts.name);
  await expect(page.getByLabel("Address")).toHaveValue(/^[a-z0-9-]+$/);
  await page.getByLabel("Address").fill(opts.slug);
  await page.getByLabel("Campus limit").fill(String(opts.maxCampuses));
  await page.getByLabel("Owner's email").fill(opts.ownerEmail);
  await page.getByRole("button", { name: "Create school" }).click();
  await expect(page.getByText("School created with a Main campus and its plan.")).toBeVisible();
  const link = await page.getByLabel("Invitation link").inputValue();
  return new URL(link).pathname;
}

test("a platform admin onboards a school and its owner sets it up", async ({ page, browser }) => {
  const id = suffix();
  const slug = `e2e-${id}`;
  const ownerEmail = `owner-${id}@example.test`;

  await signIn(page, "platform@example.test");
  await expect(page).toHaveURL("/admin");
  const invitePath = await createSchool(page, {
    name: `E2E Academy ${id}`,
    slug,
    ownerEmail,
    maxCampuses: 2,
  });

  // The owner opens the link in their own browser.
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await owner.goto(invitePath);
  await expect(owner.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await owner.getByLabel("Full name").fill("Adjoa Synthetic");
  await owner.getByLabel("Password").fill("short");
  await owner.getByRole("button", { name: "Create account and join" }).click();
  await expect(owner.getByText("Use at least 10 characters.")).toBeVisible();
  await expect(owner.getByLabel("Full name")).toHaveValue("Adjoa Synthetic");
  await owner.getByLabel("Password").fill("a-long-synthetic-password");
  await owner.getByRole("button", { name: "Create account and join" }).click();
  await expect(owner).toHaveURL(`/s/${slug}`);
  await expect(owner.getByRole("heading", { level: 1, name: `E2E Academy ${id}` })).toBeVisible();

  // The link cannot be used again.
  await owner.goto(invitePath);
  await expect(owner.getByRole("heading", { name: "Invitation unavailable" })).toBeVisible();

  // Campuses: one is created with the school; the plan allows two.
  await owner.goto(`/s/${slug}/settings/campuses`);
  await expect(owner.getByText("1 of 2 active campuses")).toBeVisible();
  await owner.getByLabel("New campus name").fill("East Legon");
  await owner.getByRole("button", { name: "Add campus" }).click();
  await expect(owner.getByText("East Legon added.")).toBeVisible();
  await expect(owner.getByRole("button", { name: "Add campus" })).toBeDisabled();
  await expect(owner.getByText(/Your plan allows 2 active campuses/)).toBeVisible();

  await owner.getByRole("button", { name: "Rename East Legon" }).click();
  await owner.getByRole("dialog").getByLabel("Campus name").fill("Main campus");
  await owner.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(owner.getByRole("dialog").getByText("Another campus already has this name.")).toBeVisible();
  await owner.getByRole("dialog").getByLabel("Campus name").fill("East Legon Annex");
  await owner.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(owner.getByRole("dialog")).toBeHidden();
  await expect(owner.getByRole("cell", { name: "East Legon Annex", exact: true })).toBeVisible();

  await owner.getByRole("button", { name: "Archive East Legon Annex" }).click();
  await owner.getByRole("dialog").getByRole("button", { name: "Archive campus" }).click();
  await expect(owner.getByRole("dialog")).toBeHidden();
  await expect(owner.getByText("1 of 2 active campuses")).toBeVisible();
  await expect(owner.getByRole("button", { name: "Add campus" })).toBeEnabled();

  // The platform admin suspends the school; the owner loses access immediately.
  await page.goto("/admin");
  await page.getByRole("link", { name: `E2E Academy ${id}` }).click();
  await page.getByRole("button", { name: "Suspend school" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Suspend school" }).click();
  await expect(page.getByText("School suspended.")).toBeVisible();
  await owner.goto(`/s/${slug}`);
  await expect(owner.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await ownerContext.close();
});

test("rejects a duplicate school address", async ({ page }) => {
  await signIn(page, "platform@example.test");
  await page.goto("/admin/schools/new");
  await page.getByLabel("School name").fill("Duplicate Address School");
  await page.getByLabel("Address").fill("kpone-ridge");
  await page.getByLabel("Owner's email").fill(`dup-${suffix()}@example.test`);
  await page.getByRole("button", { name: "Create school" }).click();
  await expect(page.getByText("This address is already used by another school.").first()).toBeVisible();
  await expect(page.getByLabel("School name")).toHaveValue("Duplicate Address School");
});

test("platform administration is invisible to everyone else", async ({ page }) => {
  await signIn(page, "owner@example.test");
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.goto("/admin/schools/new");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test("an existing user signs in to accept an invitation", async ({ page, browser }) => {
  await signIn(page, "platform@example.test");
  const invitePath = await createSchool(page, {
    name: `Second School ${suffix()}`,
    slug: `e2e-${suffix()}`,
    ownerEmail: "teacher@example.test",
    maxCampuses: 1,
  });
  const context = await browser.newContext();
  const teacher = await context.newPage();
  await teacher.goto(invitePath);
  await expect(teacher.getByRole("heading", { name: "Sign in to accept" })).toBeVisible();
  await teacher.getByRole("link", { name: "Sign in" }).click();
  await teacher.getByLabel("Email").fill("teacher@example.test");
  await teacher.getByLabel("Password").fill("edubridge-dev-only");
  await teacher.getByRole("button", { name: "Sign in" }).click();
  await expect(teacher.getByRole("heading", { name: "Join your school" })).toBeVisible();
  await teacher.getByRole("button", { name: "Accept invitation" }).click();
  await expect(teacher).toHaveURL(/\/s\/e2e-/);
  await context.close();
});
