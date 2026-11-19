import { expect, test } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

// Runs in order: the office sets up a house, gives a student a bed and appoints the teacher as house staff; the
// teacher signs the boarder out on exeat and back in. The house carries a marker so repeated runs do not collide.
test.describe.configure({ mode: "serial" });

const house = `House ${Date.now().toString(36)}`;
let boarder = "";

test("the office sets up a house, gives a student a bed and appoints house staff", async ({ page }) => {
  await signIn(page, "admin@example.test", `${SCHOOL.path}/boarding`);
  await page.goto(`${SCHOOL.path}/boarding`);
  await page.getByRole("button", { name: "Add a house" }).click();
  const add = page.getByRole("dialog", { name: "Add a house" });
  await add.getByLabel("Name").fill(house);
  await add.getByLabel("For").selectOption({ label: "Mixed" });
  await add.getByRole("button", { name: "Save" }).click();
  await expect(add).toBeHidden();
  await page.getByRole("link", { name: house }).click();

  await page.getByRole("button", { name: "Add a room" }).click();
  const room = page.getByRole("dialog", { name: "Add a room" });
  await room.getByLabel("Room").fill("Dormitory A");
  await room.getByLabel("Beds").fill("2");
  await room.getByRole("button", { name: "Add" }).click();
  await expect(room).toBeHidden();
  await expect(page.getByRole("heading", { name: "Dormitory A" })).toBeVisible();

  await page.getByRole("button", { name: "Give a student a bed" }).click();
  const place = page.getByRole("dialog", { name: "Give a student a bed" });
  const student = place.getByLabel("Student");
  await student.selectOption({ index: 1 });
  boarder = (await student.locator("option:checked").innerText()).trim();
  await place.getByLabel("Bed").selectOption({ label: "Dormitory A, Bed 1" });
  await place.getByRole("button", { name: "Save" }).click();
  await expect(place).toBeHidden();
  await expect(page.getByRole("listitem").filter({ hasText: "Bed 1" }).getByText(boarder)).toBeVisible();

  const appoint = page.getByRole("form", { name: "Appoint house staff" });
  await appoint.getByLabel("Appoint house staff").selectOption({ label: "Yaw Boateng" });
  await appoint.getByRole("button", { name: "Appoint" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Yaw Boateng" })).toBeVisible();
});

test("the house staff signs the boarder out on exeat and back in", async ({ page }) => {
  await signIn(page, "teacher@example.test", `${SCHOOL.path}/boarding/exeats`);
  await page.goto(`${SCHOOL.path}/boarding/exeats`);
  await page.getByRole("button", { name: "Sign a boarder out" }).click();
  const out = page.getByRole("dialog", { name: "Sign a boarder out" });
  await out.getByLabel("Boarder").selectOption({ label: boarder });
  await out.getByLabel("Why").fill("Family wedding");
  await out.getByLabel("Collected by").fill("Grace Mensah, mother");
  const due = out.getByLabel("Due back");
  await due.fill((await due.getAttribute("min")) ?? "");
  await out.getByRole("button", { name: "Sign out" }).click();
  await expect(out).toBeHidden();
  const row = page.getByRole("row").filter({ hasText: boarder });
  await expect(row.getByText("Family wedding")).toBeVisible();
  await row.getByRole("button", { name: `Sign ${boarder} back in` }).click();
  await expect(page.getByRole("table", { name: "Boarders out on exeat" }).getByText(boarder)).toHaveCount(0);
  await expect(page.getByText(new RegExp(`${boarder} · ${house}`))).toBeVisible();
});
