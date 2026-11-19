import { expect, test } from "@playwright/test";
import { ACCOUNTANT_AUTH, SCHOOL, signIn } from "./helpers";

// Runs in order: the Accountant keeps stock and asks to buy more, but cannot approve; the Proprietor cannot
// approve their own request; a teacher reports a repair and the head teacher closes it. Names carry a marker so
// repeated runs do not collide.
test.describe.configure({ mode: "serial" });

const marker = Date.now().toString(36);
const item = `Exam paper ${marker}`;
const purchase = `Paper for exams ${marker}`;
const repair = `Broken window ${marker}`;

test.describe("the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("adds a stock item, receives and issues it, and asks to buy more", async ({ page }) => {
    await page.goto(`${SCHOOL.path}/inventory`);
    await page.getByRole("button", { name: "Add an item" }).click();
    const add = page.getByRole("dialog", { name: "Add a stock item" });
    await add.getByLabel("Name").fill(item);
    await add.getByLabel("Unit").fill("ream");
    await add.getByLabel(/Reorder level/).fill("5");
    await add.getByRole("button", { name: "Save" }).click();
    await expect(add).toBeHidden();
    await page.getByRole("link", { name: item }).click();

    await page.getByRole("button", { name: "Receive" }).click();
    const receive = page.getByRole("dialog", { name: "Receive stock" });
    await receive.getByLabel(/How many arrived/).fill("10");
    await receive.getByRole("button", { name: "Add to stock" }).click();
    await expect(receive).toBeHidden();
    await expect(page.getByText("10 ream", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Issue" }).click();
    const issue = page.getByRole("dialog", { name: "Issue stock" });
    await issue.getByLabel(/How many/).fill("20");
    await issue.getByLabel("To whom or where").fill("Basic 4A");
    await issue.getByRole("button", { name: "Issue" }).click();
    await expect(issue.getByText("Only 10 ream on hand")).toBeVisible();
    await issue.getByLabel(/How many/).fill("7");
    await issue.getByRole("button", { name: "Issue" }).click();
    await expect(issue).toBeHidden();
    await expect(page.getByText("3 ream", { exact: true })).toBeVisible();
    await expect(page.getByText("Low: order more")).toBeVisible();

    await page.goto(`${SCHOOL.path}/inventory/purchases`);
    await page.getByRole("button", { name: "Request a purchase" }).click();
    const request = page.getByRole("dialog", { name: "Request a purchase" });
    await request.getByLabel("What it is for").fill(purchase);
    await request.getByLabel("Item 1").fill("A4 paper");
    await request.getByLabel("Quantity").first().fill("20");
    await request
      .getByLabel(/Unit price/)
      .first()
      .fill("45");
    await request.getByLabel("Stock item").first().selectOption({ label: item });
    await request.getByRole("button", { name: "Send for approval" }).click();
    await expect(request).toBeHidden();
    const row = page.getByRole("row").filter({ hasText: purchase });
    await expect(row.getByText("Waiting for approval")).toBeVisible();
    await expect(row.getByText("GH₵900.00")).toBeVisible();
  });
});

test.describe("the accountant again", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("cannot approve the request: that is the Proprietor's", async ({ page }) => {
    await page.goto(`${SCHOOL.path}/inventory/purchases`);
    await page.getByRole("link", { name: new RegExp(purchase) }).click();
    await expect(page.getByRole("cell", { name: "GH₵900.00" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel request" })).toBeVisible();
  });
});

// Kpone Ridge asks its Proprietor for two-step verification, so the Proprietor's part runs at Adenta Hall.
// Approving and receiving are covered by the integration tests (tests/integration/inventory.test.ts).
test("the Proprietor cannot approve their own request, and cancels it", async ({ page }) => {
  const adenta = "/s/adenta-hall";
  const own = `New printer ${marker}`;
  await signIn(page, "owner@example.test", `${adenta}/inventory/purchases`);
  await page.goto(`${adenta}/inventory/purchases`);
  await page.getByRole("button", { name: "Request a purchase" }).click();
  const request = page.getByRole("dialog", { name: "Request a purchase" });
  await request.getByLabel("What it is for").fill(own);
  await request.getByLabel("Item 1").fill("Laser printer");
  await request.getByLabel("Quantity").first().fill("1");
  await request.getByRole("button", { name: "Send for approval" }).click();
  await expect(request).toBeHidden();
  await page.getByRole("link", { name: new RegExp(own) }).click();
  await expect(page.getByText("This is your own request: someone else must decide on it.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel request" }).click();
  const cancel = page.getByRole("dialog", { name: /^Cancel PR/ });
  await cancel.getByRole("button", { name: "Cancel request" }).click();
  await expect(cancel).toBeHidden();
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
});

test("a teacher reports a repair and the head teacher closes it", async ({ page, browser }) => {
  await signIn(page, "teacher@example.test", `${SCHOOL.path}/inventory/maintenance`);
  await page.goto(`${SCHOOL.path}/inventory/maintenance`);
  await page.getByRole("button", { name: "Report something" }).click();
  const report = page.getByRole("dialog", { name: "Report something that needs fixing" });
  await report.getByLabel("What needs fixing").fill(repair);
  await report.getByLabel(/Where/).fill("Basic 4A");
  await report.getByLabel("How urgent").selectOption({ label: "Urgent" });
  await report.getByRole("button", { name: "Report" }).click();
  await expect(report).toBeHidden();
  await expect(page.getByRole("link", { name: new RegExp(repair) })).toBeVisible();
  // Teachers see only Maintenance, not stock.
  await expect(page.getByRole("navigation", { name: "Inventory" })).toHaveCount(0);

  const head = await (await browser.newContext()).newPage();
  await signIn(head, "head@example.test", `${SCHOOL.path}/inventory/maintenance`);
  await head.goto(`${SCHOOL.path}/inventory/maintenance`);
  await head.getByRole("link", { name: new RegExp(repair) }).click();
  await head.getByRole("button", { name: "Update" }).click();
  const update = head.getByRole("dialog", { name: "Update this request" });
  await update.getByLabel("Status").selectOption({ label: "Done" });
  await update.getByLabel(/Note/).fill("Glass replaced.");
  await update.getByRole("button", { name: "Save" }).click();
  await expect(update).toBeHidden();
  await expect(head.getByText("Glass replaced.")).toBeVisible();
});
