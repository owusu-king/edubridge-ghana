import { expect, test } from "@playwright/test";
import { SCHOOL, signIn } from "./helpers";

test("pages send a nonce-based CSP and the app runs without violations", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });

  const response = await page.goto("/login");
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("unsafe-eval");

  // Exercises hydration, client navigation and Radix popovers under the policy.
  await signIn(page, "admin@example.test", `${SCHOOL.path}/members`);
  await page.getByRole("button", { name: /^Account:/ }).click();
  await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
  expect(violations).toEqual([]);
});

test("each response gets a fresh nonce", async ({ request }) => {
  const nonce = async () =>
    (await request.get("/login")).headers()["content-security-policy"]?.match(/nonce-([^']+)/)?.[1];
  const [a, b] = [await nonce(), await nonce()];
  expect(a).toBeTruthy();
  expect(a).not.toEqual(b);
});
