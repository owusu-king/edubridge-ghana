import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { todayIn } from "@/lib/format";
import { planIncludesParentView } from "./schools";
import { hashToken } from "../auth/tokens";
import type { Database, Transaction } from "../db/client";
import { balanceLinks, guardians, studentGuardians, students, tenants } from "../db/schema";
import { readChildSummary, type ChildSummary } from "./portal";

/**
 * Read-only links to one child's balance, sent in fee reminders so a parent can check the figure without
 * signing in. Valid for 7 days, and only while the guardian it was sent to still has that number, is still
 * linked to the child and is not blocked. The token is 128 random bits (22 characters, to keep the SMS
 * short); only its hash is stored.
 */

export const BALANCE_LINK_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export async function createBalanceLink(
  tx: Transaction,
  link: { tenantId: string; studentId: string; guardianId: string; recipient: string },
  now = new Date(),
): Promise<string> {
  const token = randomBytes(16).toString("base64url");
  await tx.insert(balanceLinks).values({
    ...link,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + BALANCE_LINK_LIFETIME_MS),
    createdAt: now,
  });
  return token;
}

export interface BalanceView {
  schoolName: string;
  timeZone: string;
  /** Today in the school's time zone: the balance is live, not the figure when the link was sent. */
  asOf: string;
  expiresAt: Date;
  child: ChildSummary;
}

export async function readBalanceLink(
  database: Database,
  token: string,
  now = new Date(),
): Promise<BalanceView | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const tokenHash = hashToken(token);
  return database.transaction(async (tx) => {
    // Lets row-level security show this one link before the school is known (migration 0039).
    await tx.execute(sql`select set_config('app.balance_link_token_hash', ${tokenHash}, true)`);
    const [link] = await tx
      .select()
      .from(balanceLinks)
      .where(and(eq(balanceLinks.tokenHash, tokenHash), gt(balanceLinks.expiresAt, now)));
    if (!link) return null;
    const [school] = await tx
      .select({ name: tenants.name, timezone: tenants.timezone })
      .from(tenants)
      .where(and(eq(tenants.id, link.tenantId), eq(tenants.status, "active"), eq(tenants.isDemo, false)));
    if (!school) return null;
    // Sets the school's tenant context as well; a plan without the parent view shows nothing.
    if (!(await planIncludesParentView(tx, link.tenantId))) return null;
    const [student] = await tx
      .select({
        id: students.id,
        firstName: students.firstName,
        otherNames: students.otherNames,
        lastName: students.lastName,
        status: students.status,
      })
      .from(studentGuardians)
      .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
      .innerJoin(students, eq(students.id, studentGuardians.studentId))
      .where(
        and(
          eq(studentGuardians.tenantId, link.tenantId),
          eq(studentGuardians.studentId, link.studentId),
          eq(studentGuardians.guardianId, link.guardianId),
          eq(guardians.phone, link.recipient),
          isNull(guardians.portalBlockedAt),
        ),
      );
    if (!student) return null;
    const asOf = todayIn(school.timezone);
    return {
      schoolName: school.name,
      timeZone: school.timezone,
      asOf,
      expiresAt: link.expiresAt,
      child: await readChildSummary(tx, link.tenantId, student, asOf),
    };
  });
}
