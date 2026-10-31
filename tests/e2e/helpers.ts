import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, type Page } from "@playwright/test";
import { base32Decode, timeStep, totpAt } from "../../src/server/auth/totp";

/** Matches scripts/seed.ts (synthetic accounts). */
export const PASSWORD = "edubridge-dev-only";
export const PLATFORM_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
export const PLATFORM_AUTH = "playwright/.auth/platform.json";
export const SCHOOL = { path: "/s/kpone-ridge", name: "Kpone Ridge International School" };

export async function signIn(page: Page, email: string, next?: string) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/**
 * The server accepts each 30-second step once per user (replay protection) and allows one step of drift.
 * To never submit a used code — which would also count towards the sign-in throttle — the steps used are
 * remembered across test runs, and the next unused step is chosen (waiting for it if necessary).
 */
const STEP_FILE = "playwright/.auth/totp-steps.json";

function readSteps(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(STEP_FILE, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

export async function totp(secret: string): Promise<string> {
  const steps = readSteps();
  let step = Math.max(timeStep(), (steps[secret] ?? 0) + 1);
  while (step > timeStep() + 1) await new Promise((r) => setTimeout(r, 1000));
  step = Math.max(step, timeStep());
  mkdirSync(dirname(STEP_FILE), { recursive: true });
  writeFileSync(STEP_FILE, JSON.stringify({ ...readSteps(), [secret]: step }));
  return totpAt(base32Decode(secret), step);
}

export async function completeTwoStep(page: Page, secret: string) {
  await expect(page).toHaveURL(/\/login\/verify/);
  await page.getByLabel("Verification code").fill(await totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
