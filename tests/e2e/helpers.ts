import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, type Page } from "@playwright/test";
import { base32Decode, timeStep, totpAt } from "../../src/server/auth/totp";

/** Matches scripts/seed.ts (synthetic accounts). */
export const PASSWORD = "edubridge-dev-only";
export const PLATFORM_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
export const ACCOUNTANT_TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
export const PLATFORM_AUTH = "playwright/.auth/platform.json";
export const SCHOOL = { path: "/s/kpone-ridge", name: "Kpone Ridge International School" };

/** Signs in with the seeded password, and a two-step code when the account has a TOTP secret. */
export async function signIn(page: Page, email: string, next?: string, totpSecret?: string) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  if (totpSecret) await completeTwoStep(page, totpSecret);
  else await expect(page).not.toHaveURL(/\/login/);
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

/** Sets up two-step verification on /account/security; returns the secret for later codes. */
export async function enrollTwoStep(page: Page): Promise<{ secret: string; recoveryCodes: string[] }> {
  await page.getByRole("button", { name: "Set up two-step verification" }).click();
  const secret = (await page.getByTestId("mfa-secret").innerText()).replace(/\s+/g, "");
  await page.getByLabel("Code from your app").fill(await totp(secret));
  await page.getByRole("button", { name: "Turn on" }).click();
  const items = page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem");
  await expect(items).toHaveCount(10);
  const recoveryCodes = await items.allInnerTexts();
  await page.getByRole("button", { name: "I have saved them" }).click();
  return { secret, recoveryCodes };
}

interface MailboxEntry {
  channel: "email" | "sms";
  to: string;
  subject?: string;
  text: string;
}

/** Waits for the newest development-mailbox message to a recipient (written by the log provider). */
export async function waitForMessage(to: string, match?: RegExp): Promise<MailboxEntry> {
  let found: MailboxEntry | undefined;
  await expect
    .poll(
      () => {
        let lines: string[] = [];
        try {
          lines = readFileSync(".dev-mailbox.jsonl", "utf8").trim().split("\n");
        } catch {
          return false;
        }
        found = lines
          .map((l) => JSON.parse(l) as MailboxEntry)
          .filter((m) => m.to === to && (!match || match.test(m.text)))
          .at(-1);
        return Boolean(found);
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  return found!;
}

/** The path of the first app link in a message, e.g. "/invite/abc". */
export function linkPath(text: string): string {
  const url = text.match(/https?:\/\/\S+/)?.[0];
  if (!url) throw new Error("No link in message");
  return new URL(url).pathname;
}
