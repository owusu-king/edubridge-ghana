import { expect, test } from "@playwright/test";
import { PLATFORM_AUTH, signIn } from "./helpers";

// Adenta Hall: its Proprietor has no two-step requirement. Access is ended at the end of the test.
test("the Proprietor lets support in for a while, and sees what support opened", async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage();
  await signIn(owner, "owner@example.test", "/s/adenta-hall/settings/support");
  await owner.goto("/s/adenta-hall/settings/support");
  await expect(owner.getByText("EduBridge support cannot open the school.")).toBeVisible();
  await owner.getByLabel("For how long").selectOption({ label: "4 hours" });
  await owner.getByLabel(/What do you need help with/).fill("Setting up fees");
  await owner.getByRole("button", { name: "Allow support access" }).click();
  await expect(owner.getByText("Support access allowed.")).toBeVisible();
  await expect(owner.getByText(/EduBridge support can open the school until/).first()).toBeVisible();

  const support = await (await browser.newContext({ storageState: PLATFORM_AUTH })).newPage();
  await support.goto("/admin");
  await support.getByRole("link", { name: "Adenta Hall" }).first().click();
  await expect(support.getByText(/Setting up fees/)).toBeVisible();
  await support.getByRole("link", { name: "Open the school as support" }).click();
  await expect(support.getByText(/You are here as EduBridge support/)).toBeVisible();
  await support.goto("/s/adenta-hall/settings/calendar");
  // Support access stays the school's decision.
  await expect(support.getByRole("link", { name: "Support access" })).toHaveCount(0);
  await support.goto("/s/adenta-hall/settings/support");
  await expect(support.getByRole("heading", { name: "Page not found" })).toBeVisible();

  await owner.reload();
  await expect(owner.getByText("Opened /s/adenta-hall/settings/calendar")).toBeVisible();
  await owner.getByRole("button", { name: "End support access now" }).click();
  await expect(owner.getByText("EduBridge support cannot open the school.")).toBeVisible();

  // The next page support opens is not found.
  await support.goto("/s/adenta-hall");
  await expect(support.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
