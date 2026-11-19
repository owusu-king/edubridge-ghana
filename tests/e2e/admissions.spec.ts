import { randomInt } from "node:crypto";
import { expect, test } from "@playwright/test";
import { SCHOOL, signIn, waitForMessage } from "./helpers";

/**
 * Admissions (R3-4): the head teacher takes a walk-in applicant to enrolment, and a family applies online.
 * Each run uses its own names and numbers, so it never touches another spec's students.
 */
test.describe.configure({ mode: "serial" });

const tag = String(randomInt(1000, 9999));
const localPhone = () => `024${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;

test("the head teacher records an applicant, offers a place and enrols the child", async ({ page }) => {
  await signIn(page, "head@example.test", `${SCHOOL.path}/admissions`);
  await page.goto(`${SCHOOL.path}/admissions`);
  await expect(page.getByRole("heading", { level: 1, name: "Admissions" })).toBeVisible();

  await page.getByRole("button", { name: "New inquiry or application" }).click();
  const dialog = page.getByRole("dialog", { name: "New inquiry or application" });
  await dialog.getByLabel("This is").selectOption("applied");
  await dialog.getByLabel("Child's first name").fill(`Abena${tag}`);
  await dialog.getByLabel("Surname").fill("Owusu");
  await dialog.getByLabel("Sex").selectOption("female");
  await dialog.getByLabel("Level applying for").selectOption({ label: "Basic 4" });
  await dialog.getByLabel("Parent or guardian").fill("Ama Owusu");
  await dialog.getByLabel("Phone").fill(localPhone());
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: `Abena${tag} Owusu` })).toBeVisible();

  await page.getByRole("button", { name: "Make an offer" }).click();
  const offer = page.getByRole("dialog", { name: "Offer a place" });
  await offer.getByLabel("Starts in").selectOption({ index: 1 });
  await offer.getByLabel("Class (optional)").selectOption({ label: "Basic 4B" });
  await offer.getByRole("button", { name: "Make the offer" }).click();
  await expect(offer).toBeHidden();
  await expect(page.getByRole("link", { name: "Offer letter (PDF)" })).toBeVisible();

  await page.getByRole("button", { name: "Enrol" }).click();
  const enrol = page.getByRole("dialog", { name: /enrol the child/ });
  await expect(enrol.getByLabel("Class")).toHaveValue(/.+/);
  await enrol.getByRole("button", { name: "Enrol" }).click();
  await expect(page).toHaveURL(new RegExp(`${SCHOOL.path}/students/[0-9a-f-]{36}`));
  await expect(page.getByRole("heading", { name: new RegExp(`Abena${tag} Owusu`) })).toBeVisible();
});

test("a family applies online after confirming their phone", async ({ page, browser }) => {
  await signIn(page, "head@example.test", `${SCHOOL.path}/admissions/settings`);
  await page.goto(`${SCHOOL.path}/admissions/settings`);
  const choice = page
    .locator("form")
    .filter({ has: page.getByRole("group", { name: "Online applications" }) });
  await choice.getByRole("radio", { name: /Families can apply online/ }).check();
  await choice.getByRole("button", { name: "Save" }).click();
  // Confirmed by a short message at the bottom of the page.
  await expect(page.getByRole("status").getByText("Saved.")).toBeVisible();

  // The family has no account: a fresh browser with no sign-in.
  const family = await (await browser.newContext()).newPage();
  await family.goto(`/apply/${SCHOOL.path.split("/").pop()}`);
  await expect(family.getByRole("heading", { name: `Apply to ${SCHOOL.name}` })).toBeVisible();
  const phone = localPhone();
  await family.getByLabel("First name").fill(`Kojo${tag}`);
  await family.getByLabel("Surname").fill("Mensah");
  await family.getByLabel("Sex").selectOption("male");
  await family.getByLabel("Date of birth").fill("2018-05-06");
  await family.getByLabel("Class applying for").selectOption({ label: "Basic 4" });
  await family.getByLabel("Your full name").fill("Grace Mensah");
  await family.getByLabel("Mobile number").fill(phone);
  await family.getByRole("button", { name: "Send the code to my phone" }).click();
  const sms = await waitForMessage(`+233${phone.slice(1)}`, /application code/);
  const code = /(\d{6})/.exec(sms.text)![1]!;
  await family.getByLabel("Code").fill(code);
  await family.getByRole("button", { name: "Send application" }).click();
  await expect(family.getByText("Application sent")).toBeVisible();

  await page.goto(`${SCHOOL.path}/admissions?status=applied`);
  const row = page.getByRole("row").filter({ hasText: `Kojo${tag} Mensah` });
  await expect(row).toContainText("Online application");
});
