import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });

test("redirects signed-out visitors to sign in, then back to where they were going", async ({ page }) => {
  await page.goto(`${SCHOOL.path}/members`);
  await expect(page).toHaveURL(/\/login\?next=%2Fs%2Fkpone-ridge%2Fmembers$/);
  await signIn(page, "admin@example.test", `${SCHOOL.path}/members`);
  await expect(page).toHaveURL(`${SCHOOL.path}/members`);
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Yaw Boateng/ })).toBeVisible();
});

test("shows one generic error for bad credentials", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(`nobody-${randomUUID().slice(0, 8)}@example.test`);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "The sign-in details are incorrect." }),
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

test("the API reads with the web session, but takes only device tokens as bearer tokens", async ({
  page,
  request,
}) => {
  await signIn(page, "teacher@example.test");
  const cookie = (await page.context().cookies()).find((c) => c.name.endsWith("eb_session"));
  expect(cookie).toBeDefined();
  const unauthenticated = await request.get("/api/v1/me", { headers: { cookie: "" } });
  expect(unauthenticated.status()).toBe(401);
  // A web session token is not a device token: refused as a bearer token.
  const asBearer = await request.get("/api/v1/me", {
    headers: { cookie: "", authorization: `Bearer ${cookie!.value}` },
  });
  expect(asBearer.status()).toBe(401);
  // The browser's own session cookie may read.
  const response = await page.request.get("/api/v1/me");
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.user.email).toBe("teacher@example.test");
  expect(body.schools.map((s: { slug: string }) => s.slug)).toEqual(
    expect.arrayContaining(["kpone-ridge", "adenta-hall"]),
  );
  // A device signs in for a token of its own.
  const signedIn = await request.post("/api/v1/auth/token", {
    headers: { cookie: "" },
    data: { identifier: "teacher@example.test", password: "edubridge-dev-only", deviceName: "Playwright" },
  });
  const { token } = await signedIn.json();
  expect(token).toMatch(/^ebd_/);
  const withToken = await request.get("/api/v1/me", {
    headers: { cookie: "", authorization: `Bearer ${token}` },
  });
  expect(withToken.status()).toBe(200);
});
