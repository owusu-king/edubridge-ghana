import { expect, test } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

test("a head teacher registers a student while offline; it is sent when the connection returns", async ({
  page,
  context,
}) => {
  await signIn(page, "head@example.test", `${SCHOOL.path}/students/register`);
  await page.goto(`${SCHOOL.path}/students/register`);
  await expect(page.getByRole("heading", { name: "Register students" })).toBeVisible();
  await context.setOffline(true);
  await page.getByLabel("First name").fill("Esi");
  await page.getByLabel("Surname").fill("Offlineson");
  await page.getByLabel("Sex").selectOption("female");
  await page.getByRole("button", { name: "Register student" }).click();
  await expect(page.getByText(/kept on this device/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting to send (1)" })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByRole("heading", { name: "Registered just now" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Esi Offlineson, \S+/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting to send (0)" })).toBeVisible();

  // Entered again (say, on another device): the school asks before adding a second Esi Offlineson.
  await page.getByLabel("First name").fill("Esi");
  await page.getByLabel("Surname").fill("Offlineson");
  await page.getByLabel("Sex").selectOption("female");
  await page.getByRole("button", { name: "Register student" }).click();
  await expect(page.getByRole("heading", { name: "Already on record?" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Same child: discard" }).click();
  await expect(page.getByRole("heading", { name: "Already on record?" })).toHaveCount(0);
});

test("a class teacher saves marks while offline and they are sent later", async ({ page, context }) => {
  await signIn(page, "teacher@example.test", `${SCHOOL.path}/assessment`);
  await page.goto(`${SCHOOL.path}/assessment`);
  await page.getByRole("link", { name: "Basic 4A" }).click();
  await page.getByRole("link", { name: "Enter Mathematics scores" }).click();
  const mark = page.getByLabel("Akua Owusu, Class score (out of 50)");
  // Wait for the sheet itself before the connection goes.
  await expect(mark).toBeVisible();
  await context.setOffline(true);
  await mark.fill("37");
  await page.getByRole("button", { name: "Save scores" }).click();
  await expect(page.getByText(/You are offline\. 1 mark is kept on this device/)).toBeVisible();
  await expect(page.getByText(/kept on this device, waiting for a connection/)).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText(/waiting for a connection/)).toHaveCount(0, { timeout: 15_000 });
  await page.reload();
  await expect(page.getByLabel("Akua Owusu, Class score (out of 50)")).toHaveValue("37");
});

test("a head teacher asks another school for a child's records, sees insights and the assistant", async ({
  page,
}) => {
  await signIn(page, "head@example.test", `${SCHOOL.path}/students/transfers`);
  await page.goto(`${SCHOOL.path}/students/transfers`);
  await expect(page.getByRole("heading", { name: "Transfers", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Request a child's records" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("School the child is leaving").selectOption({ label: "Adenta Hall Academy" });
  await dialog.getByLabel("Child's first name").fill("Yaa");
  await dialog.getByLabel("Surname").fill("Asantewaa");
  await dialog.getByLabel("Guardian's mobile number").fill("024 555 0177");
  await dialog.getByRole("button", { name: "Send request" }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole("row", { name: /Yaa Asantewaa/ });
  await expect(row).toContainText("Waiting for the family");
  await expect(row).toContainText("Adenta Hall Academy");

  await page.goto(`${SCHOOL.path}/insights`);
  await expect(page.getByRole("heading", { name: "Term by term" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Students to follow up" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Outstanding work" })).toBeVisible();

  await page.goto(`${SCHOOL.path}/assistant`);
  // The assistant is a paid service: off in this environment.
  await expect(page.getByText("The assistant is not switched on for EduBridge yet.")).toBeVisible();

  await page.goto("/account/devices");
  await expect(page.getByText("No apps or devices are signed in with your account.")).toBeVisible();
});

test("anyone can check a learner record, without signing in", async ({ page }) => {
  await page.goto("/verify");
  await expect(page.getByRole("heading", { name: "Check a learner record" })).toBeVisible();
  await page
    .getByLabel("Or paste the file's contents")
    .fill('{"format":"edubridge.learner-record","version":1}');
  await page.getByRole("button", { name: "Check record" }).click();
  await expect(page.getByText(/Not genuine\./)).toBeVisible();
});

test("the API answers device sign-in with the documented error format", async ({ request }) => {
  const index = await request.get("/api/v1");
  expect(index.status()).toBe(200);
  expect((await index.json()).routes.length).toBeGreaterThan(10);
  const bad = await request.post("/api/v1/auth/token", {
    data: { identifier: "head@example.test", password: "wrong password", deviceName: "Playwright" },
  });
  expect(bad.status()).toBe(401);
  expect((await bad.json()).error.code).toBe("invalid_credentials");
  const ok = await request.post("/api/v1/auth/token", {
    data: { identifier: "bursar@example.test", password: "edubridge-dev-only", deviceName: "Playwright" },
  });
  const body = await ok.json();
  // The accountant uses two-step verification in the seed, so a challenge comes back first.
  expect(body.token ?? body.challenge).toBeTruthy();
});
