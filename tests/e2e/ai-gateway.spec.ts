import { expect, test } from "@playwright/test";
import { PLATFORM_AUTH, signIn } from "./helpers";

// AI stays off throughout (other specs expect it off): these check the settings and what schools are told.

test.describe("as platform staff", () => {
  test.use({ storageState: PLATFORM_AUTH });

  test("choose a free provider without switching AI on, and see the limits", async ({ page }) => {
    await page.goto("/admin/integrations");
    await expect(page.getByRole("heading", { name: "AI", exact: true })).toBeVisible();
    await expect(page.getByText("Off for the platform")).toBeVisible();
    const form = page.locator("form").filter({ has: page.getByLabel("Provider") });
    await form.getByLabel("Provider").selectOption({ label: "Ollama (on our own machine)" });
    await expect(form.getByText(/nothing leaves the machine/)).toBeVisible();
    // Free and local providers are never approved for identifiable data.
    await expect(form.getByLabel("Approved for identifiable data")).toHaveCount(0);
    await expect(form.getByText(/De-identified only/)).toBeVisible();
    await form.getByLabel("Model").fill("llama3.1:8b");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("AI settings saved.")).toBeVisible();
    await expect(page.getByText("Ollama (on our own machine) · llama3.1:8b")).toBeVisible();
    await expect(page.getByText("Off for the platform")).toBeVisible();
    await expect(page.getByLabel("Each school, tokens a month")).toHaveValue("500000");
    // Back to no provider, as the other specs expect.
    await form.getByLabel("Provider").selectOption({ label: "None (AI off)" });
    await form.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("AI settings saved.")).toBeVisible();
  });
});

test("the Proprietor sees what the assistant would send, and this month's use", async ({ page }) => {
  // Adenta Hall: the seeded Proprietor's second school, which does not require two-step verification.
  await signIn(page, "owner@example.test", "/s/adenta-hall/settings/assistant");
  await page.goto("/s/adenta-hall/settings/assistant");
  await expect(page.getByText(/is not approved for identifiable data, so names/)).toBeVisible();
  await expect(page.getByText(/This month: \d[\d,]* of [\d,]+ tokens used/)).toBeVisible();
});
