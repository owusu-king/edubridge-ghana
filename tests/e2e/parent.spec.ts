import { expect, test } from "@playwright/test";
import { mailboxCount, SCHOOL, signIn, waitForMessage } from "./helpers";

// Grace Mensah (+233 54 555 0122) is the seeded guardian of Kwame Mensah (receipt R000002) and Efua Ofori.
// One code per run: codes are limited to 3 per number in 15 minutes.
const GRACE = "+233545550122";

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("a parent signs in with a texted code and sees each child's fees, statement and receipts", async ({
    page,
  }) => {
    await page.goto("/p");
    await expect(page).toHaveURL(/\/p\/login$/);
    const before = mailboxCount(GRACE, /EduBridge code: \d{6}/);
    await page.getByLabel("Mobile number").fill("054 555 0122");
    await page.getByRole("button", { name: "Text me a code" }).click();
    await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
    await expect(page.getByText("+233••••••122")).toBeVisible();
    const sms = await waitForMessage(GRACE, /EduBridge code: \d{6}/, before);
    await page.getByLabel("Code").fill(sms.text.match(/\d{6}/)![0]);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("heading", { name: "Your children" })).toBeVisible();
    const school = page.getByRole("region", { name: SCHOOL.name });
    await expect(school.getByRole("link", { name: /Efua Ofori/ })).toBeVisible();
    await school.getByRole("link", { name: /Kwame Mensah/ }).click();

    await expect(page.getByRole("heading", { name: "Kwame Mensah" })).toBeVisible();
    await expect(page.getByText(/School fees as of/)).toBeVisible();
    const receipt = page.getByRole("link", { name: "Download receipt R000002 (PDF)" });
    const pdf = await page.request.get((await receipt.getAttribute("href"))!);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    const statement = await page.request.get(
      (await page.getByRole("link", { name: "Download statement (PDF)" }).getAttribute("href"))!,
    );
    expect((await statement.body()).subarray(0, 5).toString()).toBe("%PDF-");
    // Touch targets are at least 44 px tall on the parent pages.
    expect((await receipt.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    // A child the number does not reach is simply not found.
    const other = await page.goto(`/p/kpone-ridge/00000000-0000-4000-8000-000000000000`);
    expect(other!.status()).toBe(404);

    // School news and how to reach the office, from the family home.
    await page.goto("/p");
    await page
      .getByRole("region", { name: SCHOOL.name })
      .getByRole("link", { name: /School news/ })
      .click();
    await expect(page.getByRole("heading", { name: `News from ${SCHOOL.name}` })).toBeVisible();
    await expect(page.getByRole("link", { name: "Call +233 30 200 0100" })).toHaveAttribute(
      "href",
      "tel:+233302000100",
    );
    await expect(page.getByRole("link", { name: /WhatsApp/ })).toHaveAttribute(
      "href",
      "https://wa.me/233245550100",
    );
    await expect(page.getByText("Office hours: Weekdays 7:30 to 16:00")).toBeVisible();

    await page.goto("/p");
    await expect(
      page.getByRole("region", { name: SCHOOL.name }).getByRole("link", { name: /School news/ }),
    ).not.toContainText(/\d+ new/);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/p\/login$/);
    await page.goto("/p");
    await expect(page).toHaveURL(/\/p\/login$/);
  });
});

test("the head teacher blocks a guardian from the parent view and allows them again", async ({ page }) => {
  await signIn(page, "head@example.test");
  await page.goto(`${SCHOOL.path}/students?q=Kojo%20Addo`);
  await page.getByRole("link", { name: "Kojo Addo" }).click();
  await page.getByRole("button", { name: "Block Adjoa Addo from the parent view" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Block" }).click();
  await expect(page.getByText("Blocked from parent view")).toBeVisible();
  await page.getByRole("button", { name: "Allow Adjoa Addo to use the parent view" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Allow" }).click();
  await expect(page.getByText("Blocked from parent view")).toHaveCount(0);
});
