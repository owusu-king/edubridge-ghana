import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

test("an administrator imports students from a spreadsheet", async ({ page }) => {
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const csv = [
    "Adm No,First Name,Surname,Gender,DOB,Class,Parent Name,Parent Phone",
    `IMP-${tag}-1,Ekow,Import${tag},M,14/03/2017,Basic 4B,Araba Import,0245${tag.replace(/\D/g, "0").slice(0, 6).padEnd(6, "0")}`,
    `IMP-${tag}-2,Efua,Import${tag},F,02/07/2018,Basic 4B,Araba Import,0245${tag.replace(/\D/g, "0").slice(0, 6).padEnd(6, "0")}`,
    `IMP-${tag}-3,Bad,Row,X,31/02/2017,Basic 99,,`,
  ].join("\n");

  await signIn(page, "admin@example.test");
  await page.goto(`${SCHOOL.path}/students`);
  await page.getByRole("link", { name: "Import", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Import students" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download template" })).toHaveAttribute(
    "href",
    "/templates/students-import.csv",
  );

  await page
    .getByLabel("Spreadsheet file")
    .setInputFiles({ name: "register.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Read file" }).click();
  await expect(page.getByRole("heading", { name: "2. Match your columns" })).toBeVisible();
  await expect(page.getByLabel("Column for Sex")).toHaveValue("3");
  await expect(page.getByLabel("Column for Other names")).toHaveValue("");

  await page.getByRole("button", { name: "Check rows" }).click();
  await expect(page.getByText("2 of 3 rows are ready to import.")).toBeVisible();
  const problems = page.getByRole("table", { name: "Rows with problems" });
  await expect(problems.getByRole("row", { name: /4 Sex/ })).toBeVisible();
  await expect(problems.getByText("There is no class called “Basic 99”.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Import 2 students" }).click();
  await expect(page.getByText("2 students were imported. 1 row was left out.")).toBeVisible();
  await page.getByRole("link", { name: "View students" }).click();

  await page.getByRole("searchbox", { name: "Search by name or admission number" }).fill(`Import${tag}`);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(
    page.getByRole("row", { name: new RegExp(`Efua Import${tag}.*Basic 4B.*Araba Import`) }),
  ).toBeVisible();
  await page.getByRole("link", { name: `Ekow Import${tag}` }).click();
  await expect(page.getByText(`Also guardian of Efua Import${tag}`)).toBeVisible();
});

test("a bad file gets a clear message", async ({ page }) => {
  await signIn(page, "admin@example.test");
  await page.goto(`${SCHOOL.path}/students/import`);
  await page
    .getByLabel("Spreadsheet file")
    .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await page.getByRole("button", { name: "Read file" }).click();
  await expect(page.getByText("Choose an Excel (.xlsx) or CSV (.csv) file.")).toBeVisible();
});
