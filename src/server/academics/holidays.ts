import "server-only";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { schoolHolidays } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";

/**
 * Days a school is closed within its terms: public holidays and breaks. No register is taken on them, and
 * they are left out of attendance counts (which only ever count registers taken).
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date.");

export interface Holiday {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
}

export async function listHolidays(database: Database, ctx: TenantContext): Promise<Holiday[]> {
  assertAllowed(ctx, "classes.view");
  return withTenant(database, scope(ctx), (tx) =>
    tx
      .select({
        id: schoolHolidays.id,
        name: schoolHolidays.name,
        startsOn: schoolHolidays.startsOn,
        endsOn: schoolHolidays.endsOn,
      })
      .from(schoolHolidays)
      .where(eq(schoolHolidays.tenantId, ctx.tenant.id))
      .orderBy(asc(schoolHolidays.startsOn)),
  );
}

/** The holiday covering a date, if any (inside the caller's tenant transaction). */
export async function holidayOn(tx: Transaction, tenantId: string, date: string): Promise<string | null> {
  const [row] = await tx
    .select({ name: schoolHolidays.name })
    .from(schoolHolidays)
    .where(
      and(
        eq(schoolHolidays.tenantId, tenantId),
        lte(schoolHolidays.startsOn, date),
        gte(schoolHolidays.endsOn, date),
      ),
    )
    .limit(1);
  return row?.name ?? null;
}

const holidaySchema = z
  .object({
    name: z.string().trim().min(2, "Name the holiday.").max(80, "Use 80 characters or fewer."),
    startsOn: isoDate,
    endsOn: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), isoDate.optional()),
  })
  .transform((v) => ({ ...v, endsOn: v.endsOn ?? v.startsOn }))
  .refine((v) => v.endsOn >= v.startsOn, {
    message: "The last day must be on or after the first.",
    path: ["endsOn"],
  })
  .refine((v) => Date.parse(v.endsOn) - Date.parse(v.startsOn) <= 60 * 86_400_000, {
    message: "A holiday can last up to 60 days. Holidays between terms need no entry.",
    path: ["endsOn"],
  });

/** Adds holidays (one, or several chosen from the suggestions). Days already covered are skipped. */
export async function addHolidays(database: Database, ctx: TenantContext, input: unknown[]): Promise<number> {
  assertAllowed(ctx, "academics.manage");
  const list = z.array(holidaySchema).min(1, "Choose at least one holiday.").max(60).parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    let added = 0;
    for (const h of list) {
      const [overlap] = await tx
        .select({ id: schoolHolidays.id })
        .from(schoolHolidays)
        .where(
          and(
            eq(schoolHolidays.tenantId, ctx.tenant.id),
            lte(schoolHolidays.startsOn, h.endsOn),
            gte(schoolHolidays.endsOn, h.startsOn),
          ),
        )
        .limit(1);
      if (overlap) {
        if (list.length === 1)
          throw new DomainError("holiday_overlap", "These days are already a holiday.", "startsOn");
        continue;
      }
      await tx.insert(schoolHolidays).values({ tenantId: ctx.tenant.id, ...h, createdByUserId: ctx.userId });
      added++;
    }
    if (added)
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "holidays.added",
        entityType: "holiday",
        metadata: {
          holidays: list.map(
            (h) => `${h.name} (${h.startsOn}${h.endsOn !== h.startsOn ? ` to ${h.endsOn}` : ""})`,
          ),
        },
      });
    return added;
  });
}

export async function removeHoliday(
  database: Database,
  ctx: TenantContext,
  holidayId: string,
): Promise<void> {
  assertAllowed(ctx, "academics.manage");
  if (!z.string().uuid().safeParse(holidayId).success)
    throw new DomainError("not_found", "Holiday not found.");
  await withTenant(database, scope(ctx), async (tx) => {
    const [removed] = await tx
      .delete(schoolHolidays)
      .where(and(eq(schoolHolidays.tenantId, ctx.tenant.id), eq(schoolHolidays.id, holidayId)))
      .returning();
    if (!removed) throw new DomainError("not_found", "Holiday not found.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "holiday.removed",
      entityType: "holiday",
      entityId: removed.id,
      metadata: { name: removed.name, startsOn: removed.startsOn, endsOn: removed.endsOn },
    });
  });
}
