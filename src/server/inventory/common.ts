import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { parseMoney } from "../../lib/money";
import { normalizePhone } from "../../lib/phone";
import { recordAudit } from "../audit/record";
import type { Transaction } from "../db/client";
import { tenantCounters } from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import type { TenantContext } from "../tenancy/service";

/** Shared helpers for inventory, assets and procurement (R4-6). */

export const UUID = z.string().uuid();
export const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

export const optionalText = (max: number) =>
  z.preprocess(blank, z.string().trim().max(max, `Use ${max} characters or fewer.`).nullable().optional());

export const requiredText = (min: number, max: number, message: string) =>
  z.string({ message }).trim().min(min, message).max(max, `Use ${max} characters or fewer.`);

export const wholeNumber = (min: number, max: number, message = "Use a whole number.") =>
  z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
    z
      .number({ message })
      .int(message)
      .min(min, `Use ${min} or more.`)
      .max(max, `Use ${max.toLocaleString("en-GB")} or fewer.`),
  );

export const optionalWholeNumber = (min: number, max: number) =>
  z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z
      .number()
      .int("Use a whole number.")
      .min(min, `Use ${min} or more.`)
      .max(max, `Use ${max.toLocaleString("en-GB")} or fewer.`)
      .nullable(),
  );

export const optionalPhone = (country: string) =>
  z.preprocess(
    blank,
    z
      .string()
      .transform((v, c) => {
        const phone = normalizePhone(v, country);
        if (!phone) c.addIssue({ code: "custom", message: "Enter a valid phone number." });
        return phone ?? "";
      })
      .nullable()
      .optional(),
  );

/** An optional amount typed in the school's currency, as minor units. */
export const optionalMoney = (currency: string) =>
  z.preprocess(blank, z.string().nullable().optional()).transform((v, c) => {
    if (v === null || v === undefined) return null;
    const minor = parseMoney(v, currency);
    if (minor === null || minor < 0) {
      c.addIssue({ code: "custom", message: "Enter an amount, e.g. 450.00." });
      return z.NEVER;
    }
    return minor;
  });

export const scopeOf = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

export function audit(
  tx: Transaction,
  ctx: TenantContext,
  action: string,
  entityType: string,
  entityId: string,
  metadata?: Record<string, unknown>,
) {
  return recordAudit(tx, {
    tenantId: ctx.tenant.id,
    actorUserId: ctx.userId,
    action,
    entityType,
    entityId,
    metadata,
  });
}

/** The next number of a per-school counter (asset tags, request references); never reused. */
export async function nextNumber(tx: Transaction, tenantId: string, key: string): Promise<number> {
  const [counter] = await tx
    .insert(tenantCounters)
    .values({ tenantId, key, value: 1 })
    .onConflictDoUpdate({
      target: [tenantCounters.tenantId, tenantCounters.key],
      set: { value: sql`${tenantCounters.value} + 1` },
    })
    .returning({ value: tenantCounters.value });
  return counter!.value;
}

export const nameTaken = (what: string) => (error: unknown) => {
  if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
    throw new DomainError("name_taken", `There is already ${what} with this name.`, "name");
  throw error;
};
