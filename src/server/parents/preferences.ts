import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { guardians, studentGuardians } from "../db/schema";
import { DomainError } from "../errors";
import { schoolBySlug } from "./schools";

/**
 * A parent's message choices for one school (PAR-05). Announcements by SMS can be turned off; receipts,
 * fee notices, absence alerts and sign-in codes are essential and always sent. Staff can change the same
 * setting per child on the student's page (guardian roles).
 */

const parentScope = (tenantId: string) => ({ tenantId, userId: "" });

async function links(tx: Parameters<Parameters<typeof withTenant>[2]>[0], tenantId: string, phone: string) {
  return tx
    .select({
      guardianId: guardians.id,
      studentId: studentGuardians.studentId,
      on: studentGuardians.receivesMessages,
    })
    .from(studentGuardians)
    .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
    .where(
      and(
        eq(studentGuardians.tenantId, tenantId),
        eq(guardians.phone, phone),
        isNull(guardians.portalBlockedAt),
      ),
    );
}

/** Whether announcements reach this number by SMS at this school (true if any child's link has it on). */
export async function getAnnouncementSms(
  database: Database,
  phone: string,
  slug: string,
): Promise<boolean | null> {
  const school = await schoolBySlug(database, slug);
  if (!school) return null;
  return withTenant(database, parentScope(school.id), async (tx) => {
    const rows = await links(tx, school.id, phone);
    if (rows.length === 0) return null;
    return rows.some((r) => r.on);
  });
}

/** Turns announcements by SMS on or off for every child of this number at this school. */
export async function setAnnouncementSms(
  database: Database,
  phone: string,
  slug: string,
  input: unknown,
): Promise<void> {
  const { on } = z.object({ on: z.boolean() }).parse(input);
  const school = await schoolBySlug(database, slug);
  if (!school) throw new DomainError("not_found", "School not found.");
  await withTenant(database, parentScope(school.id), async (tx) => {
    const rows = await links(tx, school.id, phone);
    if (rows.length === 0) throw new DomainError("not_found", "School not found.");
    const guardianIds = [...new Set(rows.map((r) => r.guardianId))];
    await tx
      .update(studentGuardians)
      .set({ receivesMessages: on })
      .where(
        and(eq(studentGuardians.tenantId, school.id), inArray(studentGuardians.guardianId, guardianIds)),
      );
    for (const guardianId of guardianIds)
      await recordAudit(tx, {
        tenantId: school.id,
        actorUserId: null,
        action: on ? "guardian.announcements_sms_on" : "guardian.announcements_sms_off",
        entityType: "guardian",
        entityId: guardianId,
        metadata: { by: "parent" },
      });
  });
}
