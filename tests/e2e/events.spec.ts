import { randomInt } from "node:crypto";
import { expect, test } from "@playwright/test";
import { mailboxCount, SCHOOL, signIn, waitForMessage } from "./helpers";

/**
 * Events and consent forms (R3-3): the head teacher adds an event for KG 1 and asks for consent; Nana
 * Agyeman's father answers from the parent view, and the school sees his answer.
 */
test.describe.configure({ mode: "serial" });

const KOFI = "+233205550111";
const tag = String(randomInt(1000, 9999));
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

test("an event with a consent form, answered by a parent", async ({ page, browser }) => {
  const event = `Science fair ${tag}`;
  const form = `Science fair trip ${tag}`;
  await signIn(page, "head@example.test", `${SCHOOL.path}/events`);
  await page.goto(`${SCHOOL.path}/events`);
  await expect(page.getByRole("heading", { level: 1, name: "Events" })).toBeVisible();

  await page.getByRole("button", { name: "New event" }).first().click();
  const add = page.getByRole("dialog", { name: "New event" });
  await add.getByLabel("Event", { exact: true }).fill(event);
  await add.getByLabel("Day", { exact: true }).fill(inDays(7));
  await add.getByLabel("Starts at (optional)").fill("09:00");
  await add.getByLabel("Place (optional)").fill("Accra International Conference Centre");
  await add.getByLabel("For", { exact: true }).selectOption({ label: "KG 1" });
  await add.getByRole("button", { name: "Add event" }).click();
  await expect(add).toBeHidden();
  const row = page.getByRole("listitem").filter({ hasText: event });
  await expect(row).toContainText("Accra International Conference Centre");

  await row.getByRole("link", { name: "Ask for consent" }).click();
  const ask = page.getByRole("dialog", { name: "New consent form" });
  await ask.getByLabel("Title", { exact: true }).fill(form);
  await ask
    .getByLabel("What families are agreeing to")
    .fill("Your child will travel by school bus to the science fair.");
  await ask.getByLabel("Last day for answers").fill(inDays(5));
  await ask.getByRole("button", { name: "Send the form" }).click();
  await expect(page.getByRole("heading", { name: form })).toBeVisible();
  const nana = page.getByRole("row").filter({ hasText: "Nana Agyeman" });
  await expect(nana).toContainText("Waiting");

  // The father signs in to the parent view on his own phone.
  const parent = await (await browser.newContext()).newPage();
  await parent.goto("/p/login");
  const before = mailboxCount(KOFI, /EduBridge code: \d{6}/);
  await parent.getByLabel("Mobile number").fill("020 555 0111");
  await parent.getByRole("button", { name: "Text me a code" }).click();
  const sms = await waitForMessage(KOFI, /EduBridge code: \d{6}/, before);
  await parent.getByLabel("Code").fill(sms.text.match(/\d{6}/)![0]);
  await parent.getByRole("button", { name: "Sign in" }).click();
  const waiting = parent.getByRole("region", { name: "Waiting for your answer" });
  await waiting.getByRole("link", { name: new RegExp(form) }).click();
  await expect(parent.getByRole("heading", { name: form })).toBeVisible();
  await expect(parent.getByText(event)).toBeVisible();
  await parent.getByLabel("Note for the school (optional)").fill("He gets travel sick");
  await parent.getByRole("button", { name: "Yes for Nana" }).click();
  await expect(parent.getByText("You answered yes.")).toBeVisible();
  await parent.goto("/p/kpone-ridge/events");
  await expect(parent.getByRole("listitem").filter({ hasText: event })).toContainText("For Nana");

  await page.reload();
  await expect(nana).toContainText("Yes");
  await expect(nana).toContainText("He gets travel sick");
  await expect(nana).toContainText("Kofi Agyeman, parent view");
});
