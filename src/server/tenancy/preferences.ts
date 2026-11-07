import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { parseCedis } from "../../lib/money";
import { normalizeCallablePhone, normalizePhone } from "../../lib/phone";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Queryable } from "../db/client";
import { withTenant } from "../db/context";
import { schoolPreferences } from "../db/schema";
import type { TenantContext } from "./service";

/**
 * A school's own choices (founder decisions, 2026-11-06): whether Accountants may void receipts, decided by
 * the Proprietor; and how the overview's collection rate and attendance follow-up are defined.
 */

export interface SchoolPreferences {
  accountantsCanVoid: boolean;
  collectionRateBasis: "due" | "billed";
  attendanceConcernPercent: number;
  attendanceConcernMinDays: number;
  paymentReceiptSms: boolean;
  autoRemindersEnabled: boolean;
  autoReminderIntervalDays: number;
  autoReminderMinPesewas: number;
  autoRemindersLastRunOn: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  contactWhatsapp: string | null;
  officeHours: string | null;
}

export const DEFAULT_PREFERENCES: SchoolPreferences = {
  accountantsCanVoid: false,
  collectionRateBasis: "due",
  attendanceConcernPercent: 80,
  attendanceConcernMinDays: 5,
  paymentReceiptSms: false,
  autoRemindersEnabled: false,
  autoReminderIntervalDays: 14,
  autoReminderMinPesewas: 10_000,
  autoRemindersLastRunOn: null,
  contactPhone: null,
  contactEmail: null,
  contactWhatsapp: null,
  officeHours: null,
};

/** The school's preferences, or the defaults (inside a tenant transaction). */
export async function readPreferences(tx: Queryable, tenantId: string): Promise<SchoolPreferences> {
  const [row] = await tx
    .select({
      accountantsCanVoid: schoolPreferences.accountantsCanVoid,
      collectionRateBasis: schoolPreferences.collectionRateBasis,
      attendanceConcernPercent: schoolPreferences.attendanceConcernPercent,
      attendanceConcernMinDays: schoolPreferences.attendanceConcernMinDays,
      paymentReceiptSms: schoolPreferences.paymentReceiptSms,
      autoRemindersEnabled: schoolPreferences.autoRemindersEnabled,
      autoReminderIntervalDays: schoolPreferences.autoReminderIntervalDays,
      autoReminderMinPesewas: schoolPreferences.autoReminderMinPesewas,
      autoRemindersLastRunOn: schoolPreferences.autoRemindersLastRunOn,
      contactPhone: schoolPreferences.contactPhone,
      contactEmail: schoolPreferences.contactEmail,
      contactWhatsapp: schoolPreferences.contactWhatsapp,
      officeHours: schoolPreferences.officeHours,
    })
    .from(schoolPreferences)
    .where(eq(schoolPreferences.tenantId, tenantId));
  return row ?? DEFAULT_PREFERENCES;
}

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

export async function getSchoolPreferences(
  database: Database,
  ctx: TenantContext,
): Promise<SchoolPreferences> {
  return withTenant(database, scope(ctx), (tx) => readPreferences(tx, ctx.tenant.id));
}

async function save(
  database: Database,
  ctx: TenantContext,
  changes: Partial<SchoolPreferences>,
  action: string,
): Promise<void> {
  await withTenant(database, scope(ctx), async (tx) => {
    const before = await readPreferences(tx, ctx.tenant.id);
    const values = { ...before, ...changes, updatedAt: new Date(), updatedByUserId: ctx.userId };
    await tx
      .insert(schoolPreferences)
      .values({ tenantId: ctx.tenant.id, ...values })
      .onConflictDoUpdate({ target: schoolPreferences.tenantId, set: values });
    const from = Object.fromEntries(
      Object.keys(changes).map((k) => [k, before[k as keyof SchoolPreferences]]),
    );
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action,
      entityType: "tenant",
      entityId: ctx.tenant.id,
      metadata: { from, to: changes },
    });
  });
}

/** Who may void receipts: the Proprietor only, or also Accountants. The Proprietor decides. */
export async function saveVoidPolicy(database: Database, ctx: TenantContext, input: unknown): Promise<void> {
  assertAllowed(ctx, "security.manage");
  const { accountantsCanVoid } = z.object({ accountantsCanVoid: z.boolean() }).parse(input);
  await save(database, ctx, { accountantsCanVoid }, "school.void_policy_updated");
}

const overviewSchema = z.object({
  collectionRateBasis: z.enum(["due", "billed"], {
    message: "Choose how the collection rate is worked out.",
  }),
  attendanceConcernPercent: z.coerce
    .number()
    .int("Use a whole number.")
    .min(1, "Use 1 to 100.")
    .max(100, "Use 1 to 100."),
  attendanceConcernMinDays: z.coerce
    .number()
    .int("Use a whole number.")
    .min(1, "Use 1 or more.")
    .max(100, "Use 100 or fewer."),
});

export async function saveOverviewPreferences(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "school.settings.manage");
  await save(database, ctx, overviewSchema.parse(input), "school.overview_preferences_updated");
}

const messageSchema = z.object({
  paymentReceiptSms: z.boolean(),
  autoRemindersEnabled: z.boolean(),
  autoReminderIntervalDays: z.coerce
    .number()
    .int("Use a whole number.")
    .min(7, "Use 7 to 90 days.")
    .max(90, "Use 7 to 90 days."),
  autoReminderMin: z.string().transform((text, issue) => {
    const pesewas = parseCedis(text.trim() === "" ? "0" : text);
    if (pesewas === null) {
      issue.addIssue({ code: "custom", message: "Enter an amount in cedis, like 100." });
      return z.NEVER;
    }
    return pesewas;
  }),
});

/** Payment receipt SMS and automatic fee reminders: the Proprietor and Accountant decide (they cost SMS). */
export async function saveMessageSettings(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "fees.manage");
  const data = messageSchema.parse(input);
  await save(
    database,
    ctx,
    {
      paymentReceiptSms: data.paymentReceiptSms,
      autoRemindersEnabled: data.autoRemindersEnabled,
      autoReminderIntervalDays: data.autoReminderIntervalDays,
      autoReminderMinPesewas: data.autoReminderMin,
    },
    "school.message_settings_updated",
  );
}

const optional = (max: number, message: string) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(max, message).nullable(),
  );

const contactsSchema = z.object({
  contactPhone: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z
      .string()
      .nullable()
      .transform((v, issue) => {
        if (v === null) return null;
        const phone = normalizeCallablePhone(v);
        if (!phone) {
          issue.addIssue({ code: "custom", message: "Enter a valid phone number, e.g. 030 123 4567." });
          return z.NEVER;
        }
        return phone;
      }),
  ),
  contactWhatsapp: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z
      .string()
      .nullable()
      .transform((v, issue) => {
        if (v === null) return null;
        const phone = normalizePhone(v);
        if (!phone) {
          issue.addIssue({ code: "custom", message: "Enter the WhatsApp number, e.g. 024 123 4567." });
          return z.NEVER;
        }
        return phone;
      }),
  ),
  contactEmail: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().toLowerCase().email("Enter a valid email address.").max(254).nullable(),
  ),
  officeHours: optional(120, "Use 120 characters or fewer."),
});

/** How families reach the school, shown in the parent view (PRT-06). */
export async function saveSchoolContacts(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "school.settings.manage");
  await save(database, ctx, contactsSchema.parse(input), "school.contacts_updated");
}
