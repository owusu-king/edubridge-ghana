import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });

test("redirects signed-out visitors to sign in, then back to where they were going", async ({ page }) => {
  await page.goto(`${SCHOOL.path}/members`);
  await expect(page).toHaveURL(/\/login\?next=%2Fs%2Fkpone-ridge%2Fmembers$/);
  await signIn(page, "owner@example.test", `${SCHOOL.path}/members`);
  await expect(page).toHaveURL(`${SCHOOL.path}/members`);
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  await expect(page.getByRole("cell", { name: /Yaw Boateng/ })).toBeVisible();
});

test("shows one generic error for bad credentials", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(`nobody-${randomUUID().slice(0, 8)}@example.test`);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "The email or password is incorrect." }),
  ).toBeVisible();
});

test("ignores off-site redirect targets after sign in", async ({ page }) => {
  await signIn(page, "admin@example.test", "//evil.example/phish");
  await expect(page).toHaveURL(`${SCHOOL.path}`);
});

test("signs out and invalidates the session", async ({ page }) => {
  await signIn(page, "admin@example.test");
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/login");
  await page.goto(`${SCHOOL.path}`);
  await expect(page).toHaveURL(/\/login/);
});

test("the API accepts the session as a bearer token", async ({ page, request }) => {
  await signIn(page, "teacher@example.test");
  const cookie = (await page.context().cookies()).find((c) => c.name.endsWith("eb_session"));
  expect(cookie).toBeDefined();
  const unauthenticated = await request.get("/api/v1/me", { headers: { cookie: "" } });
  expect(unauthenticated.status()).toBe(401);
  const response = await request.get("/api/v1/me", { headers: { authorization: `Bearer ${cookie!.value}` } });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.user.email).toBe("teacher@example.test");
  expect(body.schools).toHaveLength(2);
});
