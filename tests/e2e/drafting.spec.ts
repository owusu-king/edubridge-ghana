import { expect, test } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

// AI is off in this environment: each form says drafting is not available and works as before (integration tests
// check the drafts themselves, with a scripted model).

test("the class teacher's report card says suggestions are not available while AI is off", async ({
  page,
}) => {
  await signIn(page, "teacher@example.test", `${SCHOOL.path}/assessment`);
  await page.goto(`${SCHOOL.path}/assessment`);
  await page.getByRole("link", { name: "Basic 4A" }).click();
  await page.getByRole("link", { name: "Esi Quaye" }).click();
  await expect(page.getByRole("heading", { name: /Esi Quaye/ })).toBeVisible();
  await expect(page.getByText(/Suggested remarks are not available: AI is not switched on/)).toBeVisible();
  await expect(page.getByLabel("Class teacher's remark")).toBeEditable();
});

test("the announcement form offers drafting, and says why it is not available", async ({ page }) => {
  await signIn(page, "head@example.test");
  await page.goto(`${SCHOOL.path}/announcements`);
  await page.getByRole("button", { name: "New announcement" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Draft it from a few points").click();
  await expect(dialog.getByText(/Drafting is not available: AI is not switched on/)).toBeVisible();
  await expect(dialog.getByLabel("Title", { exact: true })).toBeEditable();
});

test("the board report is the Proprietor's, and handles a school without terms", async ({
  page,
  browser,
}) => {
  // Adenta Hall: the seeded Proprietor's school that does not require two-step verification, and has no terms yet.
  await signIn(page, "owner@example.test", "/s/adenta-hall/board-report");
  await page.goto("/s/adenta-hall/board-report");
  await expect(page.getByRole("heading", { name: "Board report", level: 1 })).toBeVisible();
  await expect(page.getByText("No terms yet")).toBeVisible();
  // Not for the head teacher.
  const head = await (await browser.newContext()).newPage();
  await signIn(head, "head@example.test", `${SCHOOL.path}/board-report`);
  await head.goto(`${SCHOOL.path}/board-report`);
  await expect(head.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await head.context().close();
});
