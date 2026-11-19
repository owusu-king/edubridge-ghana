import { expect, test } from "@playwright/test";
import { ACCOUNTANT_AUTH, SCHOOL, signIn } from "./helpers";

// Runs in order: the office sets up a route and puts a child on it, the teacher on the bus marks the morning
// trip, and the Accountant sets the fare. Names carry a marker so repeated runs do not collide.
test.describe.configure({ mode: "serial" });

const marker = Date.now().toString(36);
const route = `Route ${marker}`;
const stop = `Junction ${marker}`;

test("the office adds a route with a stop and puts a child on it", async ({ page }) => {
  await signIn(page, "admin@example.test", `${SCHOOL.path}/transport`);
  await page.goto(`${SCHOOL.path}/transport`);
  await page.getByRole("button", { name: "Add a route" }).click();
  const add = page.getByRole("dialog", { name: "Add a route" });
  await add.getByLabel("Name").fill(route);
  await add.getByLabel("Vehicle").selectOption({ label: "Bus 1" });
  await add.getByRole("button", { name: "Save" }).click();
  await expect(add).toBeHidden();
  await page.getByRole("link", { name: route }).click();
  await expect(page.getByRole("heading", { name: route })).toBeVisible();

  await page.getByRole("button", { name: "Add a stop" }).click();
  const addStop = page.getByRole("dialog", { name: "Add a stop" });
  await addStop.getByLabel("Stop").fill(stop);
  await addStop.getByLabel("Morning time (optional)").fill("06:40");
  await addStop.getByRole("button", { name: "Save" }).click();
  await expect(addStop).toBeHidden();
  await expect(page.getByRole("cell", { name: stop, exact: true })).toBeVisible();

  await page.goto(`${SCHOOL.path}/transport/students`);
  await page.getByRole("button", { name: "Put a student on a route" }).click();
  const assign = page.getByRole("dialog", { name: "Put a student on a route" });
  await assign.getByLabel("Student").selectOption({ label: "Abena Asante" });
  await assign.getByLabel("Stop").selectOption({ label: stop });
  await assign.getByLabel("Rides").selectOption({ label: "Both ways" });
  await assign.getByRole("button", { name: "Save" }).click();
  await expect(assign).toBeHidden();
  const row = page.getByRole("row").filter({ hasText: "Abena Asante" });
  await expect(row.getByText(route)).toBeVisible();
});

test("the teacher on the bus marks the child on, then at school", async ({ page }) => {
  await signIn(page, "teacher@example.test", `${SCHOOL.path}/transport/trips`);
  await page.goto(`${SCHOOL.path}/transport/trips`);
  await page.getByLabel("Route", { exact: true }).selectOption({ label: route });
  await page.getByLabel("Trip", { exact: true }).selectOption({ label: "Morning, to school" });
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("heading", { name: `${route} · Morning, to school` })).toBeVisible();

  await page.getByRole("button", { name: "Abena Asante is on the bus" }).click();
  const row = page.getByRole("row").filter({ hasText: "Abena Asante" });
  await expect(row.getByText("On the bus")).toBeVisible();
  await page.getByRole("button", { name: "Abena Asante is at school" }).click();
  await expect(row.getByText("At school")).toBeVisible();
});

test.describe("the accountant", () => {
  test.use({ storageState: ACCOUNTANT_AUTH });

  test("sets the fare but does not mark trips", async ({ page }) => {
    await page.goto(`${SCHOOL.path}/transport`);
    await expect(page.getByRole("button", { name: "Add a route" })).toHaveCount(0);
    await page.getByRole("link", { name: route }).click();
    await page.getByLabel(/Fare per term/).fill("450");
    await page.getByRole("button", { name: "Save fares" }).click();
    await expect(page.getByText("Fares saved.")).toBeVisible();
    await expect(page.getByRole("cell", { name: "GH₵450.00" })).toBeVisible();

    await page.goto(`${SCHOOL.path}/transport/trips`);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });
});
