import { expect, test } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

// Runs in order: the office adds a book and lends it; someone reserves it; when it comes back it is held for
// them; a teacher finds it in the catalogue. The title carries a marker so repeated runs do not collide.
test.describe.configure({ mode: "serial" });

const book = `Anowa ${Date.now().toString(36)}`;
let copy = "";

test("the office adds a book, lends it, takes a reservation and returns it", async ({ page }) => {
  await signIn(page, "admin@example.test", `${SCHOOL.path}/library`);
  await page.goto(`${SCHOOL.path}/library`);
  await page.getByRole("button", { name: "Add a book" }).click();
  const add = page.getByRole("dialog", { name: "Add a book" });
  await add.getByLabel("Title").fill(book);
  await add.getByLabel(/Author/).fill("Ama Ata Aidoo");
  await add.getByLabel("Copies").fill("1");
  await add.getByRole("button", { name: "Save" }).click();
  await expect(add).toBeHidden();
  await page.getByRole("link", { name: book }).click();
  const copies = page.getByRole("table", { name: `Copies of ${book}` });
  copy = (await copies.getByRole("row").nth(1).getByRole("cell").first().innerText()).trim();
  expect(copy).toMatch(/^B\d{4,}$/);

  await page.goto(`${SCHOOL.path}/library/loans`);
  const lend = page.getByRole("form", { name: "Lend a book" });
  await lend.getByLabel("Copy number").fill(copy);
  await lend.getByLabel("Borrower").selectOption({ label: "Abena Asante" });
  await lend.getByRole("button", { name: "Lend" }).click();
  const row = page.getByRole("row").filter({ hasText: book });
  await expect(row.getByText("Abena Asante")).toBeVisible();

  // No copy is in: Esi Quaye joins the queue.
  await page.goto(`${SCHOOL.path}/library`);
  await page.getByRole("link", { name: book }).click();
  await page.getByRole("button", { name: "Reserve" }).click();
  const reserve = page.getByRole("dialog", { name: "Reserve this book" });
  await reserve.getByLabel("Borrower").selectOption({ label: "Esi Quaye" });
  await reserve.getByRole("button", { name: "Add to the queue" }).click();
  await expect(reserve).toBeHidden();
  await expect(page.getByText("1. Esi Quaye")).toBeVisible();

  // Returned at the desk: the copy is held for Esi.
  await page.goto(`${SCHOOL.path}/library/loans`);
  const giveBack = page.getByRole("form", { name: "Return a book" });
  await giveBack.getByLabel("Copy number").fill(copy);
  await giveBack.getByRole("button", { name: "Return" }).click();
  await expect(giveBack.getByText(`${copy} returned.`)).toBeVisible();
  await expect(giveBack.getByText("it is held for Esi Quaye")).toBeVisible();

  // Lent to Esi, which fulfils her reservation; then back again.
  await lend.getByLabel("Copy number").fill(copy);
  await lend.getByLabel("Borrower").selectOption({ label: "Esi Quaye" });
  await lend.getByRole("button", { name: "Lend" }).click();
  await expect(page.getByRole("row").filter({ hasText: book }).getByText("Esi Quaye")).toBeVisible();
  await page.getByRole("button", { name: `Return ${copy}` }).click();
  await expect(page.getByText(`${copy} returned.`).first()).toBeVisible();
});

test("a teacher finds the book in the catalogue but cannot lend", async ({ page }) => {
  await signIn(page, "teacher@example.test", `${SCHOOL.path}/library`);
  await page.goto(`${SCHOOL.path}/library`);
  await page.getByLabel("Title, author or ISBN").fill("Ama Ata Aidoo");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByRole("link", { name: book })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a book" })).toHaveCount(0);
  await page.goto(`${SCHOOL.path}/library/loans`);
  await expect(page.getByRole("form", { name: "Lend a book" })).toHaveCount(0);
});
