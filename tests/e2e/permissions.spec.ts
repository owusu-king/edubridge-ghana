import { expect, test } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

test("teachers see only what their role allows", async ({ page }) => {
  await signIn(page, "teacher@example.test");
  await page.goto(`${SCHOOL.path}`);
  const nav = page.getByRole("navigation", { name: "School" });
  await expect(nav.getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Members" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Settings" })).toHaveCount(0);

  // Page-level checks run inside a streaming boundary, so the status may already be 200; the content must be the 404.
  await page.goto(`${SCHOOL.path}/members`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.getByText("Yaw Boateng")).toHaveCount(0);
});

test("a school the user does not belong to is indistinguishable from one that does not exist", async ({
  page,
}) => {
  await signIn(page, "parent@example.test");
  const foreign = await page.goto("/s/adenta-hall");
  const missing = await page.goto("/s/no-such-school");
  expect(foreign?.status()).toBe(404);
  expect(missing?.status()).toBe(404);
});

test("users with several schools are asked to choose", async ({ page }) => {
  await signIn(page, "owner@example.test");
  await expect(page).toHaveURL("/schools");
  await page.getByRole("link", { name: /Adenta Hall Academy/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Adenta Hall Academy" })).toBeVisible();
});

test("administrators can update the school profile", async ({ page }) => {
  // Shared seed school: other tests read its name concurrently, so only the time zone is changed here.
  await signIn(page, "admin@example.test");
  await page.goto(`${SCHOOL.path}/settings`);

  await page.getByLabel("School name").fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Enter the school's name.")).toBeVisible();
  await expect(page.getByLabel("School name")).toHaveValue("");

  await page.getByLabel("School name").fill(SCHOOL.name);
  await page.getByLabel("Time zone").selectOption("UTC");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("School profile saved.")).toBeVisible();

  await page.goto(`${SCHOOL.path}/settings/audit`);
  await expect(
    page.getByRole("row", { name: /School profile updated.*timezone: Africa\/Accra → UTC/ }).first(),
  ).toBeVisible();

  await page.goto(`${SCHOOL.path}/settings`);
  await page.getByLabel("Time zone").selectOption("Africa/Accra");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("School profile saved.")).toBeVisible();
});

test("the school's two-step policy is enforced for required roles", async ({ page }) => {
  // Kpone Ridge keeps the default policy (owners and bursars); the seeded owner has not set it up.
  await signIn(page, "owner@example.test");
  await page.goto(SCHOOL.path);
  await expect(page).toHaveURL("/account/security?required=school");
  // Adenta Hall's policy requires no roles, so the same owner can enter it.
  await page.goto("/s/adenta-hall");
  await expect(page.getByRole("heading", { level: 1, name: "Adenta Hall Academy" })).toBeVisible();
});
